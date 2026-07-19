use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::models::{AppSettings, SkillSummary, WorkspacePersistence};
use crate::workspace::{
    display_path_value, home_dir_option, managed_skill_library_root, managed_workspace_root_option,
    normalize_workspace_path, remove_legacy_workspace_file, workspace_file_candidates,
    workspace_file_path,
};

const STATE_FILE_NAME: &str = "state.json";
const SETTINGS_FILE_NAME: &str = "settings.json";
const EMPTY_DESCRIPTION_VALUES: [&str; 4] = ["", "---", "...", "未提供简介"];
const RESERVED_WORKSPACE_DIR_NAMES: [&str; 5] =
    ["state.json", "skills", "repo-cache", "cache", "imports"];

const SKILL_INSTALL_ACTIVATION_APPLY_ALL: &str = "apply-all-tools";
const SKILL_INSTALL_ACTIVATION_DISABLE_ALL: &str = "disable-all-tools";
const MCP_INSTALL_ACTIVATION_APPLY_ALL: &str = "apply-all-tools";
const MCP_INSTALL_ACTIVATION_DISABLE_ALL: &str = "disable-all-tools";
const SKILL_SOURCE_VIEW_STYLE_FLAT: &str = "flat";
const SKILL_SOURCE_VIEW_STYLE_SELECT: &str = "select";
const APP_LANGUAGE_ZH_CN: &str = "zh-CN";
const APP_LANGUAGE_EN: &str = "en";
const APP_LANGUAGE_SOURCE_AUTO: &str = "auto";
const APP_LANGUAGE_SOURCE_USER: &str = "user";
const APP_THEME_LIGHT: &str = "light";
const APP_THEME_DARK: &str = "dark";
const APP_THEME_SYSTEM: &str = "system";

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SettingsPersistence {
    #[serde(default)]
    default_open_tool_id: String,
    #[serde(default)]
    skill_install_activation: String,
    #[serde(default)]
    mcp_install_activation: String,
    #[serde(default)]
    skill_source_view_style: String,
    #[serde(default)]
    language: String,
    #[serde(default)]
    language_source: String,
    #[serde(default)]
    theme: String,
}

