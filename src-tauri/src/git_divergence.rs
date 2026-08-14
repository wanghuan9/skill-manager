use std::path::Path;

use crate::library::git_command;

const ORIGIN_REMOTE: &str = "origin";
const REMOTE_BRANCH_PREFIX: &str = "origin/";

fn run_git(repo_path: &Path, args: &[String]) -> Option<String> {
    let output = git_command()
        .args(["-C", repo_path.to_string_lossy().as_ref()])
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn resolve_remote_branch(repo_path: &Path, branch: &str) -> Option<String> {
    let upstream = run_git(
        repo_path,
        &[
            "rev-parse".to_string(),
            "--abbrev-ref".to_string(),
            "--symbolic-full-name".to_string(),
            "@{upstream}".to_string(),
        ],
    );
    if let Some(upstream) = upstream.filter(|value| !value.trim().is_empty()) {
        return Some(upstream);
    }

    let remote_branch = format!("{REMOTE_BRANCH_PREFIX}{branch}");
    run_git(
        repo_path,
        &[
            "show-ref".to_string(),
            "--verify".to_string(),
            "--quiet".to_string(),
            format!("refs/remotes/{remote_branch}"),
        ],
    )?;
    Some(remote_branch)
}

fn unpublished_commit_count(repo_path: &Path, pathspec: &str) -> Option<usize> {
    run_git(
        repo_path,
        &[
            "remote".to_string(),
            "get-url".to_string(),
            ORIGIN_REMOTE.to_string(),
        ],
    )?;
    let mut args = vec![
        "rev-list".to_string(),
        "--count".to_string(),
        "HEAD".to_string(),
        "--not".to_string(),
        "--remotes=origin".to_string(),
    ];
    if !pathspec.is_empty() {
        args.push("--".to_string());
        args.push(pathspec.to_string());
    }
    run_git(repo_path, &args)?.parse::<usize>().ok()
}

pub fn local_branch_divergence_counts(
    repo_path: &Path,
    branch: &str,
    pathspec: &str,
) -> Option<(usize, usize)> {
    if branch.is_empty() || branch == "HEAD" {
        return None;
    }

    if let Some(remote_branch) = resolve_remote_branch(repo_path, branch) {
        let mut args = vec![
            "rev-list".to_string(),
            "--left-right".to_string(),
            "--count".to_string(),
            format!("{remote_branch}...HEAD"),
        ];
        if !pathspec.is_empty() {
            args.push("--".to_string());
            args.push(pathspec.to_string());
        }
        let output = run_git(repo_path, &args)?;
        let mut parts = output.split_whitespace();
        let behind = parts.next()?.parse::<usize>().ok()?;
        let ahead = parts.next()?.parse::<usize>().ok()?;
        return Some((behind, ahead));
    }

    unpublished_commit_count(repo_path, pathspec).map(|ahead| (0, ahead))
}
