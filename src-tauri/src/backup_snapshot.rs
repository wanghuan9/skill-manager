use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::mcp_manager::{apply_portable_mcp_state, export_portable_mcp_state, PortableMcpState};
use crate::models::SkillSummary;
use crate::plugin_manager::{
    align_portable_plugin_targets, collect_portable_plugin_sources, PortablePluginTarget,
};
use crate::state::{
    apply_portable_preferences, export_portable_preferences, load_installed_skills,
    load_installed_skills_read_only, save_installed_skills, PortablePreferences,
};
use crate::workspace::{home_dir, managed_skill_library_root, WORKSPACE_DIR_NAME};

const BACKUP_SCHEMA_VERSION: u32 = 2;
const PORTABLE_MCP_FILE_NAME: &str = "mcp-servers.json";
const PORTABLE_PREFERENCES_FILE_NAME: &str = "preferences.json";
const PORTABLE_PLUGIN_TARGETS_FILE_NAME: &str = "plugin-targets.json";
const SKILL_FILESYSTEM_MANIFEST_FILE_NAME: &str = "skill-filesystem.json";
const SKILL_FILESYSTEM_DIRECTORY_NAME: &str = "skill-filesystem";
const ENCODED_GIT_DIRECTORY_NAME: &str = ".skilldock-git";
const PORTABLE_PLUGIN_SCHEMA_VERSION: u32 = 1;
const SNAPSHOT_MANIFEST_SCHEMA_VERSION: u32 = 1;
const SKILL_FILESYSTEM_SCHEMA_VERSION: u32 = 1;
const MAX_SKILL_BYTES: u64 = 100 * 1024 * 1024;
const MAX_SKILL_FILESYSTEM_BYTES: u64 = 500 * 1024 * 1024;

pub type SnapshotProgressCallback<'a> = dyn Fn(usize, usize) + 'a;
const EXCLUDED_DIRECTORY_NAMES: [&str; 5] = [".git", "node_modules", "target", ".cache", "tmp"];
const EXCLUDED_FILE_NAMES: [&str; 4] = [
    ".DS_Store",
    "Thumbs.db",
    "settings.json",
    "mcp-servers.json",
];

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
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
    #[serde(default)]
    pub repository_url: String,
    #[serde(default)]
    pub git_head: String,
    #[serde(default)]
    pub repository_relative_path: String,
    #[serde(default)]
    pub git_linked: bool,
    #[serde(default)]
    pub collab_status: String,
    #[serde(default)]
    pub local_change_count: usize,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub enabled_hosts: BTreeMap<String, bool>,
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
struct BackupSkillFilesystemManifest {
    schema_version: u32,
    skill_paths: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshotReport {
    pub included_skills: usize,
    pub included_mcp_servers: usize,
    pub included_plugins: usize,
    pub preferences_included: bool,
    pub excluded_skills: Vec<String>,
    pub warnings: Vec<String>,
    pub assigned_backup_ids: usize,
    pub preserved_backup_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshotManifest {
    pub schema_version: u32,
    pub created_at: String,
    pub device_label: String,
    pub skill_count: usize,
    pub mcp_count: usize,
    pub plugin_count: usize,
}

#[derive(Clone, Debug, Default)]
pub struct PortableWorkspaceRestoreReport {
    pub preferences_applied: bool,
    pub mcp_applied: bool,
    pub restored_plugins: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRestorePreview {
    pub added: usize,
    pub overwritten: usize,
    pub deleted: usize,
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
    Ok(home_dir()?.join(WORKSPACE_DIR_NAME).join("backup"))
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

fn copy_portable_directory(source: &Path, target: &Path) -> Result<String, String> {
    fs::create_dir_all(target)
        .map_err(|error| format!("创建便携备份目录失败 {}: {error}", target.display()))?;
    let mut hasher = Sha256::new();
    let mut total_bytes = 0;
    copy_directory_entry(source, target, Path::new(""), &mut hasher, &mut total_bytes)?;
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Default)]
struct GitSnapshotMetadata {
    repository_url: String,
    head: String,
    relative_path: String,
}

fn run_git(path: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    crate::library::configure_hidden_subprocess(&mut command);
    let output = command
        .current_dir(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("启动 Git 失败 {}: {error}", path.display()))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if message.is_empty() {
        format!("读取 Git 元数据失败 {}: {}", path.display(), args.join(" "))
    } else {
        message
    })
}

fn sanitize_repository_url(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || Path::new(trimmed).is_absolute()
        || trimmed.to_ascii_lowercase().starts_with("file:")
    {
        return String::new();
    }
    let Ok(mut parsed) = url::Url::parse(trimmed) else {
        return trimmed
            .strip_prefix("git@")
            .filter(|destination| {
                !destination.is_empty()
                    && !destination.contains(['?', '#'])
                    && destination.contains(':')
            })
            .map(|destination| format!("git@{destination}"))
            .unwrap_or_default();
    };
    if parsed.host_str().is_none() {
        return trimmed
            .strip_prefix("git@")
            .filter(|destination| {
                !destination.is_empty()
                    && !destination.contains(['?', '#'])
                    && destination.contains(':')
            })
            .map(|destination| format!("git@{destination}"))
            .unwrap_or_default();
    }
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.set_query(None);
    parsed.set_fragment(None);
    parsed.to_string()
}

fn sanitize_git_config(contents: &str) -> String {
    let mut section = String::new();
    let mut lines = Vec::new();
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed.to_ascii_lowercase();
            lines.push(line.to_string());
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            lines.push(line.to_string());
            continue;
        };
        let normalized_key = key.trim().to_ascii_lowercase();
        let sensitive_key = [
            "authorization",
            "credential",
            "extraheader",
            "oauth",
            "password",
            "token",
        ]
        .iter()
        .any(|pattern| normalized_key.contains(pattern));
        let machine_local_include = section.starts_with("[include") && normalized_key == "path";
        if sensitive_key || section.starts_with("[credential") || machine_local_include {
            continue;
        }
        if matches!(normalized_key.as_str(), "url" | "pushurl") {
            let sanitized = sanitize_repository_url(value);
            if !sanitized.is_empty() {
                let indentation = line.len() - line.trim_start().len();
                lines.push(format!(
                    "{}{} = {}",
                    " ".repeat(indentation),
                    key.trim(),
                    sanitized
                ));
            }
            continue;
        }
        lines.push(line.to_string());
    }
    let mut sanitized = lines.join("\n");
    if contents.ends_with('\n') {
        sanitized.push('\n');
    }
    sanitized
}

fn copy_safe_symlink(
    source_root: &Path,
    source: &Path,
    target: &Path,
    relative_path: &Path,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let link_target = fs::read_link(source)
        .map_err(|error| format!("读取 Skill 符号链接失败 {}: {error}", source.display()))?;
    let resolved = source
        .parent()
        .unwrap_or(source_root)
        .join(&link_target)
        .canonicalize()
        .ok();
    let canonical_root = source_root.canonicalize().ok();
    if link_target.is_absolute()
        || !matches!(
            (resolved.as_ref(), canonical_root.as_ref()),
            (Some(path), Some(root)) if path.starts_with(root)
        )
    {
        warnings.push(format!(
            "已跳过指向 Skill 目录外的符号链接: {}",
            relative_path.display()
        ));
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 Skill 符号链接目录失败: {error}"))?;
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&link_target, target)
            .map_err(|error| format!("备份 Skill 符号链接失败 {}: {error}", target.display()))?;
    }
    #[cfg(windows)]
    {
        let resolved = resolved.expect("validated symlink target");
        let result = if resolved.is_dir() {
            std::os::windows::fs::symlink_dir(&link_target, target)
        } else {
            std::os::windows::fs::symlink_file(&link_target, target)
        };
        result.map_err(|error| format!("备份 Skill 符号链接失败 {}: {error}", target.display()))?;
    }
    Ok(())
}

fn copy_skill_filesystem_entry(
    source_root: &Path,
    source: &Path,
    target: &Path,
    relative_path: &Path,
    inside_git: bool,
    total_bytes: &mut u64,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("读取 Skill 文件系统失败 {}: {error}", source.display()))?;
    if metadata.file_type().is_symlink() {
        return copy_safe_symlink(source_root, source, target, relative_path, warnings);
    }
    if metadata.is_dir() {
        if !inside_git && should_exclude(relative_path, true) {
            return Ok(());
        }
        fs::create_dir_all(target)
            .map_err(|error| format!("创建 Skill 文件系统快照目录失败: {error}"))?;
        let mut entries = fs::read_dir(source)
            .map_err(|error| format!("读取 Skill 文件系统目录失败 {}: {error}", source.display()))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name();
            let name_text = name.to_string_lossy();
            if name_text == ENCODED_GIT_DIRECTORY_NAME {
                return Err(format!(
                    "Skill 目录包含备份保留名称 {}，无法安全备份",
                    ENCODED_GIT_DIRECTORY_NAME
                ));
            }
            let child_source = entry.path();
            let child_relative = relative_path.join(&name);
            let child_inside_git = inside_git || name_text == ".git";
            let child_target = if name_text == ".git" {
                if !child_source.is_dir() {
                    return Err(format!(
                        "暂不支持 Git worktree 形式的 .git 文件: {}",
                        child_relative.display()
                    ));
                }
                target.join(ENCODED_GIT_DIRECTORY_NAME)
            } else {
                target.join(&name)
            };
            copy_skill_filesystem_entry(
                source_root,
                &child_source,
                &child_target,
                &child_relative,
                child_inside_git,
                total_bytes,
                warnings,
            )?;
        }
        return Ok(());
    }
    if !metadata.is_file() || (!inside_git && should_exclude(relative_path, false)) {
        return Ok(());
    }
    *total_bytes = total_bytes.saturating_add(metadata.len());
    if *total_bytes > MAX_SKILL_FILESYSTEM_BYTES {
        return Err("Skill 文件系统超过 500 MB 备份上限".to_string());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 Skill 文件系统快照目录失败: {error}"))?;
    }
    if inside_git
        && matches!(
            source.file_name().and_then(|name| name.to_str()),
            Some("config" | "config.worktree")
        )
    {
        let contents = fs::read_to_string(source)
            .map_err(|error| format!("读取 Git 配置失败 {}: {error}", source.display()))?;
        fs::write(target, sanitize_git_config(&contents))
            .map_err(|error| format!("写入脱敏 Git 配置失败 {}: {error}", target.display()))?;
        return Ok(());
    }
    fs::copy(source, target)
        .map(|_| ())
        .map_err(|error| format!("复制 Skill 文件系统失败 {}: {error}", source.display()))
}

