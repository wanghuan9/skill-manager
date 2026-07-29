use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::state::load_installed_skills;
use crate::workspace::skill_root_paths;

static WATCHED_SKILL_ROOTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
const SKILL_LIBRARY_CHANGE_EVENT: &str = "skill-library-changed";

#[derive(Clone, Debug)]
struct WatchedSkill {
    name: String,
    local_path: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLibraryChangeEvent {
    pub skill_name: String,
}

pub fn start_skill_library_watcher(app_handle: AppHandle) -> Result<(), String> {
    let compatibility_enabled =
        crate::state::load_app_settings().agent_skills_compatibility_enabled;
    for skills_root in skill_root_paths(compatibility_enabled)? {
        start_skill_root_watcher(app_handle.clone(), skills_root)?;
    }
    Ok(())
}

fn start_skill_root_watcher(app_handle: AppHandle, skills_root: PathBuf) -> Result<(), String> {
    if !skills_root.exists() {
        return Ok(());
    }

    let watched_roots = WATCHED_SKILL_ROOTS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut watched_roots = watched_roots
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !watched_roots.insert(skills_root.clone()) {
        return Ok(());
    }
    drop(watched_roots);

    let thread_app_handle = app_handle.clone();
    let thread_skills_root = skills_root.clone();
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
                log::warn!("Failed to create skill library watcher: {error}");
                return;
            }
        };

        if let Err(error) = watcher.watch(&thread_skills_root, RecursiveMode::Recursive) {
            log::warn!(
                "Failed to watch skill library root {}: {error}",
                thread_skills_root.display()
            );
            return;
        }

        while let Ok(result) = rx.recv() {
            let event = match result {
                Ok(event) => event,
                Err(error) => {
                    log::warn!("Skill library watcher error: {error}");
                    continue;
                }
            };

            let watched_skills = current_watched_skills();
            for skill_name in
                classify_skill_change_event_for_root(&event, &watched_skills, &thread_skills_root)
            {
                crate::backup_scheduler::schedule_library_change();
                let payload = SkillLibraryChangeEvent { skill_name };
                if let Err(error) = thread_app_handle.emit(SKILL_LIBRARY_CHANGE_EVENT, payload) {
                    log::warn!("Failed to emit skill library change event: {error}");
                }
            }
        }
    });

    Ok(())
}

fn current_watched_skills() -> Vec<WatchedSkill> {
    load_installed_skills(&Vec::new())
        .into_iter()
        .filter_map(|skill| {
            let local_path = PathBuf::from(skill.local_path.trim());
            local_path.exists().then_some(WatchedSkill {
                name: skill.name,
                local_path,
            })
        })
        .collect()
}

fn classify_skill_change_event_for_root(
    event: &Event,
    watched_skills: &[WatchedSkill],
    skills_root: &Path,
) -> Vec<String> {
    classify_skill_change_paths_for_root(&event.paths, watched_skills, skills_root)
}

#[cfg(test)]
fn classify_skill_change_paths(paths: &[PathBuf], watched_skills: &[WatchedSkill]) -> Vec<String> {
    classify_skill_change_paths_internal(paths, watched_skills, None)
}

fn classify_skill_change_paths_for_root(
    paths: &[PathBuf],
    watched_skills: &[WatchedSkill],
    skills_root: &Path,
) -> Vec<String> {
    classify_skill_change_paths_internal(paths, watched_skills, Some(skills_root))
}

fn classify_skill_change_paths_internal(
    paths: &[PathBuf],
    watched_skills: &[WatchedSkill],
    skills_root: Option<&Path>,
) -> Vec<String> {
    let mut matched_skill_names = std::collections::BTreeSet::new();

    for path in paths {
        if is_git_metadata_path(path) {
            continue;
        }

        if let Some(skill_name) = match_skill_name_for_path(path, watched_skills) {
            matched_skill_names.insert(skill_name.to_string());
            continue;
        }
        if let Some(skill_name) = skills_root.and_then(|root| skill_name_under_root(path, root)) {
            matched_skill_names.insert(skill_name);
        }
    }

    matched_skill_names.into_iter().collect()
}

fn skill_name_under_root(path: &Path, skills_root: &Path) -> Option<String> {
    path.strip_prefix(skills_root)
        .ok()?
        .components()
        .next()?
        .as_os_str()
        .to_str()
        .map(ToOwned::to_owned)
}

fn match_skill_name_for_path<'a>(
    path: &Path,
    watched_skills: &'a [WatchedSkill],
) -> Option<&'a str> {
    watched_skills
        .iter()
        .filter(|skill| path.starts_with(&skill.local_path))
        .max_by_key(|skill| skill.local_path.as_os_str().len())
        .map(|skill| skill.name.as_str())
}

fn is_git_metadata_path(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == ".git")
}

#[cfg(test)]
mod tests {
    use super::{classify_skill_change_paths, WatchedSkill};
    use std::path::PathBuf;

    #[test]
    fn classify_skill_change_paths_ignores_git_metadata_paths() {
        let watched_skills = vec![WatchedSkill {
            name: "drawio-diagram".into(),
            local_path: PathBuf::from("/Users/demo/.skilldock/skills/drawio-diagram"),
        }];

        let matched = classify_skill_change_paths(
            &[
                PathBuf::from("/Users/demo/.skilldock/skills/drawio-diagram/.git/index.lock"),
                PathBuf::from("/Users/demo/.skilldock/skills/drawio-diagram/SKILL.md"),
            ],
            &watched_skills,
        );

        assert_eq!(matched, vec!["drawio-diagram"]);
    }

    #[test]
    fn classify_skill_change_paths_prefers_the_longest_matching_skill_path() {
        let watched_skills = vec![
            WatchedSkill {
                name: "repo-root".into(),
                local_path: PathBuf::from("/Users/demo/.skilldock/skills/repo-root"),
            },
            WatchedSkill {
                name: "technical-design-test".into(),
                local_path: PathBuf::from(
                    "/Users/demo/.skilldock/skills/repo-root/skills/technical-design-test",
                ),
            },
        ];

        let matched = classify_skill_change_paths(
            &[PathBuf::from(
                "/Users/demo/.skilldock/skills/repo-root/skills/technical-design-test/SKILL.md",
            )],
            &watched_skills,
        );

        assert_eq!(matched, vec!["technical-design-test"]);
    }

    #[test]
    fn classify_skill_change_paths_falls_back_to_root_entry_name() {
        let matched = super::classify_skill_change_paths_for_root(
            &[PathBuf::from(
                "/Users/demo/.agents/skills/new-skill/SKILL.md",
            )],
            &[],
            PathBuf::from("/Users/demo/.agents/skills").as_path(),
        );

        assert_eq!(matched, vec!["new-skill"]);
    }
}
