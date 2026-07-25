use std::collections::{hash_map::DefaultHasher, BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[cfg(windows)]
use crate::library::{command_for_executable, resolve_command_in_path};
use crate::workspace::home_dir;
use crate::{
    library::git_command,
    models::{GitChangeFile, UpdatePreviewSnapshot},
    workspace::managed_workspace_root,
};

const CLI_COMMAND: &str = "skills";
const NPX_COMMAND: &str = "npx";
const WELL_KNOWN_SOURCE_TYPE: &str = "well-known";
const UPDATE_PREVIEW_CACHE_DIR: &str = "agent-cli-update-preview";
const UPDATE_PREVIEW_CACHE_PREFIX: &str = "preview-";
const UPDATE_PREVIEW_CACHE_MAX_AGE_SECS: u64 = 24 * 60 * 60;
const UPDATE_PREVIEW_RESULT_CACHE_TTL: Duration = Duration::from_secs(300);

static UPDATE_PREVIEW_RESULT_CACHE: OnceLock<Mutex<HashMap<PreviewCacheKey, PreviewCacheValue>>> =
    OnceLock::new();

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSkillLockEntry {
    #[serde(default)]
    pub source_type: String,
    #[serde(default)]
    pub source_url: String,
    #[serde(default)]
    pub skill_path: Option<String>,
    #[serde(default)]
    pub skill_folder_hash: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct GlobalSkillLock {
    #[serde(default)]
    pub skills: BTreeMap<String, GlobalSkillLockEntry>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentSkillUpdateCheck {
    pub checked_names: BTreeSet<String>,
    pub updated_names: BTreeSet<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliSkillEntry {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub agents: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillsCliStatus {
    pub available: bool,
    pub global_path: String,
    pub entries: Vec<CliSkillEntry>,
    pub error: String,
}

struct UpdatePreviewWorkspace {
    root: PathBuf,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct PreviewCacheKey {
    skill_name: String,
    source_path: PathBuf,
    source_url: String,
    skill_folder_hash: String,
    local_signature: u64,
}

#[derive(Clone)]
struct PreviewCacheValue {
    snapshot: UpdatePreviewSnapshot,
    created_at: Instant,
}

impl Drop for UpdatePreviewWorkspace {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.root) {
            log::warn!(
                "清理 Agent CLI 更新预览临时目录失败: path={}, error={error}",
                self.root.to_string_lossy()
            );
        }
    }
}

type PreviewFiles = BTreeMap<String, Vec<u8>>;
type PreviewChange<'a> = (String, &'a str, Option<&'a Vec<u8>>, Option<&'a Vec<u8>>);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillEntryPath {
    pub entry_path: PathBuf,
    pub canonical_path: Option<PathBuf>,
    pub path_error: String,
}

pub fn global_skill_root() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".agents/skills"))
}

pub fn resolve_skill_entry_path(entry: &Path) -> SkillEntryPath {
    match entry.canonicalize() {
        Ok(canonical_path) => SkillEntryPath {
            entry_path: entry.to_path_buf(),
            canonical_path: Some(canonical_path),
            path_error: String::new(),
        },
        Err(error) => SkillEntryPath {
            entry_path: entry.to_path_buf(),
            canonical_path: None,
            path_error: format!("无法解析 Skill 入口: {error}"),
        },
    }
}

pub fn global_skill_lock_entries() -> BTreeMap<String, GlobalSkillLockEntry> {
    let Ok(lock_path) = home_dir().map(|home| home.join(".agents/.skill-lock.json")) else {
        return BTreeMap::new();
    };
    let Ok(contents) = fs::read_to_string(lock_path) else {
        return BTreeMap::new();
    };
    parse_global_skill_lock(&contents)
        .map(|lock| lock.skills)
        .unwrap_or_default()
}

pub fn parse_global_skill_lock(contents: &str) -> Result<GlobalSkillLock, String> {
    serde_json::from_str(contents)
        .map_err(|error| format!("解析 Agent Skills CLI 锁文件失败: {error}"))
}

pub fn changed_global_skill_names(
    before: &GlobalSkillLock,
    after: &GlobalSkillLock,
) -> BTreeSet<String> {
    before
        .skills
        .iter()
        .filter_map(|(name, before_entry)| {
            let after_entry = after.skills.get(name)?;
            (before_entry.skill_folder_hash != after_entry.skill_folder_hash).then(|| name.clone())
        })
        .collect()
}

pub fn cleanup_update_preview_cache() {
    let Ok(cache_root) = update_preview_cache_root() else {
        return;
    };
    let Ok(entries) = fs::read_dir(cache_root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_preview_dir = path.is_dir()
            && path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with(UPDATE_PREVIEW_CACHE_PREFIX));
        if !is_preview_dir {
            continue;
        }
        let should_remove = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age.as_secs() > UPDATE_PREVIEW_CACHE_MAX_AGE_SECS);
        if should_remove {
            let _ = fs::remove_dir_all(path);
        }
    }
}

pub fn preview_global_skill_update(
    skill_name: &str,
    skill_path: &Path,
) -> Result<UpdatePreviewSnapshot, String> {
    validate_skill_name(skill_name)?;
    let lock_contents = read_global_skill_lock_contents()?;
    let lock = parse_global_skill_lock(&lock_contents)?;
    let lock_entry = lock
        .skills
        .get(skill_name)
        .ok_or_else(|| format!("Agent Skills CLI 锁文件中没有 {skill_name} 的记录"))?;
    let source_path = skill_path
        .canonicalize()
        .map_err(|error| format!("解析 Agent CLI Skill 目录失败: {error}"))?;
    if !source_path.is_dir() {
        return Err("Agent CLI Skill 本地路径不是目录，无法生成更新预览。".into());
    }

    let cache_key = build_preview_cache_key(skill_name, &source_path, lock_entry)?;
    if let Some(snapshot) = read_preview_result_cache(&cache_key) {
        return Ok(snapshot);
    }

    let workspace = create_update_preview_workspace()?;
    let preview_home = workspace.root.join("home");
    let before_root = workspace.root.join("before");
    let before_files = prepare_preview_home(
        &preview_home,
        &source_path,
        skill_name,
        &lock_contents,
        &before_root,
    )?;
    run_preview_update(&preview_home, skill_name, lock_entry)?;
    let updated_skill_path = preview_home.join(".agents/skills").join(skill_name);
    let after_skill_path = updated_skill_path
        .canonicalize()
        .map_err(|error| format!("解析 Agent CLI 更新后 Skill 目录失败: {error}"))?;
    let preview_agents_root = preview_home
        .join(".agents")
        .canonicalize()
        .map_err(|error| format!("解析 Agent CLI 预览目录失败: {error}"))?;
    if !after_skill_path.starts_with(preview_agents_root) {
        return Err("Agent CLI 更新后的 Skill 路径超出临时目录范围。".into());
    }
    let after_files = collect_preview_files(&after_skill_path)?;
    let changed_files = build_preview_changes(
        &workspace.root,
        &before_files,
        &after_files,
        &before_root,
        &after_skill_path,
    )?;
    let snapshot = UpdatePreviewSnapshot {
        current_branch: "agent-skills-cli".into(),
        remote_branch: lock_entry.source_url.clone(),
        commits_to_pull: 0,
        changed_files,
        has_local_changes: false,
    };
    write_preview_result_cache(cache_key, snapshot.clone());

    Ok(snapshot)
}