pub fn load_installed_skills(default_skills: &[SkillSummary]) -> Vec<SkillSummary> {
    let Some((loaded_from, contents)) =
        workspace_state_candidates()
            .into_iter()
            .find_map(|state_file| {
                fs::read_to_string(&state_file)
                    .ok()
                    .map(|contents| (state_file, contents))
            })
    else {
        return default_skills.to_vec();
    };

    let Ok(persistence) = serde_json::from_str::<WorkspacePersistence>(&contents) else {
        return default_skills.to_vec();
    };

    if persistence.installed_skills.is_empty() {
        return default_skills.to_vec();
    }

    let original_skills = persistence.installed_skills;
    let original_paths = original_skills
        .iter()
        .map(|skill| skill.local_path.clone())
        .collect::<Vec<_>>();
    let original_count = original_skills.len();
    let loaded_from_legacy = loaded_from.to_string_lossy().contains("/.skillm/");
    let filtered_skills = original_skills
        .into_iter()
        .map(normalize_skill_workspace_path)
        .map(repair_skill_local_path)
        .filter(is_skill_local_path_valid)
        .map(hydrate_skill_description)
        .collect::<Vec<_>>();
    if loaded_from_legacy
        || filtered_skills.len() != original_count
        || filtered_skills
            .iter()
            .zip(original_paths.iter())
            .any(|(current, original)| current.local_path != *original)
    {
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

    let normalized_skills = skills
        .iter()
        .cloned()
        .map(normalize_skill_workspace_path)
        .collect::<Vec<_>>();
    let persistence = WorkspacePersistence {
        installed_skills: normalized_skills,
    };
    let payload = serde_json::to_string_pretty(&persistence)
        .map_err(|error| format!("序列化状态失败: {error}"))?;
    atomic_write_workspace_file(&state_file, &payload)
        .map_err(|error| format!("写入状态文件失败: {error}"))?;
    remove_legacy_workspace_file(STATE_FILE_NAME);
    Ok(())
}

pub fn load_app_settings() -> AppSettings {
    let settings_path = settings_file_path()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();

    let persisted = settings_file_candidates()
        .into_iter()
        .find_map(|path| fs::read_to_string(path).ok())
        .and_then(|content| serde_json::from_str::<SettingsPersistence>(&content).ok())
        .unwrap_or_default();

    AppSettings {
        storage_path: settings_path,
        default_open_tool_id: persisted.default_open_tool_id,
        skill_install_activation: normalize_skill_install_activation(
            &persisted.skill_install_activation,
        )
        .to_string(),
        mcp_install_activation: normalize_mcp_install_activation(&persisted.mcp_install_activation)
            .to_string(),
        skill_source_view_style: normalize_skill_source_view_style(
            &persisted.skill_source_view_style,
        )
        .to_string(),
        language: normalize_app_language(&persisted.language).to_string(),
        language_source: normalize_app_language_source(&persisted.language_source).to_string(),
        theme: normalize_app_theme(&persisted.theme).to_string(),
    }
}

pub fn save_app_settings(input: AppSettings) -> Result<AppSettings, String> {
    let settings_file =
        settings_file_path().ok_or_else(|| "无法定位用户目录，不能保存设置".to_string())?;
    let parent_dir = settings_file
        .parent()
        .ok_or_else(|| "设置文件目录无效".to_string())?;

    fs::create_dir_all(parent_dir).map_err(|error| format!("创建设置目录失败: {error}"))?;

    let normalized = AppSettings {
        storage_path: settings_file.to_string_lossy().to_string(),
        default_open_tool_id: input.default_open_tool_id.trim().to_string(),
        skill_install_activation: normalize_skill_install_activation(
            &input.skill_install_activation,
        )
        .to_string(),
        mcp_install_activation: normalize_mcp_install_activation(&input.mcp_install_activation)
            .to_string(),
        skill_source_view_style: normalize_skill_source_view_style(&input.skill_source_view_style)
            .to_string(),
        language: normalize_app_language(&input.language).to_string(),
        language_source: normalize_app_language_source(&input.language_source).to_string(),
        theme: normalize_app_theme(&input.theme).to_string(),
    };
    let persistence = SettingsPersistence {
        default_open_tool_id: normalized.default_open_tool_id.clone(),
        skill_install_activation: normalized.skill_install_activation.clone(),
        mcp_install_activation: normalized.mcp_install_activation.clone(),
        skill_source_view_style: normalized.skill_source_view_style.clone(),
        language: normalized.language.clone(),
        language_source: normalized.language_source.clone(),
        theme: normalized.theme.clone(),
    };
    let payload = serde_json::to_string_pretty(&persistence)
        .map_err(|error| format!("序列化设置失败: {error}"))?;

    fs::write(&settings_file, payload).map_err(|error| format!("写入设置文件失败: {error}"))?;
    remove_legacy_workspace_file(SETTINGS_FILE_NAME);
    Ok(normalized)
}

fn normalize_app_language(value: &str) -> &'static str {
    match value.trim() {
        APP_LANGUAGE_EN => APP_LANGUAGE_EN,
        _ => APP_LANGUAGE_ZH_CN,
    }
}

fn normalize_app_language_source(value: &str) -> &'static str {
    match value.trim() {
        APP_LANGUAGE_SOURCE_USER => APP_LANGUAGE_SOURCE_USER,
        _ => APP_LANGUAGE_SOURCE_AUTO,
    }
}

fn normalize_app_theme(value: &str) -> &'static str {
    match value.trim() {
        APP_THEME_LIGHT => APP_THEME_LIGHT,
        APP_THEME_DARK => APP_THEME_DARK,
        _ => APP_THEME_SYSTEM,
    }
}

pub fn scan_local_skill_candidates(installed_skills: &[SkillSummary]) -> Vec<(String, String)> {
    let Some(home_dir) = home_dir_option() else {
        return Vec::new();
    };

    let Some(managed_skills_root) = managed_skill_library_root().ok() else {
        return Vec::new();
    };
    let known_roots = [
        home_dir.join(".claude/skills"),
        home_dir.join(".codex/skills"),
        home_dir.join(".config/opencode/skills"),
        home_dir.join(".cursor/skills"),
        home_dir.join(".gemini/skills"),
        home_dir.join(".gemini/config/skills"),
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

    let installed_paths = installed_skill_path_keys(installed_skills);
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
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if is_reserved_workspace_name(name) {
                continue;
            }
            if is_reserved_workspace_path(&home_dir, &path) {
                continue;
            }
            if is_skill_name_managed(name, &managed_skills_root, installed_skills) {
                continue;
            }
            if is_synced_managed_skill_link(&path, &managed_skills_root) {
                continue;
            }
            if !path.join("SKILL.md").is_file() {
                continue;
            }

            if installed_paths.contains(&path_key(&path)) {
                continue;
            }

            candidates.push((name.to_string(), root.to_string_lossy().to_string()));
        }
    }

    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    candidates.dedup_by(|left, right| left.0 == right.0 && left.1 == right.1);
    candidates
}

