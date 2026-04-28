use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use crate::models::{SkillSummary, WorkspacePersistence};

const STATE_DIR_NAME: &str = ".skillm";
const STATE_FILE_NAME: &str = "state.json";
const EMPTY_DESCRIPTION_VALUES: [&str; 4] = ["", "---", "...", "未提供简介"];

pub fn load_installed_skills(default_skills: &[SkillSummary]) -> Vec<SkillSummary> {
    let contents = workspace_state_candidates()
        .into_iter()
        .find_map(|state_file| fs::read_to_string(state_file).ok());
    let Some(contents) = contents else {
        return default_skills.to_vec();
    };

    let Ok(persistence) = serde_json::from_str::<WorkspacePersistence>(&contents) else {
        return default_skills.to_vec();
    };

    if persistence.installed_skills.is_empty() {
        return default_skills.to_vec();
    }

    let original_skills = persistence.installed_skills;
    let original_count = original_skills.len();
    let filtered_skills = original_skills
        .into_iter()
        .filter(is_skill_local_path_valid)
        .map(hydrate_skill_description)
        .collect::<Vec<_>>();
    if filtered_skills.len() != original_count {
        let _ = save_installed_skills(&filtered_skills);
    }
    filtered_skills
}

pub fn save_installed_skills(skills: &[SkillSummary]) -> Result<(), String> {
    let state_file =
        workspace_state_file().ok_or_else(|| "无法定位用户目录，不能保存状态".to_string())?;
    let parent_dir = state_file
        .parent()
        .ok_or_else(|| "状态文件目录无效".to_string())?;

    fs::create_dir_all(parent_dir).map_err(|error| format!("创建状态目录失败: {error}"))?;

    let persistence = WorkspacePersistence {
        installed_skills: skills.to_vec(),
    };
    let payload = serde_json::to_string_pretty(&persistence)
        .map_err(|error| format!("序列化状态失败: {error}"))?;

    fs::write(state_file, payload).map_err(|error| format!("写入状态文件失败: {error}"))
}

pub fn scan_local_skill_candidates(installed_skills: &[SkillSummary]) -> Vec<(String, String)> {
    let Some(home_dir) = home_dir() else {
        return Vec::new();
    };

    let known_roots = [
        home_dir.join(".skillm/skills"),
        home_dir.join(".skills-manager/skills"),
        home_dir.join(".claude/skills"),
        home_dir.join(".codex/skills"),
        home_dir.join(".config/opencode/skills"),
        home_dir.join(".cursor/skills"),
        home_dir.join(".gemini/skills"),
        home_dir.join(".gemini/antigravity/skills"),
        home_dir.join(".codeium/windsurf/skills"),
        home_dir.join(".continue/skills"),
        home_dir.join(".iflow/skills"),
        home_dir.join(".codebuddy/skills"),
        home_dir.join(".trae/skills"),
        home_dir.join(".factory/skills"),
        home_dir.join(".cline/skills"),
        home_dir.join(".commandcode/skills"),
        home_dir.join(".config/crush/skills"),
        home_dir.join(".kiro/skills"),
        home_dir.join(".qoder/skills"),
        home_dir.join(".qwen/skills"),
        home_dir.join(".roo/skills"),
        home_dir.join(".config/goose/skills"),
        home_dir.join(".openclaw/skills"),
        home_dir.join(".augment/skills"),
        home_dir.join(".kilocode/skills"),
        home_dir.join(".zencoder/skills"),
        home_dir.join(".trae-cn/skills"),
        home_dir.join(".hermes/skills"),
        home_dir.join(".copilot/skills"),
    ];

    let installed_paths: Vec<&str> = installed_skills
        .iter()
        .map(|skill| skill.local_path.as_str())
        .collect();
    let mut candidates = Vec::new();

    for root in known_roots {
        if !root.exists() {
            continue;
        }

        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if is_reserved_skillm_path(&home_dir, &path) {
                continue;
            }
            if !path.join("SKILL.md").is_file() {
                continue;
            }

            let local_path = path.to_string_lossy().to_string();
            if installed_paths
                .iter()
                .any(|installed| *installed == local_path)
            {
                continue;
            }

            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };

            candidates.push((name.to_string(), root.to_string_lossy().to_string()));
        }
    }

    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    candidates.dedup_by(|left, right| left.0 == right.0 && left.1 == right.1);
    candidates
}

fn is_reserved_skillm_path(home_dir: &Path, path: &Path) -> bool {
    let skillm_root = home_dir.join(".skillm");
    if path.parent() != Some(skillm_root.as_path()) {
        return false;
    }

    matches!(
        path.file_name().and_then(|value| value.to_str()),
        Some("repo-cache" | "cache" | "imports")
    )
}

