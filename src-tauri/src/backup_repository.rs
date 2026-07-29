use std::fs;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::backup_merge::BackupConflict;
use crate::backup_snapshot::{
    apply_library_snapshot, apply_library_snapshot_preserving, backup_repo_path, backup_root,
    read_library_snapshot, replace_repository_snapshot, write_current_library_snapshot,
};
use crate::github_api;
use crate::github_credentials;
use crate::models::{BackupStatus, GithubBackupSettings};
use crate::state::{load_github_backup_settings, save_github_backup_settings};

const DEFAULT_BACKUP_REPOSITORY_NAME: &str = "skilldock-backup";
pub(crate) const BACKUP_STATUS_CHANGED_EVENT: &str = "backup-status-changed";
const ASKPASS_USERNAME_ENV: &str = "SKILLDOCK_ASKPASS_USERNAME";
const ASKPASS_PASSWORD_ENV: &str = "SKILLDOCK_ASKPASS_PASSWORD";
const BACKUP_REMOTE_CONFIG_KEY: &str = "skilldock.remoteUrl";
const ASKPASS_SCRIPT: &str = "#!/bin/sh\ncase \"$1\" in\n  *[Uu]sername*) printf '%s\\n' \"${SKILLDOCK_ASKPASS_USERNAME}\" ;;\n  *) printf '%s\\n' \"${SKILLDOCK_ASKPASS_PASSWORD}\" ;;\nesac\n";

static BACKUP_SYNC_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static BACKUP_SYNCING: AtomicBool = AtomicBool::new(false);

pub(crate) fn is_backup_syncing() -> bool {
    BACKUP_SYNCING.load(Ordering::SeqCst)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSyncResult {
    pub status: BackupStatus,
    pub included_skills: usize,
    pub excluded_skills: Vec<String>,
    pub changed: bool,
    pub snapshot_tag: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshotInfo {
    pub tag: String,
    pub commit: String,
    pub created_at: String,
    pub message: String,
}

struct WorktreeGuard {
    repository: std::path::PathBuf,
    path: std::path::PathBuf,
}

impl Drop for WorktreeGuard {
    fn drop(&mut self) {
        let path = self.path.to_string_lossy().to_string();
        let _ = git(
            &self.repository,
            &["worktree", "remove", "--force", &path],
            None,
        );
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn sync_lock() -> &'static Mutex<()> {
    BACKUP_SYNC_LOCK.get_or_init(|| Mutex::new(()))
}

fn status_from_settings(settings: GithubBackupSettings) -> BackupStatus {
    BackupStatus {
        enabled: settings.enabled,
        repository_owner: settings.repository_owner,
        repository_name: settings.repository_name,
        repository_url: settings.repository_url,
        device_name: settings.device_name,
        auto_backup: settings.auto_backup,
        last_sync_at: settings.last_sync_at,
        last_error: settings.last_error,
        syncing: BACKUP_SYNCING.load(Ordering::SeqCst),
        pending_conflicts: pending_conflict_count(),
    }
}

fn pending_conflict_count() -> usize {
    let Ok(repo_path) = backup_repo_path() else {
        return 0;
    };
    let path = repo_path.join(".skilldock/conflicts.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok())
        .and_then(|value| value.get("conflicts")?.as_array().map(Vec::len))
        .unwrap_or(0)
}

fn askpass_script_path() -> Result<std::path::PathBuf, String> {
    Ok(backup_root()?.join("git-askpass.sh"))
}

fn ensure_askpass_script() -> Result<std::path::PathBuf, String> {
    let path = askpass_script_path()?;
    if fs::read_to_string(&path).ok().as_deref() != Some(ASKPASS_SCRIPT) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建 Git 认证目录失败: {error}"))?;
        }
        fs::write(&path, ASKPASS_SCRIPT)
            .map_err(|error| format!("写入 Git 认证脚本失败: {error}"))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("设置 Git 认证脚本权限失败: {error}"))?;
    }
    Ok(path)
}

fn git_output(repo_path: &Path, args: &[&str], token: Option<&str>) -> Result<Output, String> {
    let mut command = Command::new("git");
    command.current_dir(repo_path).args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");
    if let Some(token) = token.filter(|value| !value.trim().is_empty()) {
        let askpass = ensure_askpass_script()?;
        command.env("GIT_ASKPASS", askpass);
        command.env(ASKPASS_USERNAME_ENV, "x-access-token");
        command.env(ASKPASS_PASSWORD_ENV, token);
    }
    #[cfg(windows)]
    crate::library::configure_hidden_subprocess(&mut command);
    command
        .output()
        .map_err(|error| format!("执行 Git 备份命令失败: {error}"))
}

pub(crate) fn git(repo_path: &Path, args: &[&str], token: Option<&str>) -> Result<String, String> {
    let output = git_output(repo_path, args, token)?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if message.is_empty() {
        format!("Git 备份命令失败: {}", args.join(" "))
    } else {
        message
    })
}

