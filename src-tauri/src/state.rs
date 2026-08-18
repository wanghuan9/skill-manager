use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::models::{
    AppSettings, GithubBackupSettings, GithubConnectionMetadata, SkillInstanceMetadata,
    SkillSummary, WorkspacePersistence,
};
use crate::workspace::{
    display_path_value, home_dir_option, managed_skill_library_root, managed_workspace_root_option,
    normalize_skill_library_provider, normalize_workspace_path, remove_legacy_workspace_file,
    workspace_file_candidates, workspace_file_path, SKILL_LIBRARY_PROVIDER_AGENT_SKILLS,
    SKILL_LIBRARY_PROVIDER_SKILLDOCK,
};

const STATE_FILE_NAME: &str = "state.json";
const SKILL_TAGS_FILE_NAME: &str = "skill-tags.json";
const SETTINGS_FILE_NAME: &str = "settings.json";
const EMPTY_DESCRIPTION_VALUES: [&str; 4] = ["", "---", "...", "未提供简介"];
const RESERVED_WORKSPACE_DIR_NAMES: [&str; 12] = [
    "state.json",
    "config",
    "data",
    "credentials",
    "skills",
    "repositories",
    "repo-cache",
    "cache",
    "plugins",
    "imports",
    "backup",
    "logs",
];

