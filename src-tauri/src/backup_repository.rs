use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::backup_merge::BackupConflict;
use crate::backup_snapshot::{
    apply_library_snapshot, apply_library_snapshot_preserving,
    apply_library_snapshot_replace_with_progress, apply_portable_workspace_snapshot,
    backup_repo_path, backup_root, current_workspace_has_backup_data, preview_workspace_restore,
    read_library_snapshot, write_current_library_snapshot,
    write_current_library_snapshot_with_progress, BackupSnapshotManifest, BackupSnapshotReport,
    WorkspaceRestorePreview,
};
use crate::github_api;
use crate::github_credentials;
use crate::models::{BackupPhase, BackupStatus, GithubBackupSettings};
use crate::state::{
    load_github_backup_settings, load_github_connection_metadata, save_github_backup_settings,
};

const DEFAULT_BACKUP_REPOSITORY_NAME: &str = "skilldock-backup";
const ASKPASS_USERNAME_ENV: &str = "SKILLDOCK_ASKPASS_USERNAME";
const ASKPASS_PASSWORD_ENV: &str = "SKILLDOCK_ASKPASS_PASSWORD";
const BACKUP_REMOTE_CONFIG_KEY: &str = "skilldock.remoteUrl";
const BACKUP_STATUS_CHANGED_EVENT: &str = "backup-status-changed";
const GIT_TRANSFER_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_PROGRESS_POLL_INTERVAL: Duration = Duration::from_millis(100);
const ASKPASS_SCRIPT: &str = "#!/bin/sh\ncase \"$1\" in\n  *[Uu]sername*) printf '%s\\n' \"${SKILLDOCK_ASKPASS_USERNAME}\" ;;\n  *) printf '%s\\n' \"${SKILLDOCK_ASKPASS_PASSWORD}\" ;;\nesac\n";

static BACKUP_SYNC_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static BACKUP_SYNCING: AtomicBool = AtomicBool::new(false);
static BACKUP_OPERATION_PHASE: OnceLock<Mutex<Option<BackupPhase>>> = OnceLock::new();
static BACKUP_OPERATION_PROGRESS: OnceLock<Mutex<BackupOperationProgress>> = OnceLock::new();

#[derive(Clone, Debug, Default)]
struct BackupOperationProgress {
    stage: String,
    percent: u8,
}

type OperationProgressCallback<'a> = dyn Fn(&str, u8) + 'a;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSyncResult {
    pub status: BackupStatus,
    pub included_skills: usize,
    pub included_mcp_servers: usize,
    pub included_plugins: usize,
    pub preferences_included: bool,
    pub excluded_skills: Vec<String>,
    pub warnings: Vec<String>,
    pub changed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBackupNode {
    pub commit_id: String,
    pub created_at: String,
    pub device_label: String,
    pub skill_count: usize,
    pub mcp_count: usize,
    pub plugin_count: usize,
}

#[derive(Default)]
struct BackupOperationReport {
    included_skills: usize,
    included_mcp_servers: usize,
    included_plugins: usize,
    preferences_included: bool,
    excluded_skills: Vec<String>,
    warnings: Vec<String>,
}

fn sync_lock() -> &'static Mutex<()> {
    BACKUP_SYNC_LOCK.get_or_init(|| Mutex::new(()))
}

fn operation_phase_lock() -> &'static Mutex<Option<BackupPhase>> {
    BACKUP_OPERATION_PHASE.get_or_init(|| Mutex::new(None))
}

fn operation_progress_lock() -> &'static Mutex<BackupOperationProgress> {
    BACKUP_OPERATION_PROGRESS.get_or_init(|| Mutex::new(BackupOperationProgress::default()))
}

fn current_operation_progress() -> BackupOperationProgress {
    operation_progress_lock()
        .lock()
        .map(|progress| progress.clone())
        .unwrap_or_default()
}

fn advance_operation_progress(
    progress: &mut BackupOperationProgress,
    stage: &str,
    percent: u8,
) -> bool {
    let next_percent = progress.percent.max(percent.min(100));
    if progress.stage == stage && progress.percent == next_percent {
        return false;
    }
    progress.stage = stage.to_string();
    progress.percent = next_percent;
    true
}

fn set_operation_progress(stage: &str, percent: u8) -> bool {
    if let Ok(mut progress) = operation_progress_lock().lock() {
        return advance_operation_progress(&mut progress, stage, percent);
    }
    false
}

fn clear_operation_progress() {
    if let Ok(mut progress) = operation_progress_lock().lock() {
        *progress = BackupOperationProgress::default();
    }
}

fn current_operation_phase() -> Option<BackupPhase> {
    operation_phase_lock().lock().ok().and_then(|phase| *phase)
}

fn begin_operation(phase: BackupPhase) -> Result<(), String> {
    let mut current = operation_phase_lock()
        .lock()
        .map_err(|_| "备份任务状态锁不可用".to_string())?;
    if current.is_some() {
        return Err("已有备份操作正在后台执行".to_string());
    }
    *current = Some(phase);
    BACKUP_SYNCING.store(true, Ordering::SeqCst);
    clear_operation_progress();
    if matches!(phase, BackupPhase::BackingUp | BackupPhase::Restoring) {
        let _ = set_operation_progress("preparing", 0);
    }
    Ok(())
}