fn write_skill_filesystem_snapshot(
    managed_root: &Path,
    staging_root: &Path,
    skill_paths: BTreeMap<String, String>,
    warnings: &mut Vec<String>,
    progress: Option<&SnapshotProgressCallback<'_>>,
) -> Result<(), String> {
    let target = staging_root.join(SKILL_FILESYSTEM_DIRECTORY_NAME);
    let mut total_bytes = 0;
    if managed_root.is_dir() {
        fs::create_dir_all(&target)
            .map_err(|error| format!("创建 Skill 文件系统快照失败: {error}"))?;
        let mut entries = fs::read_dir(managed_root)
            .map_err(|error| format!("读取 Skill 文件系统失败: {error}"))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        let entry_count = entries.len();
        for (index, entry) in entries.into_iter().enumerate() {
            let name = entry.file_name();
            let name_text = name.to_string_lossy();
            if name_text == ENCODED_GIT_DIRECTORY_NAME {
                return Err(format!(
                    "Skill 目录包含备份保留名称 {}，无法安全备份",
                    ENCODED_GIT_DIRECTORY_NAME
                ));
            }
            let child_source = entry.path();
            let child_inside_git = name_text == ".git";
            let child_target = if child_inside_git {
                target.join(ENCODED_GIT_DIRECTORY_NAME)
            } else {
                target.join(&name)
            };
            copy_skill_filesystem_entry(
                managed_root,
                &child_source,
                &child_target,
                Path::new(&name),
                child_inside_git,
                &mut total_bytes,
                warnings,
            )?;
            if let Some(report) = progress {
                report(index + 1, entry_count);
            }
        }
    } else {
        fs::create_dir_all(&target)
            .map_err(|error| format!("创建空 Skill 文件系统快照失败: {error}"))?;
    }
    let manifest = BackupSkillFilesystemManifest {
        schema_version: SKILL_FILESYSTEM_SCHEMA_VERSION,
        skill_paths,
    };
    let payload = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("序列化 Skill 文件系统清单失败: {error}"))?;
    fs::write(
        staging_root
            .join(".skilldock")
            .join(SKILL_FILESYSTEM_MANIFEST_FILE_NAME),
        payload,
    )
    .map_err(|error| format!("写入 Skill 文件系统清单失败: {error}"))
}