fn installed_skill_path_keys(installed_skills: &[SkillSummary]) -> Vec<String> {
    let mut paths = installed_skills
        .iter()
        .flat_map(installed_skill_path_key_candidates)
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    paths
}

fn installed_skill_path_key_candidates(skill: &SkillSummary) -> Vec<String> {
    let mut paths = Vec::new();
    push_installed_skill_path_key(&mut paths, &skill.local_path);
    push_installed_skill_path_key(&mut paths, &skill.source_url);
    paths
}

fn push_installed_skill_path_key(paths: &mut Vec<String>, value: &str) {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains("://") {
        return;
    }

    let path = PathBuf::from(trimmed);
    paths.push(trimmed.to_string());
    paths.push(path_key(&path));
}

fn is_synced_managed_skill_link(path: &Path, managed_skills_root: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_symlink() {
        return false;
    }

    let Ok(target_path) = path.canonicalize() else {
        return false;
    };
    managed_skills_root
        .canonicalize()
        .is_ok_and(|root| target_path.starts_with(root))
}

fn is_skill_name_managed(
    name: &str,
    managed_skills_root: &Path,
    installed_skills: &[SkillSummary],
) -> bool {
    if installed_skills.iter().any(|skill| {
        skill.name == name && is_managed_skill_path(&skill.local_path, managed_skills_root)
    }) {
        return true;
    }

    [
        managed_skills_root.join(name),
        managed_skills_root.join(name).join("skills").join(name),
    ]
    .iter()
    .any(|path| path.join("SKILL.md").is_file())
}

fn is_managed_skill_path(skill_path: &str, managed_skills_root: &Path) -> bool {
    let path = Path::new(skill_path);
    if !path.join("SKILL.md").is_file() {
        return false;
    }

    let Ok(skill_path) = path.canonicalize() else {
        return false;
    };
    managed_skills_root
        .canonicalize()
        .is_ok_and(|root| skill_path.starts_with(root))
}

fn path_key(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn is_reserved_workspace_path(home_dir: &Path, path: &Path) -> bool {
    let Some(workspace_root) = managed_workspace_root_option() else {
        return false;
    };
    if workspace_root.parent() != Some(home_dir) || path.parent() != Some(workspace_root.as_path())
    {
        return false;
    }

    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(is_reserved_workspace_name)
}

fn is_reserved_workspace_name(name: &str) -> bool {
    RESERVED_WORKSPACE_DIR_NAMES.contains(&name)
}

fn workspace_state_file() -> Option<PathBuf> {
    workspace_file_path(STATE_FILE_NAME).ok()
}

fn workspace_state_candidates() -> Vec<PathBuf> {
    workspace_file_candidates(STATE_FILE_NAME)
}

fn settings_file_path() -> Option<PathBuf> {
    workspace_file_path(SETTINGS_FILE_NAME).ok()
}

fn settings_file_candidates() -> Vec<PathBuf> {
    workspace_file_candidates(SETTINGS_FILE_NAME)
}

pub fn normalize_skill_install_activation(value: &str) -> &'static str {
    match value.trim() {
        SKILL_INSTALL_ACTIVATION_APPLY_ALL => SKILL_INSTALL_ACTIVATION_APPLY_ALL,
        SKILL_INSTALL_ACTIVATION_DISABLE_ALL => SKILL_INSTALL_ACTIVATION_DISABLE_ALL,
        _ => SKILL_INSTALL_ACTIVATION_APPLY_ALL,
    }
}

pub fn normalize_mcp_install_activation(value: &str) -> &'static str {
    match value.trim() {
        MCP_INSTALL_ACTIVATION_APPLY_ALL => MCP_INSTALL_ACTIVATION_APPLY_ALL,
        MCP_INSTALL_ACTIVATION_DISABLE_ALL => MCP_INSTALL_ACTIVATION_DISABLE_ALL,
        _ => MCP_INSTALL_ACTIVATION_APPLY_ALL,
    }
}

pub fn normalize_skill_source_view_style(value: &str) -> &'static str {
    match value.trim() {
        SKILL_SOURCE_VIEW_STYLE_SELECT => SKILL_SOURCE_VIEW_STYLE_SELECT,
        _ => SKILL_SOURCE_VIEW_STYLE_FLAT,
    }
}