fn finish_operation() {
    if let Ok(mut current) = operation_phase_lock().lock() {
        *current = None;
    }
    BACKUP_SYNCING.store(false, Ordering::SeqCst);
    clear_operation_progress();
}

fn status_from_settings(settings: GithubBackupSettings) -> BackupStatus {
    let phase = current_operation_phase().unwrap_or_else(|| {
        if !settings.last_error.trim().is_empty() {
            BackupPhase::Error
        } else if settings.enabled {
            BackupPhase::Enabled
        } else {
            BackupPhase::Disabled
        }
    });
    let progress = current_operation_progress();
    BackupStatus {
        enabled: settings.enabled,
        repository_owner: settings.repository_owner,
        repository_name: settings.repository_name,
        repository_url: settings.repository_url,
        last_sync_at: settings.last_sync_at,
        last_error: settings.last_error,
        phase,
        syncing: BACKUP_SYNCING.load(Ordering::SeqCst),
        pending_conflicts: pending_conflict_count(),
        progress_stage: progress.stage,
        progress_percent: progress.percent,
    }
}

fn reconcile_backup_settings_for_account(
    mut settings: GithubBackupSettings,
    user_id: u64,
    username: &str,
) -> GithubBackupSettings {
    if !settings.enabled || settings.account_user_id == Some(user_id) {
        return settings;
    }
    if settings.account_user_id.is_none()
        && settings
            .repository_owner
            .trim()
            .eq_ignore_ascii_case(username.trim())
    {
        settings.account_user_id = Some(user_id);
        return settings;
    }

    settings.enabled = false;
    settings.account_user_id = None;
    settings.repository_owner.clear();
    settings.repository_name.clear();
    settings.repository_url.clear();
    settings.last_sync_at.clear();
    settings.last_error.clear();
    settings
}

pub fn reconcile_backup_preference_after_login(user_id: u64, username: &str) -> Result<(), String> {
    let settings = load_github_backup_settings();
    let reconciled = reconcile_backup_settings_for_account(settings, user_id, username);
    save_github_backup_settings(reconciled)
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

fn git_command(repo_path: &Path, args: &[&str], token: Option<&str>) -> Result<Command, String> {
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
    Ok(command)
}

fn git_output(repo_path: &Path, args: &[&str], token: Option<&str>) -> Result<Output, String> {
    git_command(repo_path, args, token)?
        .output()
        .map_err(|error| format!("执行 Git 备份命令失败: {error}"))
}

fn parse_git_progress_percent(line: &str) -> Option<u8> {
    let percent_marker = line.find('%')?;
    line[..percent_marker]
        .split_whitespace()
        .last()?
        .parse::<u8>()
        .ok()
        .filter(|percent| *percent <= 100)
}

fn map_progress_percent(percent: u8, start: u8, end: u8) -> u8 {
    let range = u16::from(end.saturating_sub(start));
    let offset = u16::from(percent.min(100)) * range / 100;
    start.saturating_add(offset as u8)
}

fn map_item_progress(completed: usize, total: usize, start: u8, end: u8) -> u8 {
    if total == 0 {
        return end;
    }
    let percent = completed.saturating_mul(100) / total;
    map_progress_percent(percent.min(100) as u8, start, end)
}

fn git_with_progress(
    repo_path: &Path,
    args: &[&str],
    token: Option<&str>,
    on_progress: &dyn Fn(&str),
) -> Result<String, String> {
    let mut command = git_command(repo_path, args, token)?;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("执行 Git 备份命令失败: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "读取 Git 标准输出失败".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "读取 Git 进度输出失败".to_string())?;

    let stdout_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stdout).read_to_end(&mut bytes);
        bytes
    });
    let (progress_sender, progress_receiver) = mpsc::channel::<String>();
    let stderr_thread = thread::spawn(move || {
        let mut collected = String::new();
        for chunk in BufReader::new(stderr).split(b'\r').filter_map(Result::ok) {
            let text = String::from_utf8_lossy(&chunk);
            for line in text.lines().filter(|line| !line.trim().is_empty()) {
                collected.push_str(line);
                collected.push('\n');
                let _ = progress_sender.send(line.to_string());
            }
        }
        collected
    });

    let mut last_activity = Instant::now();
    let status = loop {
        while let Ok(line) = progress_receiver.try_recv() {
            last_activity = Instant::now();
            on_progress(&line);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if last_activity.elapsed() >= GIT_TRANSFER_IDLE_TIMEOUT => {
                terminate_git_process_tree(&mut child);
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err("GitHub 传输长时间没有进度，请检查网络后重试".to_string());
            }
            Ok(None) => thread::sleep(GIT_PROGRESS_POLL_INTERVAL),
            Err(error) => {
                terminate_git_process_tree(&mut child);
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(format!("等待 Git 备份命令失败: {error}"));
            }
        }
    };
    while let Ok(line) = progress_receiver.try_recv() {
        on_progress(&line);
    }
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    if status.success() {
        return Ok(String::from_utf8_lossy(&stdout).trim().to_string());
    }
    let message = stderr.trim();
    Err(if message.is_empty() {
        format!("Git 备份命令失败: {}", args.join(" "))
    } else {
        message.to_string()
    })
}

