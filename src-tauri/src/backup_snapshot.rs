use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::models::SkillSummary;
use crate::state::{load_installed_skills, save_installed_skills};
use crate::workspace::{managed_skill_library_root, managed_workspace_root_option};

const BACKUP_SCHEMA_VERSION: u32 = 1;
const MAX_SKILL_BYTES: u64 = 100 * 1024 * 1024;
const EXCLUDED_DIRECTORY_NAMES: [&str; 5] = [".git", "node_modules", "target", ".cache", "tmp"];
const EXCLUDED_FILE_NAMES: [&str; 4] = [
    ".DS_Store",
    "Thumbs.db",
    "settings.json",
    "mcp-servers.json",
];

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSkillMetadata {
    pub schema_version: u32,
    pub backup_id: String,
    pub name: String,
    pub directory_name: String,
    pub source_type: String,
    pub source_url: String,
    pub branch: String,
    pub update_driver: String,
    pub description: String,
    pub tools: BTreeMap<String, bool>,
    pub content_hash: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupLibrary {
    pub schema_version: u32,
    pub skills: Vec<BackupSkillMetadata>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshotReport {
    pub included_skills: usize,
    pub excluded_skills: Vec<String>,
    pub assigned_backup_ids: usize,
    pub preserved_backup_ids: Vec<String>,
}

struct TemporaryDirectoryGuard {
    path: PathBuf,
}

impl TemporaryDirectoryGuard {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for TemporaryDirectoryGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub fn backup_root() -> Result<PathBuf, String> {
    managed_workspace_root_option()
        .map(|root| root.join("backup"))
        .ok_or_else(|| "无法定位 SkillDock 备份目录".to_string())
}

pub fn backup_repo_path() -> Result<PathBuf, String> {
    Ok(backup_root()?.join("repo"))
}

fn validate_relative_path(path: &Path) -> Result<(), String> {
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("备份路径不安全: {}", path.display()));
    }
    Ok(())
}

fn should_exclude(path: &Path, is_directory: bool) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if is_directory {
        return EXCLUDED_DIRECTORY_NAMES.contains(&name);
    }
    EXCLUDED_FILE_NAMES.contains(&name)
        || name == ".env"
        || name.starts_with(".env.")
        || name.ends_with(".key")
        || name.to_ascii_lowercase().contains("credentials")
        || name.to_ascii_lowercase().contains("secrets")
}

fn copy_directory_entry(
    source_root: &Path,
    target_root: &Path,
    relative_path: &Path,
    hasher: &mut Sha256,
    total_bytes: &mut u64,
) -> Result<(), String> {
    validate_relative_path(relative_path)?;
    let source = source_root.join(relative_path);
    let metadata = fs::symlink_metadata(&source)
        .map_err(|error| format!("读取备份文件失败 {}: {error}", source.display()))?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        if should_exclude(relative_path, true) {
            return Ok(());
        }
        let target = target_root.join(relative_path);
        fs::create_dir_all(&target)
            .map_err(|error| format!("创建备份目录失败 {}: {error}", target.display()))?;
        let mut children = fs::read_dir(&source)
            .map_err(|error| format!("读取 Skill 目录失败 {}: {error}", source.display()))?
            .filter_map(Result::ok)
            .map(|entry| entry.file_name())
            .collect::<Vec<_>>();
        children.sort();
        for child in children {
            copy_directory_entry(
                source_root,
                target_root,
                &relative_path.join(child),
                hasher,
                total_bytes,
            )?;
        }
        return Ok(());
    }
    if !metadata.is_file() || should_exclude(relative_path, false) {
        return Ok(());
    }

    *total_bytes = total_bytes.saturating_add(metadata.len());
    if *total_bytes > MAX_SKILL_BYTES {
        return Err("Skill 超过 100 MB 备份上限".to_string());
    }
    let target = target_root.join(relative_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建备份文件目录失败 {}: {error}", parent.display()))?;
    }
    let mut input = fs::File::open(&source)
        .map_err(|error| format!("打开备份文件失败 {}: {error}", source.display()))?;
    let mut contents = Vec::new();
    input
        .read_to_end(&mut contents)
        .map_err(|error| format!("读取备份文件失败 {}: {error}", source.display()))?;
    hasher.update(relative_path.to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(&contents);
    fs::write(&target, contents)
        .map_err(|error| format!("写入备份文件失败 {}: {error}", target.display()))
}