fn workspace_state_file() -> Option<PathBuf> {
    let home_dir = home_dir()?;
    Some(home_dir.join(STATE_DIR_NAME).join(STATE_FILE_NAME))
}

fn workspace_state_candidates() -> Vec<PathBuf> {
    let Some(home_dir) = home_dir() else {
        return Vec::new();
    };

    vec![home_dir.join(STATE_DIR_NAME).join(STATE_FILE_NAME)]
}

fn home_dir() -> Option<PathBuf> {
    env::var("HOME").ok().map(PathBuf::from)
}

fn hydrate_skill_description(mut skill: SkillSummary) -> SkillSummary {
    if !needs_description_refresh(&skill.description) {
        return skill;
    }

    let skill_description_path = Path::new(&skill.local_path).join("SKILL.md");
    if let Some(description) = read_skill_description(&skill_description_path) {
        skill.description = description;
    }

    skill
}

fn is_skill_local_path_valid(skill: &SkillSummary) -> bool {
    let skill_path = Path::new(&skill.local_path);
    if !skill_path.is_dir() {
        return false;
    }
    skill_path.join("SKILL.md").is_file()
}

fn needs_description_refresh(description: &str) -> bool {
    let trimmed = description.trim();
    EMPTY_DESCRIPTION_VALUES.contains(&trimmed)
        || (trimmed.starts_with("来自 ") && trimmed.ends_with(" 的公开 skill。"))
}

