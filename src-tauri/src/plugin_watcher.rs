use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::git_metadata::{git_state_metadata_repository_root, is_git_metadata_path};
use crate::workspace::managed_workspace_root_option;

static PLUGIN_LIBRARY_WATCHER_STARTED: OnceLock<()> = OnceLock::new();
static PENDING_PLUGIN_LIBRARY_SYNC_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
const PLUGIN_LIBRARY_CHANGE_EVENT: &str = "plugin-library-changed";
const PLUGIN_LIBRARY_SYNC_DEBOUNCE: Duration = Duration::from_secs(10);

struct PendingPluginChange {
    changed_paths: BTreeSet<String>,
    deadline: Instant,
}

#[derive(Default)]
struct PendingPluginChanges {
    by_package: BTreeMap<PathBuf, PendingPluginChange>,
}

impl PendingPluginChanges {
    fn record(
        &mut self,
        package_root: PathBuf,
        changed_path: String,
        now: Instant,
        debounce: Duration,
    ) {
        let pending = self
            .by_package
            .entry(package_root)
            .or_insert_with(|| PendingPluginChange {
                changed_paths: BTreeSet::new(),
                deadline: now + debounce,
            });
        pending.changed_paths.insert(changed_path);
        pending.deadline = now + debounce;
    }

    fn next_wait(&self, now: Instant) -> Option<Duration> {
        self.by_package
            .values()
            .map(|pending| pending.deadline)
            .min()
            .map(|deadline| deadline.saturating_duration_since(now))
    }