fn copy_skill(source: &Path, target: &Path) -> Result<String, String> {
    if !source.join("SKILL.md").is_file() {
        return Err("Skill 缺少 SKILL.md".to_string());
    }
    fs::create_dir_all(target)
        .map_err(|error| format!("创建 Skill 备份目录失败 {}: {error}", target.display()))?;
    let mut hasher = Sha256::new();
    let mut total_bytes = 0;
    copy_directory_entry(source, target, Path::new(""), &mut hasher, &mut total_bytes)?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn is_tool_enabled(status_label: &str) -> bool {
    let normalized = status_label.trim().to_ascii_lowercase();
    normalized == "enabled" || status_label.trim() == "已启用"
}

fn skill_path(skill: &SkillSummary) -> PathBuf {
    let path = if skill.instance.canonical_path.trim().is_empty() {
        &skill.local_path
    } else {
        &skill.instance.canonical_path
    };
    PathBuf::from(path)
}

fn directory_name(path: &Path, fallback: &str) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn replace_directory(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        fs::remove_dir_all(target)
            .map_err(|error| format!("清理旧备份目录失败 {}: {error}", target.display()))?;
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建备份目录失败 {}: {error}", parent.display()))?;
    }
    fs::rename(source, target)
        .map_err(|error| format!("替换备份目录失败 {}: {error}", target.display()))
}