pub(crate) fn git_success(repo_path: &Path, args: &[&str]) -> bool {
    git_output(repo_path, args, None)
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn ensure_local_repository(repo_path: &Path, remote_url: &str) -> Result<(), String> {
    archive_repository_for_different_remote(repo_path, remote_url)?;
    fs::create_dir_all(repo_path).map_err(|error| format!("创建本地备份仓库失败: {error}"))?;
    if !repo_path.join(".git").is_dir() && git(repo_path, &["init", "-b", "main"], None).is_err() {
        git(repo_path, &["init"], None)?;
        git(repo_path, &["checkout", "-B", "main"], None)?;
    }
    git(
        repo_path,
        &["config", "user.name", "SkillDock Backup"],
        None,
    )?;
    git(
        repo_path,
        &["config", "user.email", "backup@skilldock.local"],
        None,
    )?;
    if git_success(repo_path, &["remote", "get-url", "origin"]) {
        git(
            repo_path,
            &["remote", "set-url", "origin", remote_url],
            None,
        )?;
    } else {
        git(repo_path, &["remote", "add", "origin", remote_url], None)?;
    }
    git(
        repo_path,
        &["config", BACKUP_REMOTE_CONFIG_KEY, remote_url],
        None,
    )?;
    Ok(())
}

fn archive_repository_for_different_remote(
    repo_path: &Path,
    remote_url: &str,
) -> Result<(), String> {
    if !repo_path.join(".git").is_dir() {
        return Ok(());
    }
    let bound_remote = git(
        repo_path,
        &["config", "--get", BACKUP_REMOTE_CONFIG_KEY],
        None,
    )
    .ok();
    let origin_remote = git(repo_path, &["remote", "get-url", "origin"], None).ok();
    let matches_remote = bound_remote.as_deref() == Some(remote_url)
        || (bound_remote.is_none() && origin_remote.as_deref() == Some(remote_url));
    if matches_remote {
        return Ok(());
    }

    let parent = repo_path
        .parent()
        .ok_or_else(|| "本地备份仓库路径无效".to_string())?;
    let archive_root = parent.join("repository-archive");
    fs::create_dir_all(&archive_root)
        .map_err(|error| format!("创建备份仓库归档目录失败: {error}"))?;
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S");
    let archive_path = archive_root.join(format!(
        "{timestamp}-{}",
        &uuid::Uuid::new_v4().to_string()[..8]
    ));
    fs::rename(repo_path, &archive_path)
        .map_err(|error| format!("归档旧备份仓库失败 {}: {error}", archive_path.display()))
}

fn commit_snapshot(repo_path: &Path, device_name: &str) -> Result<bool, String> {
    git(repo_path, &["add", "--all"], None)?;
    if git_success(repo_path, &["diff", "--cached", "--quiet"]) {
        return Ok(false);
    }
    let message = format!("SkillDock backup from {device_name}");
    git(repo_path, &["commit", "-m", &message], None)?;
    Ok(true)
}

fn remote_branch_exists(repo_path: &Path) -> bool {
    git_success(
        repo_path,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            "refs/remotes/origin/main",
        ],
    )
}