fn git_snapshot_metadata(
    skill: &SkillSummary,
    skill_path: &Path,
) -> Result<GitSnapshotMetadata, String> {
    let requires_git = skill.git_linked || skill.instance.update_driver == "git";
    let root = match run_git(skill_path, &["rev-parse", "--show-toplevel"]) {
        Ok(root) => PathBuf::from(root),
        Err(error) if requires_git => return Err(error),
        Err(_) => return Ok(GitSnapshotMetadata::default()),
    };
    let relative_path = skill_path
        .canonicalize()
        .ok()
        .and_then(|path| {
            let root = root.canonicalize().ok()?;
            path.strip_prefix(root)
                .ok()
                .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        })
        .unwrap_or_default();
    let repository_url = run_git(&root, &["config", "--get", "remote.origin.url"])
        .ok()
        .map(|value| sanitize_repository_url(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| sanitize_repository_url(&skill.source_url));
    let head = run_git(&root, &["rev-parse", "HEAD"])?;
    if requires_git && head.is_empty() {
        return Err(format!("Git Skill {} 缺少可恢复的 HEAD", skill.name));
    }
    Ok(GitSnapshotMetadata {
        repository_url,
        head,
        relative_path,
    })
}

fn deterministic_backup_id(skill: &SkillSummary, source: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(skill.source_type.trim().as_bytes());
    hasher.update([0]);
    hasher.update(sanitize_repository_url(&skill.source_url).as_bytes());
    hasher.update([0]);
    hasher.update(
        source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&skill.name)
            .as_bytes(),
    );
    let digest = format!("{:x}", hasher.finalize());
    format!("skill-{}", &digest[..32])
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

fn write_portable_preferences(staging_root: &Path) -> Result<bool, String> {
    let preferences = export_portable_preferences();
    let payload = serde_json::to_string_pretty(&preferences)
        .map_err(|error| format!("序列化便携偏好失败: {error}"))?;
    let metadata_root = staging_root.join(".skilldock");
    fs::create_dir_all(&metadata_root).map_err(|error| format!("创建便携偏好目录失败: {error}"))?;
    fs::write(metadata_root.join(PORTABLE_PREFERENCES_FILE_NAME), payload)
        .map_err(|error| format!("写入便携偏好失败: {error}"))?;
    Ok(true)
}

fn write_portable_mcp_state(staging_root: &Path) -> Result<usize, String> {
    let state = export_portable_mcp_state()?;
    let server_count = state.servers.len();
    let payload = serde_json::to_string_pretty(&state)
        .map_err(|error| format!("序列化便携 MCP 失败: {error}"))?;
    let metadata_root = staging_root.join(".skilldock");
    fs::create_dir_all(&metadata_root)
        .map_err(|error| format!("创建便携 MCP 目录失败: {error}"))?;
    fs::write(metadata_root.join(PORTABLE_MCP_FILE_NAME), payload)
        .map_err(|error| format!("写入便携 MCP 失败: {error}"))?;
    Ok(server_count)
}

fn write_portable_plugins(staging_root: &Path) -> Result<usize, String> {
    let plugins_root = staging_root.join("plugins");
    let legacy_cursor_disabled_root = staging_root.join("cursor-disabled");
    fs::create_dir_all(&plugins_root).map_err(|error| format!("创建插件备份目录失败: {error}"))?;
    fs::create_dir_all(&legacy_cursor_disabled_root)
        .map_err(|error| format!("创建兼容插件备份目录失败: {error}"))?;

    let mut targets = Vec::new();
    for source in collect_portable_plugin_sources()? {
        let target = plugins_root.join(&source.directory_name);
        let content_hash = copy_portable_directory(&source.source_root, &target)?;
        targets.push(PortablePluginTarget {
            schema_version: PORTABLE_PLUGIN_SCHEMA_VERSION,
            package_id: source.package_id,
            directory_name: source.directory_name,
            host_tools: source.host_tools,
            cursor_was_disabled: source.cursor_was_disabled,
            disabled_host_tools: source.disabled_host_tools,
            plugin_relative_path: source.plugin_relative_path,
            content_hash,
        });
    }
    targets.sort_by(|left, right| {
        left.cursor_was_disabled
            .cmp(&right.cursor_was_disabled)
            .then(left.package_id.cmp(&right.package_id))
    });
    let payload = serde_json::to_string_pretty(&targets)
        .map_err(|error| format!("序列化插件目标失败: {error}"))?;
    fs::write(
        staging_root
            .join(".skilldock")
            .join(PORTABLE_PLUGIN_TARGETS_FILE_NAME),
        payload,
    )
    .map_err(|error| format!("写入插件目标失败: {error}"))?;
    Ok(targets.len())
}

fn portable_device_label() -> String {
    #[cfg(target_os = "macos")]
    {
        let model = Command::new("sysctl")
            .args(["-n", "hw.model"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_default();
        for (prefix, label) in [
            ("MacBookPro", "MacBook Pro"),
            ("MacBookAir", "MacBook Air"),
            ("Macmini", "Mac mini"),
            ("MacPro", "Mac Pro"),
            ("iMac", "iMac"),
        ] {
            if model.starts_with(prefix) {
                return label.to_string();
            }
        }
        return "Mac".to_string();
    }
    #[cfg(target_os = "windows")]
    {
        "Windows PC".to_string()
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        "Linux".to_string()
    }
}

fn write_snapshot_manifest(
    staging_root: &Path,
    report: &BackupSnapshotReport,
) -> Result<(), String> {
    let manifest = BackupSnapshotManifest {
        schema_version: SNAPSHOT_MANIFEST_SCHEMA_VERSION,
        created_at: Utc::now().to_rfc3339(),
        device_label: portable_device_label(),
        skill_count: report.included_skills,
        mcp_count: report.included_mcp_servers,
        plugin_count: report.included_plugins,
    };
    let payload = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("序列化备份节点清单失败: {error}"))?;
    fs::write(staging_root.join(".skilldock/snapshot.json"), payload)
        .map_err(|error| format!("写入备份节点清单失败: {error}"))
}

pub fn write_current_library_snapshot(repo_path: &Path) -> Result<BackupSnapshotReport, String> {
    write_current_library_snapshot_with_progress(repo_path, None)
}

pub fn write_current_library_snapshot_with_progress(
    repo_path: &Path,
    progress: Option<&SnapshotProgressCallback<'_>>,
) -> Result<BackupSnapshotReport, String> {
    let skills = load_installed_skills_read_only(&[]);
    let previous_skills = read_library_snapshot(repo_path)
        .unwrap_or_default()
        .skills
        .into_iter()
        .map(|skill| (skill.backup_id.clone(), skill))
        .collect::<BTreeMap<_, _>>();
    let managed_root = managed_skill_library_root()?;
    let eligible_skills = skills
        .iter()
        .filter(|skill| {
            let source = skill_path(skill);
            source.starts_with(&managed_root) && skill.instance.update_driver != "agent-skills-cli"
        })
        .collect::<Vec<_>>();
    let tool_states_by_skill = crate::commands::backup_skill_tool_states(&eligible_skills);
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
    let mut skill_paths = BTreeMap::new();
    let mut library = BackupLibrary {
        schema_version: BACKUP_SCHEMA_VERSION,
        skills: Vec::new(),
    };
    for (skill, tool_states) in eligible_skills.into_iter().zip(tool_states_by_skill) {
        let source = skill_path(skill);
        let needs_backup_id = skill.instance.backup_id.trim().is_empty();
        let backup_id = if needs_backup_id {
            deterministic_backup_id(skill, &source)
        } else {
            skill.instance.backup_id.clone()
        };
        let relative_path = source
            .strip_prefix(&managed_root)
            .map_err(|_| format!("Skill 不在托管目录中: {}", source.display()))?;
        validate_relative_path(relative_path)?;
        skill_paths.insert(
            backup_id.clone(),
            relative_path.to_string_lossy().replace('\\', "/"),
        );
        let git = match git_snapshot_metadata(skill, &source) {
            Ok(metadata) => metadata,
            Err(error) => {
                report
                    .excluded_skills
                    .push(format!("{}: {error}", skill.name));
                if let Some(previous) = previous_skills.get(&backup_id) {
                    let previous_path = repo_path.join("skills").join(&backup_id);
                    if !previous_path.is_dir() {
                        return Err(format!("{} 的上一版备份内容已损坏", skill.name));
                    }
                    let target = staging_skills.join(&backup_id);
                    copy_skill_tree(&previous_path, &target)?;
                    let payload = serde_json::to_string_pretty(previous)
                        .map_err(|error| format!("序列化保留备份元数据失败: {error}"))?;
                    fs::write(staging_metadata.join(format!("{backup_id}.json")), payload)
                        .map_err(|error| format!("写入保留备份元数据失败: {error}"))?;
                    library.skills.push(previous.clone());
                    report.preserved_backup_ids.push(backup_id);
                } else if !needs_backup_id {
                    return Err(format!(
                        "{} 无法读取 Git 元数据且没有可保留的上一版备份",
                        skill.name
                    ));
                }
                continue;
            }
        };
        let target = staging_skills.join(&backup_id);
        let content_hash = match copy_skill(&source, &target) {
            Ok(hash) => hash,
            Err(error) => {
                let _ = fs::remove_dir_all(&target);
                report
                    .excluded_skills
                    .push(format!("{}: {error}", skill.name));
                if let Some(previous) = previous_skills.get(&backup_id) {
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
                } else if !needs_backup_id {
                    let _ = fs::remove_dir_all(&staging_root);
                    return Err(format!("{} 无法读取且没有可保留的上一版备份", skill.name));
                }
                continue;
            }
        };
        if needs_backup_id {
            report.assigned_backup_ids += 1;
        }
        let enabled_hosts = tool_states
            .iter()
            .map(|(id, _, enabled)| (id.clone(), *enabled))
            .collect::<BTreeMap<_, _>>();
        let tools = tool_states
            .into_iter()
            .map(|(_, name, enabled)| (name, enabled))
            .collect::<BTreeMap<_, _>>();
        let metadata = BackupSkillMetadata {
            schema_version: BACKUP_SCHEMA_VERSION,
            backup_id: backup_id.clone(),
            name: skill.name.clone(),
            directory_name: directory_name(&source, &skill.name),
            source_type: skill.source_type.clone(),
            source_url: sanitize_repository_url(&skill.source_url),
            branch: skill.branch.clone(),
            update_driver: skill.instance.update_driver.clone(),
            description: skill.description.clone(),
            repository_url: git.repository_url,
            git_head: git.head,
            repository_relative_path: git.relative_path,
            git_linked: skill.git_linked,
            collab_status: skill.collab_status.clone(),
            local_change_count: skill.local_change_count,
            tag: skill.instance.tag.clone(),
            enabled_hosts,
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
    write_skill_filesystem_snapshot(
        &managed_root,
        &staging_root,
        skill_paths,
        &mut report.warnings,
        progress,
    )?;
    report.preferences_included = write_portable_preferences(&staging_root)?;
    report.included_mcp_servers = write_portable_mcp_state(&staging_root)?;
    report.included_plugins = write_portable_plugins(&staging_root)?;
    report.included_skills = library.skills.len();
    write_snapshot_manifest(&staging_root, &report)?;

    fs::create_dir_all(repo_path).map_err(|error| format!("创建备份仓库目录失败: {error}"))?;
    replace_directory(&staging_skills, &repo_path.join("skills"))?;
    replace_directory(
        &staging_root.join(SKILL_FILESYSTEM_DIRECTORY_NAME),
        &repo_path.join(SKILL_FILESYSTEM_DIRECTORY_NAME),
    )?;
    replace_directory(
        &staging_root.join(".skilldock"),
        &repo_path.join(".skilldock"),
    )?;
    replace_directory(&staging_root.join("plugins"), &repo_path.join("plugins"))?;
    replace_directory(
        &staging_root.join("cursor-disabled"),
        &repo_path.join("cursor-disabled"),
    )?;
    let _ = fs::remove_dir_all(staging_root);
    Ok(report)
}

pub fn current_workspace_has_backup_data() -> Result<bool, String> {
    let managed_root = managed_skill_library_root()?;
    let has_skill_files = managed_root.is_dir()
        && fs::read_dir(&managed_root)
            .map_err(|error| format!("读取本机 Skill 目录失败: {error}"))?
            .next()
            .is_some();
    if has_skill_files || !export_portable_mcp_state()?.servers.is_empty() {
        return Ok(true);
    }
    Ok(!collect_portable_plugin_sources()?.is_empty())
}

pub fn read_library_snapshot(repo_path: &Path) -> Result<BackupLibrary, String> {
    let path = repo_path.join(".skilldock/library.json");
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("读取备份清单失败 {}: {error}", path.display()))?;
    serde_json::from_str(&contents).map_err(|error| format!("解析备份清单失败: {error}"))
}

fn read_optional_json<T>(path: &Path) -> Result<Option<T>, String>
where
    T: for<'de> Deserialize<'de>,
{
    if !path.is_file() {
        return Ok(None);
    }
    let payload = fs::read_to_string(path)
        .map_err(|error| format!("读取便携备份失败 {}: {error}", path.display()))?;
    serde_json::from_str(&payload)
        .map(Some)
        .map_err(|error| format!("解析便携备份失败 {}: {error}", path.display()))
}

pub fn preview_workspace_restore(repo_path: &Path) -> Result<WorkspaceRestorePreview, String> {
    let managed_root = managed_skill_library_root()?;
    let current_skills = load_installed_skills_read_only(&[]);
    let current_skill_keys = current_skills
        .iter()
        .filter(|skill| {
            Path::new(&skill.local_path).starts_with(&managed_root)
                && (skill.instance.management_owner == "skilldock"
                    || !skill.instance.backup_id.trim().is_empty())
        })
        .map(|skill| {
            if skill.instance.backup_id.trim().is_empty() {
                format!("skill:local:{}", skill.local_path)
            } else {
                format!("skill:{}", skill.instance.backup_id)
            }
        });
    let remote_skill_keys = read_library_snapshot(repo_path)?
        .skills
        .into_iter()
        .map(|skill| format!("skill:{}", skill.backup_id));
    let current_mcp_keys = export_portable_mcp_state()?
        .servers
        .into_iter()
        .map(|server| format!("mcp:{}", server.id));
    let remote_mcp_keys = read_optional_json::<PortableMcpState>(
        &repo_path.join(".skilldock").join(PORTABLE_MCP_FILE_NAME),
    )?
    .unwrap_or_default()
    .servers
    .into_iter()
    .map(|server| format!("mcp:{}", server.id));
    let current_plugin_keys = collect_portable_plugin_sources()?
        .into_iter()
        .map(|plugin| {
            format!(
                "plugin:{}:{}",
                plugin.cursor_was_disabled, plugin.directory_name
            )
        });
    let remote_plugin_keys = read_optional_json::<Vec<PortablePluginTarget>>(
        &repo_path
            .join(".skilldock")
            .join(PORTABLE_PLUGIN_TARGETS_FILE_NAME),
    )?
    .unwrap_or_default()
    .into_iter()
    .map(|plugin| {
        format!(
            "plugin:{}:{}",
            plugin.cursor_was_disabled, plugin.directory_name
        )
    });
    let current = current_skill_keys
        .chain(current_mcp_keys)
        .chain(current_plugin_keys)
        .collect::<BTreeSet<_>>();
    let remote = remote_skill_keys
        .chain(remote_mcp_keys)
        .chain(remote_plugin_keys)
        .collect::<BTreeSet<_>>();
    let preferences_changed = read_optional_json::<PortablePreferences>(
        &repo_path
            .join(".skilldock")
            .join(PORTABLE_PREFERENCES_FILE_NAME),
    )?
    .is_some_and(|preferences| preferences != export_portable_preferences());
    Ok(WorkspaceRestorePreview {
        added: remote.difference(&current).count(),
        overwritten: remote.intersection(&current).count() + usize::from(preferences_changed),
        deleted: current.difference(&remote).count(),
    })
}

fn restore_plugin_directory(source: &Path, target: &Path) -> Result<bool, String> {
    if target.exists() {
        fs::remove_dir_all(target)
            .map_err(|error| format!("清理本机插件目录失败 {}: {error}", target.display()))?;
    }
    copy_skill_tree(source, target)?;
    Ok(true)
}

pub fn apply_portable_workspace_snapshot(
    repo_path: &Path,
) -> Result<PortableWorkspaceRestoreReport, String> {
    let metadata_root = repo_path.join(".skilldock");
    let mut report = PortableWorkspaceRestoreReport::default();

    if let Some(preferences) = read_optional_json::<PortablePreferences>(
        &metadata_root.join(PORTABLE_PREFERENCES_FILE_NAME),
    )? {
        report.preferences_applied = apply_portable_preferences(&preferences, true)?;
    }
    if let Some(mcp_state) =
        read_optional_json::<PortableMcpState>(&metadata_root.join(PORTABLE_MCP_FILE_NAME))?
    {
        report.mcp_applied = apply_portable_mcp_state(&mcp_state, true)?;
    }

    let Some(targets) = read_optional_json::<Vec<PortablePluginTarget>>(
        &metadata_root.join(PORTABLE_PLUGIN_TARGETS_FILE_NAME),
    )?
    else {
        return Ok(report);
    };
    let home_dir = home_dir()?;
    let managed_root = home_dir.join(WORKSPACE_DIR_NAME).join("plugins");
    let cursor_disabled_root = home_dir
        .join(WORKSPACE_DIR_NAME)
        .join("disabled-plugins/cursor");
    for root in [&managed_root, &cursor_disabled_root] {
        if root.exists() {
            fs::remove_dir_all(root)
                .map_err(|error| format!("清理便携插件范围失败 {}: {error}", root.display()))?;
        }
    }
    for target in &targets {
        let source = [repo_path.join("plugins"), repo_path.join("cursor-disabled")]
            .into_iter()
            .map(|root| root.join(&target.directory_name))
            .find(|candidate| candidate.is_dir())
            .unwrap_or_else(|| repo_path.join("plugins").join(&target.directory_name));
        if !source.is_dir() {
            report
                .warnings
                .push(format!("插件备份缺失，已跳过: {}", target.package_id));
            continue;
        }
        let destination = managed_root.join(&target.directory_name);
        if restore_plugin_directory(&source, &destination)? {
            report.restored_plugins += 1;
        }
    }
    report
        .warnings
        .extend(align_portable_plugin_targets(&targets)?);
    Ok(report)
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

fn host_display_name(host_id: &str) -> String {
    match host_id {
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        "cursor" => "Cursor",
        "gemini" | "gemini-cli" => "Gemini CLI",
        "opencode" => "OpenCode",
        "windsurf" | "devin" => "Devin",
        value => value,
    }
    .to_string()
}

fn requires_git_restore(metadata: &BackupSkillMetadata) -> bool {
    metadata.git_linked
        || metadata.update_driver == "git"
        || (metadata.source_type != "local" && !metadata.source_url.trim().is_empty())
}

fn restored_skill(
    metadata: &BackupSkillMetadata,
    restored_name: &str,
    local_path: &Path,
) -> SkillSummary {
    restored_skill_with_git_state(metadata, restored_name, local_path, metadata.git_linked)
}

fn restored_skill_with_git_state(
    metadata: &BackupSkillMetadata,
    restored_name: &str,
    local_path: &Path,
    git_linked: bool,
) -> SkillSummary {
    SkillSummary {
        name: restored_name.to_string(),
        source_label: metadata.source_type.clone(),
        source_type: metadata.source_type.clone(),
        source_url: metadata.source_url.clone(),
        description: metadata.description.clone(),
        local_path: local_path.to_string_lossy().to_string(),
        branch: metadata.branch.clone(),
        collab_status: if metadata.collab_status.trim().is_empty() {
            "clean".to_string()
        } else {
            metadata.collab_status.clone()
        },
        status_text: "已从 GitHub 备份恢复".to_string(),
        remote_updated_at: String::new(),
        local_updated_at: String::new(),
        last_synced_at: String::new(),
        last_checked_at: String::new(),
        synced_tool_count: if metadata.enabled_hosts.is_empty() {
            metadata.tools.values().filter(|enabled| **enabled).count()
        } else {
            metadata
                .enabled_hosts
                .values()
                .filter(|enabled| **enabled)
                .count()
        },
        last_editor: String::new(),
        commit_label: String::new(),
        git_linked,
        local_change_count: metadata.local_change_count,
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
            tag: metadata.tag.clone(),
            ..Default::default()
        },
        tools: if metadata.enabled_hosts.is_empty() {
            metadata.tools.clone()
        } else {
            metadata
                .enabled_hosts
                .iter()
                .map(|(id, enabled)| (host_display_name(id), *enabled))
                .collect()
        }
        .iter()
        .map(|(name, enabled)| crate::models::ToolSyncStatus {
            name: name.to_string(),
            status_label: if *enabled { "已启用" } else { "未启用" }.to_string(),
        })
        .collect(),
    }
}

fn stage_exact_skill(
    repo_path: &Path,
    metadata: &BackupSkillMetadata,
    staging_root: &Path,
    occupied_directories: &mut BTreeMap<String, usize>,
) -> Result<SkillSummary, String> {
    let snapshot_path = repo_path.join("skills").join(&metadata.backup_id);
    if !snapshot_path.join("SKILL.md").is_file() {
        return Err(format!("备份 Skill {} 缺少 SKILL.md", metadata.name));
    }
    let directory_name = unique_directory_name(&metadata.directory_name, occupied_directories);
    let staged_path = staging_root.join(&directory_name);
    copy_skill_tree(&snapshot_path, &staged_path)?;
    Ok(restored_skill_with_git_state(
        metadata,
        &metadata.name,
        &managed_skill_library_root()?.join(directory_name),
        false,
    ))
}

fn copy_restored_skill_filesystem_entry(
    snapshot_root: &Path,
    source: &Path,
    target: &Path,
    relative_path: &Path,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("读取 Skill 文件系统快照失败 {}: {error}", source.display()))?;
    if metadata.file_type().is_symlink() {
        let mut warnings = Vec::new();
        copy_safe_symlink(snapshot_root, source, target, relative_path, &mut warnings)?;
        if warnings.is_empty() {
            return Ok(());
        }
        return Err(warnings.join("；"));
    }
    if metadata.is_dir() {
        fs::create_dir_all(target)
            .map_err(|error| format!("创建 Skill 恢复暂存目录失败: {error}"))?;
        let mut entries = fs::read_dir(source)
            .map_err(|error| format!("读取 Skill 恢复快照目录失败: {error}"))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name();
            let name_text = name.to_string_lossy();
            if name_text == ".git" {
                return Err("Skill 文件系统快照包含未编码的 .git 目录".to_string());
            }
            let restored_name = if name_text == ENCODED_GIT_DIRECTORY_NAME {
                ".git".into()
            } else {
                name.clone()
            };
            copy_restored_skill_filesystem_entry(
                snapshot_root,
                &entry.path(),
                &target.join(restored_name),
                &relative_path.join(name),
            )?;
        }
        return Ok(());
    }
    if metadata.is_file() {
        fs::copy(source, target)
            .map(|_| ())
            .map_err(|error| format!("复制 Skill 恢复文件失败 {}: {error}", source.display()))?;
    }
    Ok(())
}

fn apply_skill_filesystem_snapshot_replace(
    repo_path: &Path,
    progress: Option<&SnapshotProgressCallback<'_>>,
) -> Result<Vec<SkillSummary>, String> {
    let manifest_path = repo_path
        .join(".skilldock")
        .join(SKILL_FILESYSTEM_MANIFEST_FILE_NAME);
    let manifest = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("读取 Skill 文件系统清单失败: {error}"))
        .and_then(|payload| {
            serde_json::from_str::<BackupSkillFilesystemManifest>(&payload)
                .map_err(|error| format!("解析 Skill 文件系统清单失败: {error}"))
        })?;
    if manifest.schema_version != SKILL_FILESYSTEM_SCHEMA_VERSION {
        return Err(format!(
            "不支持的 Skill 文件系统快照版本: {}",
            manifest.schema_version
        ));
    }
    let snapshot_root = repo_path.join(SKILL_FILESYSTEM_DIRECTORY_NAME);
    if !snapshot_root.is_dir() {
        return Err("Skill 文件系统快照目录缺失".to_string());
    }
    let library = read_library_snapshot(repo_path)?;
    let managed_root = managed_skill_library_root()?;
    let current_skills = load_installed_skills(&[]);
    let preserved_skills = current_skills
        .iter()
        .filter(|skill| !Path::new(&skill.local_path).starts_with(&managed_root))
        .cloned()
        .collect::<Vec<_>>();
    let operation_id = uuid::Uuid::new_v4().to_string();
    let operation_staging = backup_root()?.join("staging").join(&operation_id);
    let operation_rollback = backup_root()?.join("rollback").join(&operation_id);
    let staged_root = operation_staging.join("skills");
    let rollback_root = operation_rollback.join("skills");
    let _staging_guard = TemporaryDirectoryGuard::new(operation_staging.clone());
    let _rollback_guard = TemporaryDirectoryGuard::new(operation_rollback.clone());
    fs::create_dir_all(&operation_staging)
        .map_err(|error| format!("创建 Skill 恢复暂存区失败: {error}"))?;
    fs::create_dir_all(&operation_rollback)
        .map_err(|error| format!("创建 Skill 恢复回滚区失败: {error}"))?;
    fs::create_dir_all(&staged_root)
        .map_err(|error| format!("创建 Skill 恢复暂存目录失败: {error}"))?;
    let mut entries = fs::read_dir(&snapshot_root)
        .map_err(|error| format!("读取 Skill 恢复快照目录失败: {error}"))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    let entry_count = entries.len();
    for (index, entry) in entries.into_iter().enumerate() {
        let name = entry.file_name();
        let restored_name = if name.to_string_lossy() == ENCODED_GIT_DIRECTORY_NAME {
            ".git".into()
        } else {
            name.clone()
        };
        copy_restored_skill_filesystem_entry(
            &snapshot_root,
            &entry.path(),
            &staged_root.join(restored_name),
            Path::new(&name),
        )?;
        if let Some(report) = progress {
            report(index + 1, entry_count);
        }
    }

    let mut restored = Vec::new();
    for metadata in &library.skills {
        let relative_path = manifest
            .skill_paths
            .get(&metadata.backup_id)
            .ok_or_else(|| format!("Skill {} 缺少文件系统路径", metadata.name))?;
        let relative_path = Path::new(relative_path);
        validate_relative_path(relative_path)?;
        if !staged_root.join(relative_path).join("SKILL.md").is_file() {
            return Err(format!("Skill {} 的文件系统快照不完整", metadata.name));
        }
        restored.push(restored_skill(
            metadata,
            &metadata.name,
            &managed_root.join(relative_path),
        ));
    }

    if let Some(parent) = managed_root.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建 Skill 托管目录失败: {error}"))?;
    }
    let had_managed_root = managed_root.exists();
    if had_managed_root {
        fs::rename(&managed_root, &rollback_root)
            .map_err(|error| format!("暂存本机 Skill 目录失败: {error}"))?;
    }
    if let Err(error) = fs::rename(&staged_root, &managed_root) {
        if had_managed_root {
            let _ = fs::rename(&rollback_root, &managed_root);
        }
        return Err(format!("应用 Skill 文件系统快照失败: {error}"));
    }

    let mut next_skills = preserved_skills;
    next_skills.extend(restored);
    if let Err(error) = save_installed_skills(&next_skills) {
        let _ = fs::remove_dir_all(&managed_root);
        if had_managed_root {
            let _ = fs::rename(&rollback_root, &managed_root);
        }
        let _ = save_installed_skills(&current_skills);
        return Err(error);
    }
    Ok(next_skills)
}