pub fn write_current_library_snapshot(repo_path: &Path) -> Result<BackupSnapshotReport, String> {
    let mut skills = load_installed_skills(&[]);
    let previous_skills = read_library_snapshot(repo_path)
        .unwrap_or_default()
        .skills
        .into_iter()
        .map(|skill| (skill.backup_id.clone(), skill))
        .collect::<BTreeMap<_, _>>();
    let managed_root = managed_skill_library_root()?;
    let staging_root = backup_root()?
        .join("staging")
        .join(uuid::Uuid::new_v4().to_string());
    let _staging_guard = TemporaryDirectoryGuard::new(staging_root.clone());
    let staging_skills = staging_root.join("skills");
    let staging_metadata = staging_root.join(".skilldock").join("skills");
    fs::create_dir_all(&staging_skills).map_err(|error| format!("创建备份暂存区失败: {error}"))?;
    fs::create_dir_all(&staging_metadata)
        .map_err(|error| format!("创建备份元数据暂存区失败: {error}"))?;

    let mut report = BackupSnapshotReport::default();
    let mut library = BackupLibrary {
        schema_version: BACKUP_SCHEMA_VERSION,
        skills: Vec::new(),
    };
    for skill in &mut skills {
        let source = skill_path(skill);
        if !source.starts_with(&managed_root) || skill.instance.update_driver == "agent-skills-cli"
        {
            continue;
        }
        let needs_backup_id = skill.instance.backup_id.trim().is_empty();
        let backup_id = if needs_backup_id {
            uuid::Uuid::new_v4().to_string()
        } else {
            skill.instance.backup_id.clone()
        };
        let target = staging_skills.join(&backup_id);
        let content_hash = match copy_skill(&source, &target) {
            Ok(hash) => hash,
            Err(error) => {
                let _ = fs::remove_dir_all(&target);
                report
                    .excluded_skills
                    .push(format!("{}: {error}", skill.name));
                if !needs_backup_id {
                    let Some(previous) = previous_skills.get(&backup_id) else {
                        let _ = fs::remove_dir_all(&staging_root);
                        return Err(format!("{} 无法读取且没有可保留的上一版备份", skill.name));
                    };
                    let previous_path = repo_path.join("skills").join(&backup_id);
                    if !previous_path.is_dir() {
                        let _ = fs::remove_dir_all(&staging_root);
                        return Err(format!("{} 的上一版备份内容已损坏", skill.name));
                    }
                    copy_skill_tree(&previous_path, &target)?;
                    let payload = serde_json::to_string_pretty(previous)
                        .map_err(|error| format!("序列化保留备份元数据失败: {error}"))?;
                    fs::write(staging_metadata.join(format!("{backup_id}.json")), payload)
                        .map_err(|error| format!("写入保留备份元数据失败: {error}"))?;
                    library.skills.push(previous.clone());
                    report.preserved_backup_ids.push(backup_id);
                }
                continue;
            }
        };
        if needs_backup_id {
            skill.instance.backup_id = backup_id.clone();
            report.assigned_backup_ids += 1;
        }
        let tools = skill
            .tools
            .iter()
            .map(|tool| (tool.name.clone(), is_tool_enabled(&tool.status_label)))
            .collect::<BTreeMap<_, _>>();
        let metadata = BackupSkillMetadata {
            schema_version: BACKUP_SCHEMA_VERSION,
            backup_id: backup_id.clone(),
            name: skill.name.clone(),
            directory_name: directory_name(&source, &skill.name),
            source_type: skill.source_type.clone(),
            source_url: skill.source_url.clone(),
            branch: skill.branch.clone(),
            update_driver: skill.instance.update_driver.clone(),
            description: skill.description.clone(),
            tools,
            content_hash,
        };
        let metadata_payload = serde_json::to_string_pretty(&metadata)
            .map_err(|error| format!("序列化 Skill 备份元数据失败: {error}"))?;
        fs::write(
            staging_metadata.join(format!("{backup_id}.json")),
            metadata_payload,
        )
        .map_err(|error| format!("写入 Skill 备份元数据失败: {error}"))?;
        library.skills.push(metadata);
    }
    library
        .skills
        .sort_by(|left, right| left.backup_id.cmp(&right.backup_id));
    let library_payload = serde_json::to_string_pretty(&library)
        .map_err(|error| format!("序列化 Skill 库备份失败: {error}"))?;
    fs::create_dir_all(staging_root.join(".skilldock"))
        .map_err(|error| format!("创建 Skill 库元数据目录失败: {error}"))?;
    fs::write(
        staging_root.join(".skilldock/library.json"),
        library_payload,
    )
    .map_err(|error| format!("写入 Skill 库备份失败: {error}"))?;

    if report.assigned_backup_ids > 0 {
        save_installed_skills(&skills)?;
    }
    fs::create_dir_all(repo_path).map_err(|error| format!("创建备份仓库目录失败: {error}"))?;
    replace_directory(&staging_skills, &repo_path.join("skills"))?;
    replace_directory(
        &staging_root.join(".skilldock"),
        &repo_path.join(".skilldock"),
    )?;
    let _ = fs::remove_dir_all(staging_root);
    report.included_skills = library.skills.len();
    Ok(report)
}

pub fn read_library_snapshot(repo_path: &Path) -> Result<BackupLibrary, String> {
    let path = repo_path.join(".skilldock/library.json");
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("读取备份清单失败 {}: {error}", path.display()))?;
    serde_json::from_str(&contents).map_err(|error| format!("解析备份清单失败: {error}"))
}

fn unique_directory_name(preferred: &str, occupied: &mut BTreeMap<String, usize>) -> String {
    let key = preferred.to_lowercase();
    let count = occupied.entry(key).or_insert(0);
    *count += 1;
    if *count == 1 {
        return preferred.to_string();
    }
    format!("{preferred} ({count})")
}