fn terminate_git_process_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        let process_group = format!("-{}", child.id());
        let status = Command::new("kill")
            .args(["-TERM", process_group.as_str()])
            .status();
        if !status.is_ok_and(|status| status.success()) {
            let _ = child.kill();
        }
    }
    #[cfg(windows)]
    {
        let process_id = child.id().to_string();
        let mut command = Command::new("taskkill");
        command.args(["/PID", process_id.as_str(), "/T", "/F"]);
        crate::library::configure_hidden_subprocess(&mut command);
        if !command.status().is_ok_and(|status| status.success()) {
            let _ = child.kill();
        }
    }
    let _ = child.wait();
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

fn commit_snapshot(repo_path: &Path) -> Result<bool, String> {
    commit_snapshot_with_message(repo_path, "SkillDock backup", false)
}

fn commit_snapshot_with_message(
    repo_path: &Path,
    message: &str,
    allow_empty: bool,
) -> Result<bool, String> {
    git(repo_path, &["add", "--all"], None)?;
    if !allow_empty && git_success(repo_path, &["diff", "--cached", "--quiet"]) {
        return Ok(false);
    }
    let mut arguments = vec!["commit"];
    if allow_empty {
        arguments.push("--allow-empty");
    }
    arguments.extend(["-m", message]);
    git(repo_path, &arguments, None)?;
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
    reconcile_remote_with_progress(repo_path, token, None, "", 0, 0)
}