const SKILL_INSTALL_ACTIVATION_APPLY_ALL: &str = "apply-all-tools";
const SKILL_INSTALL_ACTIVATION_DISABLE_ALL: &str = "disable-all-tools";
const MCP_INSTALL_ACTIVATION_APPLY_ALL: &str = "apply-all-tools";
const MCP_INSTALL_ACTIVATION_DISABLE_ALL: &str = "disable-all-tools";
const SKILL_SOURCE_VIEW_STYLE_SELECT: &str = "select";
const SKILL_SOURCE_VIEW_STYLE_FLAT: &str = "flat";
const SKILL_TAG_FILTER_LAYOUT_INLINE: &str = "inline";
const SKILL_TAG_FILTER_LAYOUT_POPOVER: &str = "popover";
const APP_LANGUAGE_ZH_CN: &str = "zh-CN";
const APP_LANGUAGE_EN: &str = "en";
const APP_LANGUAGE_SOURCE_AUTO: &str = "auto";
const APP_LANGUAGE_SOURCE_USER: &str = "user";
const APP_THEME_LIGHT: &str = "light";
const APP_THEME_DARK: &str = "dark";
const APP_THEME_SYSTEM: &str = "system";
const PORTABLE_PREFERENCES_SCHEMA_VERSION: u32 = 1;
static WORKSPACE_STATE_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SettingsPersistence {
    #[serde(default)]
    skill_library_provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_skills_compatibility_enabled: Option<bool>,
    #[serde(default)]
    default_open_tool_id: String,
    #[serde(default)]
    skill_install_activation: String,
    #[serde(default)]
    mcp_install_activation: String,
    #[serde(default)]
    skill_source_view_style: String,
    #[serde(default)]
    skill_tag_filter_layout: String,
    #[serde(default)]
    language: String,
    #[serde(default)]
    language_source: String,
    #[serde(default)]
    theme: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    github_token: String,
    #[serde(default)]
    github_connection: GithubConnectionMetadata,
    #[serde(default)]
    github_backup: GithubBackupSettings,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SkillTagPersistence {
    #[serde(default)]
    skill_tags: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortablePreferences {
    pub schema_version: u32,
    pub agent_skills_compatibility_enabled: bool,
    pub default_open_tool_id: String,
    pub skill_install_activation: String,
    pub mcp_install_activation: String,
    pub skill_source_view_style: String,
    #[serde(default)]
    pub skill_tag_filter_layout: String,
    pub language: String,
    pub language_source: String,
    pub theme: String,
}

fn portable_preferences_from_persistence(persistence: &SettingsPersistence) -> PortablePreferences {
    let compatibility_enabled = persistence
        .agent_skills_compatibility_enabled
        .unwrap_or(false)
        || normalize_skill_library_provider(&persistence.skill_library_provider)
            == SKILL_LIBRARY_PROVIDER_AGENT_SKILLS;
    PortablePreferences {
        schema_version: PORTABLE_PREFERENCES_SCHEMA_VERSION,
        agent_skills_compatibility_enabled: compatibility_enabled,
        default_open_tool_id: persistence.default_open_tool_id.trim().to_string(),
        skill_install_activation: normalize_skill_install_activation(
            &persistence.skill_install_activation,
        )
        .to_string(),
        mcp_install_activation: normalize_mcp_install_activation(
            &persistence.mcp_install_activation,
        )
        .to_string(),
        skill_source_view_style: normalize_skill_source_view_style(
            &persistence.skill_source_view_style,
        )
        .to_string(),
        skill_tag_filter_layout: normalize_skill_tag_filter_layout(
            &persistence.skill_tag_filter_layout,
        )
        .to_string(),
        language: normalize_app_language(&persistence.language).to_string(),
        language_source: normalize_app_language_source(&persistence.language_source).to_string(),
        theme: normalize_app_theme(&persistence.theme).to_string(),
    }
}

fn load_settings_persistence() -> SettingsPersistence {
    settings_file_candidates()
        .into_iter()
        .find_map(|path| fs::read_to_string(path).ok())
        .and_then(|content| serde_json::from_str::<SettingsPersistence>(&content).ok())
        .unwrap_or_default()
}

fn save_settings_persistence(persistence: &SettingsPersistence) -> Result<(), String> {
    let settings_file =
        settings_file_path().ok_or_else(|| "无法定位用户目录，不能保存设置".to_string())?;
    let parent_dir = settings_file
        .parent()
        .ok_or_else(|| "设置文件目录无效".to_string())?;
    fs::create_dir_all(parent_dir).map_err(|error| format!("创建设置目录失败: {error}"))?;
    let payload = serde_json::to_string_pretty(persistence)
        .map_err(|error| format!("序列化设置失败: {error}"))?;
    atomic_write_workspace_file(&settings_file, &payload)
        .map_err(|error| format!("写入设置文件失败: {error}"))?;
    remove_legacy_workspace_file(SETTINGS_FILE_NAME);
    Ok(())
}

pub fn load_installed_skills(default_skills: &[SkillSummary]) -> Vec<SkillSummary> {
    load_installed_skills_internal(default_skills, true)
}

pub fn load_installed_skills_read_only(default_skills: &[SkillSummary]) -> Vec<SkillSummary> {
    load_installed_skills_internal(default_skills, false)
}

fn load_installed_skills_internal(
    default_skills: &[SkillSummary],
    persist_repairs: bool,
) -> Vec<SkillSummary> {
    let persisted_skill_tag_file = load_skill_tag_persistence();
    let loaded_state = workspace_state_candidates()
        .into_iter()
        .find_map(|state_file| {
            let contents = fs::read_to_string(&state_file).ok()?;
            let persistence = serde_json::from_str::<WorkspacePersistence>(&contents).ok()?;
            Some((state_file, persistence))
        });
    let loaded_from_legacy = loaded_state
        .as_ref()
        .is_some_and(|(path, _)| path.to_string_lossy().contains("/.skillm/"));
    let (mut persisted_skills, legacy_skill_tags, migrated_legacy_skill_tags) = loaded_state
        .map(|(_, persistence)| {
            let mut skill_tags = persistence.skill_tags;
            let migrated_legacy_skill_tags =
                migrate_legacy_skill_tags(&persistence.installed_skills, &mut skill_tags);
            let original_skill_tag_count = skill_tags.len();
            merge_embedded_skill_tags(&persistence.installed_skills, &mut skill_tags);
            let migrated_legacy_skill_tags =
                migrated_legacy_skill_tags || original_skill_tag_count != skill_tags.len();
            (
                persistence.installed_skills,
                skill_tags,
                migrated_legacy_skill_tags,
            )
        })
        .unwrap_or_else(|| (default_skills.to_vec(), BTreeMap::new(), false));
    let should_create_skill_tag_file = persisted_skill_tag_file.is_none();
    let persisted_skill_tags = persisted_skill_tag_file.unwrap_or(legacy_skill_tags);
    apply_persisted_skill_tags(&mut persisted_skills, &persisted_skill_tags);
    let original_count = persisted_skills.len();
    let original_paths = persisted_skills
        .iter()
        .map(|skill| skill.local_path.clone())
        .collect::<Vec<_>>();
    let filtered_skills = persisted_skills
        .into_iter()
        .map(normalize_skill_workspace_path)
        .map(repair_skill_local_path)
        .filter(is_skill_local_path_valid)
        .map(hydrate_skill_description)
        .collect::<Vec<_>>();
    if persist_repairs
        && (loaded_from_legacy
            || migrated_legacy_skill_tags
            || should_create_skill_tag_file
            || filtered_skills.len() != original_count
            || filtered_skills
                .iter()
                .zip(original_paths.iter())
                .any(|(current, original)| current.local_path != *original))
    {
        let _ = save_installed_skills(&filtered_skills);
    }
    if !persist_repairs {
        return filtered_skills
            .into_iter()
            .map(hydrate_skill_instance_metadata)
            .collect();
    }

    let mut skills = merge_agent_skill_entries(filtered_skills);
    if skills.is_empty() && !default_skills.is_empty() {
        let compatibility_enabled = load_app_settings().agent_skills_compatibility_enabled;
        skills = default_skills
            .iter()
            .cloned()
            .map(hydrate_skill_instance_metadata)
            .filter(|skill| is_visible_managed_skill_instance(skill, compatibility_enabled))
            .collect();
    }
    skills
}

fn merge_agent_skill_entries(skills: Vec<SkillSummary>) -> Vec<SkillSummary> {
    let compatibility_enabled = load_app_settings().agent_skills_compatibility_enabled;
    let mut merged = skills
        .into_iter()
        .map(hydrate_skill_instance_metadata)
        .filter(|skill| is_visible_managed_skill_instance(skill, compatibility_enabled))
        .collect::<Vec<_>>();
    if !compatibility_enabled {
        return merged;
    }

    let Ok(agent_root) = crate::agent_skills_cli::global_skill_root() else {
        return merged;
    };
    let Ok(entries) = fs::read_dir(&agent_root) else {
        return merged;
    };
    let lock_entries = crate::agent_skills_cli::global_skill_lock_entries();
    let mut entry_paths = entries
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    entry_paths.sort();

    for entry_path in entry_paths {
        let Some(name) = entry_path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if is_reserved_workspace_name(name) {
            continue;
        }

        let resolved = crate::agent_skills_cli::resolve_skill_entry_path(&entry_path);
        let canonical_path = resolved.canonical_path.as_deref();
        if canonical_path.is_some_and(|path| !path.join("SKILL.md").is_file()) {
            continue;
        }
        if !canonical_path.is_some_and(is_managed_skill_root_path) {
            continue;
        }
        let canonical_key = canonical_path.map(path_key).unwrap_or_default();
        if let Some(existing) = merged.iter_mut().find(|skill| {
            skill.name.eq_ignore_ascii_case(name)
                && !canonical_key.is_empty()
                && path_key(Path::new(skill_instance_path(skill))) == canonical_key
        }) {
            if existing.instance.management_owner == "agent-skills-cli" {
                let scanned = build_agent_skill_summary(
                    name,
                    &entry_path,
                    canonical_path,
                    &resolved.path_error,
                    lock_entries.get(name),
                );
                refresh_agent_skill_metadata(existing, &scanned);
            }
            add_skill_entry(existing, &entry_path);
            continue;
        }

        merged.push(build_agent_skill_summary(
            name,
            &entry_path,
            canonical_path,
            &resolved.path_error,
            lock_entries.get(name),
        ));
    }
    merged
}

fn hydrate_skill_instance_metadata(mut skill: SkillSummary) -> SkillSummary {
    let canonical_path = Path::new(&skill.local_path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(&skill.local_path));
    if skill.instance.entry_path.trim().is_empty() {
        skill.instance.entry_path = skill.local_path.clone();
    }
    if skill.instance.canonical_path.trim().is_empty() {
        skill.instance.canonical_path = canonical_path.to_string_lossy().to_string();
    }
    if skill.instance.skill_entries.is_empty() {
        skill.instance.skill_entries = vec![skill.instance.entry_path.clone()];
    }
    if skill.instance.management_owner.trim().is_empty() {
        skill.instance.management_owner = if is_skilldock_path(&canonical_path) {
            "skilldock"
        } else if is_agent_skills_path(&canonical_path) {
            "agent-skills-cli"
        } else {
            "external"
        }
        .into();
    }
    if skill.instance.update_driver.trim().is_empty() {
        skill.instance.update_driver = if skill.git_linked { "git" } else { "none" }.into();
    }
    skill
}

fn build_agent_skill_summary(
    name: &str,
    entry_path: &Path,
    canonical_path: Option<&Path>,
    path_error: &str,
    lock_entry: Option<&crate::agent_skills_cli::GlobalSkillLockEntry>,
) -> SkillSummary {
    let effective_path = canonical_path.unwrap_or(entry_path);
    let git_linked = find_git_root(effective_path).is_some();
    let locked_by_cli = lock_entry.is_some();
    let source_type = lock_entry
        .map(|entry| entry.source_type.as_str())
        .filter(|value| matches!(*value, "github" | "gitlab" | "gitee" | "well-known"))
        .unwrap_or("local");
    let source_url = lock_entry
        .map(|entry| entry.source_url.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    let management_owner = if is_skilldock_path(effective_path) {
        "skilldock"
    } else {
        "agent-skills-cli"
    };
    let update_driver = if git_linked {
        "git"
    } else if locked_by_cli {
        "agent-skills-cli"
    } else {
        "none"
    };
    let description = canonical_path
        .and_then(|path| read_skill_description(&path.join("SKILL.md")))
        .unwrap_or_default();

    SkillSummary {
        name: name.to_string(),
        source_label: match source_type {
            "github" => "GitHub",
            "gitlab" => "GitLab",
            "gitee" => "Gitee",
            "well-known" => "Agent Skills CLI",
            _ if locked_by_cli => "Agent Skills CLI",
            _ => "外部 Skill",
        }
        .into(),
        source_type: source_type.into(),
        source_url: source_url.into(),
        description,
        local_path: effective_path.to_string_lossy().to_string(),
        branch: if git_linked { "main" } else { "local" }.into(),
        collab_status: "clean".into(),
        status_text: if path_error.is_empty() {
            "已从 Agent Skills CLI 全局目录识别。"
        } else {
            "Agent Skills CLI 入口路径不可用。"
        }
        .into(),
        remote_updated_at: String::new(),
        local_updated_at: String::new(),
        last_synced_at: String::new(),
        last_checked_at: "刚刚检查".into(),
        synced_tool_count: 0,
        last_editor: String::new(),
        commit_label: String::new(),
        git_linked,
        local_change_count: 0,
        lifecycle_source: String::new(),
        owner_plugin_id: String::new(),
        owner_plugin_name: String::new(),
        instance: SkillInstanceMetadata {
            backup_id: String::new(),
            entry_path: entry_path.to_string_lossy().to_string(),
            canonical_path: canonical_path
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default(),
            management_owner: management_owner.into(),
            update_driver: update_driver.into(),
            skill_entries: vec![entry_path.to_string_lossy().to_string()],
            path_error: path_error.to_string(),
            content_hash: String::new(),
            tag: String::new(),
            marketplace_source: String::new(),
            marketplace_owner: String::new(),
            marketplace_slug: String::new(),
            marketplace_version: String::new(),
            marketplace_content_hash: String::new(),
        },
        tools: Vec::new(),
    }
}

fn refresh_agent_skill_metadata(existing: &mut SkillSummary, scanned: &SkillSummary) {
    existing.source_label = scanned.source_label.clone();
    existing.source_type = scanned.source_type.clone();
    existing.source_url = scanned.source_url.clone();
    existing.description = scanned.description.clone();
    existing.local_path = scanned.local_path.clone();
    existing.branch = scanned.branch.clone();
    existing.git_linked = scanned.git_linked;
    existing.instance.entry_path = scanned.instance.entry_path.clone();
    existing.instance.canonical_path = scanned.instance.canonical_path.clone();
    existing.instance.management_owner = scanned.instance.management_owner.clone();
    existing.instance.update_driver = scanned.instance.update_driver.clone();
    existing.instance.path_error = scanned.instance.path_error.clone();
}

fn add_skill_entry(skill: &mut SkillSummary, entry_path: &Path) {
    let entry = entry_path.to_string_lossy().to_string();
    if !skill.instance.skill_entries.contains(&entry) {
        skill.instance.skill_entries.push(entry.clone());
    }
    if skill.instance.entry_path.trim().is_empty() {
        skill.instance.entry_path = entry;
    }
}

fn skill_instance_path(skill: &SkillSummary) -> &str {
    if skill.instance.canonical_path.trim().is_empty() {
        &skill.local_path
    } else {
        &skill.instance.canonical_path
    }
}

fn find_git_root(path: &Path) -> Option<PathBuf> {
    let mut current = path.to_path_buf();
    loop {
        if current.join(".git").exists() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

fn is_skilldock_path(path: &Path) -> bool {
    managed_skill_library_root()
        .ok()
        .and_then(|root| root.canonicalize().ok())
        .is_some_and(|root| {
            path.canonicalize()
                .unwrap_or_else(|_| path.to_path_buf())
                .starts_with(root)
        })
}

fn is_agent_skills_path(path: &Path) -> bool {
    crate::agent_skills_cli::global_skill_root()
        .ok()
        .and_then(|root| root.canonicalize().ok())
        .is_some_and(|root| {
            path.canonicalize()
                .unwrap_or_else(|_| path.to_path_buf())
                .starts_with(root)
        })
}

fn is_managed_skill_root_path(path: &Path) -> bool {
    is_skilldock_path(path) || is_agent_skills_path(path)
}

fn is_visible_managed_skill_instance(skill: &SkillSummary, compatibility_enabled: bool) -> bool {
    let path = Path::new(skill_instance_path(skill));
    is_skilldock_path(path) || (compatibility_enabled && is_agent_skills_path(path))
}

pub fn save_installed_skills(skills: &[SkillSummary]) -> Result<(), String> {
    let _write_guard = WORKSPACE_STATE_WRITE_LOCK
        .lock()
        .map_err(|_| "状态文件写入锁已失效，请重启应用后重试".to_string())?;
    let skill_tags = load_persisted_skill_tags();
    save_skill_tag_persistence(&skill_tags)?;
    save_workspace_persistence(skills, &skill_tags)
}

pub fn save_installed_skill_tag(
    skills: &[SkillSummary],
    tagged_skill: &SkillSummary,
) -> Result<(), String> {
    let _write_guard = WORKSPACE_STATE_WRITE_LOCK
        .lock()
        .map_err(|_| "状态文件写入锁已失效，请重启应用后重试".to_string())?;
    let mut skill_tags = load_persisted_skill_tags();
    let tag_key = skill_tag_key(tagged_skill);
    let tag = tagged_skill.instance.tag.trim();
    if tag.is_empty() {
        skill_tags.remove(&tag_key);
    } else {
        skill_tags.insert(tag_key, tag.to_string());
    }
    save_skill_tag_persistence(&skill_tags)?;
    save_workspace_persistence(skills, &skill_tags)
}

fn save_workspace_persistence(
    skills: &[SkillSummary],
    skill_tags: &BTreeMap<String, String>,
) -> Result<(), String> {
    let state_file =
        workspace_state_file().ok_or_else(|| "无法定位用户目录，不能保存状态".to_string())?;
    let parent_dir = state_file
        .parent()
        .ok_or_else(|| "状态文件目录无效".to_string())?;

    fs::create_dir_all(parent_dir).map_err(|error| format!("创建状态目录失败: {error}"))?;

    let mut normalized_skills = skills
        .iter()
        .cloned()
        .map(normalize_skill_workspace_path)
        .collect::<Vec<_>>();
    apply_persisted_skill_tags(&mut normalized_skills, skill_tags);
    let persistence = WorkspacePersistence {
        installed_skills: normalized_skills,
        skill_tags: skill_tags.clone(),
    };
    let payload = serde_json::to_string_pretty(&persistence)
        .map_err(|error| format!("序列化状态失败: {error}"))?;
    atomic_write_workspace_file(&state_file, &payload)
        .map_err(|error| format!("写入状态文件失败: {error}"))?;
    remove_legacy_workspace_file(STATE_FILE_NAME);
    Ok(())
}

fn load_persisted_skill_tags() -> BTreeMap<String, String> {
    if let Some(skill_tags) = load_skill_tag_persistence() {
        return skill_tags;
    }

    let Some((_, persistence)) = workspace_state_candidates()
        .into_iter()
        .find_map(|state_file| {
            let contents = fs::read_to_string(&state_file).ok()?;
            let persistence = serde_json::from_str::<WorkspacePersistence>(&contents).ok()?;
            Some((state_file, persistence))
        })
    else {
        return BTreeMap::new();
    };
    let mut skill_tags = persistence.skill_tags;
    migrate_legacy_skill_tags(&persistence.installed_skills, &mut skill_tags);
    merge_embedded_skill_tags(&persistence.installed_skills, &mut skill_tags);
    skill_tags
}

fn load_skill_tag_persistence() -> Option<BTreeMap<String, String>> {
    skill_tag_file_candidates().into_iter().find_map(|path| {
        let contents = fs::read_to_string(path).ok()?;
        let persistence = serde_json::from_str::<SkillTagPersistence>(&contents).ok()?;
        Some(persistence.skill_tags)
    })
}

fn save_skill_tag_persistence(skill_tags: &BTreeMap<String, String>) -> Result<(), String> {
    let tag_file =
        skill_tag_file_path().ok_or_else(|| "无法定位用户目录，不能保存 Skill 标签".to_string())?;
    let parent_dir = tag_file
        .parent()
        .ok_or_else(|| "Skill 标签目录无效".to_string())?;
    fs::create_dir_all(parent_dir).map_err(|error| format!("创建 Skill 标签目录失败: {error}"))?;

    let persistence = SkillTagPersistence {
        skill_tags: skill_tags.clone(),
    };
    let payload = serde_json::to_string_pretty(&persistence)
        .map_err(|error| format!("序列化 Skill 标签失败: {error}"))?;
    atomic_write_workspace_file(&tag_file, &payload)
        .map_err(|error| format!("写入 Skill 标签文件失败: {error}"))?;
    remove_legacy_workspace_file(SKILL_TAGS_FILE_NAME);
    Ok(())
}

fn legacy_skill_tag_key(skill_name: &str) -> String {
    skill_name.trim().to_lowercase()
}

fn skill_tag_key(skill: &SkillSummary) -> String {
    let instance_path = if skill.instance.canonical_path.trim().is_empty() {
        &skill.local_path
    } else {
        &skill.instance.canonical_path
    };
    let normalized_path = display_path_value(&normalize_workspace_path(instance_path));
    format!(
        "{}\n{}",
        legacy_skill_tag_key(&skill.name),
        normalized_path.trim()
    )
}

fn migrate_legacy_skill_tags(
    skills: &[SkillSummary],
    skill_tags: &mut BTreeMap<String, String>,
) -> bool {
    let mut migrated = false;
    let mut legacy_keys = BTreeSet::new();
    for skill in skills {
        let legacy_key = legacy_skill_tag_key(&skill.name);
        let Some(tag) = skill_tags.get(&legacy_key).cloned() else {
            continue;
        };
        legacy_keys.insert(legacy_key);
        if let std::collections::btree_map::Entry::Vacant(entry) =
            skill_tags.entry(skill_tag_key(skill))
        {
            entry.insert(tag);
            migrated = true;
        }
    }
    for legacy_key in legacy_keys {
        migrated |= skill_tags.remove(&legacy_key).is_some();
    }
    migrated
}

fn merge_embedded_skill_tags(skills: &[SkillSummary], skill_tags: &mut BTreeMap<String, String>) {
    for skill in skills {
        let tag = skill.instance.tag.trim();
        if !tag.is_empty() {
            skill_tags
                .entry(skill_tag_key(skill))
                .or_insert_with(|| tag.to_string());
        }
    }
}

fn apply_persisted_skill_tags(skills: &mut [SkillSummary], skill_tags: &BTreeMap<String, String>) {
    for skill in skills {
        skill.instance.tag = skill_tags
            .get(&skill_tag_key(skill))
            .cloned()
            .unwrap_or_default();
    }
}

pub fn load_app_settings() -> AppSettings {
    let settings_path = settings_file_path()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();

    let persisted = load_settings_persistence();

    let legacy_agent_skills_enabled =
        normalize_skill_library_provider(&persisted.skill_library_provider)
            == SKILL_LIBRARY_PROVIDER_AGENT_SKILLS;
    let compatibility_enabled = persisted
        .agent_skills_compatibility_enabled
        .unwrap_or(false)
        || legacy_agent_skills_enabled;

    AppSettings {
        storage_path: settings_path,
        skill_library_path: managed_skill_library_root()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        skill_library_provider: if compatibility_enabled {
            SKILL_LIBRARY_PROVIDER_AGENT_SKILLS.to_string()
        } else {
            SKILL_LIBRARY_PROVIDER_SKILLDOCK.to_string()
        },
        agent_skills_compatibility_enabled: compatibility_enabled,
        agent_skills_compatibility_configured: persisted
            .agent_skills_compatibility_enabled
            .is_some()
            || legacy_agent_skills_enabled,
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
        skill_tag_filter_layout: normalize_skill_tag_filter_layout(
            &persisted.skill_tag_filter_layout,
        )
        .to_string(),
        language: normalize_app_language(&persisted.language).to_string(),
        language_source: normalize_app_language_source(&persisted.language_source).to_string(),
        theme: normalize_app_theme(&persisted.theme).to_string(),
    }
}

pub fn export_portable_preferences() -> PortablePreferences {
    portable_preferences_from_persistence(&load_settings_persistence())
}

pub fn apply_portable_preferences(
    input: &PortablePreferences,
    overwrite: bool,
) -> Result<bool, String> {
    if input.schema_version != PORTABLE_PREFERENCES_SCHEMA_VERSION {
        return Err(format!("不支持的便携偏好版本: {}", input.schema_version));
    }

    let mut persistence = load_settings_persistence();
    let current = portable_preferences_from_persistence(&persistence);
    let defaults = portable_preferences_from_persistence(&SettingsPersistence::default());
    if !overwrite && current != defaults && current != *input {
        return Ok(false);
    }
    if current == *input {
        return Ok(false);
    }

    persistence.skill_library_provider = if input.agent_skills_compatibility_enabled {
        SKILL_LIBRARY_PROVIDER_AGENT_SKILLS
    } else {
        SKILL_LIBRARY_PROVIDER_SKILLDOCK
    }
    .to_string();
    persistence.agent_skills_compatibility_enabled = Some(input.agent_skills_compatibility_enabled);
    persistence.default_open_tool_id = input.default_open_tool_id.trim().to_string();
    persistence.skill_install_activation =
        normalize_skill_install_activation(&input.skill_install_activation).to_string();
    persistence.mcp_install_activation =
        normalize_mcp_install_activation(&input.mcp_install_activation).to_string();
    persistence.skill_source_view_style =
        normalize_skill_source_view_style(&input.skill_source_view_style).to_string();
    persistence.skill_tag_filter_layout =
        normalize_skill_tag_filter_layout(&input.skill_tag_filter_layout).to_string();
    persistence.language = normalize_app_language(&input.language).to_string();
    persistence.language_source = normalize_app_language_source(&input.language_source).to_string();
    persistence.theme = normalize_app_theme(&input.theme).to_string();
    save_settings_persistence(&persistence)?;
    Ok(true)
}

pub fn load_legacy_github_token() -> String {
    load_settings_persistence().github_token.trim().to_string()
}

pub fn load_github_connection_metadata() -> GithubConnectionMetadata {
    load_settings_persistence().github_connection
}

pub fn save_github_connection_metadata(
    metadata: GithubConnectionMetadata,
    clear_legacy_token: bool,
) -> Result<(), String> {
    let mut persistence = load_settings_persistence();
    persistence.github_connection = metadata;
    if clear_legacy_token {
        persistence.github_token.clear();
    }
    save_settings_persistence(&persistence)
}

pub fn load_github_backup_settings() -> GithubBackupSettings {
    load_settings_persistence().github_backup
}

pub fn save_github_backup_settings(settings: GithubBackupSettings) -> Result<(), String> {
    let mut persistence = load_settings_persistence();
    persistence.github_backup = settings;
    save_settings_persistence(&persistence)
}

pub fn save_app_settings(input: AppSettings) -> Result<AppSettings, String> {
    let settings_file =
        settings_file_path().ok_or_else(|| "无法定位用户目录，不能保存设置".to_string())?;
    let parent_dir = settings_file
        .parent()
        .ok_or_else(|| "设置文件目录无效".to_string())?;

    fs::create_dir_all(parent_dir).map_err(|error| format!("创建设置目录失败: {error}"))?;

    let compatibility_enabled = input.agent_skills_compatibility_enabled
        || normalize_skill_library_provider(&input.skill_library_provider)
            == SKILL_LIBRARY_PROVIDER_AGENT_SKILLS;
    let skill_library_provider = if compatibility_enabled {
        SKILL_LIBRARY_PROVIDER_AGENT_SKILLS
    } else {
        SKILL_LIBRARY_PROVIDER_SKILLDOCK
    };
    let skill_library_path = managed_skill_library_root()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let normalized = AppSettings {
        storage_path: settings_file.to_string_lossy().to_string(),
        skill_library_path,
        skill_library_provider: skill_library_provider.to_string(),
        agent_skills_compatibility_enabled: compatibility_enabled,
        agent_skills_compatibility_configured: input.agent_skills_compatibility_configured,
        default_open_tool_id: input.default_open_tool_id.trim().to_string(),
        skill_install_activation: normalize_skill_install_activation(
            &input.skill_install_activation,
        )
        .to_string(),
        mcp_install_activation: normalize_mcp_install_activation(&input.mcp_install_activation)
            .to_string(),
        skill_source_view_style: normalize_skill_source_view_style(&input.skill_source_view_style)
            .to_string(),
        skill_tag_filter_layout: normalize_skill_tag_filter_layout(&input.skill_tag_filter_layout)
            .to_string(),
        language: normalize_app_language(&input.language).to_string(),
        language_source: normalize_app_language_source(&input.language_source).to_string(),
        theme: normalize_app_theme(&input.theme).to_string(),
    };
    let existing = load_settings_persistence();
    let persistence = SettingsPersistence {
        skill_library_provider: normalized.skill_library_provider.clone(),
        agent_skills_compatibility_enabled: normalized
            .agent_skills_compatibility_configured
            .then_some(normalized.agent_skills_compatibility_enabled),
        default_open_tool_id: normalized.default_open_tool_id.clone(),
        skill_install_activation: normalized.skill_install_activation.clone(),
        mcp_install_activation: normalized.mcp_install_activation.clone(),
        skill_source_view_style: normalized.skill_source_view_style.clone(),
        skill_tag_filter_layout: normalized.skill_tag_filter_layout.clone(),
        language: normalized.language.clone(),
        language_source: normalized.language_source.clone(),
        theme: normalized.theme.clone(),
        github_token: existing.github_token.trim().to_string(),
        github_connection: existing.github_connection,
        github_backup: existing.github_backup,
    };

    fs::create_dir_all(&normalized.skill_library_path)
        .map_err(|error| format!("创建 Skill 托管目录失败: {error}"))?;
    save_settings_persistence(&persistence)?;
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
        home_dir.join(".zcode/skills"),
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
    push_installed_skill_path_key(&mut paths, &skill.instance.entry_path);
    push_installed_skill_path_key(&mut paths, &skill.instance.canonical_path);
    for entry in &skill.instance.skill_entries {
        push_installed_skill_path_key(&mut paths, entry);
    }
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

fn skill_tag_file_path() -> Option<PathBuf> {
    workspace_file_path(SKILL_TAGS_FILE_NAME).ok()
}

fn skill_tag_file_candidates() -> Vec<PathBuf> {
    workspace_file_candidates(SKILL_TAGS_FILE_NAME)
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
        SKILL_SOURCE_VIEW_STYLE_FLAT => SKILL_SOURCE_VIEW_STYLE_FLAT,
        _ => SKILL_SOURCE_VIEW_STYLE_SELECT,
    }
}

pub fn normalize_skill_tag_filter_layout(value: &str) -> &'static str {
    match value.trim() {
        SKILL_TAG_FILTER_LAYOUT_INLINE => SKILL_TAG_FILTER_LAYOUT_INLINE,
        SKILL_TAG_FILTER_LAYOUT_POPOVER => SKILL_TAG_FILTER_LAYOUT_POPOVER,
        _ => SKILL_TAG_FILTER_LAYOUT_POPOVER,
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
    skill.instance.entry_path =
        display_path_value(&normalize_workspace_path(&skill.instance.entry_path));
    skill.instance.canonical_path =
        display_path_value(&normalize_workspace_path(&skill.instance.canonical_path));
    skill.instance.skill_entries = skill
        .instance
        .skill_entries
        .into_iter()
        .map(|path| display_path_value(&normalize_workspace_path(&path)))
        .collect();
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

    use crate::models::ToolSyncStatus;
    use crate::models::WorkspacePersistence;
    use crate::models::{GithubConnectionMetadata, SkillSummary};
    use crate::workspace::TEST_ENV_LOCK;

    use super::{
        apply_portable_preferences, export_portable_preferences, hydrate_skill_description,
        load_app_settings, load_github_connection_metadata, load_installed_skills,
        load_legacy_github_token, normalize_app_theme, normalize_skill_source_view_style,
        normalize_skill_tag_filter_layout, save_app_settings, save_github_connection_metadata,
        save_installed_skills, scan_local_skill_candidates,
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
            local_change_count: 0,
            lifecycle_source: "direct".into(),
            owner_plugin_id: String::new(),
            owner_plugin_name: String::new(),
            instance: Default::default(),
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
                local_change_count: 0,
                lifecycle_source: "direct".into(),
                owner_plugin_id: String::new(),
                owner_plugin_name: String::new(),
                instance: Default::default(),
                tools: vec![ToolSyncStatus {
                    name: "Codex".into(),
                    status_label: "已同步".into(),
                }],
            }];

            let result = save_installed_skills(&skills);
            assert!(result.is_ok());
            assert!(temp_home.join(".skilldock/data/state.json").exists());
        });
    }

    #[test]
    fn persists_agent_cli_skill_tool_statuses() {
        with_temp_home(|temp_home| {
            enable_agent_skills_compatibility(&temp_home);
            let agent_skill_dir = temp_home.join(".agents/skills/tdd");
            fs::create_dir_all(&agent_skill_dir).expect("create Agent CLI skill");
            fs::write(agent_skill_dir.join("SKILL.md"), "# tdd").expect("write Agent CLI skill");
            let mut agent_skill = test_skill_summary("tdd", &agent_skill_dir);
            agent_skill.instance.entry_path = agent_skill_dir.to_string_lossy().to_string();
            agent_skill.instance.canonical_path = agent_skill_dir.to_string_lossy().to_string();
            agent_skill.instance.management_owner = "agent-skills-cli".into();
            agent_skill.instance.update_driver = "agent-skills-cli".into();
            agent_skill.tools = vec![ToolSyncStatus {
                name: "Codex".into(),
                status_label: "已同步".into(),
            }];

            save_installed_skills(&[agent_skill]).expect("save Agent CLI skill");

            let loaded = load_installed_skills(&[]);
            let persisted = loaded
                .iter()
                .find(|skill| skill.name == "tdd")
                .expect("load persisted Agent CLI skill");
            assert_eq!(persisted.instance.management_owner, "agent-skills-cli");
            assert!(persisted
                .tools
                .iter()
                .any(|tool| tool.name == "Codex" && tool.status_label == "已同步"));
        });
    }

    #[test]
    fn normalizes_skill_source_view_style_with_compact_fallback() {
        assert_eq!(normalize_skill_source_view_style("flat"), "flat");
        assert_eq!(normalize_skill_source_view_style("select"), "select");
        assert_eq!(normalize_skill_source_view_style("band"), "select");
        assert_eq!(normalize_skill_source_view_style("inline"), "select");
        assert_eq!(normalize_skill_source_view_style("legacy"), "select");
        assert_eq!(normalize_skill_source_view_style(""), "select");
    }

    #[test]
    fn normalizes_skill_tag_filter_layout_with_popover_fallback() {
        assert_eq!(normalize_skill_tag_filter_layout("inline"), "inline");
        assert_eq!(normalize_skill_tag_filter_layout("popover"), "popover");
        assert_eq!(normalize_skill_tag_filter_layout("legacy"), "popover");
        assert_eq!(normalize_skill_tag_filter_layout(""), "popover");
    }

    #[test]
    fn normalizes_app_theme_with_system_fallback() {
        assert_eq!(normalize_app_theme("light"), "light");
        assert_eq!(normalize_app_theme("dark"), "dark");
        assert_eq!(normalize_app_theme("system"), "system");
        assert_eq!(normalize_app_theme(""), "system");
    }

    #[test]
    fn portable_preferences_only_include_allowed_fields() {
        with_temp_home(|_| {
            save_github_connection_metadata(
                GithubConnectionMetadata {
                    auth_method: "oauth".into(),
                    user_id: Some(42),
                    username: "octocat".into(),
                    avatar_url: "https://example.com/avatar.png".into(),
                    credential_persisted: true,
                },
                true,
            )
            .expect("save GitHub metadata");
            let payload = serde_json::to_string(&export_portable_preferences())
                .expect("serialize portable preferences");

            assert!(!payload.contains("github"));
            assert!(!payload.contains("storagePath"));
            assert!(!payload.contains("skillLibraryPath"));
            assert!(!payload.contains("octocat"));
        });
    }

    #[test]
    fn portable_preferences_restore_is_conservative_unless_overwrite_is_requested() {
        with_temp_home(|_| {
            let mut settings = load_app_settings();
            settings.theme = "dark".into();
            save_app_settings(settings).expect("save local settings");
            save_github_connection_metadata(
                GithubConnectionMetadata {
                    auth_method: "oauth".into(),
                    user_id: Some(42),
                    username: "octocat".into(),
                    avatar_url: String::new(),
                    credential_persisted: true,
                },
                true,
            )
            .expect("save GitHub metadata");

            let mut portable = export_portable_preferences();
            portable.theme = "light".into();
            assert!(!apply_portable_preferences(&portable, false)
                .expect("skip different local preferences"));
            assert_eq!(load_app_settings().theme, "dark");

            assert!(apply_portable_preferences(&portable, true)
                .expect("overwrite portable preferences"));
            assert_eq!(load_app_settings().theme, "light");
            assert_eq!(load_github_connection_metadata().username, "octocat");
        });
    }

    #[test]
    fn loads_legacy_settings_with_skilldock_provider() {
        with_temp_home(|temp_home| {
            let workspace_root = temp_home.join(".skilldock");
            fs::create_dir_all(&workspace_root).expect("create workspace");
            fs::write(workspace_root.join("settings.json"), "{\"theme\":\"dark\"}")
                .expect("write legacy settings");

            let settings = load_app_settings();

            assert_eq!(settings.skill_library_provider, "skilldock");
            assert_eq!(
                settings.skill_library_path,
                temp_home.join(".skilldock/skills").to_string_lossy()
            );
            assert!(!settings.agent_skills_compatibility_enabled);
            assert!(!settings.agent_skills_compatibility_configured);
        });
    }

    #[test]
    fn loads_explicitly_disabled_agent_skills_compatibility_as_configured() {
        with_temp_home(|temp_home| {
            let workspace_root = temp_home.join(".skilldock");
            fs::create_dir_all(&workspace_root).expect("create workspace");
            fs::write(
                workspace_root.join("settings.json"),
                "{\"agentSkillsCompatibilityEnabled\":false}",
            )
            .expect("write configured settings");

            let settings = load_app_settings();

            assert!(!settings.agent_skills_compatibility_enabled);
            assert!(settings.agent_skills_compatibility_configured);
        });
    }

    #[test]
    fn ordinary_setting_save_preserves_missing_compatibility_field() {
        with_temp_home(|temp_home| {
            let workspace_root = temp_home.join(".skilldock");
            fs::create_dir_all(&workspace_root).expect("create workspace");
            let settings_path = workspace_root.join("settings.json");
            fs::write(&settings_path, "{\"theme\":\"dark\"}").expect("write legacy settings");

            let mut settings = load_app_settings();
            settings.theme = "light".into();
            let saved = save_app_settings(settings).expect("save ordinary setting");
            let content = fs::read_to_string(workspace_root.join("config/settings.json"))
                .expect("read saved settings");

            assert!(!saved.agent_skills_compatibility_configured);
            assert!(!content.contains("agentSkillsCompatibilityEnabled"));
        });
    }

    #[test]
    fn preserves_legacy_github_token_until_connection_metadata_is_saved() {
        with_temp_home(|temp_home| {
            let workspace_root = temp_home.join(".skilldock");
            fs::create_dir_all(&workspace_root).expect("create workspace");
            let settings_path = workspace_root.join("settings.json");
            fs::write(
                &settings_path,
                "{\"theme\":\"dark\",\"githubToken\":\"  github_pat_example  \"}",
            )
            .expect("write legacy settings");

            let mut settings = load_app_settings();
            assert_eq!(load_legacy_github_token(), "github_pat_example");
            settings.theme = "light".into();
            save_app_settings(settings).expect("save ordinary settings");
            let migrated_settings_path = workspace_root.join("config/settings.json");
            let content = fs::read_to_string(&migrated_settings_path).expect("read saved settings");
            assert!(content.contains("\"githubToken\": \"github_pat_example\""));

            save_github_connection_metadata(
                GithubConnectionMetadata {
                    auth_method: "pat".into(),
                    user_id: Some(42),
                    username: "octocat".into(),
                    avatar_url: "https://example.com/avatar.png".into(),
                    credential_persisted: true,
                },
                true,
            )
            .expect("save GitHub connection metadata");
            let migrated_content =
                fs::read_to_string(migrated_settings_path).expect("read migrated settings");
            assert!(!migrated_content.contains("githubToken"));
            assert_eq!(load_github_connection_metadata().username, "octocat");
        });
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
            local_change_count: 0,
            lifecycle_source: "direct".into(),
            owner_plugin_id: String::new(),
            owner_plugin_name: String::new(),
            instance: Default::default(),
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
                        local_change_count: 0,
                        lifecycle_source: "direct".into(),
                        owner_plugin_id: String::new(),
                        owner_plugin_name: String::new(),
                        instance: Default::default(),
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
                        local_change_count: 0,
                        lifecycle_source: "direct".into(),
                        owner_plugin_id: String::new(),
                        owner_plugin_name: String::new(),
                        instance: Default::default(),
                        tools: vec![],
                    },
                ],
                skill_tags: BTreeMap::new(),
            };
            let legacy_state_file = temp_home.join(".skillm/state.json");
            let state_file = temp_home.join(".skilldock/data/state.json");
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
                    local_change_count: 0,
                    lifecycle_source: "direct".into(),
                    owner_plugin_id: String::new(),
                    owner_plugin_name: String::new(),
                    instance: Default::default(),
                    tools: vec![],
                }],
                skill_tags: BTreeMap::new(),
            };
            let legacy_state_file = temp_home.join(".skilldock/state.json");
            let state_file = temp_home.join(".skilldock/data/state.json");
            fs::create_dir_all(legacy_state_file.parent().expect("state parent exists"))
                .expect("create state parent");
            fs::write(
                &legacy_state_file,
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
                        local_change_count: 0,
                        lifecycle_source: "direct".into(),
                        owner_plugin_id: String::new(),
                        owner_plugin_name: String::new(),
                        instance: Default::default(),
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
                        local_change_count: 0,
                        lifecycle_source: "direct".into(),
                        owner_plugin_id: String::new(),
                        owner_plugin_name: String::new(),
                        instance: Default::default(),
                        tools: vec![],
                    },
                ],
                skill_tags: BTreeMap::new(),
            };
            let legacy_state_file = temp_home.join(".skillm/state.json");
            let state_file = temp_home.join(".skilldock/data/state.json");
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
    fn local_candidate_scan_discovers_zcode_skills() {
        with_temp_home(|temp_home| {
            let zcode_skills_root = temp_home.join(".zcode/skills");
            let skill_dir = zcode_skills_root.join("zcode-skill");
            fs::create_dir_all(&skill_dir).expect("create zcode skill dir");
            fs::write(skill_dir.join("SKILL.md"), "# zcode-skill").expect("write skill file");

            let candidates = scan_local_skill_candidates(&[]);

            assert_eq!(
                candidates,
                vec![(
                    "zcode-skill".to_string(),
                    zcode_skills_root.to_string_lossy().to_string()
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
            fs::write(
                codex_skills_root.join("example-migration"),
                "# not a directory",
            )
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

            let installed_skills =
                vec![test_skill_summary("example-migration", &managed_skill_dir)];
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
                local_change_count: 0,
                lifecycle_source: "direct".into(),
                owner_plugin_id: String::new(),
                owner_plugin_name: String::new(),
                instance: Default::default(),
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

    fn enable_agent_skills_compatibility(temp_home: &PathBuf) {
        let settings_path = temp_home.join(".skilldock/settings.json");
        fs::create_dir_all(settings_path.parent().expect("settings parent"))
            .expect("create settings parent");
        fs::write(
            settings_path,
            r#"{"agentSkillsCompatibilityEnabled":true,"skillLibraryProvider":"agent-skills"}"#,
        )
        .expect("write settings");
    }

    #[test]
    fn compatibility_disabled_hides_persisted_agent_entry() {
        with_temp_home(|temp_home| {
            let agent_skill = temp_home.join(".agents/skills/agent-skill");
            fs::create_dir_all(&agent_skill).expect("create Agent skill");
            fs::write(agent_skill.join("SKILL.md"), "# agent-skill").expect("write Agent skill");
            let mut persisted = test_skill_summary("agent-skill", &agent_skill);
            persisted.instance.management_owner = "agent-skills-cli".into();
            let state_path = temp_home.join(".skilldock/state.json");
            fs::create_dir_all(state_path.parent().expect("state parent"))
                .expect("create state parent");
            fs::write(
                state_path,
                serde_json::to_string(&WorkspacePersistence {
                    installed_skills: vec![persisted],
                    skill_tags: BTreeMap::new(),
                })
                .expect("serialize Agent skill state"),
            )
            .expect("write Agent skill state");

            assert!(load_installed_skills(&[]).is_empty());
        });
    }

    #[test]
    fn compatibility_scan_keeps_cli_entry_and_excludes_external_agent_entry() {
        with_temp_home(|temp_home| {
            enable_agent_skills_compatibility(&temp_home);
            let cli_skill = temp_home.join(".agents/skills/cli-skill");
            let github_skill = temp_home.join(".agents/skills/github-skill");
            let external_skill = temp_home.join(".cursor/skills/external-skill");
            let external_entry = temp_home.join(".agents/skills/external-skill");
            fs::create_dir_all(&cli_skill).expect("create cli skill");
            fs::create_dir_all(&github_skill).expect("create GitHub CLI skill");
            fs::create_dir_all(&external_skill).expect("create external skill");
            fs::write(cli_skill.join("SKILL.md"), "# cli-skill").expect("write cli skill");
            fs::write(github_skill.join("SKILL.md"), "# github-skill")
                .expect("write GitHub CLI skill");
            fs::write(external_skill.join("SKILL.md"), "# external-skill")
                .expect("write external skill");
            std::os::unix::fs::symlink(&external_skill, &external_entry)
                .expect("create external entry");
            fs::write(
                temp_home.join(".agents/.skill-lock.json"),
                r#"{"version":3,"skills":{"cli-skill":{"sourceType":"well-known","sourceUrl":"https://open.example.com/.well-known/skills/cli-skill/SKILL.md"},"github-skill":{"sourceType":"github","sourceUrl":"https://github.com/example/skills.git","skillPath":"skills/github-skill/SKILL.md","skillFolderHash":"abc"}}}"#,
            )
            .expect("write lock file");

            let skills = load_installed_skills(&[]);
            let cli = skills
                .iter()
                .find(|skill| skill.name == "cli-skill")
                .expect("find cli skill");
            assert_eq!(cli.instance.management_owner, "agent-skills-cli");
            assert_eq!(cli.instance.update_driver, "agent-skills-cli");
            assert_eq!(cli.source_type, "well-known");
            assert_eq!(
                cli.source_url,
                "https://open.example.com/.well-known/skills/cli-skill/SKILL.md"
            );
            assert!(!cli.git_linked);
            let github = skills
                .iter()
                .find(|skill| skill.name == "github-skill")
                .expect("find GitHub CLI skill");
            assert_eq!(github.source_type, "github");
            assert_eq!(github.source_url, "https://github.com/example/skills.git");
            assert_eq!(github.instance.update_driver, "agent-skills-cli");
            assert!(!github.git_linked);
            assert!(skills.iter().all(|skill| skill.name != "external-skill"));
            assert!(scan_local_skill_candidates(&skills)
                .iter()
                .any(|(name, _)| { name == "external-skill" }));
        });
    }

    #[test]
    fn compatibility_scan_refreshes_persisted_agent_source_and_keeps_tool_statuses() {
        with_temp_home(|temp_home| {
            enable_agent_skills_compatibility(&temp_home);
            let agent_skill_dir = temp_home.join(".agents/skills/tdd");
            fs::create_dir_all(&agent_skill_dir).expect("create Agent CLI skill");
            fs::write(agent_skill_dir.join("SKILL.md"), "# tdd").expect("write Agent CLI skill");
            fs::write(
                temp_home.join(".agents/.skill-lock.json"),
                r#"{"version":3,"skills":{"tdd":{"sourceType":"well-known","sourceUrl":"https://example.com/.well-known/skills/tdd/SKILL.md"}}}"#,
            )
            .expect("write Agent CLI lock");
            let mut persisted = test_skill_summary("tdd", &agent_skill_dir);
            persisted.source_label = "本地".into();
            persisted.source_type = "local".into();
            persisted.source_url = String::new();
            persisted.instance.entry_path = agent_skill_dir.to_string_lossy().to_string();
            persisted.instance.canonical_path = agent_skill_dir.to_string_lossy().to_string();
            persisted.instance.management_owner = "agent-skills-cli".into();
            persisted.instance.update_driver = "agent-skills-cli".into();
            persisted.tools = vec![ToolSyncStatus {
                name: "Codex".into(),
                status_label: "已同步".into(),
            }];
            save_installed_skills(&[persisted]).expect("save Agent CLI skill");

            let loaded = load_installed_skills(&[]);
            let skill = loaded
                .iter()
                .find(|skill| skill.name == "tdd")
                .expect("load Agent CLI skill");

            assert_eq!(skill.source_type, "well-known");
            assert_eq!(
                skill.source_url,
                "https://example.com/.well-known/skills/tdd/SKILL.md"
            );
            assert!(skill
                .tools
                .iter()
                .any(|tool| tool.name == "Codex" && tool.status_label == "已同步"));
        });
    }

    #[test]
    fn compatibility_scan_merges_same_path_and_excludes_external_variant() {
        with_temp_home(|temp_home| {
            enable_agent_skills_compatibility(&temp_home);
            let managed_skill = temp_home.join(".skilldock/skills/demo");
            let external_skill = temp_home.join(".cursor/skills/demo");
            let agent_entry = temp_home.join(".agents/skills/demo");
            fs::create_dir_all(&managed_skill).expect("create managed skill");
            fs::create_dir_all(&external_skill).expect("create external skill");
            fs::create_dir_all(agent_entry.parent().expect("agent parent"))
                .expect("create agent root");
            fs::write(managed_skill.join("SKILL.md"), "# managed demo")
                .expect("write managed skill");
            fs::write(external_skill.join("SKILL.md"), "# external demo")
                .expect("write external skill");
            save_installed_skills(&[test_skill_summary("demo", &managed_skill)])
                .expect("save managed skill");

            std::os::unix::fs::symlink(&managed_skill, &agent_entry)
                .expect("link same managed skill");
            let merged = load_installed_skills(&[]);
            assert_eq!(merged.len(), 1);
            assert_eq!(merged[0].instance.skill_entries.len(), 2);

            fs::remove_file(&agent_entry).expect("remove same-path link");
            std::os::unix::fs::symlink(&external_skill, &agent_entry)
                .expect("link different external skill");
            let variants = load_installed_skills(&[]);
            assert_eq!(variants.len(), 1);
            assert!(variants.iter().any(|skill| {
                skill.instance.canonical_path
                    == managed_skill.canonicalize().unwrap().to_string_lossy()
                    && skill.instance.management_owner == "skilldock"
            }));
        });
    }
}
