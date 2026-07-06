use std::cmp::Ordering;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime};

use crate::library::{configure_git_network_command, git_command};
use crate::models::SkillSummary;
use crate::workspace::{
    remove_legacy_workspace_file, workspace_file_candidates, workspace_file_path,
};
use serde::{Deserialize, Serialize};

const STATUS_CLEAN: &str = "clean";
const STATUS_UPDATE_AVAILABLE: &str = "update-available";
const STATUS_PENDING_PUSH: &str = "pending-push";
const ORIGIN_REMOTE: &str = "origin";
const REMOTE_BRANCH_PREFIX: &str = "origin/";
const UPDATE_CACHE_FILE_NAME: &str = "git-update-cache.json";

static UPDATE_CACHE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static GIT_FETCH_LOCKS: OnceLock<(Mutex<HashSet<String>>, Condvar)> = OnceLock::new();

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct GitUpdateCache {
    #[serde(default)]
    entries: Vec<GitUpdateCacheEntry>,
    #[serde(default)]
    pending_push_entries: Vec<GitPendingPushCacheEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct GitUpdateCacheEntry {
    skill_name: String,
    local_path: String,
    branch: String,
    head: String,
    behind: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct GitPendingPushCacheEntry {
    skill_name: String,
    local_path: String,
    branch: String,
    head: String,
    working_tree_signature: String,
    ahead: usize,
}

#[derive(Clone, Debug, Default)]
struct GitCommitMetadata {
    updated_at: Option<String>,
    committer: Option<String>,
}

struct GitFetchLockGuard {
    repo_key: String,
}

impl Drop for GitFetchLockGuard {
    fn drop(&mut self) {
        let (active_repos, waiters) = git_fetch_locks();
        let mut active_repos = active_repos
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        active_repos.remove(&self.repo_key);
        waiters.notify_all();
    }
}

pub fn enrich_skill_with_git_state(skill: &SkillSummary) -> SkillSummary {
    let skill_path = Path::new(&skill.local_path);
    if !skill_path.exists() || repo_root(skill_path).is_none() {
        let mut unlinked = skill.clone();
        let fallback_local_updated_at = if skill.local_updated_at.trim().is_empty() {
            skill.last_synced_at.clone()
        } else {
            skill.local_updated_at.clone()
        };
        let local_updated_at = prefer_newer_local_updated_at(
            &fallback_local_updated_at,
            latest_local_content_modified_at(skill_path),
        );
        if !local_updated_at.trim().is_empty() {
            unlinked.local_updated_at = local_updated_at.clone();
            unlinked.last_synced_at = local_updated_at;
        }
        unlinked.git_linked = false;
        return unlinked;
    }

    let branch = run_git(skill_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|| skill.branch.clone());
    let commit_label = run_git(skill_path, &["rev-parse", "--short", "HEAD"])
        .unwrap_or_else(|| skill.commit_label.clone());
    let head = run_git(skill_path, &["rev-parse", "HEAD"]).unwrap_or_else(|| commit_label.clone());
    let working_tree_signature =
        run_git(skill_path, &["status", "--porcelain", "--", "."]).unwrap_or_default();
    let working_tree_dirty = !working_tree_signature.trim().is_empty();

    let remote_counts = cached_update_counts(skill, &branch, &head)
        .or_else(|| branch_divergence(skill_path, &branch));
    sync_update_cache(skill, &branch, &head, remote_counts);
    let (collab_status, status_text) = derive_collab_status(working_tree_dirty, remote_counts);
    sync_pending_push_cache(
        skill,
        &branch,
        &head,
        &working_tree_signature,
        remote_counts,
        collab_status,
    );
    let fallback_local_updated_at = if skill.local_updated_at.trim().is_empty() {
        skill.last_synced_at.clone()
    } else {
        skill.local_updated_at.clone()
    };
    let fallback_remote_updated_at = if skill.remote_updated_at.trim().is_empty() {
        fallback_local_updated_at.clone()
    } else {
        skill.remote_updated_at.clone()
    };
    let local_commit_metadata = latest_commit_metadata(skill_path);
    let remote_commit_metadata = latest_remote_commit_metadata(skill_path, &branch);
    let local_updated_at = prefer_newer_local_updated_at(
        &fallback_local_updated_at,
        local_updated_at_candidate(
            skill_path,
            working_tree_dirty,
            local_commit_metadata.updated_at.clone(),
        ),
    );
    let remote_updated_at = remote_commit_metadata
        .as_ref()
        .and_then(|metadata| metadata.updated_at.clone())
        .or_else(|| local_commit_metadata.updated_at.clone())
        .unwrap_or_else(|| fallback_remote_updated_at.clone());
    let remote_updated_by = remote_commit_metadata
        .as_ref()
        .and_then(|metadata| metadata.committer.clone())
        .or_else(|| local_commit_metadata.committer.clone())
        .unwrap_or_else(|| skill.last_editor.clone());

    let mut enriched = skill.clone();
    enriched.branch = branch;
    enriched.commit_label = commit_label;
    enriched.collab_status = collab_status.to_string();
    enriched.status_text = status_text;
    enriched.remote_updated_at = remote_updated_at;
    enriched.local_updated_at = local_updated_at.clone();
    enriched.last_synced_at = local_updated_at;
    enriched.last_checked_at = "刚刚检查".into();
    enriched.last_editor = remote_updated_by;
    enriched.git_linked = true;
    enriched
}

/// 刚 clone 完的 skill 快速 enrich：仅跑一次 `git log`。
/// 跳过 `git status`（工作区刚 clone 必定 clean）和 remote 元数据查询（remote == local HEAD）。
pub fn enrich_freshly_installed_skill(skill: &SkillSummary, known_branch: Option<&str>) -> SkillSummary {
    let skill_path = Path::new(&skill.local_path);

    // 取 known_branch 作为分支名，无需再跑 rev-parse --abbrev-ref HEAD
    let branch = known_branch
        .filter(|b| !b.trim().is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| skill.branch.clone());

    // 一次 git log 同时拿到 short hash + 提交时间 + 提交者
    let git_state = run_git(
        skill_path,
        &[
            "log",
            "-1",
            "--date=format-local:%Y/%-m/%-d %H:%M:%S",
            "--pretty=format:%h%x00%cd%x00%cn",
            "--",
            ".",
        ],
    );

    let (commit_label, updated_at, committer) = git_state
        .as_deref()
        .map(|raw| {
            let mut parts = raw.splitn(3, '\x00');
            let hash = parts.next().map(str::trim).filter(|s| !s.is_empty()).map(ToOwned::to_owned);
            let date = parts.next().map(str::trim).filter(|s| !s.is_empty()).map(ToOwned::to_owned);
            let author = parts.next().map(str::trim).filter(|s| !s.is_empty()).map(ToOwned::to_owned);
            (hash, date, author)
        })
        .unwrap_or((None, None, None));

    let fallback_local = if skill.local_updated_at.trim().is_empty() {
        skill.last_synced_at.clone()
    } else {
        skill.local_updated_at.clone()
    };
    let local_updated_at = prefer_newer_local_updated_at(&fallback_local, updated_at.clone());
    let remote_updated_at = updated_at.unwrap_or_else(|| local_updated_at.clone());

    let (collab_status, status_text) = derive_collab_status(false, Some((0, 0)));

    let mut enriched = skill.clone();
    enriched.branch = branch;
    enriched.commit_label = commit_label.unwrap_or_else(|| skill.commit_label.clone());
    enriched.collab_status = collab_status.to_string();
    enriched.status_text = status_text;
    enriched.remote_updated_at = remote_updated_at;
    enriched.local_updated_at = local_updated_at.clone();
    enriched.last_synced_at = local_updated_at;
    enriched.last_checked_at = "刚刚检查".into();
    enriched.last_editor = committer.unwrap_or_else(|| skill.last_editor.clone());
    enriched.git_linked = true;
    enriched
}

pub fn enrich_newly_installed_skill_with_git_state(skill: &SkillSummary) -> SkillSummary {
    let skill_path = Path::new(&skill.local_path);
    if !skill_path.exists() || repo_root(skill_path).is_none() {
        let mut unlinked = skill.clone();
        let fallback_local_updated_at = if skill.local_updated_at.trim().is_empty() {
            skill.last_synced_at.clone()
        } else {
            skill.local_updated_at.clone()
        };
        let local_updated_at = prefer_newer_local_updated_at(
            &fallback_local_updated_at,
            latest_local_content_modified_at(skill_path),
        );
        if !local_updated_at.trim().is_empty() {
            unlinked.local_updated_at = local_updated_at.clone();
            unlinked.last_synced_at = local_updated_at;
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
    let (collab_status, status_text) = derive_collab_status(working_tree_dirty, Some((0, 0)));
    let fallback_local_updated_at = if skill.local_updated_at.trim().is_empty() {
        skill.last_synced_at.clone()
    } else {
        skill.local_updated_at.clone()
    };
    let fallback_remote_updated_at = if skill.remote_updated_at.trim().is_empty() {
        fallback_local_updated_at.clone()
    } else {
        skill.remote_updated_at.clone()
    };
    let local_commit_metadata = latest_commit_metadata(skill_path);
    let remote_commit_metadata = latest_remote_commit_metadata(skill_path, &branch);
    let local_updated_at = prefer_newer_local_updated_at(
        &fallback_local_updated_at,
        local_commit_metadata
            .updated_at
            .clone()
            .or_else(|| latest_local_content_modified_at(skill_path)),
    );
    let remote_updated_at = remote_commit_metadata
        .as_ref()
        .and_then(|metadata| metadata.updated_at.clone())
        .or_else(|| local_commit_metadata.updated_at.clone())
        .unwrap_or_else(|| fallback_remote_updated_at.clone());
    let remote_updated_by = remote_commit_metadata
        .as_ref()
        .and_then(|metadata| metadata.committer.clone())
        .or_else(|| local_commit_metadata.committer.clone())
        .unwrap_or_else(|| skill.last_editor.clone());

    let mut enriched = skill.clone();
    enriched.branch = branch;
    enriched.commit_label = commit_label;
    enriched.collab_status = collab_status.to_string();
    enriched.status_text = status_text;
    enriched.remote_updated_at = remote_updated_at;
    enriched.local_updated_at = local_updated_at.clone();
    enriched.last_synced_at = local_updated_at;
    enriched.last_checked_at = "刚刚检查".into();
    enriched.last_editor = remote_updated_by;
    enriched.git_linked = true;
    enriched
}

pub fn enrich_skill_with_cached_update_state(skill: &SkillSummary) -> SkillSummary {
    let skill_path = Path::new(&skill.local_path);
    if !skill_path.exists() {
        return skill.clone();
    }

    if repo_root(skill_path).is_none() {
        let mut enriched = skill.clone();
        let fallback_local_updated_at = if skill.local_updated_at.trim().is_empty() {
            skill.last_synced_at.clone()
        } else {
            skill.local_updated_at.clone()
        };
        let local_updated_at = prefer_newer_local_updated_at(
            &fallback_local_updated_at,
            latest_local_content_modified_at(skill_path),
        );
        if !local_updated_at.trim().is_empty() {
            enriched.local_updated_at = local_updated_at.clone();
            enriched.last_synced_at = local_updated_at;
        }
        enriched.git_linked = false;
        return enriched;
    }

    let branch = run_git(skill_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|| skill.branch.clone());
    let commit_label = run_git(skill_path, &["rev-parse", "--short", "HEAD"])
        .unwrap_or_else(|| skill.commit_label.clone());
    let head = run_git(skill_path, &["rev-parse", "HEAD"]).unwrap_or_else(|| commit_label.clone());
    let working_tree_signature =
        run_git(skill_path, &["status", "--porcelain", "--", "."]).unwrap_or_default();
    let working_tree_dirty = !working_tree_signature.trim().is_empty();
    let fallback_local_updated_at = if skill.local_updated_at.trim().is_empty() {
        skill.last_synced_at.clone()
    } else {
        skill.local_updated_at.clone()
    };
    let local_updated_at = prefer_newer_local_updated_at(
        &fallback_local_updated_at,
        local_updated_at_candidate(
            skill_path,
            working_tree_dirty,
            latest_commit_metadata(skill_path).updated_at,
        ),
    );

    if cached_pending_push_entry(skill, &branch, &head, &working_tree_signature).is_some() {
        let mut enriched = skill.clone();
        enriched.branch = branch;
        enriched.commit_label = commit_label;
        enriched.collab_status = STATUS_PENDING_PUSH.into();
        enriched.status_text = "本地存在待推送内容，已使用上次检测结果。".into();
        enriched.local_updated_at = local_updated_at.clone();
        enriched.last_synced_at = local_updated_at;
        enriched.last_checked_at = "已缓存".into();
        enriched.git_linked = true;
        return enriched;
    }

    if cached_update_counts(skill, &branch, &head).is_none() {
        let mut enriched = skill.clone();
        enriched.branch = branch;
        enriched.commit_label = commit_label;
        enriched.local_updated_at = local_updated_at.clone();
        enriched.last_synced_at = local_updated_at;
        enriched.git_linked = true;
        return enriched;
    }

    let mut enriched = skill.clone();
    enriched.branch = branch;
    enriched.commit_label = commit_label;
    enriched.collab_status = STATUS_UPDATE_AVAILABLE.into();
    enriched.status_text = "远端存在更新，已使用上次检测结果。".into();
    enriched.local_updated_at = local_updated_at.clone();
    enriched.last_synced_at = local_updated_at;
    enriched.last_checked_at = "已缓存".into();
    enriched.git_linked = true;
    enriched
}

pub fn enrich_skill_with_local_git_state(skill: &SkillSummary) -> SkillSummary {
    let skill_path = Path::new(&skill.local_path);
    if !skill_path.exists() || repo_root(skill_path).is_none() {
        let mut unlinked = skill.clone();
        let fallback_local_updated_at = if skill.local_updated_at.trim().is_empty() {
            skill.last_synced_at.clone()
        } else {
            skill.local_updated_at.clone()
        };
        let local_updated_at = prefer_newer_local_updated_at(
            &fallback_local_updated_at,
            latest_local_content_modified_at(skill_path),
        );
        if !local_updated_at.trim().is_empty() {
            unlinked.local_updated_at = local_updated_at.clone();
            unlinked.last_synced_at = local_updated_at;
        }
        unlinked.git_linked = false;
        return unlinked;
    }

    let branch = run_git(skill_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|| skill.branch.clone());
    let commit_label = run_git(skill_path, &["rev-parse", "--short", "HEAD"])
        .unwrap_or_else(|| skill.commit_label.clone());
    let head = run_git(skill_path, &["rev-parse", "HEAD"]).unwrap_or_else(|| commit_label.clone());
    let working_tree_signature =
        run_git(skill_path, &["status", "--porcelain", "--", "."]).unwrap_or_default();
    let working_tree_dirty = !working_tree_signature.trim().is_empty();
    let remote_counts = cached_update_counts(skill, &branch, &head)
        .or_else(|| local_branch_divergence(skill_path, &branch));
    let (collab_status, status_text) = derive_collab_status(working_tree_dirty, remote_counts);
    sync_pending_push_cache(
        skill,
        &branch,
        &head,
        &working_tree_signature,
        remote_counts,
        collab_status,
    );
    let fallback_local_updated_at = if skill.local_updated_at.trim().is_empty() {
        skill.last_synced_at.clone()
    } else {
        skill.local_updated_at.clone()
    };
    let local_updated_at = prefer_newer_local_updated_at(
        &fallback_local_updated_at,
        local_updated_at_candidate(
            skill_path,
            working_tree_dirty,
            latest_commit_metadata(skill_path).updated_at,
        ),
    );

    let mut enriched = skill.clone();
    enriched.branch = branch;
    enriched.commit_label = commit_label;
    enriched.collab_status = collab_status.to_string();
    enriched.status_text = status_text;
    enriched.remote_updated_at = skill.remote_updated_at.clone();
    enriched.local_updated_at = local_updated_at.clone();
    enriched.last_synced_at = local_updated_at;
    enriched.last_checked_at = "刚刚检查".into();
    enriched.last_editor = skill.last_editor.clone();
    enriched.git_linked = true;
    enriched
}

pub fn clear_skill_update_cache(skill: &SkillSummary) {
    remove_update_cache_entry(skill);
    remove_pending_push_cache_entry(skill);
}

fn repo_root(skill_path: &Path) -> Option<String> {
    run_git(skill_path, &["rev-parse", "--show-toplevel"])
}

fn git_fetch_with_timeout(skill_path: &Path) {
    let path_str = skill_path.to_string_lossy().to_string();
    let repo_key = repo_root(skill_path).unwrap_or_else(|| path_str.clone());
    let _fetch_guard = acquire_git_fetch_lock(repo_key);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut command = git_command();
        configure_git_network_command(&mut command);
        let result = command
            .args([
                "-C",
                &path_str,
                "fetch",
                ORIGIN_REMOTE,
                "--quiet",
                "--no-tags",
            ])
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
            "--",
            ".",
        ],
    )?;
    let mut parts = output.split_whitespace();
    let behind = parts.next()?.parse::<usize>().ok()?;
    let ahead = parts.next()?.parse::<usize>().ok()?;
    Some((behind, ahead))
}

fn local_branch_divergence(skill_path: &Path, branch: &str) -> Option<(usize, usize)> {
    let remote_branch = resolve_remote_branch(skill_path, branch)?;
    let output = run_git(
        skill_path,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{remote_branch}...HEAD"),
            "--",
            ".",
        ],
    )?;
    let mut parts = output.split_whitespace();
    let behind = parts.next()?.parse::<usize>().ok()?;
    let ahead = parts.next()?.parse::<usize>().ok()?;
    Some((behind, ahead))
}

fn cached_update_counts(skill: &SkillSummary, branch: &str, head: &str) -> Option<(usize, usize)> {
    let _guard = lock_update_cache();
    let cache = load_update_cache();
    cache
        .entries
        .into_iter()
        .find(|entry| update_cache_entry_matches(entry, skill, branch, head))
        .map(|entry| (entry.behind, 0))
}

fn cached_pending_push_entry(
    skill: &SkillSummary,
    branch: &str,
    head: &str,
    working_tree_signature: &str,
) -> Option<GitPendingPushCacheEntry> {
    let _guard = lock_update_cache();
    let cache = load_update_cache();
    cache.pending_push_entries.into_iter().find(|entry| {
        pending_push_cache_entry_matches(entry, skill, branch, head, working_tree_signature)
    })
}

fn sync_update_cache(
    skill: &SkillSummary,
    branch: &str,
    head: &str,
    remote_counts: Option<(usize, usize)>,
) {
    let Some((behind, _)) = remote_counts else {
        return;
    };

    if behind > 0 {
        save_update_cache_entry(skill, branch, head, behind);
    } else {
        remove_update_cache_entry(skill);
    }
}

fn sync_pending_push_cache(
    skill: &SkillSummary,
    branch: &str,
    head: &str,
    working_tree_signature: &str,
    remote_counts: Option<(usize, usize)>,
    collab_status: &str,
) {
    if collab_status == STATUS_PENDING_PUSH {
        let ahead = remote_counts.map(|(_, ahead)| ahead).unwrap_or(0);
        save_pending_push_cache_entry(skill, branch, head, working_tree_signature, ahead);
    } else {
        remove_pending_push_cache_entry(skill);
    }
}

fn update_cache_entry_matches(
    entry: &GitUpdateCacheEntry,
    skill: &SkillSummary,
    branch: &str,
    head: &str,
) -> bool {
    entry.skill_name == skill.name
        && entry.local_path == skill.local_path
        && entry.branch == branch
        && entry.head == head
        && entry.behind > 0
}

fn pending_push_cache_entry_matches(
    entry: &GitPendingPushCacheEntry,
    skill: &SkillSummary,
    branch: &str,
    head: &str,
    working_tree_signature: &str,
) -> bool {
    entry.skill_name == skill.name
        && entry.local_path == skill.local_path
        && entry.branch == branch
        && entry.head == head
        && entry.working_tree_signature == working_tree_signature
        && (entry.ahead > 0 || !entry.working_tree_signature.trim().is_empty())
}

fn save_update_cache_entry(skill: &SkillSummary, branch: &str, head: &str, behind: usize) {
    let _guard = lock_update_cache();
    let mut cache = load_update_cache();
    cache
        .entries
        .retain(|entry| entry.skill_name != skill.name || entry.local_path != skill.local_path);
    cache.entries.push(GitUpdateCacheEntry {
        skill_name: skill.name.clone(),
        local_path: skill.local_path.clone(),
        branch: branch.to_string(),
        head: head.to_string(),
        behind,
    });
    let _ = save_update_cache(&cache);
}

fn save_pending_push_cache_entry(
    skill: &SkillSummary,
    branch: &str,
    head: &str,
    working_tree_signature: &str,
    ahead: usize,
) {
    let _guard = lock_update_cache();
    let mut cache = load_update_cache();
    cache
        .pending_push_entries
        .retain(|entry| entry.skill_name != skill.name || entry.local_path != skill.local_path);
    cache.pending_push_entries.push(GitPendingPushCacheEntry {
        skill_name: skill.name.clone(),
        local_path: skill.local_path.clone(),
        branch: branch.to_string(),
        head: head.to_string(),
        working_tree_signature: working_tree_signature.to_string(),
        ahead,
    });
    let _ = save_update_cache(&cache);
}

fn remove_update_cache_entry(skill: &SkillSummary) {
    let _guard = lock_update_cache();
    let mut cache = load_update_cache();
    let original_len = cache.entries.len();
    cache
        .entries
        .retain(|entry| entry.skill_name != skill.name || entry.local_path != skill.local_path);
    if cache.entries.len() != original_len {
        let _ = save_update_cache(&cache);
    }
}

fn remove_pending_push_cache_entry(skill: &SkillSummary) {
    let _guard = lock_update_cache();
    let mut cache = load_update_cache();
    let original_len = cache.pending_push_entries.len();
    cache
        .pending_push_entries
        .retain(|entry| entry.skill_name != skill.name || entry.local_path != skill.local_path);
    if cache.pending_push_entries.len() != original_len {
        let _ = save_update_cache(&cache);
    }
}

fn load_update_cache() -> GitUpdateCache {
    let Some((_, contents)) = workspace_file_candidates(UPDATE_CACHE_FILE_NAME)
        .into_iter()
        .find_map(|path| {
            fs::read_to_string(&path)
                .ok()
                .map(|contents| (path, contents))
        })
    else {
        return GitUpdateCache::default();
    };
    let mut cache = serde_json::from_str(&contents).unwrap_or_default();
    if prune_stale_update_cache(&mut cache) {
        let _ = save_update_cache(&cache);
    }
    cache
}

fn prune_stale_update_cache(cache: &mut GitUpdateCache) -> bool {
    let original_entries_len = cache.entries.len();
    let original_pending_push_entries_len = cache.pending_push_entries.len();
    cache
        .entries
        .retain(|entry| cached_skill_path_exists(&entry.local_path));
    cache
        .pending_push_entries
        .retain(|entry| cached_skill_path_exists(&entry.local_path));
    cache.entries.len() != original_entries_len
        || cache.pending_push_entries.len() != original_pending_push_entries_len
}

fn cached_skill_path_exists(local_path: &str) -> bool {
    !local_path.trim().is_empty() && Path::new(local_path).exists()
}

fn save_update_cache(cache: &GitUpdateCache) -> Result<(), String> {
    let cache_file = update_cache_file().ok_or_else(|| "无法定位用户目录".to_string())?;
    let parent_dir = cache_file
        .parent()
        .ok_or_else(|| "Git 更新缓存目录无效".to_string())?;
    fs::create_dir_all(parent_dir)
        .map_err(|error| format!("创建 Git 更新缓存目录失败: {error}"))?;
    let payload = serde_json::to_string_pretty(cache)
        .map_err(|error| format!("序列化 Git 更新缓存失败: {error}"))?;
    fs::write(cache_file, payload).map_err(|error| format!("写入 Git 更新缓存失败: {error}"))?;
    remove_legacy_workspace_file(UPDATE_CACHE_FILE_NAME);
    Ok(())
}

fn update_cache_file() -> Option<PathBuf> {
    workspace_file_path(UPDATE_CACHE_FILE_NAME).ok()
}

fn update_cache_lock() -> &'static Mutex<()> {
    UPDATE_CACHE_LOCK.get_or_init(|| Mutex::new(()))
}