fn reconcile_remote_with_progress(
    repo_path: &Path,
    token: &str,
    progress: Option<&OperationProgressCallback<'_>>,
    stage: &str,
    start: u8,
    end: u8,
) -> Result<(), String> {
    let fetch_args = ["fetch", "--progress", "--prune", "--tags", "origin", "main"];
    let fetch_result = if let Some(report) = progress {
        git_with_progress(repo_path, &fetch_args, Some(token), &|line| {
            if line.contains("Receiving objects") {
                if let Some(percent) = parse_git_progress_percent(line) {
                    report(stage, map_progress_percent(percent, start, end));
                }
            }
        })
    } else {
        git(repo_path, &fetch_args, Some(token))
    };
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
    if !git_success(repo_path, &["rev-parse", "--verify", "HEAD"]) {
        git(repo_path, &["checkout", "-B", "main", "origin/main"], None)?;
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

fn retryable_push_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("non-fast-forward")
        || normalized.contains("fetch first")
        || normalized.contains("rejected")
}

fn push_branch_with_retry(repo_path: &Path, token: &str) -> Result<(), String> {
    push_branch_with_retry_progress(repo_path, token, None, "", 0, 0)
}

fn push_branch_with_retry_progress(
    repo_path: &Path,
    token: &str,
    progress: Option<&OperationProgressCallback<'_>>,
    stage: &str,
    start: u8,
    end: u8,
) -> Result<(), String> {
    let mut last_error = String::new();
    for attempt in 0..3 {
        let push_args = ["push", "--progress", "origin", "HEAD:main"];
        let push_result = if let Some(report) = progress {
            git_with_progress(repo_path, &push_args, Some(token), &|line| {
                if line.contains("Writing objects") {
                    if let Some(percent) = parse_git_progress_percent(line) {
                        report(stage, map_progress_percent(percent, start, end));
                    }
                }
            })
        } else {
            git(repo_path, &push_args, Some(token))
        };
        match push_result {
            Ok(_) => return Ok(()),
            Err(error) if attempt < 2 && retryable_push_error(&error) => {
                last_error = error;
                reconcile_remote_with_progress(repo_path, token, progress, stage, start, end)?;
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error)
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

#[cfg(test)]
fn upload_current_snapshot(repo_path: &Path, token: &str) -> Result<BackupOperationReport, String> {
    upload_current_snapshot_with_progress(repo_path, token, None)
}

fn upload_current_snapshot_with_progress(
    repo_path: &Path,
    token: &str,
    progress: Option<&OperationProgressCallback<'_>>,
) -> Result<BackupOperationReport, String> {
    if let Some(report) = progress {
        report("preparing", 3);
    }
    reconcile_remote_with_progress(repo_path, token, progress, "preparing", 3, 10)?;
    if !current_workspace_has_backup_data()? && remote_snapshot_has_data(repo_path)? {
        return Err("本机暂无可备份数据，未覆盖云端备份".to_string());
    }
    if let Some(report) = progress {
        report("collecting", 12);
    }
    let snapshot_progress = |completed: usize, total: usize| {
        if let Some(progress) = progress {
            progress("collecting", map_item_progress(completed, total, 12, 58));
        }
    };
    let report = write_current_library_snapshot_with_progress(repo_path, Some(&snapshot_progress))?;
    if let Some(progress) = progress {
        progress("committing", 60);
    }
    let _ = commit_snapshot(repo_path)?;
    if let Some(progress) = progress {
        progress("uploading", 70);
    }
    push_branch_with_retry_progress(repo_path, token, progress, "uploading", 70, 99)?;
    Ok(operation_report_from_snapshot(report))
}

fn parse_cloud_node(
    repo_path: &Path,
    commit_id: &str,
    commit_created_at: &str,
) -> Result<CloudBackupNode, String> {
    let manifest = git(
        repo_path,
        &["show", &format!("{commit_id}:.skilldock/snapshot.json")],
        None,
    )
    .ok()
    .and_then(|payload| serde_json::from_str::<BackupSnapshotManifest>(&payload).ok());
    if let Some(manifest) = manifest {
        return Ok(CloudBackupNode {
            commit_id: commit_id.to_string(),
            created_at: manifest.created_at,
            device_label: manifest.device_label,
            skill_count: manifest.skill_count,
            mcp_count: manifest.mcp_count,
            plugin_count: manifest.plugin_count,
        });
    }
    let library = git(
        repo_path,
        &["show", &format!("{commit_id}:.skilldock/library.json")],
        None,
    )
    .ok()
    .and_then(|payload| {
        serde_json::from_str::<crate::backup_snapshot::BackupLibrary>(&payload).ok()
    })
    .unwrap_or_default();
    Ok(CloudBackupNode {
        commit_id: commit_id.to_string(),
        created_at: commit_created_at.to_string(),
        device_label: "未知设备".to_string(),
        skill_count: library.skills.len(),
        mcp_count: 0,
        plugin_count: 0,
    })
}

fn cloud_node_has_data(node: &CloudBackupNode) -> bool {
    node.skill_count > 0 || node.mcp_count > 0 || node.plugin_count > 0
}

fn remote_snapshot_has_data(repo_path: &Path) -> Result<bool, String> {
    latest_nonempty_cloud_commit(repo_path).map(|commit| commit.is_some())
}

fn latest_nonempty_cloud_commit(repo_path: &Path) -> Result<Option<String>, String> {
    if !remote_branch_exists(repo_path) {
        return Ok(None);
    }
    let history = git(repo_path, &["log", "--format=%H", "origin/main"], None)?;
    for commit_id in history.lines() {
        if cloud_node_has_data(&parse_cloud_node(repo_path, commit_id, "")?) {
            return Ok(Some(commit_id.to_string()));
        }
    }
    Ok(None)
}

fn latest_restore_commit(repo_path: &Path) -> Result<String, String> {
    latest_nonempty_cloud_commit(repo_path)?.ok_or_else(|| "还没有可用的云端备份节点".to_string())
}

fn list_cloud_backup_nodes_blocking() -> Result<Vec<CloudBackupNode>, String> {
    let _guard = sync_lock()
        .lock()
        .map_err(|_| "备份同步锁不可用".to_string())?;
    let settings = load_github_backup_settings();
    if !settings.enabled {
        return Err("尚未启用 GitHub 备份".to_string());
    }
    let credential = github_credentials::load_active_credential()
        .ok_or_else(|| "GitHub 凭据不可用，请重新连接".to_string())?;
    let repo_path = backup_repo_path()?;
    ensure_local_repository(&repo_path, &settings.repository_url)?;
    reconcile_remote(&repo_path, &credential.token)?;
    if !remote_branch_exists(&repo_path) {
        return Ok(Vec::new());
    }
    let history = git(
        &repo_path,
        &["log", "--max-count=5", "--format=%H%x09%cI", "origin/main"],
        None,
    )?;
    history
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(commit_id, created_at)| parse_cloud_node(&repo_path, commit_id, created_at))
        .collect()
}

fn validate_cloud_commit(repo_path: &Path, commit_id: &str) -> Result<(), String> {
    if commit_id.len() != 40
        || !commit_id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("备份节点标识无效".to_string());
    }
    if !git_success(
        repo_path,
        &["merge-base", "--is-ancestor", commit_id, "origin/main"],
    ) {
        return Err("备份节点不属于当前云端备份历史".to_string());
    }
    Ok(())
}

fn preview_cloud_backup_node_blocking(
    commit_id: String,
) -> Result<WorkspaceRestorePreview, String> {
    let _guard = sync_lock()
        .lock()
        .map_err(|_| "备份同步锁不可用".to_string())?;
    let settings = load_github_backup_settings();
    if !settings.enabled {
        return Err("尚未启用 GitHub 备份".to_string());
    }
    let credential = github_credentials::load_active_credential()
        .ok_or_else(|| "GitHub 凭据不可用，请重新连接".to_string())?;
    let repo_path = backup_repo_path()?;
    ensure_local_repository(&repo_path, &settings.repository_url)?;
    reconcile_remote(&repo_path, &credential.token)?;
    validate_cloud_commit(&repo_path, &commit_id)?;
    crate::backup_merge::with_materialized_commit(
        &repo_path,
        &commit_id,
        "preview",
        preview_workspace_restore,
    )
}

fn create_before_restore_node(repo_path: &Path, token: &str) -> Result<(), String> {
    reconcile_remote(repo_path, token)?;
    write_current_library_snapshot(repo_path)?;
    commit_snapshot_with_message(repo_path, "SkillDock before restore", true)?;
    push_branch_with_retry(repo_path, token)
}

fn restore_cloud_node_blocking(
    app_handle: tauri::AppHandle,
    commit_id: Option<String>,
    backup_current: bool,
) -> Result<(), String> {
    let _guard = sync_lock()
        .lock()
        .map_err(|_| "备份同步锁不可用".to_string())?;
    let mut settings = load_github_backup_settings();
    if !settings.enabled {
        return Err("尚未启用 GitHub 备份".to_string());
    }
    let credential = github_credentials::load_active_credential()
        .ok_or_else(|| "GitHub 凭据不可用，请重新连接".to_string())?;
    let progress = |stage: &str, percent: u8| {
        update_operation_progress(&app_handle, stage, percent);
    };
    progress("preparing", 3);
    let repo_path = backup_repo_path()?;
    ensure_local_repository(&repo_path, &settings.repository_url)?;
    if backup_current {
        progress("preserving", 10);
        create_before_restore_node(&repo_path, &credential.token)?;
    }
    progress("downloading", 12);
    reconcile_remote_with_progress(
        &repo_path,
        &credential.token,
        Some(&progress),
        "downloading",
        12,
        35,
    )?;
    let effective_commit_id = match commit_id {
        Some(commit_id) => commit_id,
        None => latest_restore_commit(&repo_path)?,
    };
    validate_cloud_commit(&repo_path, &effective_commit_id)?;

    progress("restoring", 50);
    crate::backup_merge::with_materialized_commit(
        &repo_path,
        &effective_commit_id,
        "restore",
        |snapshot_path| {
            let restore_progress = |completed: usize, total: usize| {
                progress("restoring", map_item_progress(completed, total, 50, 84));
            };
            let installed_skills = apply_library_snapshot_replace_with_progress(
                snapshot_path,
                Some(&restore_progress),
            )?;
            progress("refreshing", 86);
            crate::commands::refresh_backup_library(&app_handle, &installed_skills)?;
            progress("restoring", 92);
            apply_portable_workspace_snapshot(snapshot_path)?;
            Ok(())
        },
    )?;

    progress("finalizing", 94);
    write_current_library_snapshot(&repo_path)?;
    let message = format!("SkillDock restore {}", &effective_commit_id[..8]);
    commit_snapshot_with_message(&repo_path, &message, true)?;
    push_branch_with_retry_progress(
        &repo_path,
        &credential.token,
        Some(&progress),
        "finalizing",
        95,
        99,
    )?;
    settings.last_sync_at = Utc::now().to_rfc3339();
    settings.last_error.clear();
    save_github_backup_settings(settings)?;
    progress("completed", 100);
    Ok(())
}

fn operation_report_from_snapshot(report: BackupSnapshotReport) -> BackupOperationReport {
    BackupOperationReport {
        included_skills: report.included_skills,
        included_mcp_servers: report.included_mcp_servers,
        included_plugins: report.included_plugins,
        preferences_included: report.preferences_included,
        excluded_skills: report.excluded_skills,
        warnings: report.warnings,
    }
}

fn run_backup_operation_blocking(app_handle: tauri::AppHandle) -> Result<BackupSyncResult, String> {
    let _guard = sync_lock()
        .lock()
        .map_err(|_| "备份同步锁不可用".to_string())?;
    run_backup_operation_locked(&app_handle)
}

fn run_backup_operation_locked(app_handle: &tauri::AppHandle) -> Result<BackupSyncResult, String> {
    let mut settings = load_github_backup_settings();
    if !settings.enabled {
        return Err("尚未启用 GitHub 备份".to_string());
    }
    let credential = github_credentials::load_active_credential()
        .ok_or_else(|| "GitHub 凭据不可用，请重新连接".to_string())?;
    let repo_path = backup_repo_path()?;
    update_operation_progress(app_handle, "preparing", 1);
    ensure_local_repository(&repo_path, &settings.repository_url)?;
    let starting_commit = git(&repo_path, &["rev-parse", "HEAD"], None).ok();
    let progress = |stage: &str, percent: u8| {
        update_operation_progress(app_handle, stage, percent);
    };
    let report =
        upload_current_snapshot_with_progress(&repo_path, &credential.token, Some(&progress))?;
    let ending_commit = git(&repo_path, &["rev-parse", "HEAD"], None)?;
    let changed = starting_commit.as_deref() != Some(ending_commit.as_str());
    settings.last_sync_at = Utc::now().to_rfc3339();
    settings.last_error.clear();
    save_github_backup_settings(settings.clone())?;
    update_operation_progress(app_handle, "completed", 100);
    Ok(BackupSyncResult {
        status: status_from_settings(settings),
        included_skills: report.included_skills,
        included_mcp_servers: report.included_mcp_servers,
        included_plugins: report.included_plugins,
        preferences_included: report.preferences_included,
        excluded_skills: report.excluded_skills,
        warnings: report.warnings,
        changed,
    })
}

fn record_sync_error(error: &str) {
    let mut settings = load_github_backup_settings();
    settings.last_error = error.to_string();
    let _ = save_github_backup_settings(settings);
}

fn emit_backup_status(app_handle: &tauri::AppHandle) -> BackupStatus {
    let status = status_from_settings(load_github_backup_settings());
    let _ = app_handle.emit(BACKUP_STATUS_CHANGED_EVENT, status.clone());
    status
}

fn update_operation_progress(app_handle: &tauri::AppHandle, stage: &str, percent: u8) {
    if set_operation_progress(stage, percent) {
        emit_backup_status(app_handle);
    }
}

#[tauri::command]
pub fn get_backup_status() -> BackupStatus {
    status_from_settings(load_github_backup_settings())
}

#[tauri::command]
pub async fn list_cloud_backup_nodes() -> Result<Vec<CloudBackupNode>, String> {
    tauri::async_runtime::spawn_blocking(list_cloud_backup_nodes_blocking)
        .await
        .map_err(|error| format!("读取云端备份节点失败: {error}"))?
}

#[tauri::command]
pub async fn preview_cloud_backup_node(
    commit_id: String,
) -> Result<WorkspaceRestorePreview, String> {
    tauri::async_runtime::spawn_blocking(move || preview_cloud_backup_node_blocking(commit_id))
        .await
        .map_err(|error| format!("预览云端备份节点失败: {error}"))?
}

#[tauri::command]
pub fn restore_cloud_backup_node(
    app_handle: tauri::AppHandle,
    commit_id: String,
) -> Result<BackupStatus, String> {
    start_cloud_restore(app_handle, Some(commit_id), true)
}

fn start_cloud_restore(
    app_handle: tauri::AppHandle,
    commit_id: Option<String>,
    backup_current: bool,
) -> Result<BackupStatus, String> {
    if !load_github_backup_settings().enabled {
        return Err("尚未启用 GitHub 备份".to_string());
    }
    github_credentials::load_active_credential()
        .ok_or_else(|| "GitHub 凭据不可用，请重新连接".to_string())?;
    begin_operation(BackupPhase::Restoring)?;
    let mut settings = load_github_backup_settings();
    settings.last_error.clear();
    if let Err(error) = save_github_backup_settings(settings) {
        finish_operation();
        return Err(error);
    }
    let initial_status = emit_backup_status(&app_handle);
    let restore_app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            restore_cloud_node_blocking(restore_app_handle, commit_id, backup_current)
        })
        .await
        .map_err(|error| format!("启动云端恢复失败: {error}"))
        .and_then(|result| result);
        if let Err(error) = result {
            record_sync_error(&error);
        }
        finish_operation();
        emit_backup_status(&app_handle);
    });
    Ok(initial_status)
}