fn restored_skill(
    metadata: &BackupSkillMetadata,
    restored_name: &str,
    local_path: &Path,
) -> SkillSummary {
    SkillSummary {
        name: restored_name.to_string(),
        source_label: metadata.source_type.clone(),
        source_type: metadata.source_type.clone(),
        source_url: metadata.source_url.clone(),
        description: metadata.description.clone(),
        local_path: local_path.to_string_lossy().to_string(),
        branch: metadata.branch.clone(),
        collab_status: "clean".to_string(),
        status_text: "已从 GitHub 备份恢复".to_string(),
        remote_updated_at: String::new(),
        local_updated_at: String::new(),
        last_synced_at: String::new(),
        last_checked_at: String::new(),
        synced_tool_count: metadata.tools.values().filter(|enabled| **enabled).count(),
        last_editor: String::new(),
        commit_label: String::new(),
        git_linked: false,
        local_change_count: 0,
        lifecycle_source: String::new(),
        owner_plugin_id: String::new(),
        owner_plugin_name: String::new(),
        instance: crate::models::SkillInstanceMetadata {
            backup_id: metadata.backup_id.clone(),
            entry_path: local_path.to_string_lossy().to_string(),
            canonical_path: local_path.to_string_lossy().to_string(),
            management_owner: "skilldock".to_string(),
            update_driver: metadata.update_driver.clone(),
            skill_entries: vec![local_path.to_string_lossy().to_string()],
            ..Default::default()
        },
        tools: metadata
            .tools
            .iter()
            .map(|(name, enabled)| crate::models::ToolSyncStatus {
                name: name.clone(),
                status_label: if *enabled { "已启用" } else { "未启用" }.to_string(),
            })
            .collect(),
    }
}

pub fn apply_library_snapshot(repo_path: &Path) -> Result<Vec<SkillSummary>, String> {
    apply_library_snapshot_preserving(repo_path, &[])
}