fn hydrate_skill_description(mut skill: SkillSummary) -> SkillSummary {
    if skill.local_updated_at.trim().is_empty() {
        skill.local_updated_at = skill.last_synced_at.clone();
    }
    if skill.remote_updated_at.trim().is_empty() {
        skill.remote_updated_at = skill.last_synced_at.clone();
    }

    if !needs_description_refresh(&skill.description) {
        return skill;
    }

    let skill_description_path = Path::new(&skill.local_path).join("SKILL.md");
    if let Some(description) = read_skill_description(&skill_description_path) {
        skill.description = description;
    }

    skill
}

fn normalize_skill_workspace_path(mut skill: SkillSummary) -> SkillSummary {
    skill.local_path = display_path_value(&normalize_workspace_path(&skill.local_path));
    if skill.source_url.contains(r"\\?\") {
        skill.source_url = display_path_value(&skill.source_url);
    }
    skill
}

fn repair_skill_local_path(mut skill: SkillSummary) -> SkillSummary {
    let repaired_path = resolve_skill_local_path(&skill);
    if repaired_path != skill.local_path {
        skill.local_path = repaired_path;
    }
    skill
}

fn is_skill_local_path_valid(skill: &SkillSummary) -> bool {
    if is_reserved_workspace_name(skill.name.trim()) {
        return false;
    }

    let skill_path = Path::new(&skill.local_path);
    if !skill_path.is_dir() {
        return false;
    }
    if skill_path
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(is_reserved_workspace_name)
    {
        return false;
    }
    skill_path.join("SKILL.md").is_file()
}

fn resolve_skill_local_path(skill: &SkillSummary) -> String {
    let current_path = PathBuf::from(&skill.local_path);
    if current_path.join("SKILL.md").is_file() {
        return skill.local_path.clone();
    }

    let nested_path = current_path.join("skills").join(skill.name.trim());
    if nested_path.join("SKILL.md").is_file() {
        return nested_path.to_string_lossy().to_string();
    }

    skill.local_path.clone()
}