fn validate_skill_name(skill_name: &str) -> Result<(), String> {
    let path = Path::new(skill_name);
    let valid = !skill_name.trim().is_empty()
        && path.components().count() == 1
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)));
    if valid {
        Ok(())
    } else {
        Err("Agent CLI Skill 名称无效".into())
    }
}

fn read_global_skill_lock_contents() -> Result<String, String> {
    let lock_path = home_dir()?.join(".agents/.skill-lock.json");
    fs::read_to_string(lock_path)
        .map_err(|error| format!("读取 Agent Skills CLI 锁文件失败: {error}"))
}

fn build_preview_cache_key(
    skill_name: &str,
    source_path: &Path,
    lock_entry: &GlobalSkillLockEntry,
) -> Result<PreviewCacheKey, String> {
    Ok(PreviewCacheKey {
        skill_name: skill_name.to_string(),
        source_path: source_path.to_path_buf(),
        source_url: lock_entry.source_url.clone(),
        skill_folder_hash: lock_entry.skill_folder_hash.clone(),
        local_signature: preview_file_signature(source_path)?,
    })
}

fn read_preview_result_cache(cache_key: &PreviewCacheKey) -> Option<UpdatePreviewSnapshot> {
    let cache = UPDATE_PREVIEW_RESULT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = cache.lock().ok()?;
    let now = Instant::now();
    cache.retain(|_, value| now.duration_since(value.created_at) < UPDATE_PREVIEW_RESULT_CACHE_TTL);
    cache.get(cache_key).map(|value| value.snapshot.clone())
}

fn write_preview_result_cache(cache_key: PreviewCacheKey, snapshot: UpdatePreviewSnapshot) {
    let cache = UPDATE_PREVIEW_RESULT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut cache) = cache.lock() else {
        return;
    };
    let now = Instant::now();
    cache.retain(|_, value| now.duration_since(value.created_at) < UPDATE_PREVIEW_RESULT_CACHE_TTL);
    cache.insert(
        cache_key,
        PreviewCacheValue {
            snapshot,
            created_at: now,
        },
    );
}

fn preview_file_signature(root: &Path) -> Result<u64, String> {
    let mut hasher = DefaultHasher::new();
    hash_preview_tree(root, root, &mut hasher)?;
    Ok(hasher.finish())
}

fn hash_preview_tree(
    root: &Path,
    current: &Path,
    hasher: &mut DefaultHasher,
) -> Result<(), String> {
    let mut entries = fs::read_dir(current)
        .map_err(|error| format!("读取 Agent CLI Skill 缓存签名失败: {error}"))?
        .flatten()
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if entry.file_name() == ".git" {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("读取 Agent CLI Skill 缓存签名元数据失败: {error}"))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            hash_preview_tree(root, &path, hasher)?;
            continue;
        }
        let relative_path = path
            .strip_prefix(root)
            .map_err(|error| format!("解析 Agent CLI Skill 缓存签名路径失败: {error}"))?;
        relative_path.hash(hasher);
        metadata.len().hash(hasher);
        metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|modified| (modified.as_secs(), modified.subsec_nanos()))
            .hash(hasher);
    }
    Ok(())
}

fn update_preview_cache_root() -> Result<PathBuf, String> {
    Ok(managed_workspace_root()?
        .join("cache")
        .join(UPDATE_PREVIEW_CACHE_DIR))
}