pub fn apply_library_snapshot_preserving(
    repo_path: &Path,
    preserved_backup_ids: &[String],
) -> Result<Vec<SkillSummary>, String> {
    let library = read_library_snapshot(repo_path)?;
    let preserved_backup_ids = preserved_backup_ids.iter().collect::<BTreeSet<_>>();
    let managed_root = managed_skill_library_root()?;
    let backup_root_path = backup_root()?;
    let attempt_id = uuid::Uuid::new_v4().to_string();
    let staging_root = backup_root_path.join("staging").join(&attempt_id);
    let rollback_root = backup_root_path.join("rollback").join(&attempt_id);
    let _staging_guard = TemporaryDirectoryGuard::new(staging_root.clone());
    let _rollback_guard = TemporaryDirectoryGuard::new(rollback_root.clone());
    fs::create_dir_all(&staging_root).map_err(|error| format!("创建恢复暂存区失败: {error}"))?;
    fs::create_dir_all(&rollback_root).map_err(|error| format!("创建恢复回滚区失败: {error}"))?;

    let current_skills = load_installed_skills(&[]);
    let current_by_id = current_skills
        .iter()
        .filter(|skill| !skill.instance.backup_id.trim().is_empty())
        .map(|skill| (skill.instance.backup_id.clone(), skill.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut occupied_directories = current_skills
        .iter()
        .filter(|skill| {
            skill.instance.backup_id.trim().is_empty()
                || preserved_backup_ids.contains(&skill.instance.backup_id)
        })
        .filter_map(|skill| Path::new(&skill.local_path).file_name()?.to_str())
        .map(|name| (name.to_lowercase(), 1))
        .collect::<BTreeMap<_, _>>();
    let mut occupied_names = current_skills
        .iter()
        .filter(|skill| {
            skill.instance.backup_id.trim().is_empty()
                || preserved_backup_ids.contains(&skill.instance.backup_id)
        })
        .map(|skill| (skill.name.to_lowercase(), 1))
        .collect::<BTreeMap<_, _>>();
    let mut restored = Vec::new();
    for metadata in &library.skills {
        if preserved_backup_ids.contains(&metadata.backup_id) {
            continue;
        }
        let preferred_name = current_by_id
            .get(&metadata.backup_id)
            .and_then(|skill| Path::new(&skill.local_path).file_name()?.to_str())
            .unwrap_or(&metadata.directory_name);
        let directory_name = unique_directory_name(preferred_name, &mut occupied_directories);
        let restored_name = unique_directory_name(&metadata.name, &mut occupied_names);
        let staged_path = staging_root.join(&directory_name);
        copy_skill_tree(
            &repo_path.join("skills").join(&metadata.backup_id),
            &staged_path,
        )?;
        if !staged_path.join("SKILL.md").is_file() {
            let _ = fs::remove_dir_all(&staging_root);
            return Err(format!("备份 Skill {} 缺少 SKILL.md", metadata.name));
        }
        restored.push(restored_skill(
            metadata,
            &restored_name,
            &managed_root.join(directory_name),
        ));
    }

    let affected_paths = current_skills
        .iter()
        .filter(|skill| {
            !skill.instance.backup_id.trim().is_empty()
                && !preserved_backup_ids.contains(&skill.instance.backup_id)
                && Path::new(&skill.local_path).starts_with(&managed_root)
        })
        .map(|skill| PathBuf::from(&skill.local_path))
        .collect::<Vec<_>>();
    let mut moved_paths = Vec::new();
    for path in &affected_paths {
        if path.exists() {
            let name = path
                .file_name()
                .ok_or_else(|| "恢复 Skill 路径无效".to_string())?;
            let rollback_path = rollback_root.join(name);
            if let Err(error) = fs::rename(path, &rollback_path) {
                for (original_path, moved_path) in moved_paths.into_iter().rev() {
                    let _ = fs::rename(moved_path, original_path);
                }
                return Err(format!("暂存现有 Skill 失败 {}: {error}", path.display()));
            }
            moved_paths.push((path.clone(), rollback_path));
        }
    }
    let apply_result = (|| {
        for skill in &restored {
            let target = PathBuf::from(&skill.local_path);
            let name = target
                .file_name()
                .ok_or_else(|| "恢复 Skill 路径无效".to_string())?;
            fs::rename(staging_root.join(name), &target)
                .map_err(|error| format!("恢复 Skill 失败 {}: {error}", target.display()))?;
        }
        let mut next_skills = current_skills
            .iter()
            .filter(|skill| {
                skill.instance.backup_id.trim().is_empty()
                    || preserved_backup_ids.contains(&skill.instance.backup_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        next_skills.extend(restored.clone());
        save_installed_skills(&next_skills)?;
        Ok::<Vec<SkillSummary>, String>(next_skills)
    })();
    if let Err(error) = apply_result {
        for skill in &restored {
            let target = PathBuf::from(&skill.local_path);
            let _ = fs::remove_dir_all(target);
        }
        if let Ok(entries) = fs::read_dir(&rollback_root) {
            for entry in entries.filter_map(Result::ok) {
                let _ = fs::rename(entry.path(), managed_root.join(entry.file_name()));
            }
        }
        let _ = save_installed_skills(&current_skills);
        return Err(error);
    }
    let _ = fs::remove_dir_all(staging_root);
    let _ = fs::remove_dir_all(rollback_root);
    apply_result
}

fn copy_skill_tree(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("读取恢复来源失败 {}: {error}", source.display()))?;
    if metadata.file_type().is_symlink() {
        return Err("备份中不允许符号链接".to_string());
    }
    if metadata.is_dir() {
        fs::create_dir_all(target)
            .map_err(|error| format!("创建恢复目录失败 {}: {error}", target.display()))?;
        let mut entries = fs::read_dir(source)
            .map_err(|error| format!("读取恢复目录失败 {}: {error}", source.display()))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            copy_skill_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if metadata.is_file() {
        fs::copy(source, target)
            .map_err(|error| format!("复制恢复文件失败 {}: {error}", source.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{copy_skill, should_exclude};
    use std::fs;
    use std::path::Path;

    #[test]
    fn excludes_nested_git_and_secret_files_from_snapshot() {
        let temp_root = std::env::temp_dir().join(format!(
            "skilldock-backup-snapshot-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let source = temp_root.join("source");
        let target = temp_root.join("target");
        fs::create_dir_all(source.join(".git")).expect("create nested git");
        fs::write(source.join("SKILL.md"), "# Example").expect("write skill");
        fs::write(source.join(".env"), "TOKEN=secret").expect("write secret");
        fs::write(source.join(".git/config"), "remote").expect("write git config");

        copy_skill(&source, &target).expect("copy skill snapshot");

        assert!(target.join("SKILL.md").is_file());
        assert!(!target.join(".env").exists());
        assert!(!target.join(".git").exists());
        assert!(should_exclude(Path::new("credentials.json"), false));
        let _ = fs::remove_dir_all(temp_root);
    }
}