fn reconcile_remote(repo_path: &Path, token: &str) -> Result<(), String> {
    let fetch_result = git(
        repo_path,
        &["fetch", "--prune", "--tags", "origin", "main"],
        Some(token),
    );
    if let Err(error) = fetch_result {
        if error.contains("couldn't find remote ref")
            || error.contains("does not appear to be a git repository")
        {
            return Ok(());
        }
        return Err(error);
    }
    if !remote_branch_exists(repo_path) {
        return Ok(());
    }
    if git_success(
        repo_path,
        &["merge-base", "--is-ancestor", "origin/main", "HEAD"],
    ) {
        return Ok(());
    }
    if git_success(
        repo_path,
        &["merge-base", "--is-ancestor", "HEAD", "origin/main"],
    ) {
        git(repo_path, &["merge", "--ff-only", "origin/main"], None)?;
        return Ok(());
    }
    crate::backup_merge::merge_remote_branch(repo_path)
}

fn create_snapshot_tag(repo_path: &Path, device_name: &str) -> Result<String, String> {
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let tag = format!(
        "skilldock/snapshot/{timestamp}-{}",
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let message = format!("SkillDock snapshot from {device_name}");
    git(repo_path, &["tag", "-a", &tag, "-m", &message], None)?;
    Ok(tag)
}

fn materialize_reference(repo_path: &Path, reference: &str) -> Result<WorktreeGuard, String> {
    let path = backup_root()?
        .join("staging")
        .join(format!("history-{}", uuid::Uuid::new_v4()));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建历史恢复暂存区失败: {error}"))?;
    }
    let path_value = path.to_string_lossy().to_string();
    git(
        repo_path,
        &["worktree", "add", "--detach", &path_value, reference],
        None,
    )?;
    Ok(WorktreeGuard {
        repository: repo_path.to_path_buf(),
        path,
    })
}

fn retryable_push_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("non-fast-forward")
        || normalized.contains("fetch first")
        || normalized.contains("rejected")
}

