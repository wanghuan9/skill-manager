use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{mpsc, OnceLock};
use std::thread;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::git_metadata::{git_state_metadata_repository_root, is_git_metadata_path};
use crate::workspace::managed_workspace_root_option;

static PLUGIN_LIBRARY_WATCHER_STARTED: OnceLock<()> = OnceLock::new();
const PLUGIN_LIBRARY_CHANGE_EVENT: &str = "plugin-library-changed";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLibraryChangeEvent {
    pub changed_paths: Vec<String>,
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

        while let Ok(result) = rx.recv() {
            let event = match result {
                Ok(event) => event,
                Err(error) => {
                    log::warn!("Plugin library watcher error: {error}");
                    continue;
                }
            };

            let changed_paths = classify_plugin_change_event(&event, &watched_roots);
            if changed_paths.is_empty() {
                continue;
            }

            let payload = PluginLibraryChangeEvent { changed_paths };
            if let Err(error) = thread_app_handle.emit(PLUGIN_LIBRARY_CHANGE_EVENT, payload) {
                log::warn!("Failed to emit plugin library change event: {error}");
            }
        }
    });

    let _ = PLUGIN_LIBRARY_WATCHER_STARTED.set(());
    Ok(())
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
    use super::classify_plugin_change_paths;
    use std::path::PathBuf;

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
