use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::models::SkillSummary;
use serde::{Deserialize, Serialize};

const STATUS_CLEAN: &str = "clean";
const STATUS_UPDATE_AVAILABLE: &str = "update-available";
const STATUS_PENDING_PUSH: &str = "pending-push";
const GIT_BINARY: &str = "git";
const ORIGIN_REMOTE: &str = "origin";
const REMOTE_BRANCH_PREFIX: &str = "origin/";
const UPDATE_CACHE_FILE_NAME: &str = "git-update-cache.json";

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

pub fn enrich_newly_installed_skill_with_git_state(skill: &SkillSummary) -> SkillSummary {
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
    let (collab_status, status_text) = derive_collab_status(working_tree_dirty, Some((0, 0)));

    let mut enriched = skill.clone();
    enriched.branch = branch;
    enriched.commit_label = commit_label;
    enriched.collab_status = collab_status.to_string();
    enriched.status_text = status_text;
    enriched.last_synced_at = latest_commit_time(skill_path)
        .or_else(|| latest_local_content_modified_at(skill_path))
        .unwrap_or_else(|| skill.last_synced_at.clone());
    enriched.last_checked_at = "刚刚检查".into();
    enriched.last_editor = latest_commit_author(skill_path).unwrap_or_default();
    enriched.git_linked = true;
    enriched
}

pub fn enrich_skill_with_cached_update_state(skill: &SkillSummary) -> SkillSummary {
    let skill_path = Path::new(&skill.local_path);
    if !skill_path.exists() || repo_root(skill_path).is_none() {
        return skill.clone();
    }

    let branch = run_git(skill_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|| skill.branch.clone());
    let commit_label = run_git(skill_path, &["rev-parse", "--short", "HEAD"])
        .unwrap_or_else(|| skill.commit_label.clone());
    let head = run_git(skill_path, &["rev-parse", "HEAD"]).unwrap_or_else(|| commit_label.clone());
    let working_tree_signature =
        run_git(skill_path, &["status", "--porcelain", "--", "."]).unwrap_or_default();

    if cached_pending_push_entry(skill, &branch, &head, &working_tree_signature).is_some() {
        let mut enriched = skill.clone();
        enriched.branch = branch;
        enriched.commit_label = commit_label;
        enriched.collab_status = STATUS_PENDING_PUSH.into();
        enriched.status_text = "本地存在待推送内容，已使用上次检测结果。".into();
        enriched.last_checked_at = "已缓存".into();
        enriched.git_linked = true;
        return enriched;
    }

    if cached_update_counts(skill, &branch, &head).is_none() {
        return skill.clone();
    }

    let mut enriched = skill.clone();
    enriched.branch = branch;
    enriched.commit_label = commit_label;
    enriched.collab_status = STATUS_UPDATE_AVAILABLE.into();
    enriched.status_text = "远端存在更新，已使用上次检测结果。".into();
    enriched.last_checked_at = "已缓存".into();
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
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = Command::new(GIT_BINARY)
            .args([
                "-C",
                &path_str,
                "fetch",
                ORIGIN_REMOTE,
                "--quiet",
                "--no-tags",
            ])
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
    let Some(cache_file) = update_cache_file() else {
        return GitUpdateCache::default();
    };
    let Ok(contents) = fs::read_to_string(cache_file) else {
        return GitUpdateCache::default();
    };
    serde_json::from_str(&contents).unwrap_or_default()
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
    fs::write(cache_file, payload).map_err(|error| format!("写入 Git 更新缓存失败: {error}"))
}

fn update_cache_file() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(PathBuf::from)
        .map(|home_dir| home_dir.join(".skillm").join(UPDATE_CACHE_FILE_NAME))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

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
            last_synced_at: "刚刚".into(),
            last_checked_at: "刚刚".into(),
            synced_tool_count: 0,
            last_editor: "".into(),
            commit_label: "initial".into(),
            git_linked: true,
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
            "skillm-git-state-{name}-{}-{timestamp}",
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
            "skillm@example.com",
        ]);
        run_git_test([
            "-C",
            local_dir.to_str().expect("local path"),
            "config",
            "user.name",
            "Skill Manager",
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
            "skillm@example.com",
        ]);
        run_git_test([
            "-C",
            remote_work_dir.to_str().expect("remote work path"),
            "config",
            "user.name",
            "Skill Manager",
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