fn push_branch_with_retry(repo_path: &Path, token: &str) -> Result<(), String> {
    let mut last_error = String::new();
    for attempt in 0..3 {
        match git(repo_path, &["push", "origin", "HEAD:main"], Some(token)) {
            Ok(_) => return Ok(()),
            Err(error) if attempt < 2 && retryable_push_error(&error) => {
                last_error = error;
                reconcile_remote(repo_path, token)?;
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error)
}

fn push_snapshot_tags(repo_path: &Path, token: &str) -> Result<(), String> {
    git(repo_path, &["push", "origin", "--tags"], Some(token)).map(|_| ())
}

fn apply_and_refresh_library(
    app_handle: &tauri::AppHandle,
    repo_path: &Path,
    preserved_backup_ids: &[String],
) -> Result<usize, String> {
    let installed_skills = if preserved_backup_ids.is_empty() {
        apply_library_snapshot(repo_path)?
    } else {
        apply_library_snapshot_preserving(repo_path, preserved_backup_ids)?
    };
    crate::commands::refresh_backup_library(app_handle, &installed_skills)?;
    Ok(read_library_snapshot(repo_path)?.skills.len())
}

fn run_backup_sync_blocking(app_handle: tauri::AppHandle) -> Result<BackupSyncResult, String> {
    let _guard = sync_lock()
        .lock()
        .map_err(|_| "备份同步锁不可用".to_string())?;
    BACKUP_SYNCING.store(true, Ordering::SeqCst);
    let result = run_backup_sync_locked(&app_handle);
    BACKUP_SYNCING.store(false, Ordering::SeqCst);
    result
}

fn run_backup_sync_locked(app_handle: &tauri::AppHandle) -> Result<BackupSyncResult, String> {
    let mut settings = load_github_backup_settings();
    if !settings.enabled {
        return Err("尚未启用 GitHub 备份".to_string());
    }
    let credential = github_credentials::load_credential()
        .ok_or_else(|| "GitHub 凭据不可用，请重新连接".to_string())?;
    if !credential.persisted {
        return Err("系统凭据存储不可用，不能启用多设备备份".to_string());
    }
    let repo_path = backup_repo_path()?;
    ensure_local_repository(&repo_path, &settings.repository_url)?;
    let starting_commit = git(&repo_path, &["rev-parse", "HEAD"], None).ok();
    let report = write_current_library_snapshot(&repo_path)?;
    let _ = commit_snapshot(&repo_path, &settings.device_name)?;
    reconcile_remote(&repo_path, &credential.token)?;
    let _ = apply_and_refresh_library(app_handle, &repo_path, &report.preserved_backup_ids)?;
    push_branch_with_retry(&repo_path, &credential.token)?;
    let included_skills =
        apply_and_refresh_library(app_handle, &repo_path, &report.preserved_backup_ids)?;
    let ending_commit = git(&repo_path, &["rev-parse", "HEAD"], None)?;
    let changed = starting_commit.as_deref() != Some(ending_commit.as_str());
    let snapshot_tag = if changed {
        create_snapshot_tag(&repo_path, &settings.device_name)?
    } else {
        String::new()
    };
    push_snapshot_tags(&repo_path, &credential.token)?;
    settings.last_sync_at = Utc::now().to_rfc3339();
    settings.last_error.clear();
    save_github_backup_settings(settings.clone())?;
    Ok(BackupSyncResult {
        status: status_from_settings(settings),
        included_skills,
        excluded_skills: report.excluded_skills,
        changed,
        snapshot_tag,
    })
}

fn record_sync_error(error: &str) {
    let mut settings = load_github_backup_settings();
    settings.last_error = error.to_string();
    let _ = save_github_backup_settings(settings);
}

pub(crate) fn run_scheduled_backup(
    app_handle: tauri::AppHandle,
) -> Result<BackupSyncResult, String> {
    let result = run_backup_sync_blocking(app_handle.clone());
    match result {
        Ok(sync_result) => {
            let _ = app_handle.emit(BACKUP_STATUS_CHANGED_EVENT, sync_result.status.clone());
            Ok(sync_result)
        }
        Err(error) => {
            record_sync_error(&error);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn get_backup_status() -> BackupStatus {
    status_from_settings(load_github_backup_settings())
}

#[tauri::command]
pub async fn enable_github_backup(
    app_handle: tauri::AppHandle,
    repository_name: Option<String>,
) -> Result<BackupSyncResult, String> {
    let credential =
        github_credentials::load_credential().ok_or_else(|| "请先连接 GitHub".to_string())?;
    if !credential.persisted {
        return Err("系统凭据存储不可用，不能启用多设备备份".to_string());
    }
    let repository_name = repository_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_BACKUP_REPOSITORY_NAME);
    let client = github_api::http_client()?;
    let repository =
        github_api::ensure_private_backup_repository(&client, &credential.token, repository_name)
            .await?;
    let mut settings = load_github_backup_settings();
    settings.enabled = true;
    settings.repository_owner = repository.owner;
    settings.repository_name = repository.name;
    settings.repository_url = repository.clone_url;
    if settings.device_name.trim().is_empty() {
        settings.device_name = default_device_name();
    }
    save_github_backup_settings(settings)?;
    let sync_app_handle = app_handle.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || run_backup_sync_blocking(sync_app_handle))
            .await
            .map_err(|error| format!("启动备份同步失败: {error}"))?;
    match result {
        Ok(sync_result) => {
            let _ = app_handle.emit(BACKUP_STATUS_CHANGED_EVENT, sync_result.status.clone());
            Ok(sync_result)
        }
        Err(error) => {
            record_sync_error(&error);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn run_backup_sync(app_handle: tauri::AppHandle) -> Result<BackupSyncResult, String> {
    let sync_app_handle = app_handle.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || run_backup_sync_blocking(sync_app_handle))
            .await
            .map_err(|error| format!("启动备份同步失败: {error}"))?;
    match result {
        Ok(sync_result) => {
            let _ = app_handle.emit(BACKUP_STATUS_CHANGED_EVENT, sync_result.status.clone());
            Ok(sync_result)
        }
        Err(error) => {
            record_sync_error(&error);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn disconnect_github_backup(app_handle: tauri::AppHandle) -> Result<BackupStatus, String> {
    if let Ok(repo_path) = backup_repo_path() {
        if repo_path.join(".git").is_dir() {
            let _ = git(&repo_path, &["remote", "remove", "origin"], None);
        }
    }
    save_github_backup_settings(GithubBackupSettings::default())?;
    let status = status_from_settings(GithubBackupSettings::default());
    let _ = app_handle.emit(BACKUP_STATUS_CHANGED_EVENT, status.clone());
    Ok(status)
}

#[tauri::command]
pub fn set_backup_device_name(device_name: String) -> Result<BackupStatus, String> {
    let device_name = device_name.trim();
    if device_name.is_empty() || device_name.chars().count() > 80 {
        return Err("设备名称不能为空且不能超过 80 个字符".to_string());
    }
    let mut settings = load_github_backup_settings();
    settings.device_name = device_name.to_string();
    save_github_backup_settings(settings.clone())?;
    Ok(status_from_settings(settings))
}

#[tauri::command]
pub fn set_backup_auto_backup(
    app_handle: tauri::AppHandle,
    enabled: bool,
) -> Result<BackupStatus, String> {
    let mut settings = load_github_backup_settings();
    if enabled && !settings.enabled {
        return Err("请先启用 GitHub 备份".to_string());
    }
    settings.auto_backup = enabled;
    save_github_backup_settings(settings.clone())?;
    if enabled {
        crate::backup_scheduler::schedule_startup_sync();
    }
    let status = status_from_settings(settings);
    let _ = app_handle.emit(BACKUP_STATUS_CHANGED_EVENT, status.clone());
    Ok(status)
}

#[tauri::command]
pub fn list_backup_snapshots() -> Result<Vec<BackupSnapshotInfo>, String> {
    let repo_path = backup_repo_path()?;
    if !repo_path.join(".git").is_dir() {
        return Ok(Vec::new());
    }
    let output = git(
        &repo_path,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            "--format=%(refname:short)%09%(objectname)%09%(creatordate:iso-strict)%09%(contents:subject)",
            "refs/tags/skilldock/snapshot",
        ],
        None,
    )?;
    Ok(output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\t');
            Some(BackupSnapshotInfo {
                tag: parts.next()?.to_string(),
                commit: parts.next()?.to_string(),
                created_at: parts.next()?.to_string(),
                message: parts.next().unwrap_or_default().to_string(),
            })
        })
        .collect())
}

#[tauri::command]
pub fn list_backup_conflicts() -> Result<Vec<BackupConflict>, String> {
    crate::backup_merge::list_conflicts()
}

fn resolve_backup_conflict_blocking(
    app_handle: tauri::AppHandle,
    conflict_id: String,
    resolution: String,
) -> Result<BackupSyncResult, String> {
    let _guard = sync_lock()
        .lock()
        .map_err(|_| "备份同步锁不可用".to_string())?;
    BACKUP_SYNCING.store(true, Ordering::SeqCst);
    let result = (|| {
        let mut settings = load_github_backup_settings();
        if !settings.enabled {
            return Err("尚未启用 GitHub 备份".to_string());
        }
        let credential = github_credentials::load_credential()
            .ok_or_else(|| "GitHub 凭据不可用，请重新连接".to_string())?;
        let repo_path = backup_repo_path()?;
        let snapshot_tag = create_snapshot_tag(&repo_path, &settings.device_name)?;
        crate::backup_merge::resolve_conflict(&repo_path, &conflict_id, &resolution)?;
        let changed = commit_snapshot(&repo_path, &settings.device_name)?;
        let _ = apply_and_refresh_library(&app_handle, &repo_path, &[])?;
        push_branch_with_retry(&repo_path, &credential.token)?;
        let included_skills = apply_and_refresh_library(&app_handle, &repo_path, &[])?;
        push_snapshot_tags(&repo_path, &credential.token)?;
        settings.last_sync_at = Utc::now().to_rfc3339();
        settings.last_error.clear();
        save_github_backup_settings(settings.clone())?;
        Ok(BackupSyncResult {
            status: status_from_settings(settings),
            included_skills,
            excluded_skills: Vec::new(),
            changed,
            snapshot_tag,
        })
    })();
    BACKUP_SYNCING.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
pub async fn resolve_backup_conflict(
    app_handle: tauri::AppHandle,
    conflict_id: String,
    resolution: String,
) -> Result<BackupSyncResult, String> {
    let operation_app_handle = app_handle.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        resolve_backup_conflict_blocking(operation_app_handle, conflict_id, resolution)
    })
    .await
    .map_err(|error| format!("启动冲突解决失败: {error}"))?;
    match result {
        Ok(sync_result) => {
            let _ = app_handle.emit(BACKUP_STATUS_CHANGED_EVENT, sync_result.status.clone());
            Ok(sync_result)
        }
        Err(error) => {
            record_sync_error(&error);
            Err(error)
        }
    }
}

fn restore_backup_snapshot_blocking(
    app_handle: tauri::AppHandle,
    tag: String,
) -> Result<BackupSyncResult, String> {
    let _guard = sync_lock()
        .lock()
        .map_err(|_| "备份同步锁不可用".to_string())?;
    BACKUP_SYNCING.store(true, Ordering::SeqCst);
    let result = (|| {
        if !tag.starts_with("skilldock/snapshot/") {
            return Err("只能恢复 SkillDock 创建的历史快照".to_string());
        }
        let mut settings = load_github_backup_settings();
        if !settings.enabled {
            return Err("尚未启用 GitHub 备份".to_string());
        }
        let credential = github_credentials::load_credential()
            .ok_or_else(|| "GitHub 凭据不可用，请重新连接".to_string())?;
        let repo_path = backup_repo_path()?;
        let target_reference = format!("{tag}^{{commit}}");
        git(
            &repo_path,
            &["rev-parse", "--verify", &target_reference],
            None,
        )?;
        let safety_tag = create_snapshot_tag(&repo_path, &settings.device_name)?;
        let target = materialize_reference(&repo_path, &tag)?;
        replace_repository_snapshot(&target.path, &repo_path)?;
        git(&repo_path, &["add", "--all"], None)?;
        let message = format!("Restore SkillDock backup {tag}");
        git(
            &repo_path,
            &["commit", "--allow-empty", "-m", &message],
            None,
        )?;
        let _ = apply_and_refresh_library(&app_handle, &repo_path, &[])?;
        push_branch_with_retry(&repo_path, &credential.token)?;
        let included_skills = apply_and_refresh_library(&app_handle, &repo_path, &[])?;
        push_snapshot_tags(&repo_path, &credential.token)?;
        settings.last_sync_at = Utc::now().to_rfc3339();
        settings.last_error.clear();
        save_github_backup_settings(settings.clone())?;
        Ok(BackupSyncResult {
            status: status_from_settings(settings),
            included_skills,
            excluded_skills: Vec::new(),
            changed: true,
            snapshot_tag: safety_tag,
        })
    })();
    BACKUP_SYNCING.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
pub async fn restore_backup_snapshot(
    app_handle: tauri::AppHandle,
    tag: String,
) -> Result<BackupSyncResult, String> {
    let operation_app_handle = app_handle.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        restore_backup_snapshot_blocking(operation_app_handle, tag)
    })
    .await
    .map_err(|error| format!("启动历史恢复失败: {error}"))?;
    match result {
        Ok(sync_result) => {
            let _ = app_handle.emit(BACKUP_STATUS_CHANGED_EVENT, sync_result.status.clone());
            Ok(sync_result)
        }
        Err(error) => {
            record_sync_error(&error);
            Err(error)
        }
    }
}

fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "SkillDock device".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        commit_snapshot, ensure_local_repository, git, push_branch_with_retry, reconcile_remote,
        status_from_settings,
    };
    use crate::backup_snapshot::{BackupLibrary, BackupSkillMetadata};
    use crate::models::GithubBackupSettings;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn metadata(backup_id: &str, name: &str) -> BackupSkillMetadata {
        BackupSkillMetadata {
            schema_version: 1,
            backup_id: backup_id.to_string(),
            name: name.to_string(),
            directory_name: name.to_string(),
            source_type: "local".to_string(),
            source_url: String::new(),
            branch: String::new(),
            update_driver: "none".to_string(),
            description: String::new(),
            tools: BTreeMap::new(),
            content_hash: format!("hash-{backup_id}"),
        }
    }

    fn write_library(repository: &Path, skills: &[BackupSkillMetadata]) {
        let skills_path = repository.join("skills");
        let metadata_path = repository.join(".skilldock/skills");
        let _ = fs::remove_dir_all(&skills_path);
        let _ = fs::remove_dir_all(repository.join(".skilldock"));
        fs::create_dir_all(&skills_path).expect("create skills path");
        fs::create_dir_all(&metadata_path).expect("create metadata path");
        for skill in skills {
            let skill_path = skills_path.join(&skill.backup_id);
            fs::create_dir_all(&skill_path).expect("create skill path");
            fs::write(skill_path.join("SKILL.md"), format!("# {}", skill.name))
                .expect("write skill");
            fs::write(
                metadata_path.join(format!("{}.json", skill.backup_id)),
                serde_json::to_string_pretty(skill).expect("serialize metadata"),
            )
            .expect("write metadata");
        }
        let library = BackupLibrary {
            schema_version: 1,
            skills: skills.to_vec(),
        };
        fs::write(
            repository.join(".skilldock/library.json"),
            serde_json::to_string_pretty(&library).expect("serialize library"),
        )
        .expect("write library");
    }

    #[test]
    fn builds_disabled_status_from_default_settings() {
        let status = status_from_settings(GithubBackupSettings::default());
        assert!(!status.enabled);
        assert!(!status.syncing);
        assert_eq!(status.pending_conflicts, 0);
    }

    #[test]
    fn archives_local_history_when_remote_binding_changes() {
        let temp_root = std::env::temp_dir().join(format!(
            "skilldock-backup-binding-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let repository = temp_root.join("repo");
        fs::create_dir_all(&temp_root).expect("create test root");
        ensure_local_repository(&repository, "https://github.com/example/first.git")
            .expect("initialize first binding");
        fs::write(repository.join("local-history.txt"), "preserved").expect("write local history");

        let second_remote = "https://github.com/example/second.git";
        ensure_local_repository(&repository, second_remote).expect("initialize second binding");

        assert!(repository.join(".git").is_dir());
        assert!(!repository.join("local-history.txt").exists());
        assert_eq!(
            git(&repository, &["remote", "get-url", "origin"], None).expect("read second remote"),
            second_remote
        );
        let archive_root = temp_root.join("repository-archive");
        let archived_repository = fs::read_dir(&archive_root)
            .expect("read repository archive")
            .next()
            .expect("archived repository")
            .expect("read archived repository")
            .path();
        assert!(archived_repository.join(".git").is_dir());
        assert!(archived_repository.join("local-history.txt").is_file());
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn merges_independent_skills_from_two_devices() {
        let temp_root = std::env::temp_dir().join(format!(
            "skilldock-backup-devices-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let remote = temp_root.join("remote.git");
        let device_a = temp_root.join("device-a");
        let device_b = temp_root.join("device-b");
        fs::create_dir_all(&temp_root).expect("create test root");
        let init_status = Command::new("git")
            .args([
                "init",
                "--bare",
                "--initial-branch",
                "main",
                remote.to_string_lossy().as_ref(),
            ])
            .status()
            .expect("initialize bare repository");
        assert!(init_status.success());
        let remote_url = remote.to_string_lossy().to_string();

        ensure_local_repository(&device_a, &remote_url).expect("initialize device A");
        write_library(&device_a, &[]);
        commit_snapshot(&device_a, "device-a").expect("commit base snapshot");
        push_branch_with_retry(&device_a, "").expect("push base snapshot");

        let clone_status = Command::new("git")
            .args([
                "clone",
                "--branch",
                "main",
                remote_url.as_str(),
                device_b.to_string_lossy().as_ref(),
            ])
            .status()
            .expect("clone device B");
        assert!(clone_status.success());
        git(
            &device_b,
            &["config", "user.name", "SkillDock Backup"],
            None,
        )
        .expect("configure device B name");
        git(
            &device_b,
            &["config", "user.email", "backup@skilldock.local"],
            None,
        )
        .expect("configure device B email");

        write_library(&device_a, &[metadata("skill-a", "Skill A")]);
        commit_snapshot(&device_a, "device-a").expect("commit device A snapshot");
        push_branch_with_retry(&device_a, "").expect("push device A snapshot");

        write_library(&device_b, &[metadata("skill-b", "Skill B")]);
        commit_snapshot(&device_b, "device-b").expect("commit device B snapshot");
        reconcile_remote(&device_b, "").expect("merge device snapshots");
        push_branch_with_retry(&device_b, "").expect("push merged snapshot");

        let library =
            crate::backup_snapshot::read_library_snapshot(&device_b).expect("read merged library");
        let backup_ids = library
            .skills
            .iter()
            .map(|skill| skill.backup_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(backup_ids, vec!["skill-a", "skill-b"]);
        assert!(device_b.join("skills/skill-a/SKILL.md").is_file());
        assert!(device_b.join("skills/skill-b/SKILL.md").is_file());
        let _ = fs::remove_dir_all(temp_root);
    }
}