    fn take_ready(&mut self, now: Instant) -> Vec<Vec<String>> {
        let ready_packages = self
            .by_package
            .iter()
            .filter_map(|(package_root, pending)| {
                (pending.deadline <= now).then(|| package_root.clone())
            })
            .collect::<Vec<_>>();

        ready_packages
            .into_iter()
            .filter_map(|package_root| self.by_package.remove(&package_root))
            .map(|pending| pending.changed_paths.into_iter().collect())
            .collect()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLibraryChangeEvent {
    pub changed_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_error: Option<String>,
}

fn pending_plugin_library_sync_error() -> &'static Mutex<Option<String>> {
    PENDING_PLUGIN_LIBRARY_SYNC_ERROR.get_or_init(|| Mutex::new(None))
}

pub fn emit_plugin_library_sync_error(app_handle: &AppHandle, error: String) {
    let message = format!("同步 SkillDock 插件运行时副本失败: {error}");
    if let Ok(mut pending) = pending_plugin_library_sync_error().lock() {
        *pending = Some(message.clone());
    }
    let payload = PluginLibraryChangeEvent {
        changed_paths: Vec::new(),
        sync_error: Some(message),
    };
    if let Err(emit_error) = app_handle.emit(PLUGIN_LIBRARY_CHANGE_EVENT, payload) {
        log::warn!("Failed to emit plugin library sync error: {emit_error}");
    }
}

#[tauri::command]
pub fn take_pending_plugin_library_sync_error() -> Option<String> {
    pending_plugin_library_sync_error()
        .lock()
        .ok()
        .and_then(|mut pending| pending.take())
}

pub fn start_plugin_library_watcher(app_handle: AppHandle) -> Result<(), String> {
    if PLUGIN_LIBRARY_WATCHER_STARTED.get().is_some() {
        return Ok(());
    }

    let watched_roots = collect_plugin_watch_roots();
    if watched_roots.is_empty() {
        return Ok(());
    }

    let thread_app_handle = app_handle.clone();
    thread::spawn(move || {
        let (tx, rx) = mpsc::channel();
        let mut watcher = match RecommendedWatcher::new(
            move |result| {
                let _ = tx.send(result);
            },
            notify::Config::default(),
        ) {
            Ok(watcher) => watcher,
            Err(error) => {
                log::warn!("Failed to create plugin library watcher: {error}");
                return;
            }
        };

        let mut has_watched_root = false;
        for watched_root in &watched_roots {
            if !watched_root.exists() {
                continue;
            }

            if let Err(error) = watcher.watch(watched_root, RecursiveMode::Recursive) {
                log::warn!(
                    "Failed to watch plugin library root {}: {error}",
                    watched_root.display()
                );
                continue;
            }

            has_watched_root = true;
        }

        if !has_watched_root {
            return;
        }

        let mut pending_changes = PendingPluginChanges::default();
        loop {
            let receive_result = match pending_changes.next_wait(Instant::now()) {
                Some(wait) => match rx.recv_timeout(wait) {
                    Ok(result) => Some(result),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                },
                None => match rx.recv() {
                    Ok(result) => Some(result),
                    Err(_) => break,
                },
            };

            if let Some(result) = receive_result {
                collect_changed_paths_from_result(
                    result,
                    &watched_roots,
                    &mut pending_changes,
                    Instant::now(),
                );
            }

            for changed_paths in pending_changes.take_ready(Instant::now()) {
                reconcile_and_emit_plugin_changes(&thread_app_handle, changed_paths);
            }
        }
    });

    let _ = PLUGIN_LIBRARY_WATCHER_STARTED.set(());
    Ok(())
}

fn collect_changed_paths_from_result(
    result: notify::Result<Event>,
    watched_roots: &[PathBuf],
    pending_changes: &mut PendingPluginChanges,
    now: Instant,
) {
    match result {
        Ok(event) => {
            for changed_path in classify_plugin_change_event(&event, watched_roots) {
                let path = PathBuf::from(&changed_path);
                let Some(package_root) = plugin_package_root_for_changed_path(&path, watched_roots)
                else {
                    continue;
                };
                pending_changes.record(
                    package_root,
                    changed_path,
                    now,
                    PLUGIN_LIBRARY_SYNC_DEBOUNCE,
                );
            }
        }
        Err(error) => log::warn!("Plugin library watcher error: {error}"),
    }
}

fn plugin_package_root_for_changed_path(
    path: &std::path::Path,
    watched_roots: &[PathBuf],
) -> Option<PathBuf> {
    watched_roots.iter().find_map(|watched_root| {
        let relative_path = path.strip_prefix(watched_root).ok()?;
        let package_name = relative_path.components().next()?.as_os_str();
        Some(watched_root.join(package_name))
    })
}

fn reconcile_and_emit_plugin_changes(app_handle: &AppHandle, changed_paths: Vec<String>) {
    let changed_path_bufs = changed_paths.iter().map(PathBuf::from).collect::<Vec<_>>();
    let sync_error = crate::plugin_manager::reconcile_skilldock_runtime_copies_for_changed_paths(
        &changed_path_bufs,
    )
    .err()
    .map(|error| {
        log::warn!("Failed to reconcile SkillDock plugin runtime copies: {error}");
        let message = format!("同步 SkillDock 插件运行时副本失败: {error}");
        if let Ok(mut pending) = pending_plugin_library_sync_error().lock() {
            *pending = Some(message.clone());
        }
        message
    });
    let payload = PluginLibraryChangeEvent {
        changed_paths,
        sync_error,
    };
    if let Err(error) = app_handle.emit(PLUGIN_LIBRARY_CHANGE_EVENT, payload) {
        log::warn!("Failed to emit plugin library change event: {error}");
    }
}

fn collect_plugin_watch_roots() -> Vec<PathBuf> {
    let Some(workspace_root) = managed_workspace_root_option() else {
        return Vec::new();
    };

    vec![workspace_root.join("plugins")]
}

fn classify_plugin_change_event(event: &Event, watched_roots: &[PathBuf]) -> Vec<String> {
    classify_plugin_change_paths(&event.paths, watched_roots)
}

fn classify_plugin_change_paths(paths: &[PathBuf], watched_roots: &[PathBuf]) -> Vec<String> {
    let mut matched_paths = BTreeSet::new();

    for path in paths {
        if git_state_metadata_repository_root(path).is_some() {
            if watched_roots.iter().any(|root| path.starts_with(root)) {
                matched_paths.insert(path.display().to_string());
            }
            continue;
        }

        if is_git_metadata_path(path) {
            continue;
        }

        if watched_roots.iter().any(|root| path.starts_with(root)) {
            matched_paths.insert(path.display().to_string());
        }
    }

    matched_paths.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::{
        classify_plugin_change_paths, plugin_package_root_for_changed_path, PendingPluginChanges,
    };
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    #[test]
    fn pending_plugin_changes_waits_for_a_full_quiet_window() {
        let started_at = Instant::now();
        let package_root = PathBuf::from("/Users/demo/.skilldock/plugins/browser");
        let mut pending = PendingPluginChanges::default();

        pending.record(
            package_root.clone(),
            package_root.join("README.md").display().to_string(),
            started_at,
            Duration::from_secs(10),
        );
        pending.record(
            package_root.clone(),
            package_root.join("SKILL.md").display().to_string(),
            started_at + Duration::from_secs(9),
            Duration::from_secs(10),
        );

        assert!(pending
            .take_ready(started_at + Duration::from_secs(10))
            .is_empty());
        assert_eq!(
            pending.take_ready(started_at + Duration::from_secs(19)),
            vec![vec![
                "/Users/demo/.skilldock/plugins/browser/README.md".to_string(),
                "/Users/demo/.skilldock/plugins/browser/SKILL.md".to_string(),
            ]]
        );
    }

    #[test]
    fn pending_plugin_changes_debounces_packages_independently() {
        let started_at = Instant::now();
        let browser_root = PathBuf::from("/Users/demo/.skilldock/plugins/browser");
        let chrome_root = PathBuf::from("/Users/demo/.skilldock/plugins/chrome");
        let mut pending = PendingPluginChanges::default();

        pending.record(
            browser_root.clone(),
            browser_root.join("SKILL.md").display().to_string(),
            started_at,
            Duration::from_secs(10),
        );
        pending.record(
            chrome_root.clone(),
            chrome_root.join("SKILL.md").display().to_string(),
            started_at + Duration::from_secs(5),
            Duration::from_secs(10),
        );

        assert_eq!(
            pending.take_ready(started_at + Duration::from_secs(10)),
            vec![vec![
                "/Users/demo/.skilldock/plugins/browser/SKILL.md".to_string()
            ]]
        );
        assert_eq!(
            pending.take_ready(started_at + Duration::from_secs(15)),
            vec![vec![
                "/Users/demo/.skilldock/plugins/chrome/SKILL.md".to_string()
            ]]
        );
    }

    #[test]
    fn plugin_package_root_uses_the_first_path_below_the_watched_root() {
        let watched_roots = vec![PathBuf::from("/Users/demo/.skilldock/plugins")];

        assert_eq!(
            plugin_package_root_for_changed_path(
                &PathBuf::from("/Users/demo/.skilldock/plugins/browser/skills/demo/SKILL.md"),
                &watched_roots,
            ),
            Some(PathBuf::from("/Users/demo/.skilldock/plugins/browser"))
        );
        assert_eq!(
            plugin_package_root_for_changed_path(
                &PathBuf::from("/Users/demo/.cursor/plugins/local/browser/SKILL.md"),
                &watched_roots,
            ),
            None
        );
    }

    #[test]
    fn classify_plugin_change_paths_keeps_git_state_and_ignores_git_objects() {
        let watched_roots = vec![PathBuf::from("/Users/demo/.skilldock/plugins")];

        let matched = classify_plugin_change_paths(
            &[
                PathBuf::from("/Users/demo/.skilldock/plugins/browser/.git/index"),
                PathBuf::from(
                    "/Users/demo/.skilldock/plugins/browser/.git/refs/remotes/origin/main",
                ),
                PathBuf::from("/Users/demo/.skilldock/plugins/browser/.git/objects/ab/cd"),
                PathBuf::from("/Users/demo/.skilldock/plugins/browser/.skilldock-package.json"),
            ],
            &watched_roots,
        );

        assert_eq!(
            matched,
            vec![
                "/Users/demo/.skilldock/plugins/browser/.git/index",
                "/Users/demo/.skilldock/plugins/browser/.git/refs/remotes/origin/main",
                "/Users/demo/.skilldock/plugins/browser/.skilldock-package.json",
            ]
        );
    }

    #[test]
    fn classify_plugin_change_paths_returns_matching_roots_once() {
        let watched_roots = vec![PathBuf::from("/Users/demo/.skilldock/plugins")];

        let matched = classify_plugin_change_paths(
            &[
                PathBuf::from("/Users/demo/.skilldock/plugins/browser/.skilldock-package.json"),
                PathBuf::from("/Users/demo/.skilldock/plugins/chrome/.skilldock-package.json"),
            ],
            &watched_roots,
        );

        assert_eq!(
            matched,
            vec![
                "/Users/demo/.skilldock/plugins/browser/.skilldock-package.json",
                "/Users/demo/.skilldock/plugins/chrome/.skilldock-package.json",
            ]
        );
    }
}
