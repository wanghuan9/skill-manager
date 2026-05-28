use std::path::{Path, PathBuf};
use std::sync::{mpsc, OnceLock};
use std::thread;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::state::load_installed_skills;
use crate::workspace::managed_skill_library_root;

static SKILL_LIBRARY_WATCHER_STARTED: OnceLock<()> = OnceLock::new();
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
    if SKILL_LIBRARY_WATCHER_STARTED.get().is_some() {
        return Ok(());
    }

    let skills_root = managed_skill_library_root()?;
    if !skills_root.exists() {
        return Ok(());
    }

    let watched_skills = load_installed_skills(&Vec::new())
        .into_iter()
        .filter_map(|skill| {
            let local_path = PathBuf::from(skill.local_path.trim());
            if !local_path.exists() {
                return None;
            }

            Some(WatchedSkill {
                name: skill.name,
                local_path,
            })
        })
        .collect::<Vec<_>>();
    if watched_skills.is_empty() {
        return Ok(());
    }

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

            for skill_name in classify_skill_change_event(&event, &watched_skills) {
                let payload = SkillLibraryChangeEvent { skill_name };
                if let Err(error) = thread_app_handle.emit(SKILL_LIBRARY_CHANGE_EVENT, payload) {
                    log::warn!("Failed to emit skill library change event: {error}");
                }
            }
        }
    });

    let _ = SKILL_LIBRARY_WATCHER_STARTED.set(());
    Ok(())
}

fn classify_skill_change_event(event: &Event, watched_skills: &[WatchedSkill]) -> Vec<String> {
    classify_skill_change_paths(&event.paths, watched_skills)
}

fn classify_skill_change_paths(paths: &[PathBuf], watched_skills: &[WatchedSkill]) -> Vec<String> {
    let mut matched_skill_names = std::collections::BTreeSet::new();

    for path in paths {
        if is_git_metadata_path(path) {
            continue;
        }

        if let Some(skill_name) = match_skill_name_for_path(path, watched_skills) {
            matched_skill_names.insert(skill_name.to_string());
        }
    }

    matched_skill_names.into_iter().collect()
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
}