fn create_update_preview_workspace() -> Result<UpdatePreviewWorkspace, String> {
    let cache_root = update_preview_cache_root()?;
    fs::create_dir_all(&cache_root)
        .map_err(|error| format!("创建 Agent CLI 更新预览缓存目录失败: {error}"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("生成 Agent CLI 更新预览目录失败: {error}"))?
        .as_nanos();
    let root = cache_root.join(format!(
        "{UPDATE_PREVIEW_CACHE_PREFIX}{}-{timestamp}",
        std::process::id()
    ));
    fs::create_dir(&root)
        .map_err(|error| format!("创建 Agent CLI 更新预览临时目录失败: {error}"))?;
    Ok(UpdatePreviewWorkspace { root })
}

fn prepare_preview_home(
    preview_home: &Path,
    source_path: &Path,
    skill_name: &str,
    lock_contents: &str,
    before_root: &Path,
) -> Result<PreviewFiles, String> {
    let preview_agents = preview_home.join(".agents");
    let preview_skill_path = preview_agents.join("skills").join(skill_name);
    fs::create_dir_all(&preview_skill_path)
        .map_err(|error| format!("创建 Agent CLI 更新预览 Skill 目录失败: {error}"))?;
    fs::create_dir_all(before_root)
        .map_err(|error| format!("创建 Agent CLI 更新前快照目录失败: {error}"))?;
    fs::write(preview_agents.join(".skill-lock.json"), lock_contents)
        .map_err(|error| format!("写入 Agent CLI 更新预览锁文件失败: {error}"))?;
    let mut before_files = BTreeMap::new();
    copy_preview_tree(
        source_path,
        &preview_skill_path,
        source_path,
        Some(before_root),
        &preview_skill_path,
        &mut before_files,
    )?;
    Ok(before_files)
}

fn copy_preview_tree(
    source: &Path,
    target: &Path,
    source_root: &Path,
    before_target: Option<&Path>,
    preview_skill_root: &Path,
    before_files: &mut PreviewFiles,
) -> Result<(), String> {
    for entry in
        fs::read_dir(source).map_err(|error| format!("读取 Agent CLI Skill 失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取 Agent CLI Skill 条目失败: {error}"))?;
        let source_path = entry.path();
        if entry.file_name() == ".git" {
            continue;
        }
        let target_path = target.join(entry.file_name());
        let before_path = before_target.map(|path| path.join(entry.file_name()));
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("读取 Agent CLI Skill 元数据失败: {error}"))?;
        if metadata.file_type().is_symlink() {
            let resolved_path = source_path
                .canonicalize()
                .map_err(|error| format!("解析 Agent CLI Skill 链接失败: {error}"))?;
            if !resolved_path.starts_with(source_root) {
                return Err(format!(
                    "Agent CLI Skill 包含指向目录外的符号链接: {}",
                    source_path.to_string_lossy()
                ));
            }
            if resolved_path.is_dir() {
                fs::create_dir_all(&target_path)
                    .map_err(|error| format!("创建 Agent CLI Skill 子目录失败: {error}"))?;
                if let Some(before_path) = before_path.as_deref() {
                    fs::create_dir_all(before_path)
                        .map_err(|error| format!("创建 Agent CLI 更新前快照子目录失败: {error}"))?;
                }
                copy_preview_tree(
                    &resolved_path,
                    &target_path,
                    source_root,
                    before_path.as_deref(),
                    preview_skill_root,
                    before_files,
                )?;
            } else {
                copy_preview_file(
                    &resolved_path,
                    &target_path,
                    before_path.as_deref(),
                    preview_skill_root,
                    before_files,
                )?;
            }
        } else if metadata.is_dir() {
            fs::create_dir_all(&target_path)
                .map_err(|error| format!("创建 Agent CLI Skill 子目录失败: {error}"))?;
            if let Some(before_path) = before_path.as_deref() {
                fs::create_dir_all(before_path)
                    .map_err(|error| format!("创建 Agent CLI 更新前快照子目录失败: {error}"))?;
            }
            copy_preview_tree(
                &source_path,
                &target_path,
                source_root,
                before_path.as_deref(),
                preview_skill_root,
                before_files,
            )?;
        } else {
            copy_preview_file(
                &source_path,
                &target_path,
                before_path.as_deref(),
                preview_skill_root,
                before_files,
            )?;
        }
    }
    Ok(())
}

fn copy_preview_file(
    source: &Path,
    target: &Path,
    before_target: Option<&Path>,
    preview_skill_root: &Path,
    before_files: &mut PreviewFiles,
) -> Result<(), String> {
    fs::copy(source, target).map_err(|error| format!("复制 Agent CLI Skill 文件失败: {error}"))?;
    if let Some(before_target) = before_target {
        fs::copy(source, before_target)
            .map_err(|error| format!("复制 Agent CLI 更新前快照文件失败: {error}"))?;
    }
    let relative_path = target
        .strip_prefix(preview_skill_root)
        .map_err(|error| format!("解析 Agent CLI 更新前快照路径失败: {error}"))?
        .to_string_lossy()
        .replace('\\', "/");
    let content =
        fs::read(source).map_err(|error| format!("读取 Agent CLI Skill 文件失败: {error}"))?;
    before_files.insert(relative_path, content);
    Ok(())
}

fn run_preview_update(
    preview_home: &Path,
    skill_name: &str,
    lock_entry: &GlobalSkillLockEntry,
) -> Result<(), String> {
    let program = find_cli_program_for_operation()
        .ok_or_else(|| "未检测到 skills 命令，无法预览 Agent CLI Skill 更新。".to_string())?;
    let args = if lock_entry.source_type == WELL_KNOWN_SOURCE_TYPE {
        if lock_entry.source_url.trim().is_empty() {
            return Err("Agent CLI Skill 缺少 sourceUrl，无法预览更新。".into());
        }
        vec![
            "add".to_string(),
            lock_entry.source_url.clone(),
            "-g".into(),
            "-y".into(),
        ]
    } else {
        vec![
            "update".to_string(),
            skill_name.to_string(),
            "-g".into(),
            "-y".into(),
        ]
    };
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_with_program_in_home(&program, &arg_refs, preview_home)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(command_error(&output))
    }
}

fn collect_preview_files(root: &Path) -> Result<PreviewFiles, String> {
    if !root.is_dir() {
        return Err(format!(
            "Agent CLI Skill 目录不存在: {}",
            root.to_string_lossy()
        ));
    }
    let mut files = BTreeMap::new();
    collect_preview_files_into(root, root, &mut files)?;
    Ok(files)
}

fn collect_preview_files_into(
    root: &Path,
    current: &Path,
    files: &mut PreviewFiles,
) -> Result<(), String> {
    let mut entries = fs::read_dir(current)
        .map_err(|error| format!("读取 Agent CLI Skill 快照失败: {error}"))?
        .flatten()
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if entry.file_name() == ".git" {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("读取 Agent CLI Skill 快照元数据失败: {error}"))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_preview_files_into(root, &path, files)?;
            continue;
        }
        let relative_path = path
            .strip_prefix(root)
            .map_err(|error| format!("解析 Agent CLI Skill 快照路径失败: {error}"))?
            .to_string_lossy()
            .replace('\\', "/");
        let content =
            fs::read(&path).map_err(|error| format!("读取 Agent CLI Skill 文件失败: {error}"))?;
        files.insert(relative_path, content);
    }
    Ok(())
}

