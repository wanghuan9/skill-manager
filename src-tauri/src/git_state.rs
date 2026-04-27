use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::models::SkillSummary;

const STATUS_CLEAN: &str = "clean";
const STATUS_UPDATE_AVAILABLE: &str = "update-available";
const STATUS_PENDING_PUSH: &str = "pending-push";
const GIT_BINARY: &str = "git";
const ORIGIN_REMOTE: &str = "origin";
const REMOTE_BRANCH_PREFIX: &str = "origin/";

pub fn enrich_skill_with_git_state(skill: &SkillSummary) -> SkillSummary {
    let skill_path = Path::new(&skill.local_path);
    if !skill_path.exists() || repo_root(skill_path).is_none() {
        let mut unlinked = skill.clone();
        if let Some(updated_at) = latest_local_content_modified_at(skill_path) {
            unlinked.last_synced_at = updated_at;
        }
        unlinked.git_linked = false;
        return unlinked;
    }

    let branch = run_git(skill_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|| skill.branch.clone());
    let commit_label = run_git(skill_path, &["rev-parse", "--short", "HEAD"])
        .unwrap_or_else(|| skill.commit_label.clone());
    let working_tree_dirty = run_git(skill_path, &["status", "--porcelain", "--", "."])
        .map(|output| !output.trim().is_empty())
        .unwrap_or(false);

    let remote_counts = branch_divergence(skill_path, &branch);
    let (collab_status, status_text) = derive_collab_status(working_tree_dirty, remote_counts);
    let last_synced_at = if working_tree_dirty {
        latest_local_content_modified_at(skill_path)
            .or_else(|| latest_commit_time(skill_path))
            .unwrap_or_else(|| skill.last_synced_at.clone())
    } else {
        latest_commit_time(skill_path)
            .or_else(|| latest_local_content_modified_at(skill_path))
            .unwrap_or_else(|| skill.last_synced_at.clone())
    };

    let mut enriched = skill.clone();
    enriched.branch = branch;
    enriched.commit_label = commit_label;
    enriched.collab_status = collab_status.to_string();
    enriched.status_text = status_text;
    enriched.last_synced_at = last_synced_at;
    enriched.last_checked_at = "刚刚检查".into();
    enriched.last_editor = latest_commit_author(skill_path).unwrap_or_default();
    enriched.git_linked = true;
    enriched
}

fn repo_root(skill_path: &Path) -> Option<String> {
    run_git(skill_path, &["rev-parse", "--show-toplevel"])
}

fn git_fetch_with_timeout(skill_path: &Path) {
    let path_str = skill_path.to_string_lossy().to_string();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = Command::new(GIT_BINARY)
            .args(["-C", &path_str, "fetch", ORIGIN_REMOTE, "--quiet", "--no-tags"])
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "Never")
            .output();
        let _ = tx.send(result);
    });
    let _ = rx.recv_timeout(Duration::from_secs(5));
}

fn branch_divergence(skill_path: &Path, branch: &str) -> Option<(usize, usize)> {
    git_fetch_with_timeout(skill_path);

    let remote_branch = resolve_remote_branch(skill_path, branch)?;
    let output = run_git(
        skill_path,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{remote_branch}...HEAD"),
        ],
    )?;
    let mut parts = output.split_whitespace();
    let behind = parts.next()?.parse::<usize>().ok()?;
    let ahead = parts.next()?.parse::<usize>().ok()?;
    Some((behind, ahead))
}

fn resolve_remote_branch(skill_path: &Path, branch: &str) -> Option<String> {
    let upstream = run_git(
        skill_path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    );
    if let Some(upstream) = upstream.filter(|value| !value.trim().is_empty()) {
        return Some(upstream);
    }

    let remote_branch = format!("{REMOTE_BRANCH_PREFIX}{branch}");
    let exists = run_git(
        skill_path,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{remote_branch}"),
        ],
    )
    .is_some();
    if exists {
        Some(remote_branch)
    } else {
        None
    }
}

fn derive_collab_status(
    working_tree_dirty: bool,
    remote_counts: Option<(usize, usize)>,
) -> (&'static str, String) {
    let Some((behind, ahead)) = remote_counts else {
        if working_tree_dirty {
            return (
                STATUS_PENDING_PUSH,
                "本地工作区存在改动，建议整理后推送到团队仓库。".into(),
            );
        }

        return (STATUS_CLEAN, "本地与仓库状态一致，可直接使用。".into());
    };

    if behind > 0 && (ahead > 0 || working_tree_dirty) {
        return (
            STATUS_PENDING_PUSH,
            "本地与远端均有变化，建议先处理本地改动，再更新远端内容。".into(),
        );
    }
    if behind > 0 {
        return (
            STATUS_UPDATE_AVAILABLE,
            "远端存在更新，建议先拉取后再同步到工具。".into(),
        );
    }
    if ahead > 0 || working_tree_dirty {
        return (
            STATUS_PENDING_PUSH,
            "本地存在领先或未提交改动，可继续推送到团队仓库。".into(),
        );
    }

    (STATUS_CLEAN, "本地与仓库状态一致，可直接使用。".into())
}

fn run_git(skill_path: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new(GIT_BINARY)
        .args(["-C", skill_path.to_string_lossy().as_ref()])
        .args(args)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn latest_commit_author(skill_path: &Path) -> Option<String> {
    run_git(skill_path, &["log", "-1", "--pretty=format:%an"])
}

fn latest_commit_time(skill_path: &Path) -> Option<String> {
    run_git(
        skill_path,
        &[
            "log",
            "-1",
            "--date=format-local:%Y/%-m/%-d %H:%M:%S",
            "--pretty=format:%cd",
        ],
    )
    .filter(|value| !value.trim().is_empty())
}

fn latest_local_content_modified_at(skill_path: &Path) -> Option<String> {
    let latest = latest_modified_in_directory(skill_path)?;
    format_system_time(latest)
}

fn latest_modified_in_directory(path: &Path) -> Option<SystemTime> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.is_file() {
        return metadata.modified().ok();
    }

    if !metadata.is_dir() {
        return None;
    }

    let mut latest = metadata.modified().ok();
    let entries = fs::read_dir(path).ok()?;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == ".git")
        {
            continue;
        }
        let candidate = latest_modified_path(&entry_path);
        latest = max_system_time(latest, candidate);
    }
    latest
}

fn latest_modified_path(path: &PathBuf) -> Option<SystemTime> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.is_file() {
        return metadata.modified().ok();
    }
    if metadata.is_dir() {
        return latest_modified_in_directory(path);
    }
    None
}

fn max_system_time(left: Option<SystemTime>, right: Option<SystemTime>) -> Option<SystemTime> {
    match (left, right) {
        (Some(left_time), Some(right_time)) => Some(if right_time > left_time {
            right_time
        } else {
            left_time
        }),
        (Some(left_time), None) => Some(left_time),
        (None, Some(right_time)) => Some(right_time),
        (None, None) => None,
    }
}

fn format_system_time(value: SystemTime) -> Option<String> {
    let seconds = value.duration_since(UNIX_EPOCH).ok()?.as_secs().to_string();
    let output = Command::new("date")
        .args(["-r", &seconds, "+%Y/%-m/%-d %H:%M:%S"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let formatted = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if formatted.is_empty() {
        None
    } else {
        Some(formatted)
    }
}