#[tauri::command]
pub async fn enable_github_backup(app_handle: tauri::AppHandle) -> Result<BackupStatus, String> {
    let credential = github_credentials::load_active_credential()
        .ok_or_else(|| "请先连接 GitHub".to_string())?;
    let connection = load_github_connection_metadata();
    let account_user_id = connection
        .user_id
        .ok_or_else(|| "GitHub 账号信息不完整，请重新连接".to_string())?;
    begin_operation(BackupPhase::Enabling)?;
    let mut initial_settings = load_github_backup_settings();
    initial_settings.last_error.clear();
    if let Err(error) = save_github_backup_settings(initial_settings) {
        finish_operation();
        return Err(error);
    }
    let initial_status = emit_backup_status(&app_handle);

    tauri::async_runtime::spawn(async move {
        let result = async {
            let client = github_api::http_client()?;
            let repository = github_api::ensure_private_backup_repository(
                &client,
                &credential.token,
                DEFAULT_BACKUP_REPOSITORY_NAME,
            )
            .await?;
            let repository_owner = repository.owner;
            let repository_name = repository.name;
            let repository_url = repository.clone_url;
            Ok::<_, String>((repository_owner, repository_name, repository_url))
        }
        .await;

        let mut settings = load_github_backup_settings();
        match result {
            Ok((owner, name, url)) => {
                settings.enabled = true;
                settings.account_user_id = Some(account_user_id);
                settings.repository_owner = owner;
                settings.repository_name = name;
                settings.repository_url = url;
                settings.last_error.clear();
            }
            Err(error) => {
                settings.enabled = false;
                settings.last_error = error;
            }
        }
        let _ = save_github_backup_settings(settings);
        finish_operation();
        emit_backup_status(&app_handle);
    });
    Ok(initial_status)
}