fn build_preview_changes(
    workspace_root: &Path,
    before_files: &PreviewFiles,
    after_files: &PreviewFiles,
    before_root: &Path,
    after_root: &Path,
) -> Result<Vec<GitChangeFile>, String> {
    let paths = before_files
        .keys()
        .chain(after_files.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let changed_paths = paths
        .into_iter()
        .filter_map(|path| {
            let before = before_files.get(&path);
            let after = after_files.get(&path);
            (before != after).then_some((path, before, after))
        })
        .map(|(path, before, after)| {
            let status = match (before, after) {
                (None, Some(_)) => "A",
                (Some(_), None) => "D",
                (Some(_), Some(_)) => "M",
                (None, None) => return Err("生成 Agent CLI 更新预览变更失败".into()),
            };
            Ok((path, status, before, after))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let diffs = preview_directory_diffs(workspace_root, before_root, after_root, &changed_paths)?;

    changed_paths
        .into_iter()
        .map(|(path, status, before, after)| {
            let diff = diffs
                .get(&path)
                .cloned()
                .ok_or_else(|| format!("缺少 Agent CLI Skill 文件 diff: {path}"))?;
            Ok(GitChangeFile {
                path,
                status: status.into(),
                diff,
                staged_diff: String::new(),
                unstaged_diff: String::new(),
                original_content: preview_text_content(before),
                current_content: preview_text_content(after),
            })
        })
        .collect()
}

fn preview_text_content(content: Option<&Vec<u8>>) -> Option<String> {
    content.and_then(|value| String::from_utf8(value.clone()).ok())
}

fn preview_directory_diffs(
    workspace_root: &Path,
    before_root: &Path,
    after_root: &Path,
    changed_paths: &[PreviewChange<'_>],
) -> Result<BTreeMap<String, String>, String> {
    if changed_paths.is_empty() {
        return Ok(BTreeMap::new());
    }
    let workspace_root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let before_root = before_root
        .canonicalize()
        .map_err(|error| format!("解析 Agent CLI 更新前快照目录失败: {error}"))?;
    let after_root = after_root
        .canonicalize()
        .map_err(|error| format!("解析 Agent CLI 更新后 Skill 目录失败: {error}"))?;
    let mut command = git_command();
    let output = command
        .args(["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--"])
        .arg(&before_root)
        .arg(&after_root)
        .output()
        .map_err(|error| format!("生成 Agent CLI Skill 目录 diff 失败: {error}"))?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(command_error(&output));
    }
    let diff = String::from_utf8_lossy(&output.stdout).to_string();
    let chunks = split_preview_diff_chunks(&diff);
    changed_paths
        .iter()
        .map(|(path, status, _, _)| {
            let before_path = before_root.join(path).to_string_lossy().into_owned();
            let after_path = after_root.join(path).to_string_lossy().into_owned();
            let chunk = chunks
                .iter()
                .find(|chunk| chunk.contains(&before_path) || chunk.contains(&after_path))
                .ok_or_else(|| format!("未找到 Agent CLI Skill 文件 diff: {path}"))?;
            Ok((
                path.clone(),
                normalize_preview_diff(chunk, &workspace_root, path, status),
            ))
        })
        .collect()
}

fn split_preview_diff_chunks(diff: &str) -> Vec<&str> {
    let starts = diff
        .match_indices("diff --git ")
        .map(|(start, _)| start)
        .collect::<Vec<_>>();
    starts
        .iter()
        .enumerate()
        .map(|(index, start)| {
            let end = starts.get(index + 1).copied().unwrap_or(diff.len());
            &diff[*start..end]
        })
        .collect()
}

fn normalize_preview_diff(
    diff: &str,
    workspace_root: &Path,
    relative_path: &str,
    status: &str,
) -> String {
    let old_label = if status == "A" {
        "/dev/null".to_string()
    } else {
        format!("a/{relative_path}")
    };
    let new_label = if status == "D" {
        "/dev/null".to_string()
    } else {
        format!("b/{relative_path}")
    };
    let workspace_text = workspace_root.to_string_lossy();
    diff.lines()
        .map(|line| {
            if line.starts_with("diff --git ") {
                format!("diff --git {old_label} {new_label}")
            } else if line.starts_with("--- ") {
                format!("--- {old_label}")
            } else if line.starts_with("+++ ") {
                format!("+++ {new_label}")
            } else {
                line.replace(workspace_text.as_ref(), "")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + if diff.ends_with('\n') { "\n" } else { "" }
}

pub fn detect_global_updates(
    skill_paths: &BTreeMap<String, PathBuf>,
) -> Result<AgentSkillUpdateCheck, String> {
    if skill_paths.is_empty() {
        return Ok(AgentSkillUpdateCheck::default());
    }
    let lock_path = home_dir()?.join(".agents/.skill-lock.json");
    let lock_contents = fs::read_to_string(&lock_path)
        .map_err(|error| format!("读取 Agent Skills CLI 锁文件失败: {error}"))?;
    let lock = parse_global_skill_lock(&lock_contents)?;
    let mut check = detect_cli_managed_updates(&lock_contents, &lock).unwrap_or_else(|error| {
        log::warn!("Agent Skills CLI update check failed: {error}");
        AgentSkillUpdateCheck::default()
    });
    check
        .checked_names
        .retain(|name| skill_paths.contains_key(name));
    check
        .updated_names
        .retain(|name| skill_paths.contains_key(name));
    Ok(check)
}

fn detect_cli_managed_updates(
    lock_contents: &str,
    original_lock: &GlobalSkillLock,
) -> Result<AgentSkillUpdateCheck, String> {
    let checked_names = original_lock
        .skills
        .iter()
        .filter_map(|(name, entry)| {
            (entry.source_type != WELL_KNOWN_SOURCE_TYPE
                && entry
                    .skill_path
                    .as_deref()
                    .is_some_and(|path| !path.is_empty())
                && !entry.skill_folder_hash.is_empty())
            .then(|| name.clone())
        })
        .collect::<BTreeSet<_>>();
    if checked_names.is_empty() {
        return Ok(AgentSkillUpdateCheck::default());
    }
    let temp_home = create_update_check_home(lock_contents)?;
    let result = run_update_check_in_home(&temp_home).and_then(|_| {
        let refreshed_contents = fs::read_to_string(temp_home.join(".agents/.skill-lock.json"))
            .map_err(|error| format!("读取临时 Agent Skills CLI 锁文件失败: {error}"))?;
        let refreshed_lock = parse_global_skill_lock(&refreshed_contents)?;
        Ok(AgentSkillUpdateCheck {
            checked_names,
            updated_names: changed_global_skill_names(original_lock, &refreshed_lock),
        })
    });
    let _ = fs::remove_dir_all(&temp_home);
    result
}

fn create_update_check_home(lock_contents: &str) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("生成更新检查临时目录失败: {error}"))?
        .as_nanos();
    let temp_home = std::env::temp_dir().join(format!(
        "skilldock-agent-update-check-{}-{timestamp}",
        std::process::id()
    ));
    let agents_dir = temp_home.join(".agents");
    fs::create_dir_all(&agents_dir)
        .map_err(|error| format!("创建更新检查临时目录失败: {error}"))?;
    fs::write(agents_dir.join(".skill-lock.json"), lock_contents)
        .map_err(|error| format!("写入临时 Agent Skills CLI 锁文件失败: {error}"))?;
    Ok(temp_home)
}

fn run_update_check_in_home(temp_home: &Path) -> Result<(), String> {
    let program = find_cli_program_for_operation()
        .ok_or_else(|| "未检测到 skills 命令，无法检查 Agent CLI Skill 更新。".to_string())?;
    let output = run_with_program_in_home(&program, &["update", "-g", "-y"], temp_home)?;
    if output.status.success() {
        return Ok(());
    }
    Err(command_error(&output))
}

pub fn global_status() -> AgentSkillsCliStatus {
    let global_path = global_skill_root()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let Some(program) = find_cli_program_for_operation() else {
        return AgentSkillsCliStatus {
            available: false,
            global_path,
            entries: Vec::new(),
            error: "未检测到 skills 命令；仍可扫描 ~/.agents/skills 中的文件。".into(),
        };
    };

    match run_with_program(&program, &["ls", "-g", "--json"]) {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            match parse_global_skill_list_json(&stdout) {
                Ok(entries) => AgentSkillsCliStatus {
                    available: true,
                    global_path,
                    entries,
                    error: String::new(),
                },
                Err(error) => AgentSkillsCliStatus {
                    available: true,
                    global_path,
                    entries: Vec::new(),
                    error,
                },
            }
        }
        Ok(output) => AgentSkillsCliStatus {
            available: true,
            global_path,
            entries: Vec::new(),
            error: command_error(&output),
        },
        Err(error) => AgentSkillsCliStatus {
            available: true,
            global_path,
            entries: Vec::new(),
            error,
        },
    }
}

pub fn parse_global_skill_list_json(output: &str) -> Result<Vec<CliSkillEntry>, String> {
    serde_json::from_str(output).map_err(|error| format!("解析 skills 列表失败: {error}"))
}

pub fn confirms_global_agent_installation(
    status: &AgentSkillsCliStatus,
    skill_name: &str,
    skill_path: &Path,
    agent_names: &[&str],
) -> Result<bool, String> {
    if !status.available || !status.error.is_empty() {
        return Err(if status.error.is_empty() {
            "未检测到 skills 命令，无法确认 Agent CLI 安装状态。".into()
        } else {
            status.error.clone()
        });
    }

    let expected_path = skill_path
        .canonicalize()
        .unwrap_or_else(|_| skill_path.to_path_buf());
    Ok(status.entries.iter().any(|entry| {
        if entry.name != skill_name {
            return false;
        }
        let entry_path = PathBuf::from(&entry.path);
        let entry_path = entry_path.canonicalize().unwrap_or(entry_path);
        entry_path == expected_path
            && entry.agents.iter().any(|agent| {
                agent_names
                    .iter()
                    .any(|expected| agent.trim().eq_ignore_ascii_case(expected.trim()))
            })
    }))
}

pub fn update_global_skill(name: &str) -> Result<(), String> {
    let lock_path = home_dir()?.join(".agents/.skill-lock.json");
    let lock_contents = fs::read_to_string(lock_path)
        .map_err(|error| format!("读取 Agent Skills CLI 锁文件失败: {error}"))?;
    let lock = parse_global_skill_lock(&lock_contents)?;
    if let Some(entry) = lock.skills.get(name) {
        if entry.source_type == WELL_KNOWN_SOURCE_TYPE && !entry.source_url.is_empty() {
            return run_explicit_cli(&["add", &entry.source_url, "-g", "-y"]);
        }
    }
    run_explicit_cli(&["update", name, "-g", "-y"])
}

pub fn remove_global_skill(name: &str) -> Result<(), String> {
    run_explicit_cli(&["remove", name, "-g", "-y"])?;
    verify_global_skill_removed(name)
}

fn verify_global_skill_removed(name: &str) -> Result<(), String> {
    let entry_path = global_skill_root()?.join(name);
    if fs::symlink_metadata(&entry_path).is_ok() {
        return Err(format!(
            "Agent Skills CLI 未删除全局 Skill 入口：{}",
            entry_path.to_string_lossy()
        ));
    }

    let lock_path = home_dir()?.join(".agents/.skill-lock.json");
    let lock_contents = match fs::read_to_string(&lock_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取 Agent Skills CLI 锁文件失败: {error}")),
    };
    let lock = parse_global_skill_lock(&lock_contents)?;
    if lock.skills.contains_key(name) {
        return Err(format!("Agent Skills CLI 未删除 {name} 的锁文件记录"));
    }
    Ok(())
}

fn run_explicit_cli(args: &[&str]) -> Result<(), String> {
    let program = find_cli_program_for_operation()
        .ok_or_else(|| "未检测到 skills 命令，无法执行 Agent Skills CLI 操作。".to_string())?;
    let output = run_with_program(&program, args)?;
    if output.status.success() {
        return Ok(());
    }

    Err(command_error(&output))
}

fn find_local_cli_program() -> Option<CliProgram> {
    let program = CliProgram::direct();
    let output = run_with_program(&program, &["--version"]).ok()?;
    output.status.success().then_some(program)
}

fn find_cli_program_for_operation() -> Option<CliProgram> {
    find_local_cli_program().or_else(|| {
        let program = CliProgram::npx();
        run_with_program(&program, &["--version"])
            .ok()
            .filter(|output| output.status.success())
            .map(|_| program)
    })
}

fn run_with_program(program: &CliProgram, args: &[&str]) -> Result<Output, String> {
    let mut command = cli_command(&program.program)?;
    command.args(&program.prefix_args).args(args);
    command
        .output()
        .map_err(|error| format!("执行 skills 命令失败: {error}"))
}

fn run_with_program_in_home(
    program: &CliProgram,
    args: &[&str],
    task_home: &Path,
) -> Result<Output, String> {
    let mut command = cli_command(&program.program)?;
    command.args(&program.prefix_args).args(args);
    command.env("HOME", task_home).env("USERPROFILE", task_home);
    command
        .output()
        .map_err(|error| format!("执行 skills 命令失败: {error}"))
}

fn cli_command(program: &str) -> Result<Command, String> {
    #[cfg(windows)]
    {
        let executable = resolve_command_in_path(program)
            .ok_or_else(|| format!("未找到 Agent Skills CLI 命令: {program}"))?;
        return Ok(command_for_executable(&executable));
    }

    #[cfg(not(windows))]
    {
        Ok(Command::new(program))
    }
}

fn command_error(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("skills 命令执行失败，退出码 {:?}", output.status.code())
    } else {
        format!("skills 命令执行失败: {stderr}")
    }
}

#[derive(Clone, Debug)]
struct CliProgram {
    program: String,
    prefix_args: Vec<String>,
}

impl CliProgram {
    fn direct() -> Self {
        Self {
            program: CLI_COMMAND.into(),
            prefix_args: Vec::new(),
        }
    }

    fn npx() -> Self {
        Self {
            program: NPX_COMMAND.into(),
            prefix_args: vec!["--yes".into(), CLI_COMMAND.into()],
        }
    }
}

#[allow(dead_code)]
pub fn is_global_skill_path(path: &Path) -> bool {
    let Ok(root) = global_skill_root() else {
        return false;
    };
    let lexical_path = path.to_path_buf();
    if lexical_path.starts_with(&root) {
        return true;
    }

    root.canonicalize().ok().is_some_and(|canonical_root| {
        path.canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .starts_with(canonical_root)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        changed_global_skill_names, confirms_global_agent_installation, detect_global_updates,
        global_status, is_global_skill_path, parse_global_skill_list_json, parse_global_skill_lock,
        remove_global_skill, resolve_skill_entry_path, AgentSkillsCliStatus, CliSkillEntry,
    };
    use std::collections::BTreeMap;
    use std::env;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_global_skill_list_json() {
        let entries = parse_global_skill_list_json(
            r#"[{"name":"demo","path":"/tmp/.agents/skills/demo","scope":"global","agents":["Codex"]}]"#,
        )
        .expect("parse CLI JSON");

        assert_eq!(
            entries,
            vec![CliSkillEntry {
                name: "demo".into(),
                path: "/tmp/.agents/skills/demo".into(),
                scope: "global".into(),
                agents: vec!["Codex".into()],
            }]
        );
    }

    #[test]
    fn confirms_global_skill_path_and_agent_membership() {
        let skill_path = PathBuf::from("/tmp/.agents/skills/demo");
        let status = AgentSkillsCliStatus {
            available: true,
            global_path: "/tmp/.agents/skills".into(),
            entries: vec![CliSkillEntry {
                name: "demo".into(),
                path: skill_path.to_string_lossy().to_string(),
                scope: "global".into(),
                agents: vec!["Claude Code".into()],
            }],
            error: String::new(),
        };

        assert_eq!(
            confirms_global_agent_installation(&status, "demo", &skill_path, &["Claude Code"]),
            Ok(true)
        );
        assert_eq!(
            confirms_global_agent_installation(&status, "demo", &skill_path, &["Cursor"]),
            Ok(false)
        );
        assert_eq!(
            confirms_global_agent_installation(
                &status,
                "demo",
                PathBuf::from("/tmp/other/demo").as_path(),
                &["Claude Code"]
            ),
            Ok(false)
        );
    }

    #[test]
    fn refuses_to_confirm_installation_when_cli_status_failed() {
        let status = AgentSkillsCliStatus {
            available: false,
            global_path: String::new(),
            entries: Vec::new(),
            error: "skills unavailable".into(),
        };

        assert_eq!(
            confirms_global_agent_installation(
                &status,
                "demo",
                PathBuf::from("/tmp/.agents/skills/demo").as_path(),
                &["Claude Code"]
            ),
            Err("skills unavailable".into())
        );
    }

    #[test]
    fn rejects_malformed_global_skill_list_json() {
        assert!(parse_global_skill_list_json("not-json").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn global_status_uses_operation_fallback_when_direct_cli_is_missing() {
        let _guard = crate::workspace::TEST_ENV_LOCK.lock().expect("env lock");
        let original_home = env::var_os("HOME");
        let original_path = env::var_os("PATH");
        let temp_home = env::temp_dir().join(format!(
            "skilldock-agent-status-fallback-test-{}",
            std::process::id()
        ));
        let fake_bin = temp_home.join("bin");
        let fake_skills = fake_bin.join("skills");
        let fake_npx = fake_bin.join("npx");
        fs::create_dir_all(&fake_bin).expect("create fake executable path");
        fs::write(&fake_skills, "#!/bin/sh\nexit 1\n").expect("write unavailable skills command");
        fs::set_permissions(&fake_skills, fs::Permissions::from_mode(0o755))
            .expect("make fake skills executable");
        fs::write(
            &fake_npx,
            r#"#!/bin/sh
if [ "$1" != "--yes" ] || [ "$2" != "skills" ]; then
  exit 1
fi
if [ "$3" = "--version" ]; then
  exit 0
fi
if [ "$3" = "ls" ]; then
  printf '%s' '[{"name":"demo","path":"/tmp/.agents/skills/demo","scope":"global","agents":["Claude Code"]}]'
  exit 0
fi
exit 1
"#,
        )
        .expect("write fake npx executable");
        fs::set_permissions(&fake_npx, fs::Permissions::from_mode(0o755))
            .expect("make fake npx executable");

        let next_path = original_path
            .as_ref()
            .map(|path| {
                let mut paths = env::split_paths(path).collect::<Vec<_>>();
                paths.insert(0, fake_bin.clone());
                env::join_paths(paths).expect("join fake executable path")
            })
            .unwrap_or_else(|| fake_bin.clone().into_os_string());

        unsafe {
            env::set_var("HOME", &temp_home);
            env::set_var("PATH", next_path);
        }

        let status = global_status();

        match original_home {
            Some(value) => unsafe { env::set_var("HOME", value) },
            None => unsafe { env::remove_var("HOME") },
        }
        match original_path {
            Some(value) => unsafe { env::set_var("PATH", value) },
            None => unsafe { env::remove_var("PATH") },
        }
        let _ = fs::remove_dir_all(temp_home);

        assert!(status.available);
        assert!(status.error.is_empty());
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].name, "demo");
    }

    #[test]
    fn detects_changed_global_skill_hashes() {
        let before = parse_global_skill_lock(
            r#"{"version":3,"skills":{"changed":{"skillFolderHash":"old"},"same":{"skillFolderHash":"same"}}}"#,
        )
        .expect("parse original lock");
        let after = parse_global_skill_lock(
            r#"{"version":3,"skills":{"changed":{"skillFolderHash":"new"},"same":{"skillFolderHash":"same"}}}"#,
        )
        .expect("parse refreshed lock");

        assert_eq!(
            changed_global_skill_names(&before, &after),
            ["changed".to_string()].into_iter().collect()
        );
    }

    #[test]
    fn parses_well_known_lock_entry_with_null_skill_path() {
        let lock = parse_global_skill_lock(
            r#"{"version":3,"skills":{"lark-attendance":{"sourceType":"well-known","sourceUrl":"https://open.feishu.cn/.well-known/skills/lark-attendance/SKILL.md","skillFolderHash":"","skillPath":null}}}"#,
        )
        .expect("parse well-known lock");

        let entry = lock.skills.get("lark-attendance").expect("find lock entry");
        assert_eq!(entry.skill_path, None);
    }

    #[test]
    fn skips_global_update_detection_without_agent_skills() {
        assert_eq!(
            detect_global_updates(&BTreeMap::new()),
            Ok(Default::default())
        );
    }

    #[test]
    fn does_not_check_well_known_skills_for_updates() {
        let _guard = crate::workspace::TEST_ENV_LOCK.lock().expect("env lock");
        let original_home = env::var_os("HOME");
        let temp_home = env::temp_dir().join(format!(
            "skilldock-well-known-update-test-{}",
            std::process::id()
        ));
        let skill_dir = temp_home.join(".agents/skills/lark-okr");
        fs::create_dir_all(&skill_dir).expect("create well-known skill path");
        fs::write(skill_dir.join("SKILL.md"), "local contents")
            .expect("write local skill contents");

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        listener
            .set_nonblocking(true)
            .expect("configure test server");
        let source_url = format!(
            "http://{}/.well-known/skills/lark-okr/SKILL.md",
            listener.local_addr().expect("read test server address")
        );
        let (request_tx, request_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let server = thread::spawn(move || loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut request = [0_u8; 1024];
                    let _ = stream.read(&mut request);
                    let _ = request_tx.send(());
                    let body = "remote contents";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream
                        .write_all(response.as_bytes())
                        .expect("serve remote skill contents");
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::yield_now();
                }
                Err(error) => panic!("accept test request: {error}"),
            }
        });

        fs::write(
            temp_home.join(".agents/.skill-lock.json"),
            format!(
                r#"{{"version":3,"skills":{{"lark-okr":{{"sourceType":"well-known","sourceUrl":"{source_url}","skillFolderHash":"","skillPath":null}}}}}}"#
            ),
        )
        .expect("write well-known lock");
        unsafe {
            env::set_var("HOME", &temp_home);
        }

        let check = detect_global_updates(&BTreeMap::from([("lark-okr".to_string(), skill_dir)]));

        let _ = stop_tx.send(());
        server.join().expect("stop test server");
        match original_home {
            Some(value) => unsafe { env::set_var("HOME", value) },
            None => unsafe { env::remove_var("HOME") },
        }
        let _ = fs::remove_dir_all(temp_home);

        assert!(request_rx.try_recv().is_err());
        assert_eq!(check, Ok(Default::default()));
    }

    #[cfg(unix)]
    #[test]
    fn remove_global_skill_verifies_cli_cleanup() {
        let _guard = crate::workspace::TEST_ENV_LOCK.lock().expect("env lock");
        let temp_home = env::temp_dir().join(format!(
            "skilldock-agent-remove-test-{}",
            std::process::id()
        ));
        let fake_bin = temp_home.join("bin");
        let skill_dir = temp_home.join(".agents/skills/demo");
        fs::create_dir_all(&fake_bin).expect("create fake executable path");
        let fake_skills = fake_bin.join("skills");
        fs::write(
            &fake_skills,
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
if [ "$1" = "remove" ]; then
  if [ "$SKILL_TEST_KEEP" != "1" ]; then
    rm -rf "$HOME/.agents/skills/$2"
    printf '%s' '{"version":3,"skills":{}}' > "$HOME/.agents/.skill-lock.json"
  fi
  exit 0
fi
exit 1
"#,
        )
        .expect("write fake skills executable");
        fs::set_permissions(&fake_skills, fs::Permissions::from_mode(0o755))
            .expect("make fake skills executable");

        let original_home = env::var_os("HOME");
        let original_path = env::var_os("PATH");
        let original_keep = env::var_os("SKILL_TEST_KEEP");
        let next_path = original_path
            .as_ref()
            .map(|path| {
                let mut paths = env::split_paths(path).collect::<Vec<_>>();
                paths.insert(0, fake_bin);
                env::join_paths(paths).expect("join fake executable path")
            })
            .unwrap_or_else(|| temp_home.join("bin").into_os_string());
        unsafe {
            env::set_var("HOME", &temp_home);
            env::set_var("PATH", next_path);
            env::remove_var("SKILL_TEST_KEEP");
        }

        let create_locked_skill = || {
            fs::create_dir_all(&skill_dir).expect("create Agent CLI skill");
            fs::write(skill_dir.join("SKILL.md"), "# demo\n").expect("write Agent CLI skill");
            fs::write(
                temp_home.join(".agents/.skill-lock.json"),
                r#"{"version":3,"skills":{"demo":{"sourceType":"github","skillPath":"skills/demo/SKILL.md","skillFolderHash":"hash"}}}"#,
            )
            .expect("write Agent CLI lock");
        };

        create_locked_skill();
        let removed = remove_global_skill("demo");
        create_locked_skill();
        unsafe {
            env::set_var("SKILL_TEST_KEEP", "1");
        }
        let incomplete = remove_global_skill("demo");

        match original_home {
            Some(value) => unsafe { env::set_var("HOME", value) },
            None => unsafe { env::remove_var("HOME") },
        }
        match original_path {
            Some(value) => unsafe { env::set_var("PATH", value) },
            None => unsafe { env::remove_var("PATH") },
        }
        match original_keep {
            Some(value) => unsafe { env::set_var("SKILL_TEST_KEEP", value) },
            None => unsafe { env::remove_var("SKILL_TEST_KEEP") },
        }
        let _ = fs::remove_dir_all(temp_home);

        removed.expect("remove Agent CLI skill through CLI");
        assert!(incomplete.is_err());
    }

    #[test]
    fn resolves_real_and_broken_skill_entries() {
        let temp_dir = env::temp_dir().join("skilldock-entry-path-test");
        let skill_dir = temp_dir.join("demo");
        fs::create_dir_all(&skill_dir).expect("create skill path");

        let resolved = resolve_skill_entry_path(&skill_dir);
        assert_eq!(resolved.canonical_path, skill_dir.canonicalize().ok());
        assert!(resolved.path_error.is_empty());

        let broken = resolve_skill_entry_path(&temp_dir.join("missing"));
        assert!(broken.canonical_path.is_none());
        assert!(!broken.path_error.is_empty());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn recognizes_path_inside_global_skill_root() {
        let _guard = crate::workspace::TEST_ENV_LOCK.lock().expect("env lock");
        let original_home = env::var_os("HOME");
        let temp_home = env::temp_dir().join("skilldock-cli-path-test");
        let skill_path = temp_home.join(".agents/skills/demo");
        fs::create_dir_all(&skill_path).expect("create skill path");
        unsafe {
            env::set_var("HOME", &temp_home);
        }

        assert!(is_global_skill_path(&skill_path));
        assert!(!is_global_skill_path(&PathBuf::from("/tmp/other-skill")));

        match original_home {
            Some(value) => unsafe { env::set_var("HOME", value) },
            None => unsafe { env::remove_var("HOME") },
        }
        let _ = fs::remove_dir_all(temp_home);
    }

    #[cfg(unix)]
    #[test]
    fn previews_agent_cli_update_without_mutating_real_skill() {
        let _guard = crate::workspace::TEST_ENV_LOCK.lock().expect("env lock");
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("read test time")
            .as_nanos();
        let temp_home = env::temp_dir().join(format!(
            "skilldock-agent-preview-test-{}-{timestamp}",
            std::process::id()
        ));
        let fake_bin = temp_home.join("bin");
        let skill_dir = temp_home.join(".agents/skills/demo");
        let fake_skills = fake_bin.join("skills");
        fs::create_dir_all(&fake_bin).expect("create fake executable path");
        fs::create_dir_all(&skill_dir).expect("create real Agent CLI skill");
        fs::write(skill_dir.join("SKILL.md"), "before\n").expect("write real skill");
        fs::write(skill_dir.join("remove.md"), "remove\n").expect("write removable file");
        fs::write(
            temp_home.join(".agents/.skill-lock.json"),
            r#"{"version":3,"skills":{"demo":{"sourceType":"github","sourceUrl":"https://github.com/example/demo","skillPath":"skills/demo/SKILL.md","skillFolderHash":"before"}}}"#,
        )
        .expect("write real lock");
        fs::write(
            &fake_skills,
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
if [ "$1" = "update" ]; then
  printf 'x' >> "$SKILL_TEST_COUNTER"
  printf 'after\n' > "$HOME/.agents/skills/demo/SKILL.md"
  printf 'added\n' > "$HOME/.agents/skills/demo/add.md"
  rm "$HOME/.agents/skills/demo/remove.md"
  exit 0
fi
exit 1
"#,
        )
        .expect("write fake skills executable");
        fs::set_permissions(&fake_skills, fs::Permissions::from_mode(0o755))
            .expect("make fake skills executable");

        let original_home = env::var_os("HOME");
        let original_path = env::var_os("PATH");
        let original_counter = env::var_os("SKILL_TEST_COUNTER");
        let counter_path = temp_home.join("update-invocations");
        let next_path = original_path
            .as_ref()
            .map(|path| {
                let mut paths = env::split_paths(path).collect::<Vec<_>>();
                paths.insert(0, fake_bin.clone());
                env::join_paths(paths).expect("join fake executable path")
            })
            .unwrap_or_else(|| fake_bin.clone().into_os_string());
        unsafe {
            env::set_var("HOME", &temp_home);
            env::set_var("PATH", next_path);
            env::set_var("SKILL_TEST_COUNTER", &counter_path);
        }

        let preview = super::preview_global_skill_update("demo", &skill_dir);
        let cached_preview = super::preview_global_skill_update("demo", &skill_dir);
        fs::write(skill_dir.join("local-change.md"), "changed\n")
            .expect("write local cache invalidation file");
        let invalidated_preview = super::preview_global_skill_update("demo", &skill_dir);

        match original_home {
            Some(value) => unsafe { env::set_var("HOME", value) },
            None => unsafe { env::remove_var("HOME") },
        }
        match original_path {
            Some(value) => unsafe { env::set_var("PATH", value) },
            None => unsafe { env::remove_var("PATH") },
        }
        match original_counter {
            Some(value) => unsafe { env::set_var("SKILL_TEST_COUNTER", value) },
            None => unsafe { env::remove_var("SKILL_TEST_COUNTER") },
        }

        let preview = preview.expect("preview Agent CLI update");
        let cached_preview = cached_preview.expect("load cached Agent CLI update preview");
        invalidated_preview.expect("refresh invalidated Agent CLI update preview");
        assert_eq!(
            preview
                .changed_files
                .iter()
                .map(|change| (change.path.as_str(), change.status.as_str()))
                .collect::<Vec<_>>(),
            vec![("SKILL.md", "M"), ("add.md", "A"), ("remove.md", "D")]
        );
        let skill_change = preview
            .changed_files
            .iter()
            .find(|change| change.path == "SKILL.md")
            .expect("find changed skill file");
        assert!(
            skill_change.diff.contains("-before"),
            "diff={:?}",
            skill_change.diff
        );
        assert!(skill_change.diff.contains("+after"));
        assert!(!skill_change.diff.contains("agent-cli-update-preview"));
        assert_eq!(
            cached_preview
                .changed_files
                .iter()
                .map(|change| (&change.path, &change.status, &change.diff))
                .collect::<Vec<_>>(),
            preview
                .changed_files
                .iter()
                .map(|change| (&change.path, &change.status, &change.diff))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            fs::read_to_string(temp_home.join("update-invocations"))
                .expect("read update invocation count"),
            "xx"
        );
        assert_eq!(
            fs::read_to_string(skill_dir.join("SKILL.md")).expect("read real skill"),
            "before\n"
        );
        assert!(!temp_home
            .join(".skilldock/cache/agent-cli-update-preview")
            .read_dir()
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false));
        let _ = fs::remove_dir_all(temp_home);
    }
}