fn lock_update_cache() -> MutexGuard<'static, ()> {
    update_cache_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn git_fetch_locks() -> &'static (Mutex<HashSet<String>>, Condvar) {
    GIT_FETCH_LOCKS.get_or_init(|| (Mutex::new(HashSet::new()), Condvar::new()))
}

fn acquire_git_fetch_lock(repo_key: String) -> GitFetchLockGuard {
    let (active_repos, waiters) = git_fetch_locks();
    let mut active_repos = active_repos
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    while active_repos.contains(&repo_key) {
        active_repos = waiters
            .wait(active_repos)
            .unwrap_or_else(|error| error.into_inner());
    }
    active_repos.insert(repo_key.clone());
    GitFetchLockGuard { repo_key }
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
    let output = git_command()
        .args(["-C", skill_path.to_string_lossy().as_ref()])
        .args(args)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git_owned(skill_path: &Path, args: &[String]) -> Option<String> {
    let output = git_command()
        .args(["-C", skill_path.to_string_lossy().as_ref()])
        .args(args)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn latest_commit_metadata(skill_path: &Path) -> GitCommitMetadata {
    latest_commit_metadata_for_ref(skill_path, None).unwrap_or_default()
}

#[cfg(test)]
fn latest_remote_commit_committer(skill_path: &Path, branch: &str) -> Option<String> {
    latest_remote_commit_metadata(skill_path, branch).and_then(|metadata| metadata.committer)
}

fn latest_remote_commit_metadata(skill_path: &Path, branch: &str) -> Option<GitCommitMetadata> {
    let remote_branch = resolve_remote_branch(skill_path, branch)?;
    latest_commit_metadata_for_ref(skill_path, Some(remote_branch.as_str()))
}

fn latest_commit_metadata_for_ref(
    skill_path: &Path,
    git_ref: Option<&str>,
) -> Option<GitCommitMetadata> {
    let mut args = vec!["log".to_string()];
    if let Some(reference) = git_ref.filter(|value| !value.trim().is_empty()) {
        args.push(reference.to_string());
    }
    args.push("-1".to_string());
    args.push("--date=format-local:%Y/%-m/%-d %H:%M:%S".to_string());
    args.push("--pretty=format:%cd%x00%cn".to_string());
    args.push("--".to_string());
    args.push(".".to_string());

    let output = run_git_owned(skill_path, &args).filter(|value| !value.trim().is_empty())?;
    let mut parts = output.splitn(2, '\0');
    let updated_at = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let committer = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    Some(GitCommitMetadata {
        updated_at,
        committer,
    })
}

fn latest_local_content_modified_at(skill_path: &Path) -> Option<String> {
    let latest = latest_modified_in_directory(skill_path)?;
    format_system_time(latest)
}

fn local_updated_at_candidate(
    skill_path: &Path,
    working_tree_dirty: bool,
    commit_updated_at: Option<String>,
) -> Option<String> {
    if working_tree_dirty {
        latest_local_content_modified_at(skill_path).or(commit_updated_at)
    } else {
        commit_updated_at.or_else(|| latest_local_content_modified_at(skill_path))
    }
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
    let datetime: chrono::DateTime<chrono::Utc> = value.into();
    Some(format!(
        "{}/{}/{} {}",
        datetime.format("%Y"),
        datetime.format("%m").to_string().trim_start_matches('0'),
        datetime.format("%d").to_string().trim_start_matches('0'),
        datetime.format("%H:%M:%S")
    ))
}

fn prefer_newer_local_updated_at(
    fallback_local_updated_at: &str,
    candidate_local_updated_at: Option<String>,
) -> String {
    let Some(candidate_local_updated_at) =
        candidate_local_updated_at.filter(|value| !value.trim().is_empty())
    else {
        return fallback_local_updated_at.to_string();
    };
    if fallback_local_updated_at.trim().is_empty() {
        return candidate_local_updated_at;
    }
    match compare_skill_time_labels(fallback_local_updated_at, &candidate_local_updated_at) {
        Some(Ordering::Greater) => fallback_local_updated_at.to_string(),
        _ => candidate_local_updated_at,
    }
}

fn compare_skill_time_labels(left: &str, right: &str) -> Option<Ordering> {
    let left_parts = parse_skill_time_label(left)?;
    let right_parts = parse_skill_time_label(right)?;
    Some(left_parts.cmp(&right_parts))
}

fn parse_skill_time_label(value: &str) -> Option<(u32, u32, u32, u32, u32, u32)> {
    let parts = value
        .trim()
        .split(['/', ' ', ':'])
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<u32>().ok())
        .collect::<Option<Vec<_>>>()?;
    if parts.len() != 6 {
        return None;
    }

    Some((parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::process::Command;
    use std::time::UNIX_EPOCH;

    const GIT_BINARY: &str = "git";

    fn skill_summary(name: &str, local_path: &Path) -> SkillSummary {
        SkillSummary {
            name: name.into(),
            source_label: "GitHub".into(),
            source_type: "github".into(),
            source_url: "https://github.com/demo/skills".into(),
            description: "test skill".into(),
            local_path: local_path.to_string_lossy().to_string(),
            branch: "main".into(),
            collab_status: STATUS_CLEAN.into(),
            status_text: "ok".into(),
            remote_updated_at: "刚刚".into(),
            local_updated_at: "刚刚".into(),
            last_synced_at: "刚刚".into(),
            last_checked_at: "刚刚".into(),
            synced_tool_count: 0,
            last_editor: "".into(),
            commit_label: "initial".into(),
            git_linked: true,
            lifecycle_source: "direct".into(),
            owner_plugin_id: String::new(),
            owner_plugin_name: String::new(),
            tools: vec![],
        }
    }

    fn run_git_test<I, S>(args: I)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let output = Command::new(GIT_BINARY)
            .args(args)
            .output()
            .expect("git should run");
        assert!(
            output.status.success(),
            "git command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be available")
            .as_nanos();
        env::temp_dir().join(format!(
            "skilldock-git-state-{name}-{}-{timestamp}",
            std::process::id()
        ))
    }

    #[test]
    fn branch_divergence_only_counts_commits_touching_skill_path() {
        let temp_dir = unique_temp_dir("path-divergence");
        let remote_dir = temp_dir.join("remote.git");
        let local_dir = temp_dir.join("local");
        let remote_work_dir = temp_dir.join("remote-work");

        fs::create_dir_all(&temp_dir).expect("create test temp dir");
        run_git_test(["init", "--bare", remote_dir.to_str().expect("remote path")]);
        run_git_test([
            "clone",
            remote_dir.to_str().expect("remote path"),
            local_dir.to_str().expect("local path"),
        ]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "checkout",
            "-b",
            "main",
        ]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "config",
            "user.email",
            "skilldock@example.com",
        ]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "config",
            "user.name",
            "SkillDock",
        ]);

        fs::create_dir_all(local_dir.join("skills/skill-a")).expect("create skill-a");
        fs::create_dir_all(local_dir.join("skills/skill-b")).expect("create skill-b");
        fs::write(local_dir.join("skills/skill-a/SKILL.md"), "# skill-a\n").expect("write skill-a");
        fs::write(local_dir.join("skills/skill-b/SKILL.md"), "# skill-b\n").expect("write skill-b");
        run_git_test(["-C", local_dir.to_str().expect("local path"), "add", "."]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "commit",
            "-m",
            "initial skills",
        ]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "push",
            "-u",
            "origin",
            "main",
        ]);

        run_git_test([
            "clone",
            remote_dir.to_str().expect("remote path"),
            remote_work_dir.to_str().expect("remote work path"),
        ]);
        run_git_test([
            "-C",
            remote_work_dir.to_str().expect("remote work path"),
            "checkout",
            "main",
        ]);
        run_git_test([
            "-C",
            remote_work_dir.to_str().expect("remote work path"),
            "config",
            "user.email",
            "skilldock@example.com",
        ]);
        run_git_test([
            "-C",
            remote_work_dir.to_str().expect("remote work path"),
            "config",
            "user.name",
            "SkillDock",
        ]);
        fs::write(
            remote_work_dir.join("skills/skill-b/SKILL.md"),
            "# skill-b\nupdated\n",
        )
        .expect("update skill-b");
        run_git_test([
            "-C",
            remote_work_dir.to_str().expect("remote work path"),
            "commit",
            "-am",
            "update skill-b",
        ]);
        run_git_test([
            "-C",
            remote_work_dir.to_str().expect("remote work path"),
            "push",
            "origin",
            "main",
        ]);

        let skill_a_divergence =
            branch_divergence(&local_dir.join("skills/skill-a"), "main").expect("skill-a status");
        let skill_b_divergence =
            branch_divergence(&local_dir.join("skills/skill-b"), "main").expect("skill-b status");

        assert_eq!(skill_a_divergence, (0, 0));
        assert_eq!(skill_b_divergence, (1, 0));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn local_git_refresh_preserves_existing_remote_metadata() {
        let temp_dir = unique_temp_dir("preserve-remote-metadata");
        let remote_dir = temp_dir.join("remote.git");
        let local_dir = temp_dir.join("local");
        let skill_dir = local_dir.join("skills/technical-design-test");

        run_git_test(["init", "--bare", remote_dir.to_str().expect("remote path")]);
        run_git_test([
            "clone",
            remote_dir.to_str().expect("remote path"),
            local_dir.to_str().expect("local path"),
        ]);
        fs::create_dir_all(&skill_dir).expect("create skill dir");
        fs::write(skill_dir.join("SKILL.md"), "# technical-design-test").expect("write skill file");

        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "config",
            "user.name",
            "SkillDock Test",
        ]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "config",
            "user.email",
            "skilldock@example.com",
        ]);
        run_git_test(["-C", local_dir.to_str().expect("local path"), "add", "."]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "commit",
            "-m",
            "init",
        ]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "push",
            "origin",
            "HEAD:main",
        ]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "checkout",
            "-B",
            "main",
        ]);

        let mut skill = skill_summary("technical-design-test", &skill_dir);
        skill.branch = "main".into();
        skill.remote_updated_at = "2026/5/26 19:30:00".into();
        skill.last_editor = "Remote Author".into();

        let enriched = enrich_skill_with_local_git_state(&skill);

        assert_eq!(enriched.remote_updated_at, "2026/5/26 19:30:00");
        assert_eq!(enriched.last_editor, "Remote Author");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn latest_remote_commit_committer_only_uses_commits_touching_skill_path() {
        let temp_dir = unique_temp_dir("path-remote-author");
        let remote_dir = temp_dir.join("remote.git");
        let local_dir = temp_dir.join("local");
        let remote_work_dir = temp_dir.join("remote-work");

        fs::create_dir_all(&temp_dir).expect("create test temp dir");
        run_git_test(["init", "--bare", remote_dir.to_str().expect("remote path")]);
        run_git_test([
            "clone",
            remote_dir.to_str().expect("remote path"),
            local_dir.to_str().expect("local path"),
        ]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "checkout",
            "-b",
            "main",
        ]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "config",
            "user.email",
            "skilla@example.com",
        ]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "config",
            "user.name",
            "Skill A Author",
        ]);

        fs::create_dir_all(local_dir.join("skills/skill-a")).expect("create skill-a");
        fs::create_dir_all(local_dir.join("skills/skill-b")).expect("create skill-b");
        fs::write(local_dir.join("skills/skill-a/SKILL.md"), "# skill-a\n").expect("write skill-a");
        fs::write(local_dir.join("skills/skill-b/SKILL.md"), "# skill-b\n").expect("write skill-b");
        run_git_test(["-C", local_dir.to_str().expect("local path"), "add", "."]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "commit",
            "-m",
            "initial skills",
        ]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "push",
            "-u",
            "origin",
            "main",
        ]);

        run_git_test([
            "clone",
            remote_dir.to_str().expect("remote path"),
            remote_work_dir.to_str().expect("remote work path"),
        ]);
        run_git_test([
            "-C",
            remote_work_dir.to_str().expect("remote work path"),
            "checkout",
            "main",
        ]);
        run_git_test([
            "-C",
            remote_work_dir.to_str().expect("remote work path"),
            "config",
            "user.email",
            "skillb@example.com",
        ]);
        run_git_test([
            "-C",
            remote_work_dir.to_str().expect("remote work path"),
            "config",
            "user.name",
            "Skill B Author",
        ]);
        fs::write(
            remote_work_dir.join("skills/skill-b/SKILL.md"),
            "# skill-b\nupdated\n",
        )
        .expect("update skill-b");
        run_git_test([
            "-C",
            remote_work_dir.to_str().expect("remote work path"),
            "commit",
            "-am",
            "update skill-b",
        ]);
        run_git_test([
            "-C",
            remote_work_dir.to_str().expect("remote work path"),
            "push",
            "origin",
            "main",
        ]);

        git_fetch_with_timeout(&local_dir.join("skills/skill-a"));
        git_fetch_with_timeout(&local_dir.join("skills/skill-b"));

        let skill_a_remote_committer =
            latest_remote_commit_committer(&local_dir.join("skills/skill-a"), "main")
                .expect("skill-a remote committer");
        let skill_b_remote_committer =
            latest_remote_commit_committer(&local_dir.join("skills/skill-b"), "main")
                .expect("skill-b remote committer");

        assert_eq!(skill_a_remote_committer, "Skill A Author");
        assert_eq!(skill_b_remote_committer, "Skill B Author");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn enrich_skill_uses_real_git_committer_for_last_editor() {
        let temp_dir = unique_temp_dir("skill-last-editor-committer");
        let repo_dir = temp_dir.join("repo");
        let skill_dir = repo_dir.join("skills/coding-tutor");

        fs::create_dir_all(&skill_dir).expect("create skill dir");
        fs::write(skill_dir.join("SKILL.md"), "# coding-tutor\n").expect("write skill file");

        run_git_test(["init", repo_dir.to_str().expect("repo path")]);
        run_git_test([
            "-C",
            repo_dir.to_str().expect("repo path"),
            "checkout",
            "-b",
            "main",
        ]);
        run_git_test([
            "-C",
            repo_dir.to_str().expect("repo path"),
            "config",
            "user.name",
            "Real Committer",
        ]);
        run_git_test([
            "-C",
            repo_dir.to_str().expect("repo path"),
            "config",
            "user.email",
            "committer@example.com",
        ]);
        run_git_test(["-C", repo_dir.to_str().expect("repo path"), "add", "."]);
        run_git_test([
            "-C",
            repo_dir.to_str().expect("repo path"),
            "commit",
            "--author",
            "Original Author <author@example.com>",
            "-m",
            "add skill",
        ]);

        let mut skill = skill_summary("coding-tutor", &skill_dir);
        skill.branch = "main".into();

        let enriched = enrich_skill_with_git_state(&skill);

        assert_eq!(enriched.last_editor, "Real Committer");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn cached_update_state_refreshes_local_updated_at_from_working_tree() {
        let temp_dir = unique_temp_dir("cached-local-updated-at");
        let repo_dir = temp_dir.join("repo");

        fs::create_dir_all(&temp_dir).expect("create test temp dir");
        run_git_test(["init", repo_dir.to_str().expect("repo path")]);
        run_git_test([
            "-C",
            repo_dir.to_str().expect("repo path"),
            "checkout",
            "-b",
            "main",
        ]);
        run_git_test([
            "-C",
            repo_dir.to_str().expect("repo path"),
            "config",
            "user.email",
            "skilldock@example.com",
        ]);
        run_git_test([
            "-C",
            repo_dir.to_str().expect("repo path"),
            "config",
            "user.name",
            "SkillDock",
        ]);

        fs::write(repo_dir.join("SKILL.md"), "# demo-skill\n").expect("write skill file");
        run_git_test(["-C", repo_dir.to_str().expect("repo path"), "add", "."]);
        run_git_test([
            "-C",
            repo_dir.to_str().expect("repo path"),
            "commit",
            "-m",
            "initial skill",
        ]);

        let mut skill = skill_summary("demo-skill", &repo_dir);
        skill.local_updated_at = "2000/1/1 00:00:00".into();
        skill.last_synced_at = "2000/1/1 00:00:00".into();

        std::thread::sleep(Duration::from_secs(1));
        fs::write(repo_dir.join("notes.md"), "dirty change\n").expect("write dirty file");

        let enriched = enrich_skill_with_cached_update_state(&skill);

        assert_ne!(enriched.local_updated_at, "2000/1/1 00:00:00");
        assert_eq!(enriched.last_synced_at, enriched.local_updated_at);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn newly_installed_skill_keeps_install_time_when_commit_is_older() {
        let temp_dir = unique_temp_dir("new-install-keeps-install-time");
        let repo_dir = temp_dir.join("repo");

        fs::create_dir_all(&temp_dir).expect("create test temp dir");
        run_git_test(["init", repo_dir.to_str().expect("repo path")]);
        run_git_test([
            "-C",
            repo_dir.to_str().expect("repo path"),
            "checkout",
            "-b",
            "main",
        ]);
        run_git_test([
            "-C",
            repo_dir.to_str().expect("repo path"),
            "config",
            "user.email",
            "skilldock@example.com",
        ]);
        run_git_test([
            "-C",
            repo_dir.to_str().expect("repo path"),
            "config",
            "user.name",
            "SkillDock",
        ]);

        fs::write(repo_dir.join("SKILL.md"), "# demo-skill\n").expect("write skill file");
        run_git_test(["-C", repo_dir.to_str().expect("repo path"), "add", "."]);
        run_git_test([
            "-C",
            repo_dir.to_str().expect("repo path"),
            "commit",
            "-m",
            "initial skill",
        ]);

        let mut skill = skill_summary("demo-skill", &repo_dir);
        skill.local_updated_at = "2099/1/1 00:00:00".into();
        skill.last_synced_at = "2099/1/1 00:00:00".into();

        let enriched = enrich_newly_installed_skill_with_git_state(&skill);

        assert_eq!(enriched.local_updated_at, "2099/1/1 00:00:00");
        assert_eq!(enriched.last_synced_at, enriched.local_updated_at);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn prunes_stale_update_cache_entries() {
        let _guard = crate::workspace::TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_dir = unique_temp_dir("prune-stale-update-cache");
        let temp_home = temp_dir.join("home");
        let existing_skill_dir = temp_dir.join("existing-skill");
        let missing_skill_dir = temp_dir.join("missing-skill");
        let original_home = env::var_os("HOME");

        fs::create_dir_all(temp_home.join(".skilldock")).expect("create workspace");
        fs::create_dir_all(&existing_skill_dir).expect("create existing skill dir");
        let cache_path = temp_home.join(".skilldock").join(UPDATE_CACHE_FILE_NAME);
        let cache = GitUpdateCache {
            entries: vec![
                GitUpdateCacheEntry {
                    skill_name: "existing-skill".into(),
                    local_path: existing_skill_dir.to_string_lossy().into_owned(),
                    branch: "main".into(),
                    head: "abc123".into(),
                    behind: 1,
                },
                GitUpdateCacheEntry {
                    skill_name: "missing-skill".into(),
                    local_path: missing_skill_dir.to_string_lossy().into_owned(),
                    branch: "main".into(),
                    head: "def456".into(),
                    behind: 2,
                },
            ],
            pending_push_entries: vec![
                GitPendingPushCacheEntry {
                    skill_name: "existing-skill".into(),
                    local_path: existing_skill_dir.to_string_lossy().into_owned(),
                    branch: "main".into(),
                    head: "abc123".into(),
                    working_tree_signature: " M SKILL.md".into(),
                    ahead: 1,
                },
                GitPendingPushCacheEntry {
                    skill_name: "missing-skill".into(),
                    local_path: missing_skill_dir.to_string_lossy().into_owned(),
                    branch: "main".into(),
                    head: "def456".into(),
                    working_tree_signature: " M SKILL.md".into(),
                    ahead: 1,
                },
            ],
        };
        fs::write(
            &cache_path,
            serde_json::to_string_pretty(&cache).expect("serialize cache"),
        )
        .expect("write update cache");

        unsafe {
            env::set_var("HOME", &temp_home);
        }
        let pruned_cache = load_update_cache();
        if let Some(home) = original_home {
            unsafe {
                env::set_var("HOME", home);
            }
        } else {
            unsafe {
                env::remove_var("HOME");
            }
        }

        assert_eq!(pruned_cache.entries.len(), 1);
        assert_eq!(pruned_cache.entries[0].skill_name, "existing-skill");
        assert_eq!(pruned_cache.pending_push_entries.len(), 1);
        assert_eq!(
            pruned_cache.pending_push_entries[0].skill_name,
            "existing-skill"
        );

        let persisted_cache: GitUpdateCache =
            serde_json::from_str(&fs::read_to_string(&cache_path).expect("read persisted cache"))
                .expect("parse persisted cache");
        assert_eq!(persisted_cache.entries.len(), 1);
        assert_eq!(persisted_cache.pending_push_entries.len(), 1);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn update_cache_entry_matches_only_same_head_and_skill() {
        let skill_path = PathBuf::from("/tmp/skill-a");
        let skill = skill_summary("skill-a", &skill_path);
        let entry = GitUpdateCacheEntry {
            skill_name: "skill-a".into(),
            local_path: skill.local_path.clone(),
            branch: "main".into(),
            head: "abc123".into(),
            behind: 2,
        };

        assert!(update_cache_entry_matches(&entry, &skill, "main", "abc123"));
        assert!(!update_cache_entry_matches(
            &entry, &skill, "main", "def456"
        ));
        assert!(!update_cache_entry_matches(&entry, &skill, "dev", "abc123"));
    }

    #[test]
    fn format_system_time_formats_epoch_without_shelling_out() {
        let label = format_system_time(UNIX_EPOCH).expect("label");
        assert!(label.contains("1970") || label.contains("1969"));
        assert!(label.contains(':'));
    }

    #[test]
    fn pending_push_cache_entry_matches_only_same_fingerprint() {
        let skill_path = PathBuf::from("/tmp/skill-a");
        let skill = skill_summary("skill-a", &skill_path);
        let entry = GitPendingPushCacheEntry {
            skill_name: "skill-a".into(),
            local_path: skill.local_path.clone(),
            branch: "main".into(),
            head: "abc123".into(),
            working_tree_signature: " M SKILL.md".into(),
            ahead: 0,
        };

        assert!(pending_push_cache_entry_matches(
            &entry,
            &skill,
            "main",
            "abc123",
            " M SKILL.md",
        ));
        assert!(!pending_push_cache_entry_matches(
            &entry,
            &skill,
            "main",
            "def456",
            " M SKILL.md",
        ));
        assert!(!pending_push_cache_entry_matches(
            &entry,
            &skill,
            "main",
            "abc123",
            " M README.md",
        ));
        assert!(!pending_push_cache_entry_matches(
            &entry,
            &skill,
            "dev",
            "abc123",
            " M SKILL.md",
        ));
    }

    #[test]
    fn pending_push_cache_entry_requires_ahead_or_dirty_signature() {
        let skill_path = PathBuf::from("/tmp/skill-a");
        let skill = skill_summary("skill-a", &skill_path);
        let clean_without_ahead = GitPendingPushCacheEntry {
            skill_name: "skill-a".into(),
            local_path: skill.local_path.clone(),
            branch: "main".into(),
            head: "abc123".into(),
            working_tree_signature: "".into(),
            ahead: 0,
        };
        let clean_with_ahead = GitPendingPushCacheEntry {
            ahead: 1,
            ..clean_without_ahead.clone()
        };

        assert!(!pending_push_cache_entry_matches(
            &clean_without_ahead,
            &skill,
            "main",
            "abc123",
            "",
        ));
        assert!(pending_push_cache_entry_matches(
            &clean_with_ahead,
            &skill,
            "main",
            "abc123",
            "",
        ));
    }
}