#[tauri::command]
pub fn run_backup_sync(app_handle: tauri::AppHandle) -> Result<BackupStatus, String> {
    run_backup_command(app_handle)
}

#[tauri::command]
pub fn sync_backup_to_local(app_handle: tauri::AppHandle) -> Result<BackupStatus, String> {
    start_cloud_restore(app_handle, None, false)
}

fn run_backup_command(app_handle: tauri::AppHandle) -> Result<BackupStatus, String> {
    if !load_github_backup_settings().enabled {
        return Err("尚未启用 GitHub 备份".to_string());
    }
    github_credentials::load_active_credential()
        .ok_or_else(|| "GitHub 凭据不可用，请重新连接".to_string())?;
    begin_operation(BackupPhase::BackingUp)?;
    let mut settings = load_github_backup_settings();
    settings.last_error.clear();
    if let Err(error) = save_github_backup_settings(settings) {
        finish_operation();
        return Err(error);
    }
    let initial_status = emit_backup_status(&app_handle);
    tauri::async_runtime::spawn(async move {
        let backup_app_handle = app_handle.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            run_backup_operation_blocking(backup_app_handle)
        })
        .await
        .map_err(|error| format!("启动备份操作失败: {error}"))
        .and_then(|result| result);
        if let Err(error) = result {
            record_sync_error(&error);
        }
        finish_operation();
        emit_backup_status(&app_handle);
    });
    Ok(initial_status)
}