fn atomic_write_workspace_file(path: &Path, contents: &str) -> Result<(), String> {
    let parent_dir = path
        .parent()
        .ok_or_else(|| "工作区文件目录无效".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "工作区文件名无效".to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("生成工作区文件时间戳失败: {error}"))?
        .as_nanos();
    let temp_path = parent_dir.join(format!(
        ".{file_name}.tmp-{}-{timestamp}",
        std::process::id()
    ));

    fs::write(&temp_path, contents).map_err(|error| format!("写入临时工作区文件失败: {error}"))?;
    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!("替换工作区文件失败: {error}")
    })?;

    Ok(())
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
                && key.chars().all(|character| {
                    character.is_ascii_alphanumeric() || character == '-' || character == '_'
                })
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
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::models::SkillSummary;
    use crate::models::ToolSyncStatus;
    use crate::models::WorkspacePersistence;
    use crate::workspace::TEST_ENV_LOCK;

    use super::{
        hydrate_skill_description, load_installed_skills, normalize_app_theme,
        normalize_skill_source_view_style, save_installed_skills, scan_local_skill_candidates,
    };

    fn with_temp_home<F>(run: F)
    where
        F: FnOnce(PathBuf),
    {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let original_home = env::var_os("HOME");
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be available")
            .as_nanos();
        let temp_home = env::temp_dir().join(format!(
            "skilldock-state-test-home-{}-{}",
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

    fn test_skill_summary(name: &str, local_path: &PathBuf) -> SkillSummary {
        SkillSummary {
            name: name.into(),
            source_label: "GitHub".into(),
            source_type: "github".into(),
            source_url: format!("https://github.com/demo/{name}"),
            description: name.into(),
            local_path: local_path.to_string_lossy().to_string(),
            branch: "main".into(),
            collab_status: "clean".into(),
            status_text: "ok".into(),
            remote_updated_at: "刚刚".into(),
            local_updated_at: "刚刚".into(),
            last_synced_at: "刚刚".into(),
            last_checked_at: "刚刚".into(),
            synced_tool_count: 0,
            last_editor: "".into(),
            commit_label: "abc123".into(),
            git_linked: false,
            lifecycle_source: "direct".into(),
            owner_plugin_id: String::new(),
            owner_plugin_name: String::new(),
            tools: vec![],
        }
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
                remote_updated_at: "刚刚".into(),
                local_updated_at: "刚刚".into(),
                last_synced_at: "刚刚".into(),
                last_checked_at: "刚刚".into(),
                synced_tool_count: 1,
                last_editor: "skills.sh".into(),
                commit_label: "v1.0.0".into(),
                git_linked: true,
                lifecycle_source: "direct".into(),
                owner_plugin_id: String::new(),
                owner_plugin_name: String::new(),
                tools: vec![ToolSyncStatus {
                    name: "Codex".into(),
                    status_label: "已同步".into(),
                }],
            }];

            let result = save_installed_skills(&skills);
            assert!(result.is_ok());
            assert!(temp_home.join(".skilldock/state.json").exists());
        });
    }

    #[test]
    fn normalizes_skill_source_view_style_with_flat_fallback() {
        assert_eq!(normalize_skill_source_view_style("flat"), "flat");
        assert_eq!(normalize_skill_source_view_style("band"), "flat");
        assert_eq!(normalize_skill_source_view_style("select"), "select");
        assert_eq!(normalize_skill_source_view_style("legacy"), "flat");
    }

    #[test]
    fn normalizes_app_theme_with_system_fallback() {
        assert_eq!(normalize_app_theme("light"), "light");
        assert_eq!(normalize_app_theme("dark"), "dark");
        assert_eq!(normalize_app_theme("system"), "system");
        assert_eq!(normalize_app_theme(""), "system");
    }

    #[test]
    fn hydrates_description_from_local_skill_file_when_state_is_placeholder() {
        let temp_dir = env::temp_dir().join(format!("skilldock-state-test-{}", std::process::id()));
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
            remote_updated_at: "刚刚".into(),
            local_updated_at: "刚刚".into(),
            last_synced_at: "刚刚".into(),
            last_checked_at: "刚刚".into(),
            synced_tool_count: 1,
            last_editor: "skills.sh".into(),
            commit_label: "v1.0.0".into(),
            git_linked: false,
            lifecycle_source: "direct".into(),
            owner_plugin_id: String::new(),
            owner_plugin_name: String::new(),
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
            let skills_root = temp_home.join(".skilldock/skills");
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
                        remote_updated_at: "刚刚".into(),
                        local_updated_at: "刚刚".into(),
                        last_synced_at: "刚刚".into(),
                        last_checked_at: "刚刚".into(),
                        synced_tool_count: 0,
                        last_editor: "".into(),
                        commit_label: "abc123".into(),
                        git_linked: false,
                        lifecycle_source: "direct".into(),
                        owner_plugin_id: String::new(),
                        owner_plugin_name: String::new(),
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
                        remote_updated_at: "刚刚".into(),
                        local_updated_at: "刚刚".into(),
                        last_synced_at: "刚刚".into(),
                        last_checked_at: "刚刚".into(),
                        synced_tool_count: 0,
                        last_editor: "".into(),
                        commit_label: "def456".into(),
                        git_linked: false,
                        lifecycle_source: "direct".into(),
                        owner_plugin_id: String::new(),
                        owner_plugin_name: String::new(),
                        tools: vec![],
                    },
                ],
            };
            let legacy_state_file = temp_home.join(".skillm/state.json");
            let state_file = temp_home.join(".skilldock/state.json");
            fs::create_dir_all(legacy_state_file.parent().expect("state parent exists"))
                .expect("create state parent");
            fs::write(
                &legacy_state_file,
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
    fn repairs_nested_skill_paths_and_rewrites_state_file() {
        with_temp_home(|temp_home| {
            let repo_root = temp_home.join(".skilldock/skills/example-migration");
            let nested_skill_dir = repo_root.join("skills/example-migration");
            fs::create_dir_all(&nested_skill_dir).expect("create nested skill dir");
            fs::write(
                nested_skill_dir.join("SKILL.md"),
                "---\nname: example-migration\ndescription: repaired path\n---\n",
            )
            .expect("write nested SKILL.md");

            let persisted = WorkspacePersistence {
                installed_skills: vec![SkillSummary {
                    name: "example-migration".into(),
                    source_label: "GitHub".into(),
                    source_type: "github".into(),
                    source_url: "https://github.com/demo/example-migration".into(),
                    description: "---".into(),
                    local_path: repo_root.to_string_lossy().to_string(),
                    branch: "main".into(),
                    collab_status: "clean".into(),
                    status_text: "ok".into(),
                    remote_updated_at: "刚刚".into(),
                    local_updated_at: "刚刚".into(),
                    last_synced_at: "刚刚".into(),
                    last_checked_at: "刚刚".into(),
                    synced_tool_count: 0,
                    last_editor: "".into(),
                    commit_label: "abc123".into(),
                    git_linked: false,
                    lifecycle_source: "direct".into(),
                    owner_plugin_id: String::new(),
                    owner_plugin_name: String::new(),
                    tools: vec![],
                }],
            };
            let state_file = temp_home.join(".skilldock/state.json");
            fs::create_dir_all(state_file.parent().expect("state parent exists"))
                .expect("create state parent");
            fs::write(
                &state_file,
                serde_json::to_string_pretty(&persisted).expect("serialize persistence"),
            )
            .expect("write state file");

            let loaded = load_installed_skills(&[]);
            assert_eq!(loaded.len(), 1);
            assert_eq!(
                loaded[0].local_path,
                nested_skill_dir.to_string_lossy().to_string()
            );
            assert_eq!(loaded[0].description, "repaired path");

            let rewritten: WorkspacePersistence = serde_json::from_str(
                &fs::read_to_string(&state_file).expect("read rewritten state file"),
            )
            .expect("deserialize rewritten state");
            assert_eq!(rewritten.installed_skills.len(), 1);
            assert_eq!(
                rewritten.installed_skills[0].local_path,
                nested_skill_dir.to_string_lossy().to_string()
            );
        });
    }

    #[test]
    fn drops_reserved_workspace_skill_entries_and_rewrites_state_file() {
        with_temp_home(|temp_home| {
            let reserved_skill_dir = temp_home.join(".skilldock/skills/skills");
            fs::create_dir_all(&reserved_skill_dir).expect("create reserved skill dir");
            fs::write(reserved_skill_dir.join("SKILL.md"), "# skills")
                .expect("write SKILL.md for reserved dir");

            let valid_skill_dir = temp_home.join(".skilldock/skills/kept-skill");
            fs::create_dir_all(&valid_skill_dir).expect("create valid skill dir");
            fs::write(valid_skill_dir.join("SKILL.md"), "# kept-skill")
                .expect("write SKILL.md for valid dir");

            let persisted = WorkspacePersistence {
                installed_skills: vec![
                    SkillSummary {
                        name: "skills".into(),
                        source_label: "GitHub".into(),
                        source_type: "github".into(),
                        source_url: "https://github.com/demo/skills".into(),
                        description: "container".into(),
                        local_path: reserved_skill_dir.to_string_lossy().to_string(),
                        branch: "main".into(),
                        collab_status: "clean".into(),
                        status_text: "ok".into(),
                        remote_updated_at: "刚刚".into(),
                        local_updated_at: "刚刚".into(),
                        last_synced_at: "刚刚".into(),
                        last_checked_at: "刚刚".into(),
                        synced_tool_count: 0,
                        last_editor: "".into(),
                        commit_label: "abc123".into(),
                        git_linked: false,
                        lifecycle_source: "direct".into(),
                        owner_plugin_id: String::new(),
                        owner_plugin_name: String::new(),
                        tools: vec![],
                    },
                    SkillSummary {
                        name: "kept-skill".into(),
                        source_label: "GitHub".into(),
                        source_type: "github".into(),
                        source_url: "https://github.com/demo/kept-skill".into(),
                        description: "kept".into(),
                        local_path: valid_skill_dir.to_string_lossy().to_string(),
                        branch: "main".into(),
                        collab_status: "clean".into(),
                        status_text: "ok".into(),
                        remote_updated_at: "刚刚".into(),
                        local_updated_at: "刚刚".into(),
                        last_synced_at: "刚刚".into(),
                        last_checked_at: "刚刚".into(),
                        synced_tool_count: 0,
                        last_editor: "".into(),
                        commit_label: "def456".into(),
                        git_linked: false,
                        lifecycle_source: "direct".into(),
                        owner_plugin_id: String::new(),
                        owner_plugin_name: String::new(),
                        tools: vec![],
                    },
                ],
            };
            let legacy_state_file = temp_home.join(".skillm/state.json");
            let state_file = temp_home.join(".skilldock/state.json");
            fs::create_dir_all(legacy_state_file.parent().expect("state parent exists"))
                .expect("create state parent");
            fs::write(
                &legacy_state_file,
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

    #[test]
    fn local_candidate_scan_skips_managed_library_skills_without_state_entry() {
        with_temp_home(|temp_home| {
            let managed_skill_dir = temp_home.join(".skilldock/skills/example-migration");
            let codex_skills_root = temp_home.join(".codex/skills");
            fs::create_dir_all(&managed_skill_dir).expect("create managed skill dir");
            fs::create_dir_all(&codex_skills_root).expect("create codex skills dir");
            fs::write(managed_skill_dir.join("SKILL.md"), "# example-migration")
                .expect("write managed skill file");
            fs::write(codex_skills_root.join("example-migration"), "# not a directory")
                .expect("write non-directory entry");

            let candidates = scan_local_skill_candidates(&[]);

            assert!(candidates.is_empty());
        });
    }

    #[test]
    fn local_candidate_scan_skips_software_skill_when_skilldock_has_same_skill() {
        with_temp_home(|temp_home| {
            let managed_skill_dir = temp_home.join(".skilldock/skills/example-migration");
            let external_skill_dir = temp_home.join(".codex/skills/example-migration");
            fs::create_dir_all(&managed_skill_dir).expect("create managed skill dir");
            fs::create_dir_all(&external_skill_dir).expect("create external skill dir");
            fs::write(
                managed_skill_dir.join("SKILL.md"),
                "# managed example-migration",
            )
            .expect("write managed skill file");
            fs::write(
                external_skill_dir.join("SKILL.md"),
                "# external example-migration",
            )
            .expect("write external skill file");

            let candidates = scan_local_skill_candidates(&[]);

            assert!(candidates.is_empty());
        });
    }

    #[cfg(unix)]
    #[test]
    fn local_candidate_scan_keeps_symlink_to_non_skilldock_source() {
        with_temp_home(|temp_home| {
            let legacy_skill_dir = temp_home.join(".skills-managers/skills/example-migration");
            let codex_skills_root = temp_home.join(".codex/skills");
            let codex_skill_link = codex_skills_root.join("example-migration");
            fs::create_dir_all(&legacy_skill_dir).expect("create legacy skill dir");
            fs::create_dir_all(&codex_skills_root).expect("create codex skills dir");
            fs::write(legacy_skill_dir.join("SKILL.md"), "# example-migration")
                .expect("write legacy skill file");
            std::os::unix::fs::symlink(&legacy_skill_dir, &codex_skill_link)
                .expect("create legacy skill symlink");

            let candidates = scan_local_skill_candidates(&[]);

            assert_eq!(
                candidates,
                vec![(
                    "example-migration".to_string(),
                    codex_skills_root.to_string_lossy().to_string()
                )]
            );
        });
    }

    #[cfg(unix)]
    #[test]
    fn local_candidate_scan_skips_external_symlink_when_skilldock_has_same_skill() {
        with_temp_home(|temp_home| {
            let managed_skill_dir = temp_home.join(".skilldock/skills/example-migration");
            let legacy_skill_dir = temp_home.join(".skills-managers/skills/example-migration");
            let codex_skills_root = temp_home.join(".codex/skills");
            let codex_skill_link = codex_skills_root.join("example-migration");
            fs::create_dir_all(&managed_skill_dir).expect("create managed skill dir");
            fs::create_dir_all(&legacy_skill_dir).expect("create legacy skill dir");
            fs::create_dir_all(&codex_skills_root).expect("create codex skills dir");
            fs::write(
                managed_skill_dir.join("SKILL.md"),
                "# managed example-migration",
            )
            .expect("write managed skill file");
            fs::write(legacy_skill_dir.join("SKILL.md"), "# example-migration")
                .expect("write legacy skill file");
            std::os::unix::fs::symlink(&legacy_skill_dir, &codex_skill_link)
                .expect("create legacy skill symlink");

            let candidates = scan_local_skill_candidates(&[]);

            assert!(candidates.is_empty());
        });
    }

    #[cfg(unix)]
    #[test]
    fn local_candidate_scan_skips_external_symlink_when_skilldock_has_nested_same_skill() {
        with_temp_home(|temp_home| {
            let managed_skill_dir =
                temp_home.join(".skilldock/skills/example-migration/skills/example-migration");
            let legacy_skill_dir = temp_home.join(".skills-managers/skills/example-migration");
            let codex_skills_root = temp_home.join(".codex/skills");
            let codex_skill_link = codex_skills_root.join("example-migration");
            fs::create_dir_all(&managed_skill_dir).expect("create nested managed skill dir");
            fs::create_dir_all(&legacy_skill_dir).expect("create legacy skill dir");
            fs::create_dir_all(&codex_skills_root).expect("create codex skills dir");
            fs::write(
                managed_skill_dir.join("SKILL.md"),
                "# managed example-migration",
            )
            .expect("write nested managed skill file");
            fs::write(legacy_skill_dir.join("SKILL.md"), "# example-migration")
                .expect("write legacy skill file");
            std::os::unix::fs::symlink(&legacy_skill_dir, &codex_skill_link)
                .expect("create legacy skill symlink");

            let installed_skills = vec![test_skill_summary("example-migration", &managed_skill_dir)];
            let candidates = scan_local_skill_candidates(&installed_skills);

            assert!(candidates.is_empty());
        });
    }

    #[test]
    fn local_candidate_scan_skips_imported_source_path_when_installed_name_differs() {
        with_temp_home(|temp_home| {
            let managed_skill_dir = temp_home.join(".skilldock/skills/示例PRD编写");
            let source_skill_dir = temp_home.join(".claude/skills/example-prd-writing");
            fs::create_dir_all(&managed_skill_dir).expect("create managed skill dir");
            fs::create_dir_all(&source_skill_dir).expect("create source skill dir");
            fs::write(managed_skill_dir.join("SKILL.md"), "# 示例PRD编写")
                .expect("write managed skill file");
            fs::write(source_skill_dir.join("SKILL.md"), "# 示例PRD编写")
                .expect("write source skill file");

            let mut installed_skill = test_skill_summary("示例PRD编写", &managed_skill_dir);
            installed_skill.source_type = "local".into();
            installed_skill.source_url = source_skill_dir.to_string_lossy().to_string();
            let candidates = scan_local_skill_candidates(&[installed_skill]);

            assert!(candidates.is_empty());
        });
    }

    #[cfg(unix)]
    #[test]
    fn local_candidate_scan_skips_symlinked_managed_skills() {
        with_temp_home(|temp_home| {
            let managed_skill_dir = temp_home.join(".skilldock/skills/managed-skill");
            let cursor_skills_root = temp_home.join(".cursor/skills");
            let cursor_skill_link = cursor_skills_root.join("managed-skill");
            fs::create_dir_all(&managed_skill_dir).expect("create managed skill dir");
            fs::create_dir_all(&cursor_skills_root).expect("create cursor skills dir");
            fs::write(managed_skill_dir.join("SKILL.md"), "# managed-skill")
                .expect("write managed skill file");
            std::os::unix::fs::symlink(&managed_skill_dir, &cursor_skill_link)
                .expect("create managed skill symlink");

            let installed_skills = vec![SkillSummary {
                name: "managed-skill".into(),
                source_label: "GitHub".into(),
                source_type: "github".into(),
                source_url: "https://github.com/demo/managed-skill".into(),
                description: "managed".into(),
                local_path: managed_skill_dir.to_string_lossy().to_string(),
                branch: "main".into(),
                collab_status: "clean".into(),
                status_text: "ok".into(),
                remote_updated_at: "刚刚".into(),
                local_updated_at: "刚刚".into(),
                last_synced_at: "刚刚".into(),
                last_checked_at: "刚刚".into(),
                synced_tool_count: 1,
                last_editor: "".into(),
                commit_label: "abc123".into(),
                git_linked: false,
                lifecycle_source: "direct".into(),
                owner_plugin_id: String::new(),
                owner_plugin_name: String::new(),
                tools: vec![],
            }];

            let candidates = scan_local_skill_candidates(&installed_skills);

            assert!(candidates.is_empty());
        });
    }

    #[test]
    fn local_candidate_scan_ignores_agents_directory_and_keeps_legacy_compatibility() {
        with_temp_home(|temp_home| {
            let agents_skill_dir = temp_home.join(".agents/skills/goose-modern");
            let legacy_skill_dir = temp_home.join(".config/goose/skills/goose-legacy");
            fs::create_dir_all(&agents_skill_dir).expect("create modern goose skill dir");
            fs::create_dir_all(&legacy_skill_dir).expect("create legacy goose skill dir");
            fs::write(agents_skill_dir.join("SKILL.md"), "# goose-modern")
                .expect("write modern goose skill file");
            fs::write(legacy_skill_dir.join("SKILL.md"), "# goose-legacy")
                .expect("write legacy goose skill file");

            let mut candidates = scan_local_skill_candidates(&[]);
            candidates.sort();

            assert_eq!(
                candidates,
                vec![(
                    "goose-legacy".to_string(),
                    temp_home
                        .join(".config/goose/skills")
                        .to_string_lossy()
                        .to_string()
                )]
            );
        });
    }
}