#[cfg(test)]
pub fn apply_library_snapshot_replace(repo_path: &Path) -> Result<Vec<SkillSummary>, String> {
    apply_library_snapshot_replace_with_progress(repo_path, None)
}

pub fn apply_library_snapshot_replace_with_progress(
    repo_path: &Path,
    progress: Option<&SnapshotProgressCallback<'_>>,
) -> Result<Vec<SkillSummary>, String> {
    if repo_path
        .join(".skilldock")
        .join(SKILL_FILESYSTEM_MANIFEST_FILE_NAME)
        .is_file()
    {
        return apply_skill_filesystem_snapshot_replace(repo_path, progress);
    }
    let library = read_library_snapshot(repo_path)?;
    let managed_root = managed_skill_library_root()?;
    fs::create_dir_all(&managed_root).map_err(|error| {
        format!(
            "创建 Skill 托管目录失败 {}: {error}",
            managed_root.display()
        )
    })?;
    let current_skills = load_installed_skills(&[]);
    let is_managed = |skill: &SkillSummary| {
        Path::new(&skill.local_path).starts_with(&managed_root)
            && (skill.instance.management_owner == "skilldock"
                || !skill.instance.backup_id.trim().is_empty())
    };
    let preserved_skills = current_skills
        .iter()
        .filter(|skill| !is_managed(skill))
        .cloned()
        .collect::<Vec<_>>();
    let mut occupied_directories = preserved_skills
        .iter()
        .filter_map(|skill| {
            let relative = Path::new(&skill.local_path)
                .strip_prefix(&managed_root)
                .ok()?;
            relative.components().next()?.as_os_str().to_str()
        })
        .map(|name| (name.to_lowercase(), 1))
        .collect::<BTreeMap<_, _>>();
    let operation_id = uuid::Uuid::new_v4().to_string();
    let backup_root_path = backup_root()?;
    let staging_root = backup_root_path.join("staging").join(&operation_id);
    let rollback_root = backup_root_path.join("rollback").join(&operation_id);
    let _staging_guard = TemporaryDirectoryGuard::new(staging_root.clone());
    let _rollback_guard = TemporaryDirectoryGuard::new(rollback_root.clone());
    fs::create_dir_all(&staging_root).map_err(|error| format!("创建恢复暂存区失败: {error}"))?;
    fs::create_dir_all(&rollback_root).map_err(|error| format!("创建恢复回滚区失败: {error}"))?;

    let mut restored = Vec::new();
    let skill_count = library.skills.len();
    for (index, metadata) in library.skills.iter().enumerate() {
        restored.push(stage_exact_skill(
            repo_path,
            metadata,
            &staging_root,
            &mut occupied_directories,
        )?);
        if let Some(report) = progress {
            report(index + 1, skill_count);
        }
    }

    let managed_top_level = current_skills
        .iter()
        .filter(|skill| is_managed(skill))
        .filter_map(|skill| {
            let relative = Path::new(&skill.local_path)
                .strip_prefix(&managed_root)
                .ok()?;
            let name = relative.components().next()?.as_os_str();
            Some(managed_root.join(name))
        })
        .collect::<BTreeSet<_>>();
    let mut moved_paths = Vec::new();
    for path in managed_top_level {
        if !path.exists() {
            continue;
        }
        let name = path
            .file_name()
            .ok_or_else(|| "恢复 Skill 路径无效".to_string())?;
        let rollback_path = rollback_root.join(name);
        fs::rename(&path, &rollback_path)
            .map_err(|error| format!("暂存现有 Skill 失败 {}: {error}", path.display()))?;
        moved_paths.push((path, rollback_path));
    }

    let mut created_paths = Vec::new();
    let apply_result = (|| {
        for entry in fs::read_dir(&staging_root)
            .map_err(|error| format!("读取恢复暂存区失败: {error}"))?
            .filter_map(Result::ok)
        {
            let target = managed_root.join(entry.file_name());
            fs::rename(entry.path(), &target)
                .map_err(|error| format!("应用 Skill 恢复失败 {}: {error}", target.display()))?;
            created_paths.push(target);
        }
        let mut next_skills = preserved_skills.clone();
        next_skills.extend(restored.clone());
        save_installed_skills(&next_skills)?;
        Ok::<Vec<SkillSummary>, String>(next_skills)
    })();
    if let Err(error) = apply_result {
        for created_path in created_paths.into_iter().rev() {
            let _ = fs::remove_dir_all(created_path);
        }
        for (original_path, rollback_path) in moved_paths.into_iter().rev() {
            let _ = fs::rename(rollback_path, original_path);
        }
        let _ = save_installed_skills(&current_skills);
        return Err(error);
    }
    apply_result
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
    let mut skipped_backup_ids = BTreeSet::new();
    for metadata in &library.skills {
        if preserved_backup_ids.contains(&metadata.backup_id) {
            continue;
        }
        if current_by_id
            .get(&metadata.backup_id)
            .is_some_and(|skill| skill_path(skill).exists())
        {
            skipped_backup_ids.insert(metadata.backup_id.clone());
            continue;
        }
        // Git-backed Skills must be recreated through the normal clone/install flow so
        // their repository identity and update state survive. Until that adapter runs,
        // skipping is safer than restoring a flattened directory as a local Skill.
        if requires_git_restore(metadata) {
            skipped_backup_ids.insert(metadata.backup_id.clone());
            continue;
        }
        let preferred_name = current_by_id
            .get(&metadata.backup_id)
            .and_then(|skill| Path::new(&skill.local_path).file_name()?.to_str())
            .unwrap_or(&metadata.directory_name);
        let preferred_target = managed_root.join(preferred_name);
        if preferred_target.exists() {
            skipped_backup_ids.insert(metadata.backup_id.clone());
            continue;
        }
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
                && !skipped_backup_ids.contains(&skill.instance.backup_id)
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
    let mut created_paths = Vec::new();
    let apply_result = (|| {
        for skill in &restored {
            let target = PathBuf::from(&skill.local_path);
            let name = target
                .file_name()
                .ok_or_else(|| "恢复 Skill 路径无效".to_string())?;
            if let Err(error) = fs::rename(staging_root.join(name), &target) {
                return Err(format!("恢复 Skill 失败 {}: {error}", target.display()));
            }
            created_paths.push(target);
        }
        let mut next_skills = current_skills
            .iter()
            .filter(|skill| {
                skill.instance.backup_id.trim().is_empty()
                    || preserved_backup_ids.contains(&skill.instance.backup_id)
                    || skipped_backup_ids.contains(&skill.instance.backup_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        next_skills.extend(restored.clone());
        save_installed_skills(&next_skills)?;
        Ok::<Vec<SkillSummary>, String>(next_skills)
    })();
    if let Err(error) = apply_result {
        for created_path in created_paths.into_iter().rev() {
            let _ = fs::remove_dir_all(created_path);
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
    use super::{
        apply_library_snapshot, apply_library_snapshot_replace, copy_skill,
        current_workspace_has_backup_data, deterministic_backup_id, read_library_snapshot,
        requires_git_restore, sanitize_repository_url, should_exclude,
        write_current_library_snapshot, BackupLibrary, BackupSkillMetadata,
        ENCODED_GIT_DIRECTORY_NAME, SKILL_FILESYSTEM_DIRECTORY_NAME,
        SKILL_FILESYSTEM_MANIFEST_FILE_NAME,
    };
    use crate::models::{SkillInstanceMetadata, SkillSummary};
    use crate::state::{load_installed_skills, save_installed_skills};
    use crate::workspace::with_test_home;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn with_temp_home(run: impl FnOnce(&Path)) {
        let home = std::env::temp_dir().join(format!(
            "skilldock-backup-home-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&home).expect("create temp HOME");
        with_test_home(&home, || run(&home));
        let _ = fs::remove_dir_all(home);
    }

    fn test_skill(path: &Path) -> SkillSummary {
        SkillSummary {
            name: "sample".into(),
            source_label: "Local".into(),
            source_type: "local".into(),
            source_url: String::new(),
            description: "sample".into(),
            local_path: path.to_string_lossy().into_owned(),
            branch: "local".into(),
            collab_status: "clean".into(),
            status_text: "clean".into(),
            remote_updated_at: String::new(),
            local_updated_at: String::new(),
            last_synced_at: String::new(),
            last_checked_at: String::new(),
            synced_tool_count: 0,
            last_editor: String::new(),
            commit_label: String::new(),
            git_linked: false,
            local_change_count: 0,
            lifecycle_source: "direct".into(),
            owner_plugin_id: String::new(),
            owner_plugin_name: String::new(),
            instance: SkillInstanceMetadata {
                canonical_path: path.to_string_lossy().into_owned(),
                entry_path: path.to_string_lossy().into_owned(),
                management_owner: "skilldock".into(),
                update_driver: "none".into(),
                skill_entries: vec![path.to_string_lossy().into_owned()],
                ..Default::default()
            },
            tools: Vec::new(),
        }
    }

    fn run_git(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(repo)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

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

    #[test]
    fn strips_credentials_and_machine_local_git_urls() {
        assert_eq!(
            sanitize_repository_url(
                "https://user:secret@github.com/example/demo.git?token=value#fragment"
            ),
            "https://github.com/example/demo.git"
        );
        assert!(sanitize_repository_url("/Users/example/private/repo").is_empty());
        assert!(sanitize_repository_url("file:///Users/example/private/repo").is_empty());
        assert!(sanitize_repository_url("oauth2:secret@gitlab.com:example/demo.git").is_empty());
        assert!(sanitize_repository_url("ghp_secret@github.com:example/demo.git").is_empty());
        assert_eq!(
            sanitize_repository_url("git@github.com:example/demo.git"),
            "git@github.com:example/demo.git"
        );
    }

    #[test]
    fn generated_backup_identity_does_not_depend_on_home_directory() {
        let left_path = Path::new("/Users/left/.skilldock/skills/sample");
        let right_path = Path::new("/Users/right/.skilldock/skills/sample");
        let left = test_skill(left_path);
        let right = test_skill(right_path);
        assert_eq!(
            deterministic_backup_id(&left, left_path),
            deterministic_backup_id(&right, right_path)
        );
    }

    #[test]
    fn reads_schema_v1_metadata_with_safe_defaults() {
        let metadata: BackupSkillMetadata = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "backupId": "legacy",
            "name": "legacy",
            "directoryName": "legacy",
            "sourceType": "local",
            "sourceUrl": "",
            "branch": "",
            "updateDriver": "none",
            "description": "",
            "tools": {},
            "contentHash": "hash"
        }))
        .expect("deserialize legacy metadata");

        assert!(!metadata.git_linked);
        assert!(metadata.git_head.is_empty());
        assert!(metadata.enabled_hosts.is_empty());
        assert!(!requires_git_restore(&metadata));

        let legacy_git: BackupSkillMetadata = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "backupId": "legacy-git",
            "name": "legacy-git",
            "directoryName": "legacy-git",
            "sourceType": "github",
            "sourceUrl": "https://github.com/example/legacy-git",
            "branch": "main",
            "updateDriver": "git",
            "description": "",
            "tools": {},
            "contentHash": "hash"
        }))
        .expect("deserialize legacy git metadata");
        assert!(requires_git_restore(&legacy_git));
    }

    #[test]
    fn snapshot_does_not_mutate_state_when_assigning_backup_identity() {
        with_temp_home(|home| {
            let skill_path = home.join(".skilldock/skills/sample");
            fs::create_dir_all(&skill_path).expect("create sample Skill");
            fs::write(skill_path.join("SKILL.md"), "# Sample").expect("write Skill");
            save_installed_skills(&[test_skill(&skill_path)]).expect("save initial state");
            let state_path = home.join(".skilldock/data/state.json");
            let state_before = fs::read(&state_path).expect("read state before backup");

            let repo = home.join(".skilldock/backup/repo");
            let report = write_current_library_snapshot(&repo).expect("write snapshot");

            assert_eq!(report.included_skills, 1);
            assert_eq!(report.assigned_backup_ids, 1);
            assert_eq!(
                fs::read(&state_path).expect("read state after backup"),
                state_before
            );
            assert_eq!(
                fs::read_to_string(skill_path.join("SKILL.md")).expect("read source Skill"),
                "# Sample"
            );
            let library = read_library_snapshot(&repo).expect("read snapshot");
            assert!(library.skills[0].backup_id.starts_with("skill-"));
        });
    }

    #[test]
    fn snapshot_writes_portable_preferences_without_github_or_machine_fields() {
        with_temp_home(|home| {
            let repo = home.join(".skilldock/backup/repo");
            write_current_library_snapshot(&repo).expect("write snapshot");

            let payload = fs::read_to_string(repo.join(".skilldock/preferences.json"))
                .expect("read portable preferences");
            assert!(!payload.contains("github"));
            assert!(!payload.contains("storagePath"));
            assert!(!payload.contains("skillLibraryPath"));
            assert!(!payload.contains(&home.to_string_lossy().to_string()));
            let mcp_payload = fs::read_to_string(repo.join(".skilldock/mcp-servers.json"))
                .expect("read portable MCP state");
            assert!(!mcp_payload.contains(&home.to_string_lossy().to_string()));
            let manifest_payload = fs::read_to_string(repo.join(".skilldock/snapshot.json"))
                .expect("read snapshot manifest");
            assert!(!manifest_payload.contains(&home.to_string_lossy().to_string()));
            assert!(!manifest_payload.contains("hostname"));
            assert!(!manifest_payload.contains("username"));
            let manifest: serde_json::Value =
                serde_json::from_str(&manifest_payload).expect("parse snapshot manifest");
            assert!(manifest["createdAt"].as_str().is_some());
            assert!(manifest["deviceLabel"].as_str().is_some());
            assert_eq!(manifest["skillCount"], 0);
        });
    }

    #[test]
    fn snapshot_copies_managed_plugins_without_derived_cursor_runtime_copies() {
        with_temp_home(|home| {
            let managed = home.join(".skilldock/plugins/demo-plugin");
            fs::create_dir_all(managed.join("node_modules/dependency"))
                .expect("create managed plugin");
            fs::write(managed.join("plugin.json"), "{\"name\":\"demo\"}")
                .expect("write plugin manifest");
            fs::write(managed.join(".env"), "TOKEN=secret").expect("write secret file");
            fs::write(
                managed.join("node_modules/dependency/index.js"),
                "excluded dependency",
            )
            .expect("write dependency");
            let cursor_disabled = home.join(".skilldock/disabled-plugins/cursor/cursor-plugin");
            fs::create_dir_all(&cursor_disabled).expect("create disabled Cursor plugin");
            fs::write(cursor_disabled.join("plugin.json"), "{\"name\":\"cursor\"}")
                .expect("write Cursor plugin");

            let repo = home.join(".skilldock/backup/repo");
            write_current_library_snapshot(&repo).expect("write snapshot");

            assert!(repo.join("plugins/demo-plugin/plugin.json").is_file());
            assert!(!repo.join("plugins/demo-plugin/.env").exists());
            assert!(!repo.join("plugins/demo-plugin/node_modules").exists());
            assert!(!repo
                .join("cursor-disabled/cursor-plugin/plugin.json")
                .exists());
            let targets = fs::read_to_string(repo.join(".skilldock/plugin-targets.json"))
                .expect("read plugin targets");
            assert!(targets.contains("demo-plugin"));
            assert!(!targets.contains("cursor-plugin"));
            assert!(!targets.contains("secret"));
        });
    }

    #[test]
    fn snapshot_read_only_loader_does_not_persist_missing_path_repairs() {
        with_temp_home(|home| {
            let skill_path = home.join(".skilldock/skills/temporarily-missing");
            fs::create_dir_all(&skill_path).expect("create temporary Skill");
            fs::write(skill_path.join("SKILL.md"), "# Temporary").expect("write Skill");
            save_installed_skills(&[test_skill(&skill_path)]).expect("save initial state");
            fs::remove_dir_all(&skill_path).expect("simulate temporarily missing path");
            let state_path = home.join(".skilldock/data/state.json");
            let state_before = fs::read(&state_path).expect("read state before backup");

            let repo = home.join(".skilldock/backup/repo");
            let report = write_current_library_snapshot(&repo).expect("write empty snapshot");

            assert_eq!(report.included_skills, 0);
            assert_eq!(
                fs::read(&state_path).expect("read state after backup"),
                state_before
            );
        });
    }

    #[test]
    fn snapshot_records_git_identity_without_credentials() {
        with_temp_home(|home| {
            let skill_path = home.join(".skilldock/skills/git-sample");
            fs::create_dir_all(&skill_path).expect("create git Skill");
            fs::write(skill_path.join("SKILL.md"), "# Git Sample").expect("write Skill");
            run_git(&skill_path, &["init", "-b", "main"]);
            run_git(&skill_path, &["config", "user.name", "SkillDock Test"]);
            run_git(
                &skill_path,
                &["config", "user.email", "skilldock@example.invalid"],
            );
            run_git(&skill_path, &["add", "SKILL.md"]);
            run_git(&skill_path, &["commit", "-m", "initial"]);
            run_git(
                &skill_path,
                &[
                    "remote",
                    "add",
                    "origin",
                    "https://user:secret@github.com/example/demo.git?token=value",
                ],
            );
            fs::write(skill_path.join("SKILL.md"), "# Changed").expect("modify Skill");

            let mut skill = test_skill(&skill_path);
            skill.source_type = "github".into();
            skill.source_url = "https://github.com/example/demo".into();
            skill.branch = "main".into();
            skill.collab_status = "pending-push".into();
            skill.git_linked = true;
            skill.local_change_count = 1;
            skill.instance.update_driver = "git".into();
            save_installed_skills(&[skill]).expect("save git state");

            let repo = home.join(".skilldock/backup/repo");
            write_current_library_snapshot(&repo).expect("write git snapshot");
            let metadata = &read_library_snapshot(&repo)
                .expect("read git snapshot")
                .skills[0];

            assert_eq!(
                metadata.repository_url,
                "https://github.com/example/demo.git"
            );
            assert_eq!(
                metadata.git_head,
                run_git(&skill_path, &["rev-parse", "HEAD"])
            );
            assert_eq!(metadata.repository_relative_path, "");
            assert!(metadata.git_linked);
            assert_eq!(metadata.collab_status, "pending-push");
            assert_eq!(metadata.local_change_count, 1);
            let payload = serde_json::to_string(metadata).expect("serialize metadata");
            assert!(!payload.contains("secret"));
            assert!(!payload.contains("token=value"));
        });
    }

    #[test]
    fn filesystem_snapshot_preserves_git_state_without_credentials() {
        with_temp_home(|home| {
            let skill_path = home.join(".skilldock/skills/git-state");
            fs::create_dir_all(&skill_path).expect("create git Skill");
            fs::write(skill_path.join("SKILL.md"), "# Original").expect("write Skill");
            run_git(&skill_path, &["init", "-b", "feature/local-state"]);
            run_git(&skill_path, &["config", "user.name", "SkillDock Test"]);
            run_git(
                &skill_path,
                &["config", "user.email", "skilldock@example.invalid"],
            );
            run_git(&skill_path, &["add", "SKILL.md"]);
            run_git(&skill_path, &["commit", "-m", "initial"]);
            run_git(
                &skill_path,
                &[
                    "remote",
                    "add",
                    "origin",
                    "https://user:secret@github.com/example/git-state.git?token=value",
                ],
            );
            fs::write(skill_path.join("staged.txt"), "staged").expect("write staged file");
            run_git(&skill_path, &["add", "staged.txt"]);
            fs::write(skill_path.join("SKILL.md"), "# Unstaged").expect("write unstaged change");
            fs::write(skill_path.join("untracked.txt"), "untracked").expect("write untracked file");

            let mut skill = test_skill(&skill_path);
            skill.source_type = "github".into();
            skill.source_url = "https://github.com/example/git-state".into();
            skill.branch = "feature/local-state".into();
            skill.git_linked = true;
            skill.local_change_count = 3;
            skill.instance.backup_id = "git-state-id".into();
            skill.instance.update_driver = "git".into();
            save_installed_skills(&[skill]).expect("save git Skill state");

            let repo = home.join(".skilldock/backup/repo");
            write_current_library_snapshot(&repo).expect("write filesystem snapshot");

            let snapshot_skill = repo.join(SKILL_FILESYSTEM_DIRECTORY_NAME).join("git-state");
            assert!(snapshot_skill
                .join(ENCODED_GIT_DIRECTORY_NAME)
                .join("HEAD")
                .is_file());
            assert!(!snapshot_skill.join(".git").exists());
            assert!(snapshot_skill.join("staged.txt").is_file());
            assert!(snapshot_skill.join("untracked.txt").is_file());
            let config = fs::read_to_string(
                snapshot_skill
                    .join(ENCODED_GIT_DIRECTORY_NAME)
                    .join("config"),
            )
            .expect("read sanitized config");
            assert!(config.contains("https://github.com/example/git-state.git"));
            assert!(!config.contains("secret"));
            assert!(!config.contains("token=value"));
            let manifest = fs::read_to_string(
                repo.join(".skilldock")
                    .join(SKILL_FILESYSTEM_MANIFEST_FILE_NAME),
            )
            .expect("read filesystem manifest");
            assert!(manifest.contains("\"git-state-id\": \"git-state\""));
            assert!(current_workspace_has_backup_data().expect("inspect local data"));
        });
    }

    #[test]
    fn filesystem_restore_round_trip_preserves_git_state() {
        with_temp_home(|home| {
            let skill_path = home.join(".skilldock/skills/git-round-trip");
            fs::create_dir_all(&skill_path).expect("create git Skill");
            fs::write(skill_path.join("SKILL.md"), "# Original").expect("write Skill");
            run_git(&skill_path, &["init", "-b", "feature/restore"]);
            run_git(&skill_path, &["config", "user.name", "SkillDock Test"]);
            run_git(
                &skill_path,
                &["config", "user.email", "skilldock@example.invalid"],
            );
            run_git(&skill_path, &["add", "SKILL.md"]);
            run_git(&skill_path, &["commit", "-m", "initial"]);
            run_git(
                &skill_path,
                &[
                    "remote",
                    "add",
                    "origin",
                    "https://user:secret@github.com/example/round-trip.git",
                ],
            );
            fs::write(skill_path.join("staged.txt"), "staged").expect("write staged file");
            run_git(&skill_path, &["add", "staged.txt"]);
            fs::write(skill_path.join("SKILL.md"), "# Unstaged").expect("write unstaged change");
            fs::write(skill_path.join("untracked.txt"), "untracked").expect("write untracked file");
            let expected_head = run_git(&skill_path, &["rev-parse", "HEAD"]);
            let expected_status = run_git(&skill_path, &["status", "--porcelain=v1"]);

            let mut skill = test_skill(&skill_path);
            skill.source_type = "github".into();
            skill.source_url = "https://github.com/example/round-trip".into();
            skill.branch = "feature/restore".into();
            skill.git_linked = true;
            skill.local_change_count = 3;
            skill.instance.backup_id = "round-trip-id".into();
            skill.instance.update_driver = "git".into();
            save_installed_skills(&[skill]).expect("save git Skill state");

            let repo = home.join(".skilldock/backup/repo");
            write_current_library_snapshot(&repo).expect("write filesystem snapshot");
            fs::remove_dir_all(home.join(".skilldock/skills")).expect("remove local Skill root");
            save_installed_skills(&[]).expect("clear local Skill state");

            let restored =
                apply_library_snapshot_replace(&repo).expect("restore filesystem snapshot");

            assert_eq!(restored.len(), 1);
            assert!(restored[0].git_linked);
            assert_eq!(restored[0].local_path, skill_path.to_string_lossy());
            assert_eq!(run_git(&skill_path, &["rev-parse", "HEAD"]), expected_head);
            assert_eq!(
                run_git(&skill_path, &["branch", "--show-current"]),
                "feature/restore"
            );
            assert_eq!(
                run_git(&skill_path, &["status", "--porcelain=v1"]),
                expected_status
            );
            assert_eq!(
                run_git(&skill_path, &["remote", "get-url", "origin"]),
                "https://github.com/example/round-trip.git"
            );
        });
    }

    #[test]
    fn restore_failure_never_removes_preexisting_conflict_directory() {
        with_temp_home(|home| {
            let managed_root = home.join(".skilldock/skills");
            let conflict_path = managed_root.join("conflict");
            fs::create_dir_all(&conflict_path).expect("create conflict directory");
            fs::write(conflict_path.join("sentinel.txt"), "keep").expect("write sentinel");
            save_installed_skills(&[]).expect("save empty state");

            let repo = home.join(".skilldock/backup/repo");
            let backup_id = "backup-conflict";
            let snapshot_skill = repo.join("skills").join(backup_id);
            fs::create_dir_all(&snapshot_skill).expect("create snapshot Skill");
            fs::write(snapshot_skill.join("SKILL.md"), "# Restored").expect("write snapshot Skill");
            let metadata = BackupSkillMetadata {
                schema_version: 2,
                backup_id: backup_id.into(),
                name: "conflict".into(),
                directory_name: "conflict".into(),
                source_type: "local".into(),
                update_driver: "none".into(),
                tools: BTreeMap::new(),
                content_hash: "hash".into(),
                ..Default::default()
            };
            fs::create_dir_all(repo.join(".skilldock")).expect("create metadata directory");
            fs::write(
                repo.join(".skilldock/library.json"),
                serde_json::to_vec(&BackupLibrary {
                    schema_version: 2,
                    skills: vec![metadata],
                })
                .expect("serialize library"),
            )
            .expect("write library");

            apply_library_snapshot(&repo).expect("skip conflicting restore target");
            assert_eq!(
                fs::read_to_string(conflict_path.join("sentinel.txt")).expect("read sentinel"),
                "keep"
            );
        });
    }

    #[test]
    fn restore_never_overwrites_existing_skill_with_same_backup_id() {
        with_temp_home(|home| {
            let skill_path = home.join(".skilldock/skills/existing");
            fs::create_dir_all(&skill_path).expect("create existing Skill");
            fs::write(skill_path.join("SKILL.md"), "# Local Changes").expect("write local Skill");
            let mut current = test_skill(&skill_path);
            current.instance.backup_id = "existing-id".into();
            save_installed_skills(&[current]).expect("save current Skill");

            let repo = home.join(".skilldock/backup/repo");
            let snapshot_skill = repo.join("skills/existing-id");
            fs::create_dir_all(&snapshot_skill).expect("create snapshot Skill");
            fs::write(snapshot_skill.join("SKILL.md"), "# Remote Snapshot")
                .expect("write remote snapshot");
            let metadata = BackupSkillMetadata {
                schema_version: 2,
                backup_id: "existing-id".into(),
                name: "existing".into(),
                directory_name: "existing".into(),
                source_type: "local".into(),
                update_driver: "none".into(),
                tools: BTreeMap::new(),
                content_hash: "remote-hash".into(),
                ..Default::default()
            };
            fs::create_dir_all(repo.join(".skilldock")).expect("create metadata directory");
            fs::write(
                repo.join(".skilldock/library.json"),
                serde_json::to_vec(&BackupLibrary {
                    schema_version: 2,
                    skills: vec![metadata],
                })
                .expect("serialize library"),
            )
            .expect("write library");

            let restored = apply_library_snapshot(&repo).expect("skip existing Skill");

            assert_eq!(restored.len(), 1);
            assert_eq!(
                fs::read_to_string(skill_path.join("SKILL.md")).expect("read local Skill"),
                "# Local Changes"
            );
        });
    }

    #[test]
    fn restore_preserves_nested_skill_with_same_backup_id() {
        with_temp_home(|home| {
            let skill_path = home.join(".skilldock/skills/repo/skills/nested");
            fs::create_dir_all(&skill_path).expect("create nested Skill");
            fs::write(skill_path.join("SKILL.md"), "# Nested Local Changes")
                .expect("write nested Skill");
            let mut current = test_skill(&skill_path);
            current.name = "nested".into();
            current.instance.backup_id = "nested-id".into();
            save_installed_skills(&[current]).expect("save nested Skill");

            let repo = home.join(".skilldock/backup/repo");
            let snapshot_skill = repo.join("skills/nested-id");
            fs::create_dir_all(&snapshot_skill).expect("create snapshot Skill");
            fs::write(snapshot_skill.join("SKILL.md"), "# Remote Snapshot")
                .expect("write remote snapshot");
            let metadata = BackupSkillMetadata {
                schema_version: 2,
                backup_id: "nested-id".into(),
                name: "nested".into(),
                directory_name: "nested".into(),
                source_type: "local".into(),
                update_driver: "none".into(),
                tools: BTreeMap::new(),
                content_hash: "remote-hash".into(),
                ..Default::default()
            };
            fs::create_dir_all(repo.join(".skilldock")).expect("create metadata directory");
            fs::write(
                repo.join(".skilldock/library.json"),
                serde_json::to_vec(&BackupLibrary {
                    schema_version: 2,
                    skills: vec![metadata],
                })
                .expect("serialize library"),
            )
            .expect("write library");

            let restored = apply_library_snapshot(&repo).expect("skip nested existing Skill");

            assert_eq!(restored.len(), 1);
            assert_eq!(restored[0].local_path, skill_path.to_string_lossy());
            assert_eq!(
                fs::read_to_string(skill_path.join("SKILL.md")).expect("read nested Skill"),
                "# Nested Local Changes"
            );
            assert!(!home.join(".skilldock/skills/nested").exists());
        });
    }

    #[test]
    fn restore_preserves_existing_git_skill_until_git_adapter_can_rebuild_it() {
        with_temp_home(|home| {
            let skill_path = home.join(".skilldock/skills/git-preserved");
            fs::create_dir_all(&skill_path).expect("create existing git Skill");
            fs::write(skill_path.join("SKILL.md"), "# Local Git State")
                .expect("write local git Skill");
            let mut current = test_skill(&skill_path);
            current.git_linked = true;
            current.source_type = "github".into();
            current.source_url = "https://github.com/example/git-preserved".into();
            current.instance.backup_id = "git-preserved-id".into();
            current.instance.update_driver = "git".into();
            save_installed_skills(&[current]).expect("save current git Skill");

            let repo = home.join(".skilldock/backup/repo");
            let snapshot_skill = repo.join("skills/git-preserved-id");
            fs::create_dir_all(&snapshot_skill).expect("create snapshot git Skill");
            fs::write(snapshot_skill.join("SKILL.md"), "# Remote Snapshot")
                .expect("write remote snapshot");
            let metadata = BackupSkillMetadata {
                schema_version: 2,
                backup_id: "git-preserved-id".into(),
                name: "git-preserved".into(),
                directory_name: "git-preserved".into(),
                source_type: "github".into(),
                source_url: "https://github.com/example/git-preserved".into(),
                update_driver: "git".into(),
                git_linked: true,
                tools: BTreeMap::new(),
                content_hash: "hash".into(),
                ..Default::default()
            };
            fs::create_dir_all(repo.join(".skilldock")).expect("create metadata directory");
            fs::write(
                repo.join(".skilldock/library.json"),
                serde_json::to_vec(&BackupLibrary {
                    schema_version: 2,
                    skills: vec![metadata],
                })
                .expect("serialize library"),
            )
            .expect("write library");

            let restored = apply_library_snapshot(&repo).expect("preserve existing git Skill");

            assert_eq!(restored.len(), 1);
            assert!(restored[0].git_linked);
            assert_eq!(
                fs::read_to_string(skill_path.join("SKILL.md")).expect("read local git Skill"),
                "# Local Git State"
            );
            assert_eq!(load_installed_skills(&[]).len(), 1);
        });
    }

    #[test]
    fn git_metadata_failure_preserves_previous_snapshot() {
        with_temp_home(|home| {
            let skill_path = home.join(".skilldock/skills/broken-git");
            fs::create_dir_all(&skill_path).expect("create broken git Skill");
            fs::write(skill_path.join("SKILL.md"), "# Broken Git").expect("write broken git Skill");
            let mut current = test_skill(&skill_path);
            current.git_linked = true;
            current.source_type = "github".into();
            current.source_url = "https://github.com/example/broken-git".into();
            current.instance.backup_id = "broken-git-id".into();
            current.instance.update_driver = "git".into();
            save_installed_skills(&[current]).expect("save broken git Skill");

            let repo = home.join(".skilldock/backup/repo");
            let previous_skill = repo.join("skills/broken-git-id");
            fs::create_dir_all(&previous_skill).expect("create previous Skill");
            fs::write(previous_skill.join("SKILL.md"), "# Previous Snapshot")
                .expect("write previous Skill");
            let previous = BackupSkillMetadata {
                schema_version: 2,
                backup_id: "broken-git-id".into(),
                name: "broken-git".into(),
                directory_name: "broken-git".into(),
                source_type: "github".into(),
                source_url: "https://github.com/example/broken-git".into(),
                repository_url: "https://github.com/example/broken-git.git".into(),
                git_head: "0123456789abcdef".into(),
                git_linked: true,
                update_driver: "git".into(),
                tools: BTreeMap::new(),
                content_hash: "previous-hash".into(),
                ..Default::default()
            };
            fs::create_dir_all(repo.join(".skilldock")).expect("create metadata directory");
            fs::write(
                repo.join(".skilldock/library.json"),
                serde_json::to_vec(&BackupLibrary {
                    schema_version: 2,
                    skills: vec![previous],
                })
                .expect("serialize previous library"),
            )
            .expect("write previous library");

            let report = write_current_library_snapshot(&repo)
                .expect("preserve snapshot when git metadata fails");
            let snapshot = read_library_snapshot(&repo).expect("read preserved library");

            assert_eq!(report.preserved_backup_ids, vec!["broken-git-id"]);
            assert_eq!(snapshot.skills[0].git_head, "0123456789abcdef");
            assert_eq!(
                fs::read_to_string(repo.join("skills/broken-git-id/SKILL.md"))
                    .expect("read preserved Skill"),
                "# Previous Snapshot"
            );
        });
    }

    #[test]
    fn exact_restore_replaces_only_skilldock_managed_skills() {
        with_temp_home(|home| {
            let old_path = home.join(".skilldock/skills/old");
            let unmanaged_path = home.join("external/unmanaged");
            fs::create_dir_all(&old_path).expect("create old managed Skill");
            fs::create_dir_all(&unmanaged_path).expect("create unmanaged Skill");
            fs::write(old_path.join("SKILL.md"), "# Old").expect("write old Skill");
            fs::write(unmanaged_path.join("SKILL.md"), "# Unmanaged")
                .expect("write unmanaged Skill");
            let mut old = test_skill(&old_path);
            old.instance.backup_id = "old-id".into();
            let mut unmanaged = test_skill(&unmanaged_path);
            unmanaged.name = "unmanaged".into();
            unmanaged.instance.management_owner.clear();
            save_installed_skills(&[old, unmanaged.clone()]).expect("save current Skills");

            let repo = home.join(".skilldock/backup/repo");
            let snapshot_skill = repo.join("skills/new-id");
            fs::create_dir_all(&snapshot_skill).expect("create snapshot Skill");
            fs::write(snapshot_skill.join("SKILL.md"), "# Restored").expect("write snapshot Skill");
            fs::create_dir_all(repo.join(".skilldock")).expect("create metadata directory");
            fs::write(
                repo.join(".skilldock/library.json"),
                serde_json::to_vec(&BackupLibrary {
                    schema_version: 2,
                    skills: vec![BackupSkillMetadata {
                        schema_version: 2,
                        backup_id: "new-id".into(),
                        name: "restored".into(),
                        directory_name: "restored".into(),
                        source_type: "local".into(),
                        update_driver: "none".into(),
                        tools: BTreeMap::new(),
                        content_hash: "restored-hash".into(),
                        ..Default::default()
                    }],
                })
                .expect("serialize library"),
            )
            .expect("write library");

            let restored =
                apply_library_snapshot_replace(&repo).expect("apply exact managed restore");

            assert_eq!(restored.len(), 1);
            assert!(!old_path.exists());
            assert!(home.join(".skilldock/skills/restored/SKILL.md").is_file());
            assert_eq!(
                fs::read_to_string(unmanaged_path.join("SKILL.md")).expect("read unmanaged Skill"),
                "# Unmanaged"
            );
            let installed = load_installed_skills(&[]);
            assert!(installed
                .iter()
                .any(|skill| skill.instance.backup_id == "new-id"));
        });
    }

    #[test]
    fn legacy_filesystem_restore_uses_snapshot_without_clone() {
        with_temp_home(|home| {
            save_installed_skills(&[]).expect("save empty state");
            let repo = home.join(".skilldock/backup/repo");
            let snapshot_skill = repo.join("skills/legacy-git-id");
            fs::create_dir_all(&snapshot_skill).expect("create legacy git snapshot");
            fs::write(snapshot_skill.join("SKILL.md"), "# Offline Legacy")
                .expect("write legacy git snapshot");
            fs::create_dir_all(repo.join(".skilldock")).expect("create metadata directory");
            fs::write(
                repo.join(".skilldock/library.json"),
                serde_json::to_vec(&BackupLibrary {
                    schema_version: 2,
                    skills: vec![BackupSkillMetadata {
                        schema_version: 2,
                        backup_id: "legacy-git-id".into(),
                        name: "legacy-git".into(),
                        directory_name: "legacy-git".into(),
                        source_type: "github".into(),
                        source_url: "https://127.0.0.1:9/unreachable/repository".into(),
                        repository_url: "https://127.0.0.1:9/unreachable/repository.git".into(),
                        git_head: "0123456789abcdef0123456789abcdef01234567".into(),
                        update_driver: "git".into(),
                        git_linked: true,
                        tools: BTreeMap::new(),
                        content_hash: "legacy-hash".into(),
                        ..Default::default()
                    }],
                })
                .expect("serialize legacy library"),
            )
            .expect("write legacy library");

            let restored =
                apply_library_snapshot_replace(&repo).expect("restore legacy snapshot offline");

            assert_eq!(restored.len(), 1);
            assert!(!restored[0].git_linked);
            assert!(home.join(".skilldock/skills/legacy-git/SKILL.md").is_file());
            assert!(!home.join(".skilldock/skills/legacy-git/.git").exists());
        });
    }
}