fn read_skill_description(skill_file: &Path) -> Option<String> {
    let content = fs::read_to_string(skill_file).ok()?;
    let mut lines = content.lines().peekable();
    if lines.peek().is_some_and(|line| line.trim() == "---") {
        lines.next();
        let mut frontmatter_description = None;
        for line in lines.by_ref() {
            let trimmed = line.trim();
            if trimmed == "---" {
                break;
            }
            if let Some(value) = trimmed.strip_prefix("description:") {
                let normalized = value.trim().trim_matches('"').trim_matches('\'');
                if !needs_description_refresh(normalized) {
                    frontmatter_description = Some(normalized.to_string());
                }
            }
        }
        if let Some(description) = frontmatter_description {
            return Some(description);
        }
    }

    for line in lines {
        let trimmed = line.trim();
        let looks_like_frontmatter_field = trimmed.split_once(':').is_some_and(|(key, _)| {
            !key.is_empty()
                && key
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
        });
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || trimmed == "---"
            || trimmed == "..."
            || looks_like_frontmatter_field
        {
            continue;
        }
        return Some(trimmed.to_string());
    }

    None
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::models::SkillSummary;
    use crate::models::ToolSyncStatus;
    use crate::models::WorkspacePersistence;

    use super::{
        hydrate_skill_description, load_installed_skills, save_installed_skills,
        scan_local_skill_candidates,
    };

    static HOME_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_home<F>(run: F)
    where
        F: FnOnce(PathBuf),
    {
        let _guard = HOME_ENV_LOCK.lock().expect("lock HOME env for test");
        let original_home = env::var_os("HOME");
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be available")
            .as_nanos();
        let temp_home = env::temp_dir().join(format!(
            "skillm-state-test-home-{}-{}",
            std::process::id(),
            timestamp
        ));
        fs::create_dir_all(&temp_home).expect("should create temp HOME");
        // SAFETY: tests serialize HOME mutation with a process-wide mutex.
        unsafe {
            env::set_var("HOME", &temp_home);
        }

        run(temp_home.clone());

        if let Some(home) = original_home {
            // SAFETY: tests serialize HOME mutation with a process-wide mutex.
            unsafe {
                env::set_var("HOME", home);
            }
        } else {
            // SAFETY: tests serialize HOME mutation with a process-wide mutex.
            unsafe {
                env::remove_var("HOME");
            }
        }
        let _ = fs::remove_dir_all(temp_home);
    }

    #[test]
    fn serializes_installed_skills_without_error() {
        with_temp_home(|temp_home| {
            let skills = vec![SkillSummary {
                name: "sample-skill".into(),
                source_label: "GitHub".into(),
                source_type: "github".into(),
                source_url: "https://github.com/demo/sample-skill".into(),
                description: "sample".into(),
                local_path: "/tmp/sample-skill".into(),
                branch: "stable".into(),
                collab_status: "clean".into(),
                status_text: "ok".into(),
                last_synced_at: "刚刚".into(),
                last_checked_at: "刚刚".into(),
                synced_tool_count: 1,
                last_editor: "skills.sh".into(),
                commit_label: "v1.0.0".into(),
                git_linked: true,
                tools: vec![ToolSyncStatus {
                    name: "Codex".into(),
                    status_label: "已同步".into(),
                }],
            }];

            let result = save_installed_skills(&skills);
            assert!(result.is_ok());
            assert!(temp_home.join(".skillm/state.json").exists());
        });
    }

    #[test]
    fn hydrates_description_from_local_skill_file_when_state_is_placeholder() {
        let temp_dir = env::temp_dir().join(format!("skillm-state-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).expect("should create temp skill dir");
        fs::write(
            temp_dir.join("SKILL.md"),
            "---\nname: lark-vc\ndescription: \"飞书视频会议简介\"\n---\n",
        )
        .expect("should write skill file");

        let skill = SkillSummary {
            name: "lark-vc".into(),
            source_label: "GitHub".into(),
            source_type: "github".into(),
            source_url: "https://github.com/larksuite/cli/tree/main/skills/lark-vc".into(),
            description: "---".into(),
            local_path: temp_dir.to_string_lossy().to_string(),
            branch: "main".into(),
            collab_status: "clean".into(),
            status_text: "ok".into(),
            last_synced_at: "刚刚".into(),
            last_checked_at: "刚刚".into(),
            synced_tool_count: 1,
            last_editor: "skills.sh".into(),
            commit_label: "v1.0.0".into(),
            git_linked: false,
            tools: vec![ToolSyncStatus {
                name: "Codex".into(),
                status_label: "已同步".into(),
            }],
        };

        let hydrated = hydrate_skill_description(skill);
        assert_eq!(hydrated.description, "飞书视频会议简介");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn drops_missing_skills_and_rewrites_state_file() {
        with_temp_home(|temp_home| {
            let skills_root = temp_home.join(".skillm/skills");
            let existing_skill_dir = skills_root.join("kept-skill");
            fs::create_dir_all(&existing_skill_dir).expect("create existing skill dir");
            fs::write(existing_skill_dir.join("SKILL.md"), "# kept-skill")
                .expect("write SKILL.md for existing skill");

            let missing_skill_dir = skills_root.join("missing-skill");
            let persisted = WorkspacePersistence {
                installed_skills: vec![
                    SkillSummary {
                        name: "missing-skill".into(),
                        source_label: "GitHub".into(),
                        source_type: "github".into(),
                        source_url: "https://github.com/demo/missing-skill".into(),
                        description: "missing".into(),
                        local_path: missing_skill_dir.to_string_lossy().to_string(),
                        branch: "main".into(),
                        collab_status: "clean".into(),
                        status_text: "ok".into(),
                        last_synced_at: "刚刚".into(),
                        last_checked_at: "刚刚".into(),
                        synced_tool_count: 0,
                        last_editor: "".into(),
                        commit_label: "abc123".into(),
                        git_linked: false,
                        tools: vec![],
                    },
                    SkillSummary {
                        name: "kept-skill".into(),
                        source_label: "GitHub".into(),
                        source_type: "github".into(),
                        source_url: "https://github.com/demo/kept-skill".into(),
                        description: "kept".into(),
                        local_path: existing_skill_dir.to_string_lossy().to_string(),
                        branch: "main".into(),
                        collab_status: "clean".into(),
                        status_text: "ok".into(),
                        last_synced_at: "刚刚".into(),
                        last_checked_at: "刚刚".into(),
                        synced_tool_count: 0,
                        last_editor: "".into(),
                        commit_label: "def456".into(),
                        git_linked: false,
                        tools: vec![],
                    },
                ],
            };
            let state_file = temp_home.join(".skillm/state.json");
            fs::create_dir_all(state_file.parent().expect("state parent exists"))
                .expect("create state parent");
            fs::write(
                &state_file,
                serde_json::to_string_pretty(&persisted).expect("serialize persistence"),
            )
            .expect("write state file");

            let loaded = load_installed_skills(&[]);
            assert_eq!(loaded.len(), 1);
            assert_eq!(loaded[0].name, "kept-skill");

            let rewritten: WorkspacePersistence = serde_json::from_str(
                &fs::read_to_string(state_file).expect("read rewritten state file"),
            )
            .expect("deserialize rewritten state");
            assert_eq!(rewritten.installed_skills.len(), 1);
            assert_eq!(rewritten.installed_skills[0].name, "kept-skill");
        });
    }

    #[test]
    fn local_candidate_scan_only_returns_skill_directories() {
        with_temp_home(|temp_home| {
            let codex_skills_root = temp_home.join(".codex/skills");
            let valid_skill_dir = codex_skills_root.join("real-skill");
            let cache_link_dir = codex_skills_root.join("cache");
            fs::create_dir_all(&valid_skill_dir).expect("create valid skill dir");
            fs::create_dir_all(&cache_link_dir).expect("create cache-like dir");
            fs::write(valid_skill_dir.join("SKILL.md"), "# real-skill").expect("write skill file");

            let candidates = scan_local_skill_candidates(&[]);

            assert_eq!(
                candidates,
                vec![(
                    "real-skill".to_string(),
                    codex_skills_root.to_string_lossy().to_string()
                )]
            );
        });
    }
}