#[tauri::command]
pub fn disconnect_github_backup(_app_handle: tauri::AppHandle) -> Result<BackupStatus, String> {
    if current_operation_phase().is_some() {
        return Err("备份操作正在后台执行，暂时不能关闭".to_string());
    }
    let mut settings = load_github_backup_settings();
    settings.enabled = false;
    settings.last_error.clear();
    save_github_backup_settings(settings.clone())?;
    Ok(status_from_settings(settings))
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
        let credential = github_credentials::load_active_credential()
            .ok_or_else(|| "GitHub 凭据不可用，请重新连接".to_string())?;
        let repo_path = backup_repo_path()?;
        crate::backup_merge::resolve_conflict(&repo_path, &conflict_id, &resolution)?;
        let changed = commit_snapshot(&repo_path)?;
        let _ = apply_and_refresh_library(&app_handle, &repo_path, &[])?;
        push_branch_with_retry(&repo_path, &credential.token)?;
        let included_skills = apply_and_refresh_library(&app_handle, &repo_path, &[])?;
        settings.last_sync_at = Utc::now().to_rfc3339();
        settings.last_error.clear();
        save_github_backup_settings(settings.clone())?;
        Ok(BackupSyncResult {
            status: status_from_settings(settings),
            included_skills,
            included_mcp_servers: 0,
            included_plugins: 0,
            preferences_included: false,
            excluded_skills: Vec::new(),
            warnings: Vec::new(),
            changed,
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
        Ok(sync_result) => Ok(sync_result),
        Err(error) => {
            record_sync_error(&error);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        advance_operation_progress, cloud_node_has_data, commit_snapshot, ensure_local_repository,
        git, latest_nonempty_cloud_commit, latest_restore_commit, map_item_progress,
        map_progress_percent, parse_cloud_node, parse_git_progress_percent, push_branch_with_retry,
        reconcile_backup_settings_for_account, reconcile_remote, remote_snapshot_has_data,
        status_from_settings, upload_current_snapshot, BackupOperationProgress,
    };
    use crate::backup_snapshot::{BackupLibrary, BackupSkillMetadata};
    use crate::models::GithubBackupSettings;
    use crate::workspace::with_test_home;
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
            ..Default::default()
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

    fn write_snapshot_manifest(
        repository: &Path,
        skill_count: usize,
        mcp_count: usize,
        plugin_count: usize,
    ) {
        fs::create_dir_all(repository.join(".skilldock")).expect("create snapshot metadata");
        fs::write(
            repository.join(".skilldock/snapshot.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "createdAt": "2026-07-31T00:00:00Z",
                "deviceLabel": "Test Mac",
                "skillCount": skill_count,
                "mcpCount": mcp_count,
                "pluginCount": plugin_count
            }))
            .expect("serialize snapshot manifest"),
        )
        .expect("write snapshot manifest");
    }

    fn initialize_bare_repository(path: &Path) {
        let status = Command::new("git")
            .args([
                "init",
                "--bare",
                "--initial-branch",
                "main",
                path.to_string_lossy().as_ref(),
            ])
            .status()
            .expect("initialize bare repository");
        assert!(status.success());
    }

    #[test]
    fn builds_disabled_status_from_default_settings() {
        let status = status_from_settings(GithubBackupSettings::default());
        assert!(!status.enabled);
        assert!(!status.syncing);
        assert_eq!(status.pending_conflicts, 0);
    }

    #[test]
    fn advances_operation_progress_without_regressing_percent() {
        let mut progress = BackupOperationProgress::default();

        assert!(advance_operation_progress(&mut progress, "uploading", 68));
        assert!(!advance_operation_progress(&mut progress, "uploading", 42));

        assert_eq!(progress.stage, "uploading");
        assert_eq!(progress.percent, 68);
    }

    #[test]
    fn parses_and_maps_git_transfer_progress() {
        assert_eq!(
            parse_git_progress_percent("Writing objects:  68% (34/50)"),
            Some(68)
        );
        assert_eq!(
            parse_git_progress_percent("remote: Resolving deltas: 100%"),
            Some(100)
        );
        assert_eq!(
            parse_git_progress_percent("To https://github.com/example/repo.git"),
            None
        );
        assert_eq!(map_progress_percent(50, 70, 99), 84);
        assert_eq!(map_progress_percent(100, 10, 35), 35);
        assert_eq!(map_item_progress(2, 4, 12, 58), 35);
        assert_eq!(map_item_progress(0, 0, 12, 58), 58);
    }

    #[test]
    fn preserves_enabled_backup_for_the_same_github_account() {
        let settings = GithubBackupSettings {
            enabled: true,
            account_user_id: Some(42),
            repository_owner: "octocat".into(),
            repository_name: "skilldock-backup".into(),
            repository_url: "https://github.com/octocat/skilldock-backup.git".into(),
            last_sync_at: "2026-07-31T00:00:00Z".into(),
            last_error: String::new(),
        };

        let reconciled = reconcile_backup_settings_for_account(settings, 42, "octocat");

        assert!(reconciled.enabled);
        assert_eq!(reconciled.account_user_id, Some(42));
        assert_eq!(reconciled.repository_owner, "octocat");
        assert_eq!(reconciled.repository_name, "skilldock-backup");
    }

    #[test]
    fn disables_old_backup_binding_for_a_different_github_account() {
        let settings = GithubBackupSettings {
            enabled: true,
            account_user_id: Some(42),
            repository_owner: "octocat".into(),
            repository_name: "skilldock-backup".into(),
            repository_url: "https://github.com/octocat/skilldock-backup.git".into(),
            last_sync_at: "2026-07-31T00:00:00Z".into(),
            last_error: "old error".into(),
        };

        let reconciled = reconcile_backup_settings_for_account(settings, 84, "hubot");

        assert!(!reconciled.enabled);
        assert_eq!(reconciled.account_user_id, None);
        assert!(reconciled.repository_owner.is_empty());
        assert!(reconciled.repository_name.is_empty());
        assert!(reconciled.repository_url.is_empty());
        assert!(reconciled.last_sync_at.is_empty());
        assert!(reconciled.last_error.is_empty());
    }

    #[test]
    fn adopts_a_legacy_backup_binding_when_the_owner_matches() {
        let settings = GithubBackupSettings {
            enabled: true,
            account_user_id: None,
            repository_owner: "OctoCat".into(),
            repository_name: "skilldock-backup".into(),
            repository_url: "https://github.com/OctoCat/skilldock-backup.git".into(),
            last_sync_at: String::new(),
            last_error: String::new(),
        };

        let reconciled = reconcile_backup_settings_for_account(settings, 42, "octocat");

        assert!(reconciled.enabled);
        assert_eq!(reconciled.account_user_id, Some(42));
        assert_eq!(reconciled.repository_owner, "OctoCat");
    }

    #[test]
    fn rejects_a_legacy_backup_binding_when_the_owner_differs() {
        let settings = GithubBackupSettings {
            enabled: true,
            account_user_id: None,
            repository_owner: "octocat".into(),
            repository_name: "skilldock-backup".into(),
            repository_url: "https://github.com/octocat/skilldock-backup.git".into(),
            last_sync_at: String::new(),
            last_error: String::new(),
        };

        let reconciled = reconcile_backup_settings_for_account(settings, 84, "hubot");

        assert!(!reconciled.enabled);
        assert_eq!(reconciled.account_user_id, None);
        assert!(reconciled.repository_owner.is_empty());
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
        commit_snapshot(&device_a).expect("commit base snapshot");
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
        commit_snapshot(&device_a).expect("commit device A snapshot");
        push_branch_with_retry(&device_a, "").expect("push device A snapshot");

        write_library(&device_b, &[metadata("skill-b", "Skill B")]);
        commit_snapshot(&device_b).expect("commit device B snapshot");
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

    #[test]
    fn selects_latest_nonempty_node_behind_accidental_empty_node() {
        let temp_root = std::env::temp_dir().join(format!(
            "skilldock-backup-node-selection-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let remote = temp_root.join("remote.git");
        let device = temp_root.join("device");
        fs::create_dir_all(&temp_root).expect("create test root");
        initialize_bare_repository(&remote);
        let remote_url = remote.to_string_lossy().to_string();
        ensure_local_repository(&device, &remote_url).expect("initialize device");

        write_library(&device, &[metadata("skill-a", "Skill A")]);
        write_snapshot_manifest(&device, 1, 0, 0);
        commit_snapshot(&device).expect("commit nonempty node");
        let nonempty_commit = git(&device, &["rev-parse", "HEAD"], None).expect("read commit");
        push_branch_with_retry(&device, "").expect("push nonempty node");

        write_library(&device, &[]);
        write_snapshot_manifest(&device, 0, 0, 0);
        commit_snapshot(&device).expect("commit empty node");
        let empty_commit = git(&device, &["rev-parse", "HEAD"], None).expect("read empty commit");
        push_branch_with_retry(&device, "").expect("push empty node");
        reconcile_remote(&device, "").expect("refresh remote branch");

        assert!(!cloud_node_has_data(
            &parse_cloud_node(&device, &empty_commit, "").expect("parse empty node")
        ));
        assert_eq!(
            latest_nonempty_cloud_commit(&device).expect("select nonempty node"),
            Some(nonempty_commit.clone())
        );
        assert_eq!(
            latest_restore_commit(&device).expect("select restore node"),
            nonempty_commit
        );
        assert!(remote_snapshot_has_data(&device).expect("inspect cloud history"));
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn empty_local_workspace_cannot_overwrite_nonempty_cloud_history() {
        let temp_home = std::env::temp_dir().join(format!(
            "skilldock-empty-upload-home-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&temp_home).expect("create temp home");
        with_test_home(&temp_home, || {
            let remote = temp_home.join("remote.git");
            let seed = temp_home.join("seed");
            let local = temp_home.join(".skilldock/backup/repo");
            initialize_bare_repository(&remote);
            let remote_url = remote.to_string_lossy().to_string();
            ensure_local_repository(&seed, &remote_url).expect("initialize seed");
            write_library(&seed, &[metadata("skill-a", "Skill A")]);
            write_snapshot_manifest(&seed, 1, 0, 0);
            commit_snapshot(&seed).expect("commit seed");
            push_branch_with_retry(&seed, "").expect("push seed");

            ensure_local_repository(&local, &remote_url).expect("initialize local backup");
            reconcile_remote(&local, "").expect("fetch cloud history");

            let error = match upload_current_snapshot(&local, "") {
                Ok(_) => panic!("empty upload should be rejected"),
                Err(error) => error,
            };
            assert_eq!(error, "本机暂无可备份数据，未覆盖云端备份");
        });
        let _ = fs::remove_dir_all(temp_home);
    }
}
