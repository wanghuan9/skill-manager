use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::models::SkillSummary;
use crate::workspace;
use crate::workspace::normalize_workspace_path;
use serde::de::DeserializeOwned;
use serde::Deserialize;

const SKILL_LIBRARY_DIR: &str = "skills";
const REPO_CACHE_DIR: &str = "repo-cache";
const RESERVED_WORKSPACE_LINK_NAMES: [&str; 5] =
    ["state.json", "skills", "repo-cache", "cache", "imports"];
const GIT_CLONE_HISTORY_DEPTH: &str = "20";
const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

fn sync_trace_enabled() -> bool {
    env::var("SKILLM_TRACE_SYNC").ok().as_deref() == Some("1")
}

pub fn install_market_skill_from_source(
    skill: &SkillSummary,
    skill_path: Option<&str>,
) -> Result<String, String> {
    let source_spec = parse_market_source_url(&skill.source_url)?;
    let repo_dir = skill_directory(&skill.name)?;

    if repo_dir.exists() {
        fs::remove_dir_all(&repo_dir).map_err(|error| format!("清理旧 skill 目录失败: {error}"))?;
    }
    let parent_dir = repo_dir
        .parent()
        .ok_or_else(|| "无法确定 skill 目录的父目录".to_string())?;
    fs::create_dir_all(parent_dir).map_err(|error| format!("创建 skill 目录失败: {error}"))?;

    let install_result =
        install_market_skill_into_repo_dir(skill, skill_path, &source_spec, &repo_dir);
    if install_result.is_err() {
        let _ = fs::remove_dir_all(&repo_dir);
    }
    install_result
}

fn install_market_skill_into_repo_dir(
    skill: &SkillSummary,
    skill_path: Option<&str>,
    source_spec: &MarketSourceSpec,
    repo_dir: &Path,
) -> Result<String, String> {
    // 优先使用传入的 skill_path，其次使用从 source_url 解析的 relative_path
    let relative_path = skill_path
        .map(|path| PathBuf::from(path.trim_matches('/')))
        .or(source_spec.relative_path.clone());

    if let Some(path) = relative_path.as_ref() {
        let clone_branch = if skill_path.is_some() {
            None
        } else {
            source_spec.branch.as_deref()
        };
        if let Ok(local_path) = install_sparse_market_skill_dir(
            skill,
            &source_spec.clone_url,
            clone_branch,
            repo_dir,
            path,
        ) {
            return Ok(local_path);
        }
        let _ = fs::remove_dir_all(repo_dir);
        fs::create_dir_all(
            repo_dir
                .parent()
                .ok_or_else(|| "无法确定 skill 目录的父目录".to_string())?,
        )
        .map_err(|error| format!("创建 skill 目录失败: {error}"))?;
    }

    let remote_skill_path =
        resolve_remote_skill_path(&source_spec, relative_path.as_deref(), &skill.name);
    let resolved_relative_path = remote_skill_path
        .as_ref()
        .map(|resolved| resolved.path.clone())
        .or(relative_path);
    let clone_branch = clone_branch_for_resolved_path(remote_skill_path.as_ref(), &source_spec);

    if let Some(path) = resolved_relative_path.as_ref() {
        return install_sparse_market_skill_dir(
            skill,
            &source_spec.clone_url,
            clone_branch,
            repo_dir,
            path,
        );
    } else {
        clone_repo_with_optional_branch(
            &source_spec.clone_url,
            source_spec.branch.as_deref(),
            &repo_dir,
        )?;
    }

    // 忽略非必要文件
    ignore_unnecessary_files(&repo_dir)?;
    Ok(repo_dir.to_string_lossy().to_string())
}

fn install_sparse_market_skill_dir(
    skill: &SkillSummary,
    clone_url: &str,
    clone_branch: Option<&str>,
    repo_dir: &Path,
    relative_path: &Path,
) -> Result<String, String> {
    // 使用 sparse checkout 只拉取 skill 目录；避免大仓库安装时回退为全量克隆。
    let sparse_paths = skill_path_variants(relative_path);
    clone_repo_with_sparse_paths(clone_url, clone_branch, repo_dir, &sparse_paths)?;

    // 找到 skill 子目录，但不移动文件，直接使用子目录作为 skill 目录
    let skill_subdir =
        match resolve_market_skill_source_dir(repo_dir, Some(relative_path), &skill.name) {
            Ok(path) => path,
            Err(original_error) => {
                let fallback_path =
                    resolve_skill_path_from_git_tree(repo_dir, Some(relative_path), &skill.name)
                        .ok_or(original_error)?;
                let sparse_paths = skill_path_variants(&fallback_path);
                let sparse_args = sparse_paths
                    .iter()
                    .map(|path| path.to_string_lossy().to_string())
                    .collect::<Vec<_>>();
                configure_sparse_checkout(repo_dir, &sparse_args, false)?;
                run_git_in_dir(repo_dir, &["checkout", "--quiet"])?;
                resolve_market_skill_source_dir(repo_dir, Some(&fallback_path), &skill.name)?
            }
        };

    // 如果 skill 在子目录中，需要更新 local_path 指向子目录
    if skill_subdir != repo_dir {
        schedule_ignore_unnecessary_files(skill_subdir.clone());
        return Ok(skill_subdir.to_string_lossy().to_string());
    }

    schedule_ignore_unnecessary_files(repo_dir.to_path_buf());
    Ok(repo_dir.to_string_lossy().to_string())
}

#[derive(Debug, Deserialize)]
struct GitHubTreeEntry {
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
}

#[derive(Debug, Deserialize)]
struct GitHubTreeResponse {
    tree: Vec<GitHubTreeEntry>,
}

#[derive(Debug, Deserialize)]
struct GitHubContentsEntry {
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
}

struct ResolvedRemoteSkillPath {
    path: PathBuf,
    branch: Option<String>,
}

fn clone_branch_for_resolved_path<'a>(
    remote_skill_path: Option<&'a ResolvedRemoteSkillPath>,
    source_spec: &'a MarketSourceSpec,
) -> Option<&'a str> {
    match remote_skill_path {
        Some(resolved) => resolved.branch.as_deref(),
        None => source_spec.branch.as_deref(),
    }
}

fn owner_repo_from_clone_url(clone_url: &str) -> Option<String> {
    let trimmed = clone_url.trim().trim_end_matches(".git");
    let parsed = url::Url::parse(trimmed).ok()?;
    if parsed.host_str()? != "github.com" {
        return None;
    }
    let segments = parsed
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.len() < 2 {
        return None;
    }
    Some(format!(
        "{}/{}",
        segments[0].to_lowercase(),
        segments[1].to_lowercase()
    ))
}

fn resolve_remote_skill_path(
    source_spec: &MarketSourceSpec,
    hinted_relative_path: Option<&Path>,
    skill_name: &str,
) -> Option<ResolvedRemoteSkillPath> {
    let owner_repo = owner_repo_from_clone_url(&source_spec.clone_url)?;
    let branch_candidates = remote_branch_candidates(source_spec.branch.as_deref());
    let normalized_skill_name = normalize_slug(skill_name);
    let hinted_paths = hinted_relative_path
        .map(skill_path_variants)
        .unwrap_or_default();

    if !hinted_paths.is_empty() {
        if let Some((branch, path)) =
            first_existing_remote_skill_file(&owner_repo, &branch_candidates, &hinted_paths)
        {
            return Some(ResolvedRemoteSkillPath {
                path,
                branch: branch_for_clone(&branch),
            });
        }
    }

    for branch in &branch_candidates {
        if let Some(found) =
            resolve_remote_skill_path_from_contents(&owner_repo, branch, &hinted_paths, skill_name)
        {
            return Some(ResolvedRemoteSkillPath {
                path: found,
                branch: branch_for_clone(branch),
            });
        }
    }

    for branch in branch_candidates {
        let Ok(skill_dirs) = fetch_remote_skill_dirs(&owner_repo, &branch) else {
            continue;
        };

        for hint in &hinted_paths {
            if skill_dirs.iter().any(|path| path == hint) {
                return Some(ResolvedRemoteSkillPath {
                    path: hint.clone(),
                    branch: branch_for_clone(&branch),
                });
            }
        }

        if let Some(found) = find_skill_dir_by_slug(&skill_dirs, &normalized_skill_name) {
            return Some(ResolvedRemoteSkillPath {
                path: found.clone(),
                branch: branch_for_clone(&branch),
            });
        }

        for hinted_slug in hinted_paths.iter().filter_map(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .map(normalize_slug)
        }) {
            if let Some(found) = find_skill_dir_by_slug(&skill_dirs, &hinted_slug) {
                return Some(ResolvedRemoteSkillPath {
                    path: found.clone(),
                    branch: branch_for_clone(&branch),
                });
            }
        }
    }

    None
}

fn first_existing_remote_skill_file(
    owner_repo: &str,
    branch_candidates: &[String],
    hinted_paths: &[PathBuf],
) -> Option<(String, PathBuf)> {
    let (tx, rx) = mpsc::channel();
    let mut task_count = 0;
    let path_count = hinted_paths.len();

    for (branch_index, branch) in branch_candidates.iter().enumerate() {
        for (path_index, path) in hinted_paths.iter().enumerate() {
            let tx = tx.clone();
            let owner_repo = owner_repo.to_string();
            let branch = branch.clone();
            let path = path.clone();
            task_count += 1;
            thread::spawn(move || {
                let exists = remote_skill_file_exists(&owner_repo, &branch, &path);
                let _ = tx.send((branch_index, path_index, exists, branch, path));
            });
        }
    }
    drop(tx);

    let mut completed = vec![false; task_count];
    let mut matches = vec![None; task_count];
    for _ in 0..task_count {
        let Ok((branch_index, path_index, exists, branch, path)) = rx.recv() else {
            continue;
        };
        let ordered_index = branch_index * path_count + path_index;
        completed[ordered_index] = true;
        if exists {
            matches[ordered_index] = Some((branch, path));
        }
        for (index, is_completed) in completed.iter().enumerate() {
            if let Some(result) = matches[index].clone() {
                return Some(result);
            }
            if !is_completed {
                break;
            }
        }
    }
    None
}

fn resolve_remote_skill_path_from_contents(
    owner_repo: &str,
    branch: &str,
    hinted_paths: &[PathBuf],
    skill_name: &str,
) -> Option<PathBuf> {
    let mut parent_dirs = vec![PathBuf::from("skills")];
    parent_dirs.extend(
        hinted_paths
            .iter()
            .filter_map(|path| path.parent().map(Path::to_path_buf))
            .filter(|path| !path.as_os_str().is_empty()),
    );
    parent_dirs.sort();
    parent_dirs.dedup();

    let wanted_slugs = remote_skill_match_slugs(hinted_paths, skill_name);
    for parent_dir in parent_dirs {
        let Ok(child_dirs) = fetch_remote_child_dirs(owner_repo, branch, &parent_dir) else {
            continue;
        };
        if let Some(found) =
            best_remote_skill_dir_match(owner_repo, branch, child_dirs, &wanted_slugs)
        {
            return Some(found);
        }
    }

    None
}

fn remote_skill_match_slugs(hinted_paths: &[PathBuf], skill_name: &str) -> Vec<String> {
    let mut slugs = Vec::new();
    let normalized_skill_name = normalize_slug(skill_name);
    if !normalized_skill_name.is_empty() {
        slugs.push(normalized_skill_name);
    }
    slugs.extend(hinted_paths.iter().filter_map(|path| {
        path.file_name()
            .and_then(|value| value.to_str())
            .map(normalize_slug)
    }));
    slugs.sort();
    slugs.dedup();
    slugs
}

fn best_remote_skill_dir_match(
    owner_repo: &str,
    branch: &str,
    child_dirs: Vec<PathBuf>,
    wanted_slugs: &[String],
) -> Option<PathBuf> {
    let scored_matches = child_dirs
        .into_iter()
        .filter_map(|path| {
            let score = skill_dir_match_score(&path, wanted_slugs)?;
            Some((score, path))
        })
        .collect::<Vec<_>>();
    let mut matches = existing_remote_skill_dirs(owner_repo, branch, scored_matches);
    matches.sort_by(|(left_score, left_path), (right_score, right_path)| {
        right_score
            .cmp(left_score)
            .then_with(|| left_path.cmp(right_path))
    });

    let (best_score, best_path) = matches.first()?;
    if matches.get(1).is_some_and(|(score, _)| score == best_score) {
        return None;
    }
    Some(best_path.clone())
}

fn existing_remote_skill_dirs(
    owner_repo: &str,
    branch: &str,
    scored_paths: Vec<(u8, PathBuf)>,
) -> Vec<(u8, PathBuf)> {
    let (tx, rx) = mpsc::channel();
    let task_count = scored_paths.len();
    for (score, path) in scored_paths {
        let tx = tx.clone();
        let owner_repo = owner_repo.to_string();
        let branch = branch.to_string();
        thread::spawn(move || {
            let exists = remote_skill_file_exists(&owner_repo, &branch, &path);
            let _ = tx.send((score, path, exists));
        });
    }
    drop(tx);

    let mut existing = Vec::new();
    for _ in 0..task_count {
        let Ok((score, path, exists)) = rx.recv() else {
            continue;
        };
        if exists {
            existing.push((score, path));
        }
    }
    existing
}

fn skill_dir_match_score(path: &Path, wanted_slugs: &[String]) -> Option<u8> {
    let Some(path_slug) = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(normalize_slug)
    else {
        return None;
    };
    wanted_slugs.iter().find_map(|wanted| {
        if wanted == &path_slug {
            Some(100)
        } else if wanted.ends_with(&format!("-{path_slug}")) {
            Some(80)
        } else {
            None
        }
    })
}

fn fetch_remote_child_dirs(
    owner_repo: &str,
    branch: &str,
    parent_dir: &Path,
) -> Result<Vec<PathBuf>, String> {
    let encoded_path = parent_dir
        .to_string_lossy()
        .split('/')
        .map(percent_encode_path_segment)
        .collect::<Vec<_>>()
        .join("/");
    let url = format!(
        "https://api.github.com/repos/{owner_repo}/contents/{encoded_path}?ref={}",
        branch.replace('/', "%2F")
    );
    let entries = fetch_json_with_curl::<Vec<GitHubContentsEntry>>(&url, 12)?;
    let mut child_dirs = entries
        .into_iter()
        .filter(|entry| entry.entry_type == "dir")
        .map(|entry| PathBuf::from(entry.path))
        .collect::<Vec<_>>();
    child_dirs.sort();
    child_dirs.dedup();
    Ok(child_dirs)
}

fn fetch_remote_skill_dirs(owner_repo: &str, branch: &str) -> Result<Vec<PathBuf>, String> {
    let url = format!(
        "https://api.github.com/repos/{owner_repo}/git/trees/{}?recursive=1",
        branch.replace('/', "%2F")
    );
    let tree = fetch_json_with_curl::<GitHubTreeResponse>(&url, 30)?;
    let mut skill_dirs = tree
        .tree
        .into_iter()
        .filter(|entry| entry.entry_type == "blob" && entry.path.ends_with("SKILL.md"))
        .filter_map(|entry| {
            let skill_file = PathBuf::from(entry.path);
            skill_file.parent().map(Path::to_path_buf)
        })
        .collect::<Vec<_>>();
    skill_dirs.sort();
    skill_dirs.dedup();
    Ok(skill_dirs)
}

fn find_skill_dir_by_slug<'a>(skill_dirs: &'a [PathBuf], slug: &str) -> Option<&'a PathBuf> {
    skill_dirs.iter().find(|path| {
        path.file_name()
            .and_then(|value| value.to_str())
            .map(normalize_slug)
            .as_deref()
            == Some(slug)
    })
}

fn remote_branch_candidates(preferred_branch: Option<&str>) -> Vec<String> {
    let mut branches = Vec::new();
    if let Some(branch) = preferred_branch.filter(|value| !value.trim().is_empty()) {
        branches.push(branch.to_string());
    }
    for branch in ["HEAD", "main", "master"] {
        if !branches.iter().any(|existing| existing == branch) {
            branches.push(branch.to_string());
        }
    }
    branches
}

fn branch_for_clone(branch: &str) -> Option<String> {
    if branch == "HEAD" {
        None
    } else {
        Some(branch.to_string())
    }
}

fn remote_skill_file_exists(owner_repo: &str, branch: &str, skill_dir: &Path) -> bool {
    let encoded_path = skill_dir
        .join("SKILL.md")
        .to_string_lossy()
        .split('/')
        .map(percent_encode_path_segment)
        .collect::<Vec<_>>()
        .join("/");
    let url = format!(
        "https://api.github.com/repos/{owner_repo}/contents/{encoded_path}?ref={}",
        branch.replace('/', "%2F")
    );
    Command::new("curl")
        .args([
            "-LsS",
            "--fail",
            "--max-time",
            "6",
            "-o",
            "/dev/null",
            "-H",
            "User-Agent: skilldock/0.1",
            &url,
        ])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn percent_encode_path_segment(segment: &str) -> String {
    segment
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect::<Vec<_>>(),
        })
        .collect()
}

fn fetch_json_with_curl<T: DeserializeOwned>(url: &str, timeout_seconds: u64) -> Result<T, String> {
    let output = Command::new("curl")
        .args([
            "-LsS",
            "--fail",
            "--max-time",
            &timeout_seconds.to_string(),
            "-H",
            "Accept: application/vnd.github.v3+json",
            "-H",
            "User-Agent: skilldock/0.1",
            url,
        ])
        .output()
        .map_err(|error| format!("执行 curl 请求失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "远程请求失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("解析远程 JSON 失败: {error}"))
}

#[allow(dead_code)]
pub fn lift_dir_contents(src: &Path, dst: &Path) -> Result<(), String> {
    let entries = fs::read_dir(src).map_err(|error| format!("读取 skill 子目录失败: {error}"))?;

    // 使用 git mv 移动文件，保持 git 索引正确
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取目录条目失败: {error}"))?;
        let file_name = entry.file_name();
        let dst_path = dst.join(&file_name);
        if dst_path.exists() {
            continue;
        }

        // 计算相对于 dst 的源路径
        let src_relative = src
            .strip_prefix(dst)
            .map_err(|_| format!("无法计算相对路径: src={:?}, dst={:?}", src, dst))?
            .join(&file_name)
            .to_string_lossy()
            .to_string();

        // 使用 git mv 移动文件
        match run_git_in_dir(dst, &["mv", &src_relative, &file_name.to_string_lossy()]) {
            Ok(_) => {}
            Err(e) => {
                // 如果 git mv 失败，回退到文件系统移动
                eprintln!("git mv 失败: {}, 使用文件系统移动", e);
                let src_path = src.join(&file_name);
                fs::rename(&src_path, &dst_path).map_err(|error| {
                    format!(
                        "文件系统移动文件 {} 失败: {error}",
                        file_name.to_string_lossy()
                    )
                })?;
            }
        }
    }

    let mut current = src.to_path_buf();
    while current != *dst {
        let is_empty = fs::read_dir(&current)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false);
        if is_empty {
            let _ = fs::remove_dir(&current);
        }
        match current.parent() {
            Some(p) => current = p.to_path_buf(),
            None => break,
        }
    }

    Ok(())
}

pub fn clone_repo_skill(repo_url: &str, skill_name: &str) -> Result<String, String> {
    let skill_dir = skill_directory(skill_name)?;
    if skill_dir.exists() {
        fs::remove_dir_all(&skill_dir)
            .map_err(|error| format!("清理旧 skill 目录失败: {error}"))?;
    }

    let parent_dir = skill_dir
        .parent()
        .ok_or_else(|| "无法确定 skill 目录的父目录".to_string())?;
    fs::create_dir_all(parent_dir)
        .map_err(|error| format!("创建 skill library 目录失败: {error}"))?;

    // 解析仓库 URL，如果包含 /tree/ 路径，使用 sparse checkout
    let source_spec = parse_market_source_url(repo_url)?;
    if let Some(relative_path) = source_spec.relative_path.as_ref() {
        let mut sparse_paths = vec![relative_path.clone()];
        let fallback_relative_path = PathBuf::from("skills").join(relative_path);
        if *relative_path != fallback_relative_path {
            sparse_paths.push(fallback_relative_path);
        }
        clone_repo_with_sparse_paths(
            &source_spec.clone_url,
            source_spec.branch.as_deref(),
            &skill_dir,
            &sparse_paths,
        )?;

        // 找到 skill 子目录，不移动文件
        let skill_subdir =
            resolve_market_skill_source_dir(&skill_dir, Some(relative_path), skill_name)?;
        if skill_subdir != skill_dir {
            // 忽略非必要文件
            ignore_unnecessary_files(&skill_subdir)?;
            Ok(skill_subdir.to_string_lossy().to_string())
        } else {
            // 忽略非必要文件
            ignore_unnecessary_files(&skill_dir)?;
            Ok(skill_dir.to_string_lossy().to_string())
        }
    } else {
        // 如果 URL 不包含 /tree/ 路径，先克隆整个仓库查找 skill 目录
        clone_repo_with_optional_branch(
            &source_spec.clone_url,
            source_spec.branch.as_deref(),
            &skill_dir,
        )?;

        // 查找 skill 目录
        let skill_subdir = resolve_market_skill_source_dir(&skill_dir, None, skill_name)?;

        if skill_subdir != skill_dir {
            // skill 在子目录中，清理并使用 sparse checkout 重新克隆
            let relative_path = skill_subdir
                .strip_prefix(&skill_dir)
                .map_err(|_| "无法计算 skill 相对路径".to_string())?;

            fs::remove_dir_all(&skill_dir).map_err(|error| format!("清理目录失败: {error}"))?;
            fs::create_dir_all(parent_dir)
                .map_err(|error| format!("创建 skill 目录失败: {error}"))?;

            let mut sparse_paths = vec![relative_path.to_path_buf()];
            let fallback_relative_path = PathBuf::from("skills").join(relative_path);
            if relative_path != fallback_relative_path {
                sparse_paths.push(fallback_relative_path);
            }
            clone_repo_with_sparse_paths(
                &source_spec.clone_url,
                source_spec.branch.as_deref(),
                &skill_dir,
                &sparse_paths,
            )?;

            // 重新查找 skill 子目录并返回
            let new_skill_subdir =
                resolve_market_skill_source_dir(&skill_dir, Some(relative_path), skill_name)?;
            // 忽略非必要文件
            ignore_unnecessary_files(&new_skill_subdir)?;
            Ok(new_skill_subdir.to_string_lossy().to_string())
        } else {
            // skill 在根目录，返回根目录
            // 忽略非必要文件
            ignore_unnecessary_files(&skill_dir)?;
            Ok(skill_dir.to_string_lossy().to_string())
        }
    }
}

pub fn clone_repo_for_discovery(repo_url: &str, repo_key: &str) -> Result<PathBuf, String> {
    clone_repo_for_discovery_with_sparse_paths(repo_url, repo_key, &[])
}

pub fn clone_repo_for_discovery_with_sparse_paths(
    repo_url: &str,
    repo_key: &str,
    sparse_paths: &[String],
) -> Result<PathBuf, String> {
    let repo_dir = repo_cache_directory(repo_key)?;
    if repo_dir.exists() {
        fs::remove_dir_all(&repo_dir).map_err(|error| format!("清理旧仓库缓存失败: {error}"))?;
    }

    let parent_dir = repo_dir
        .parent()
        .ok_or_else(|| "无法确定仓库缓存目录的父目录".to_string())?;
    fs::create_dir_all(parent_dir).map_err(|error| format!("创建仓库缓存目录失败: {error}"))?;

    let clone_result = if sparse_paths.is_empty() {
        clone_repo_into(repo_url, &repo_dir)
    } else {
        let sparse_paths = sparse_paths.iter().map(PathBuf::from).collect::<Vec<_>>();
        clone_repo_with_sparse_paths(repo_url, None, &repo_dir, &sparse_paths)
    };
    if let Err(error) = clone_result {
        let _ = fs::remove_dir_all(&repo_dir);
        return Err(error);
    }
    Ok(repo_dir)
}

pub fn ensure_repo_skill_with_sparse_paths(
    repo_url: &str,
    install_key: &str,
    sparse_paths: &[String],
) -> Result<String, String> {
    let skill_dir = skill_directory(install_key)?;
    if skill_dir.exists() {
        if !skill_dir.is_dir() {
            return Err(format!(
                "目标 skill 工作区已存在且不是目录: {}",
                skill_dir.to_string_lossy()
            ));
        }
        if skill_dir.join(".git").is_dir() {
            if !sparse_paths.is_empty() {
                configure_sparse_checkout(&skill_dir, sparse_paths, true)?;
            }
            // 忽略非必要文件
            ignore_unnecessary_files(&skill_dir)?;
            return Ok(skill_dir.to_string_lossy().to_string());
        }
        fs::remove_dir_all(&skill_dir)
            .map_err(|error| format!("清理旧 skill 目录失败: {error}"))?;
    }

    let parent_dir = skill_dir
        .parent()
        .ok_or_else(|| "无法确定 skill 目录的父目录".to_string())?;
    fs::create_dir_all(parent_dir)
        .map_err(|error| format!("创建 skill library 目录失败: {error}"))?;

    if sparse_paths.is_empty() {
        clone_repo_with_optional_branch(repo_url, None, &skill_dir)?;
    } else {
        let path_bufs = sparse_paths.iter().map(PathBuf::from).collect::<Vec<_>>();
        clone_repo_with_sparse_paths(repo_url, None, &skill_dir, &path_bufs)?;
    }
    // 忽略非必要文件
    ignore_unnecessary_files(&skill_dir)?;
    Ok(skill_dir.to_string_lossy().to_string())
}

pub fn skill_directory(skill_name: &str) -> Result<PathBuf, String> {
    Ok(workspace::managed_workspace_root()?
        .join(SKILL_LIBRARY_DIR)
        .join(skill_name))
}

pub fn repo_cache_directory(repo_key: &str) -> Result<PathBuf, String> {
    Ok(workspace::managed_workspace_root()?
        .join(REPO_CACHE_DIR)
        .join(repo_key))
}

pub fn sanitize_storage_name(name: &str) -> String {
    let mut sanitized = String::with_capacity(name.len());
    let mut last_was_separator = false;

    for character in name.chars() {
        let normalized = if character.is_ascii_alphanumeric() {
            last_was_separator = false;
            character.to_ascii_lowercase()
        } else if !last_was_separator {
            last_was_separator = true;
            '-'
        } else {
            continue;
        };
        sanitized.push(normalized);
    }

    let trimmed = sanitized.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "skill".to_string()
    } else {
        trimmed
    }
}

fn clone_repo_into(source: &str, target_dir: &Path) -> Result<(), String> {
    let mut command = Command::new("git");
    command.args([
        "clone",
        "--depth",
        GIT_CLONE_HISTORY_DEPTH,
        "--single-branch",
        "--no-tags",
        source,
        target_dir.to_string_lossy().as_ref(),
    ]);
    let output = output_with_timeout(command, GIT_NETWORK_TIMEOUT, "git clone")?;

    if !output.status.success() {
        return Err(format!(
            "仓库克隆失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(())
}

fn clone_repo_with_optional_branch(
    source: &str,
    branch: Option<&str>,
    target_dir: &Path,
) -> Result<(), String> {
    let mut command = Command::new("git");
    command.arg("clone");
    command.arg("--depth").arg(GIT_CLONE_HISTORY_DEPTH);
    command.arg("--single-branch");
    command.arg("--no-tags");
    if let Some(branch_name) = branch.filter(|value| !value.trim().is_empty()) {
        command.arg("--branch").arg(branch_name);
    }
    command
        .arg(source)
        .arg(target_dir.to_string_lossy().as_ref());
    let output = output_with_timeout(command, GIT_NETWORK_TIMEOUT, "git clone")?;

    if !output.status.success() {
        return Err(format!(
            "仓库克隆失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(())
}

fn clone_repo_with_sparse_paths(
    source: &str,
    branch: Option<&str>,
    target_dir: &Path,
    sparse_paths: &[PathBuf],
) -> Result<(), String> {
    let mut clone_command = Command::new("git");
    clone_command
        .arg("clone")
        .arg("--filter=blob:none")
        .arg("--depth")
        .arg(GIT_CLONE_HISTORY_DEPTH)
        .arg("--single-branch")
        .arg("--no-tags")
        .arg("--sparse")
        .arg("--no-checkout");
    if let Some(branch_name) = branch.filter(|value| !value.trim().is_empty()) {
        clone_command.arg("--branch").arg(branch_name);
    }
    clone_command
        .arg(source)
        .arg(target_dir.to_string_lossy().as_ref());
    let clone_output = output_with_timeout(clone_command, GIT_NETWORK_TIMEOUT, "git sparse clone")?;
    if !clone_output.status.success() {
        return Err(format!(
            "仓库克隆失败: {}",
            String::from_utf8_lossy(&clone_output.stderr).trim()
        ));
    }

    let sparse_strings = sparse_paths
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    configure_sparse_checkout(target_dir, &sparse_strings, false)?;
    run_git_in_dir(target_dir, &["checkout", "--quiet"])?;
    Ok(())
}

fn configure_sparse_checkout(
    target_dir: &Path,
    sparse_paths: &[String],
    append: bool,
) -> Result<(), String> {
    run_git_in_dir(target_dir, &["sparse-checkout", "init", "--no-cone"])?;

    let mut args = vec![
        "sparse-checkout".to_string(),
        if append {
            "add".to_string()
        } else {
            "set".to_string()
        },
        "--no-cone".to_string(),
    ];
    for path in sparse_paths {
        let normalized = path.trim_matches('/').to_string();
        if normalized.is_empty() {
            continue;
        }
        // 添加路径本身和其所有子目录
        args.push(format!("{normalized}"));
        args.push(format!("{normalized}/**"));
    }
    if args.len() <= 3 {
        return Err("未提供可用的 sparse-checkout 目录".into());
    }
    run_git_in_dir_owned(target_dir, &args)?;
    Ok(())
}

fn run_git_in_dir(target_dir: &Path, args: &[&str]) -> Result<(), String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(target_dir.to_string_lossy().as_ref())
        .args(args);
    let output = output_with_timeout(command, GIT_COMMAND_TIMEOUT, "git 命令")?;
    if !output.status.success() {
        return Err(format!(
            "执行 git 命令失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn run_git_in_dir_owned(target_dir: &Path, args: &[String]) -> Result<(), String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(target_dir.to_string_lossy().as_ref())
        .args(args);
    let output = output_with_timeout(command, GIT_COMMAND_TIMEOUT, "git 命令")?;
    if !output.status.success() {
        return Err(format!(
            "执行 git 命令失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn run_git_output(target_dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(target_dir.to_string_lossy().as_ref())
        .args(args);
    let output = output_with_timeout(command, GIT_COMMAND_TIMEOUT, "git 命令")?;
    if !output.status.success() {
        return Err(format!(
            "执行 git 命令失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn output_with_timeout(
    mut command: Command,
    timeout: Duration,
    label: &str,
) -> Result<Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("执行 {label} 失败: {error}"))?;
    let started_at = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("读取 {label} 输出失败: {error}"));
            }
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{label} 超时，请检查网络后重试"));
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待 {label} 失败: {error}"));
            }
        }
    }
}

fn resolve_market_skill_source_dir(
    repo_root: &Path,
    hinted_relative_path: Option<&Path>,
    skill_name: &str,
) -> Result<PathBuf, String> {
    // 如果有提示路径，先检查该路径
    if let Some(path) = hinted_relative_path {
        for candidate_path in skill_path_variants(path) {
            let hinted_path = repo_root.join(candidate_path);
            if hinted_path.is_dir() && hinted_path.join("SKILL.md").is_file() {
                return Ok(hinted_path);
            }
        }
    }

    // 只在 skills/ 目录下搜索，避免搜索整个大仓库
    let skills_path = repo_root.join("skills");
    if skills_path.is_dir() {
        let mut candidates = Vec::new();
        collect_skill_directories(repo_root, &skills_path, &mut candidates)?;

        if candidates.is_empty() {
            return Err(format!(
                "安装失败：仓库中未找到任何包含 SKILL.md 的目录。指定的 skill '{}' 不存在",
                skill_name
            ));
        }

        let normalized_skill_name = normalize_slug(skill_name);
        let hinted_slug = hinted_relative_path
            .and_then(|path| path.file_name())
            .and_then(|value| value.to_str())
            .map(normalize_slug);

        // 先尝试精确匹配 skill name
        if let Some(best) = candidates
            .iter()
            .find(|candidate| {
                candidate
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(normalize_slug)
                    .as_deref()
                    == Some(normalized_skill_name.as_str())
            })
            .cloned()
        {
            return Ok(best);
        }

        // 尝试匹配提示的路径
        if let Some(hinted) = hinted_slug {
            if let Some(best) = candidates
                .iter()
                .find(|candidate| {
                    candidate
                        .file_name()
                        .and_then(|value| value.to_str())
                        .map(normalize_slug)
                        .as_deref()
                        == Some(hinted.as_str())
                })
                .cloned()
            {
                return Ok(best);
            }
        }

        // 如果只有一个候选，直接返回
        if candidates.len() == 1 {
            return Ok(candidates.remove(0));
        }

        // 列出所有可用的 skill 名称
        let available_skills: Vec<String> = candidates
            .iter()
            .filter_map(|c| c.file_name().and_then(|n| n.to_str()))
            .map(|s| s.to_string())
            .collect();
        let skills_list = available_skills.join(", ");
        return Err(format!(
            "安装失败：仓库中存在多个技能目录，且无法自动匹配目标技能 '{}'。可用的 skills: {}",
            skill_name, skills_list
        ));
    }

    Err(format!(
        "安装失败：仓库中未找到 skills 目录。指定的 skill '{}' 不存在",
        skill_name
    ))
}

fn resolve_skill_path_from_git_tree(
    repo_root: &Path,
    hinted_relative_path: Option<&Path>,
    skill_name: &str,
) -> Option<PathBuf> {
    let tree_output = run_git_output(repo_root, &["ls-tree", "-r", "--name-only", "HEAD"]).ok()?;
    let mut skill_dirs = tree_output
        .lines()
        .filter(|line| line.ends_with("SKILL.md"))
        .filter_map(|line| PathBuf::from(line).parent().map(Path::to_path_buf))
        .collect::<Vec<_>>();
    skill_dirs.sort();
    skill_dirs.dedup();
    if skill_dirs.is_empty() {
        return None;
    }

    let hinted_paths = hinted_relative_path
        .map(skill_path_variants)
        .unwrap_or_default();
    for hint in &hinted_paths {
        if skill_dirs.iter().any(|path| path == hint) {
            return Some(hint.clone());
        }
    }

    let normalized_skill_name = normalize_slug(skill_name);
    if let Some(found) = find_skill_dir_by_slug(&skill_dirs, &normalized_skill_name) {
        return Some(found.clone());
    }

    let wanted_slugs = remote_skill_match_slugs(&hinted_paths, skill_name);
    best_local_skill_dir_match(skill_dirs, &wanted_slugs)
}

fn best_local_skill_dir_match(
    skill_dirs: Vec<PathBuf>,
    wanted_slugs: &[String],
) -> Option<PathBuf> {
    let mut matches = skill_dirs
        .into_iter()
        .filter_map(|path| skill_dir_match_score(&path, wanted_slugs).map(|score| (score, path)))
        .collect::<Vec<_>>();
    matches.sort_by(|(left_score, left_path), (right_score, right_path)| {
        right_score
            .cmp(left_score)
            .then_with(|| left_path.cmp(right_path))
    });

    let (best_score, best_path) = matches.first()?;
    if matches.get(1).is_some_and(|(score, _)| score == best_score) {
        return None;
    }
    Some(best_path.clone())
}

fn skill_path_variants(path: &Path) -> Vec<PathBuf> {
    let normalized = PathBuf::from(path.to_string_lossy().trim_matches('/'));
    let mut variants = vec![normalized.clone()];
    if normalized
        .components()
        .next()
        .and_then(|component| match component {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
        != Some("skills")
    {
        variants.push(PathBuf::from("skills").join(&normalized));
    }
    variants.sort();
    variants.dedup();
    variants
}

#[allow(dead_code)]
fn collect_skill_directories(
    root: &Path,
    current: &Path,
    output: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if current.join("SKILL.md").is_file() {
        output.push(current.to_path_buf());
    }
    let entries = fs::read_dir(current).map_err(|error| format!("读取目录失败: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取目录条目失败: {error}"))?;
        let file_name = entry.file_name();
        if file_name.to_string_lossy() == ".git" {
            continue;
        }
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取文件类型失败: {error}"))?;
        if file_type.is_dir() {
            collect_skill_directories(root, &path, output)?;
        }
    }
    if current == root {
        output.sort();
        output.dedup();
    }
    Ok(())
}

#[allow(dead_code)]
fn normalize_slug(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

#[derive(Debug)]
pub struct MarketSourceSpec {
    pub clone_url: String,
    pub branch: Option<String>,
    pub relative_path: Option<PathBuf>,
}

pub fn parse_market_source_url(source_url: &str) -> Result<MarketSourceSpec, String> {
    let trimmed = source_url.trim().trim_end_matches('/');
    let marker = "/tree/";
    if let Some(tree_index) = trimmed.find(marker) {
        let repo_prefix = &trimmed[..tree_index];
        let tree_suffix = &trimmed[tree_index + marker.len()..];
        let mut segments = tree_suffix.split('/').filter(|part| !part.is_empty());
        let branch = segments
            .next()
            .ok_or_else(|| format!("无法从来源地址解析分支信息: {source_url}"))?;
        let remainder = segments.collect::<Vec<_>>();
        let relative_path = if remainder.is_empty() {
            None
        } else {
            Some(remainder.iter().collect::<PathBuf>())
        };

        return Ok(MarketSourceSpec {
            clone_url: format!("{repo_prefix}.git"),
            branch: Some(branch.to_string()),
            relative_path,
        });
    }

    let clone_url = if trimmed.ends_with(".git") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.git")
    };
    Ok(MarketSourceSpec {
        clone_url,
        branch: None,
        relative_path: None,
    })
}

pub fn create_skill_symlink(
    skill_local_path: &str,
    skill_name: &str,
    tool_skills_path: &str,
) -> Result<(), String> {
    if sync_trace_enabled() {
        eprintln!(
            "[sync-trace] create_skill_symlink skill_name={skill_name} skill_local_path={skill_local_path} tool_skills_path={tool_skills_path}"
        );
    }
    let skill_path = PathBuf::from(skill_local_path);
    let tool_path = PathBuf::from(tool_skills_path);
    let normalized_skill_name = skill_name.trim();
    if normalized_skill_name.is_empty() {
        return Err("无法获取 skill 名称".to_string());
    }
    if is_reserved_workspace_name(normalized_skill_name) {
        return Err(format!(
            "同步失败：{} 是内部保留目录名，不能作为 skill 同步",
            normalized_skill_name
        ));
    }
    if !skill_path.is_dir() || !skill_path.join("SKILL.md").is_file() {
        return Err(format!(
            "同步失败：{} 不是有效的 skill 目录",
            skill_path.to_string_lossy()
        ));
    }
    ensure_managed_skill_sync_source(&skill_path)?;
    if is_reserved_workspace_dir(&skill_path) {
        return Err(format!(
            "同步失败：不能把内部工作区目录 {} 当作 skill 链接",
            skill_path.to_string_lossy()
        ));
    }

    // 确保工具的 skills 目录存在
    if !tool_path.exists() {
        fs::create_dir_all(&tool_path)
            .map_err(|error| format!("创建工具 skills 目录失败: {error}"))?;
    }

    // 旧版本曾用 local_path 的最后一级目录名作为链接名。安装自仓库子目录或缓存路径时，
    // 这可能留下 repo-cache 等错误链接；创建正确链接前先清掉旧链接。
    let legacy_skill_name = skill_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(normalized_skill_name);
    if legacy_skill_name != normalized_skill_name {
        let _ = remove_skill_symlink(tool_skills_path, legacy_skill_name);
    }

    let symlink_path = tool_path.join(normalized_skill_name);

    // 如果同名条目已存在，先按条目类型清理，再创建新的符号链接。
    if symlink_path.exists() || symlink_path.is_symlink() {
        let metadata = fs::symlink_metadata(&symlink_path)
            .map_err(|error| format!("读取现有技能条目失败: {error}"))?;
        if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
            fs::remove_dir_all(&symlink_path)
                .map_err(|error| format!("删除现有技能目录失败: {error}"))?;
        } else {
            fs::remove_file(&symlink_path)
                .map_err(|error| format!("删除现有符号链接失败: {error}"))?;
        }
    }

    // 创建符号链接
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&skill_path, &symlink_path)
            .map_err(|error| format!("创建符号链接失败: {error}"))?;
    }

    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(&skill_path, &symlink_path)
            .map_err(|error| format!("创建符号链接失败: {error}"))?;
    }

    Ok(())
}

fn is_reserved_workspace_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(is_reserved_workspace_name)
}

fn is_reserved_workspace_name(name: &str) -> bool {
    RESERVED_WORKSPACE_LINK_NAMES.contains(&name)
}

fn managed_workspace_root() -> Result<PathBuf, String> {
    workspace::managed_workspace_root()
}

fn managed_skill_library_root() -> Result<PathBuf, String> {
    workspace::managed_skill_library_root()
}

fn ensure_managed_skill_sync_source(skill_path: &Path) -> Result<(), String> {
    let canonical_skill_path = skill_path
        .canonicalize()
        .map_err(|error| format!("解析 skill 目录失败: {error}"))?;
    let canonical_skill_root = managed_skill_library_root()?
        .canonicalize()
        .map_err(|error| format!("解析 skill 库目录失败: {error}"))?;

    if canonical_skill_path == canonical_skill_root
        || !canonical_skill_path.starts_with(&canonical_skill_root)
    {
        return Err(format!(
            "同步失败：只允许同步 {} 下的 skill 目录",
            canonical_skill_root.to_string_lossy()
        ));
    }

    Ok(())
}

fn is_managed_workspace_path(path: &Path) -> bool {
    let Ok(target_path) = path.canonicalize() else {
        return false;
    };
    let Ok(workspace_root) = managed_workspace_root() else {
        return false;
    };
    let Ok(workspace_root) = workspace_root.canonicalize() else {
        return false;
    };

    target_path.starts_with(&workspace_root)
}

fn migrate_legacy_skill_symlink(entry_path: &Path) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(entry_path) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(false),
    };
    if !metadata.file_type().is_symlink() {
        return Ok(false);
    }

    let link_target =
        fs::read_link(entry_path).map_err(|error| format!("读取旧技能链接失败: {error}"))?;
    let normalized_target = normalize_workspace_path(&link_target.to_string_lossy());
    if normalized_target == link_target.to_string_lossy() {
        return Ok(false);
    }

    let replacement_target = PathBuf::from(&normalized_target);
    if !replacement_target.is_dir() || !replacement_target.join("SKILL.md").is_file() {
        return Ok(false);
    }

    fs::remove_file(entry_path).map_err(|error| format!("删除旧技能链接失败: {error}"))?;

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&replacement_target, entry_path)
            .map_err(|error| format!("迁移旧技能链接失败: {error}"))?;
    }

    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(&replacement_target, entry_path)
            .map_err(|error| format!("迁移旧技能链接失败: {error}"))?;
    }

    Ok(true)
}

pub fn migrate_legacy_skill_symlinks(tool_skills_path: &str) -> Result<(), String> {
    let tool_path = PathBuf::from(tool_skills_path);
    if !tool_path.exists() {
        return Ok(());
    }

    let entries =
        fs::read_dir(&tool_path).map_err(|error| format!("读取工具 skills 目录失败: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取工具 skills 条目失败: {error}"))?;
        let entry_path = entry.path();
        let _ = migrate_legacy_skill_symlink(&entry_path)?;
    }

    Ok(())
}

pub fn remove_skill_symlink(tool_skills_path: &str, skill_name: &str) -> Result<(), String> {
    let tool_path = PathBuf::from(tool_skills_path);
    let symlink_path = tool_path.join(skill_name);

    // 如果符号链接存在，删除它
    if symlink_path.exists() || symlink_path.is_symlink() {
        fs::remove_file(&symlink_path).map_err(|error| format!("删除符号链接失败: {error}"))?;
    }

    Ok(())
}

pub fn remove_reserved_workspace_entries(tool_skills_path: &str) -> Result<(), String> {
    if sync_trace_enabled() {
        eprintln!(
            "[sync-trace] remove_reserved_workspace_symlinks tool_skills_path={tool_skills_path}"
        );
    }
    let tool_path = PathBuf::from(tool_skills_path);
    if !tool_path.exists() {
        return Ok(());
    }
    let entries =
        fs::read_dir(&tool_path).map_err(|error| format!("读取工具 skills 目录失败: {error}"))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("读取工具 skills 条目失败: {error}"))?;
        let entry_path = entry.path();

        let entry_name = entry_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let should_remove = is_reserved_workspace_name(entry_name)
            || (entry_path.is_symlink() && is_reserved_workspace_symlink_target(&entry_path));
        if should_remove {
            if sync_trace_enabled() {
                eprintln!(
                    "[sync-trace] removing_reserved_entry entry_path={}",
                    entry_path.to_string_lossy()
                );
            }
            remove_reserved_workspace_entry(&entry_path)?;
        }
    }
    Ok(())
}

fn remove_reserved_workspace_entry(entry_path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(entry_path)
        .map_err(|error| format!("读取内部工作区错误条目失败: {error}"))?;
    let file_type = metadata.file_type();

    if file_type.is_symlink() || file_type.is_file() {
        fs::remove_file(entry_path).map_err(|error| format!("删除内部工作区错误链接失败: {error}"))
    } else if file_type.is_dir() {
        fs::remove_dir_all(entry_path)
            .map_err(|error| format!("删除内部工作区错误目录失败: {error}"))
    } else {
        fs::remove_file(entry_path).map_err(|error| format!("删除内部工作区错误条目失败: {error}"))
    }
}

fn is_reserved_workspace_symlink_target(symlink_path: &Path) -> bool {
    let Ok(target_path) = symlink_path.canonicalize() else {
        return false;
    };
    let Ok(workspace_root) = managed_workspace_root() else {
        return false;
    };
    [
        workspace_root.join("cache"),
        workspace_root.join("repo-cache"),
        workspace_root.join("skills"),
        workspace_root.join("imports"),
    ]
    .into_iter()
    .filter_map(|path| path.canonicalize().ok())
    .any(|reserved_target| target_path == reserved_target)
}

pub fn reconcile_tool_skill_symlinks(
    tool_skills_path: &str,
    enabled_skills: &[SkillSummary],
) -> Result<(), String> {
    if sync_trace_enabled() {
        let enabled_skill_names = enabled_skills
            .iter()
            .map(|skill| skill.name.as_str())
            .collect::<Vec<_>>();
        eprintln!(
            "[sync-trace] reconcile_tool_skill_symlinks tool_skills_path={tool_skills_path} enabled_skills={enabled_skill_names:?}"
        );
    }
    let tool_path = PathBuf::from(tool_skills_path);
    if !tool_path.exists() {
        fs::create_dir_all(&tool_path)
            .map_err(|error| format!("创建工具 skills 目录失败: {error}"))?;
    }
    migrate_legacy_skill_symlinks(tool_skills_path)?;

    let expected_skill_names = enabled_skills
        .iter()
        .map(|skill| skill.name.as_str())
        .collect::<std::collections::HashSet<_>>();

    let entries =
        fs::read_dir(&tool_path).map_err(|error| format!("读取工具 skills 目录失败: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取工具 skills 条目失败: {error}"))?;
        let symlink_path = entry.path();
        if !symlink_path.is_symlink() || !is_managed_workspace_path(&symlink_path) {
            continue;
        }

        let entry_name = symlink_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !expected_skill_names.contains(entry_name) {
            fs::remove_file(&symlink_path)
                .map_err(|error| format!("删除多余的技能链接失败: {error}"))?;
        }
    }

    for skill in enabled_skills {
        create_skill_symlink(&skill.local_path, &skill.name, tool_skills_path)?;
    }

    Ok(())
}

pub fn get_tool_skills_path(tool_id: &str) -> Result<String, String> {
    let home_dir = env::var("HOME").map_err(|_| "无法读取 HOME 环境变量".to_string())?;
    let home_path = PathBuf::from(&home_dir);

    let skills_path = match tool_id {
        "claude-code" => home_path.join(".claude/skills"),
        "codex" => home_path.join(".codex/skills"),
        "opencode" => home_path.join(".config/opencode/skills"),
        "cursor" => home_path.join(".cursor/skills"),
        "gemini" => home_path.join(".gemini/skills"),
        "antigravity" => home_path.join(".gemini/antigravity/skills"),
        "windsurf" => home_path.join(".codeium/windsurf/skills"),
        "intellij" => home_path.join(".intellij/skills"),
        "openclaw" => home_path.join(".openclaw/skills"),
        "continue" => home_path.join(".continue/skills"),
        "iflow" => home_path.join(".iflow/skills"),
        "codebuddy" => home_path.join(".codebuddy/skills"),
        "trae" => home_path.join(".trae/skills"),
        "droid" => home_path.join(".factory/skills"),
        "augment" => home_path.join(".augment/skills"),
        "cline" => home_path.join(".cline/skills"),
        "commandcode" => home_path.join(".commandcode/skills"),
        "crush" => home_path.join(".config/crush/skills"),
        "goose" => home_path.join(".config/goose/skills"),
        "junie" => home_path.join(".junie/skills"),
        "kilo-code" => home_path.join(".kilocode/skills"),
        "kiro" => home_path.join(".kiro/skills"),
        "qoder" => home_path.join(".qoder/skills"),
        "qwen-code" => home_path.join(".qwen/skills"),
        "roo-code" => home_path.join(".roo/skills"),
        "zencoder" => home_path.join(".zencoder/skills"),
        "trae-cn" => home_path.join(".trae-cn/skills"),
        "hermes" => home_path.join(".hermes/skills"),
        "github-copilot" => home_path.join(".copilot/skills"),
        _ => return Err(format!("未知的工具 ID: {tool_id}")),
    };

    Ok(skills_path.to_string_lossy().to_string())
}

fn tool_ids() -> [&'static str; 29] {
    [
        "claude-code",
        "codex",
        "opencode",
        "cursor",
        "gemini",
        "antigravity",
        "windsurf",
        "intellij",
        "openclaw",
        "continue",
        "iflow",
        "codebuddy",
        "trae",
        "droid",
        "augment",
        "cline",
        "commandcode",
        "crush",
        "goose",
        "junie",
        "kilo-code",
        "kiro",
        "qoder",
        "qwen-code",
        "roo-code",
        "zencoder",
        "trae-cn",
        "hermes",
        "github-copilot",
    ]
}

pub fn remove_skill_symlinks_from_all_tools(skill_name: &str) -> Result<(), String> {
    for tool_id in tool_ids() {
        if let Ok(tool_skills_path) = get_tool_skills_path(tool_id) {
            // 忽略错误，因为某些工具可能没有安装或目录不存在
            let _ = remove_skill_symlink(&tool_skills_path, skill_name);
        }
    }

    Ok(())
}

pub fn remove_reserved_workspace_symlinks_from_all_tools() -> Result<(), String> {
    for tool_id in tool_ids() {
        if let Ok(tool_skills_path) = get_tool_skills_path(tool_id) {
            let _ = migrate_legacy_skill_symlinks(&tool_skills_path);
            let _ = remove_reserved_workspace_entries(&tool_skills_path);
        }
    }

    Ok(())
}

pub fn migrate_legacy_skill_symlinks_from_all_tools() -> Result<(), String> {
    for tool_id in tool_ids() {
        if let Ok(tool_skills_path) = get_tool_skills_path(tool_id) {
            let _ = migrate_legacy_skill_symlinks(&tool_skills_path);
        }
    }

    Ok(())
}

fn ignore_unnecessary_files(skill_dir: &Path) -> Result<(), String> {
    // 定义需要忽略的文件和目录
    let ignore_patterns = [
        ".DS_Store",
        "Thumbs.db",
        "settings.json",
        "*.swp",
        "*.swo",
        ".vscode",
        ".idea",
        "*.log",
    ];

    let Some(repo_root) = git_worktree_root(skill_dir) else {
        return Ok(());
    };

    let exclude_path = repo_root.join(".git/info/exclude");
    let mut existing_content = String::new();

    // 读取现有的 exclude 内容
    if exclude_path.exists() {
        existing_content = fs::read_to_string(&exclude_path)
            .map_err(|error| format!("读取 .git/info/exclude 失败: {error}"))?;
    }

    // 添加新的忽略模式
    let mut new_content = existing_content.clone();
    for pattern in &ignore_patterns {
        if !existing_content.contains(pattern) {
            if !new_content.is_empty() && !new_content.ends_with('\n') {
                new_content.push('\n');
            }
            new_content.push_str(pattern);
            new_content.push('\n');
        }
    }

    // 写入 .git/info/exclude
    fs::write(&exclude_path, new_content)
        .map_err(|error| format!("写入 .git/info/exclude 失败: {error}"))?;

    let ignored_paths = ignore_patterns
        .iter()
        .map(|pattern| pattern.trim_start_matches('/'))
        .filter(|pattern| !pattern.is_empty())
        .collect::<Vec<_>>();
    if !ignored_paths.is_empty() {
        let mut args = vec!["rm", "--cached", "-r", "--ignore-unmatch"];
        args.extend(ignored_paths);
        let _ = run_git_in_dir(&repo_root, &args);
    }

    Ok(())
}

fn schedule_ignore_unnecessary_files(skill_dir: PathBuf) {
    thread::spawn(move || {
        let _ = ignore_unnecessary_files(&skill_dir);
    });
}

fn git_worktree_root(path: &Path) -> Option<PathBuf> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path.to_string_lossy().as_ref())
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        None
    } else {
        Some(PathBuf::from(root))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        clone_branch_for_resolved_path, create_skill_symlink, migrate_legacy_skill_symlinks,
        reconcile_tool_skill_symlinks, remove_reserved_workspace_entries, skill_dir_match_score,
        MarketSourceSpec, ResolvedRemoteSkillPath,
    };
    use crate::models::SkillSummary;
    use crate::workspace::TEST_ENV_LOCK;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(label: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be available")
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!(
            "skilldock-library-test-{label}-{}-{}",
            std::process::id(),
            timestamp
        ));
        fs::create_dir_all(&temp_dir).expect("create temp test dir");
        temp_dir
    }

    #[test]
    fn resolved_default_branch_does_not_fall_back_to_source_branch_hint() {
        let source_spec = MarketSourceSpec {
            clone_url: "https://github.com/aaaaqwq/claude-code-skills.git".into(),
            branch: Some("main".into()),
            relative_path: Some(PathBuf::from("multi-search-engine")),
        };
        let remote_skill_path = ResolvedRemoteSkillPath {
            path: PathBuf::from("skills/multi-search-engine"),
            branch: None,
        };

        assert_eq!(
            clone_branch_for_resolved_path(Some(&remote_skill_path), &source_spec),
            None
        );
    }

    #[test]
    fn skill_slug_can_match_repository_specific_prefix() {
        assert_eq!(
            skill_dir_match_score(
                &PathBuf::from("skills/react-best-practices"),
                &["vercel-react-best-practices".into()]
            ),
            Some(80)
        );
    }

    #[test]
    fn shorter_ambiguous_market_slug_does_not_match_longer_directory() {
        assert_eq!(
            skill_dir_match_score(
                &PathBuf::from("skills/react-best-practices"),
                &["best-practices".into()]
            ),
            None
        );
    }

    #[test]
    fn create_skill_symlink_rejects_reserved_workspace_name() {
        let temp_dir = temp_test_dir("reserved-symlink");
        let source_skill_dir = temp_dir.join("source-skill");
        let tool_skills_dir = temp_dir.join("tool-skills");
        fs::create_dir_all(&source_skill_dir).expect("create source skill dir");
        fs::write(source_skill_dir.join("SKILL.md"), "# source-skill").expect("write SKILL.md");
        fs::create_dir_all(&tool_skills_dir).expect("create tool skills dir");

        let error = create_skill_symlink(
            source_skill_dir.to_string_lossy().as_ref(),
            "skills",
            tool_skills_dir.to_string_lossy().as_ref(),
        )
        .expect_err("reserved workspace name should be rejected");

        assert!(error.contains("内部保留目录名"));
        assert!(!tool_skills_dir.join("skills").exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn create_skill_symlink_rejects_source_outside_managed_skill_root() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_dir = temp_test_dir("external-symlink");
        let home_dir = temp_dir.join("home");
        let external_skill_dir = temp_dir.join("external-skill");
        let tool_skills_dir = temp_dir.join("tool-skills");
        fs::create_dir_all(home_dir.join(".skilldock/skills")).expect("create managed skill root");
        fs::create_dir_all(&external_skill_dir).expect("create external skill dir");
        fs::write(external_skill_dir.join("SKILL.md"), "# external-skill").expect("write SKILL.md");
        fs::create_dir_all(&tool_skills_dir).expect("create tool skills dir");

        let original_home = std::env::var_os("HOME");
        // SAFETY: test restores HOME before exit and runs in-process only for this case.
        unsafe {
            std::env::set_var("HOME", &home_dir);
        }

        let error = create_skill_symlink(
            external_skill_dir.to_string_lossy().as_ref(),
            "external-skill",
            tool_skills_dir.to_string_lossy().as_ref(),
        )
        .expect_err("external skill path should be rejected");

        assert!(error.contains("只允许同步"));
        assert!(!tool_skills_dir.join("external-skill").exists());

        if let Some(home) = original_home {
            // SAFETY: restore HOME after the test mutation above.
            unsafe {
                std::env::set_var("HOME", home);
            }
        } else {
            // SAFETY: restore HOME after the test mutation above.
            unsafe {
                std::env::remove_var("HOME");
            }
        }
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn remove_reserved_workspace_symlinks_drops_managed_workspace_links() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_dir = temp_test_dir("reserved-cleanup");
        let home_dir = temp_dir.join("home");
        let tool_skills_dir = temp_dir.join("tool-skills");
        fs::create_dir_all(home_dir.join(".skilldock/cache")).expect("create cache dir");
        fs::create_dir_all(home_dir.join(".skilldock/repo-cache")).expect("create repo-cache dir");
        fs::create_dir_all(home_dir.join(".skilldock/skills")).expect("create skills dir");
        fs::create_dir_all(home_dir.join(".skilldock/imports")).expect("create imports dir");
        fs::create_dir_all(&tool_skills_dir).expect("create tool skills dir");
        fs::create_dir_all(tool_skills_dir.join("imports").join("stale"))
            .expect("create imports directory");
        fs::write(tool_skills_dir.join("state.json"), "{}").expect("write state.json");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                home_dir.join(".skilldock/cache"),
                tool_skills_dir.join("cache"),
            )
            .expect("create cache symlink");
            std::os::unix::fs::symlink(
                home_dir.join(".skilldock/repo-cache"),
                tool_skills_dir.join("repo-cache"),
            )
            .expect("create repo-cache symlink");
            std::os::unix::fs::symlink(
                home_dir.join(".skilldock/skills"),
                tool_skills_dir.join("skills"),
            )
            .expect("create skills symlink");
        }

        let original_home = std::env::var_os("HOME");
        // SAFETY: test restores HOME before exit and runs in-process only for this case.
        unsafe {
            std::env::set_var("HOME", &home_dir);
        }

        remove_reserved_workspace_entries(tool_skills_dir.to_string_lossy().as_ref())
            .expect("remove reserved symlinks");

        assert!(!tool_skills_dir.join("cache").exists());
        assert!(!tool_skills_dir.join("repo-cache").exists());
        assert!(!tool_skills_dir.join("skills").exists());
        assert!(!tool_skills_dir.join("imports").exists());
        assert!(!tool_skills_dir.join("state.json").exists());

        if let Some(home) = original_home {
            // SAFETY: restore HOME after the test mutation above.
            unsafe {
                std::env::set_var("HOME", home);
            }
        } else {
            // SAFETY: restore HOME after the test mutation above.
            unsafe {
                std::env::remove_var("HOME");
            }
        }
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn migrate_legacy_skill_symlinks_retargets_skilldock_workspace() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_dir = temp_test_dir("migrate-legacy-symlink");
        let home_dir = temp_dir.join("home");
        let tool_skills_dir = temp_dir.join("tool-skills");
        let current_skill_dir = home_dir.join(".skilldock/skills/demo-skill");
        fs::create_dir_all(&current_skill_dir).expect("create managed skill dir");
        fs::write(current_skill_dir.join("SKILL.md"), "# demo-skill").expect("write SKILL.md");
        fs::create_dir_all(&tool_skills_dir).expect("create tool skills dir");

        #[cfg(unix)]
        std::os::unix::fs::symlink(
            home_dir.join(".skillm/skills/demo-skill"),
            tool_skills_dir.join("demo-skill"),
        )
        .expect("create legacy symlink");

        let original_home = std::env::var_os("HOME");
        unsafe {
            std::env::set_var("HOME", &home_dir);
        }

        migrate_legacy_skill_symlinks(tool_skills_dir.to_string_lossy().as_ref())
            .expect("migrate legacy skill symlinks");

        assert_eq!(
            tool_skills_dir
                .join("demo-skill")
                .canonicalize()
                .expect("canonicalize migrated symlink"),
            current_skill_dir
                .canonicalize()
                .expect("canonicalize managed skill dir")
        );

        if let Some(home) = original_home {
            unsafe {
                std::env::set_var("HOME", home);
            }
        } else {
            unsafe {
                std::env::remove_var("HOME");
            }
        }
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn reconcile_tool_skill_symlinks_removes_unmanaged_workspace_entries() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_dir = temp_test_dir("reconcile-tool-skills");
        let home_dir = temp_dir.join("home");
        let tool_skills_dir = temp_dir.join("tool-skills");
        let kept_skill_dir = home_dir.join(".skilldock/skills/kept-skill");
        let stale_skill_dir = home_dir.join(".skilldock/skills/stale-skill");
        let external_skill_dir = temp_dir.join("external-skill");
        fs::create_dir_all(&kept_skill_dir).expect("create kept skill dir");
        fs::create_dir_all(&stale_skill_dir).expect("create stale skill dir");
        fs::create_dir_all(home_dir.join(".skilldock/cache")).expect("create cache dir");
        fs::create_dir_all(&external_skill_dir).expect("create external skill dir");
        fs::create_dir_all(&tool_skills_dir).expect("create tool skills dir");
        fs::write(kept_skill_dir.join("SKILL.md"), "# kept-skill").expect("write kept SKILL");
        fs::write(stale_skill_dir.join("SKILL.md"), "# stale-skill").expect("write stale SKILL");
        fs::write(external_skill_dir.join("SKILL.md"), "# external-skill")
            .expect("write external SKILL");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&kept_skill_dir, tool_skills_dir.join("kept-skill"))
                .expect("create kept symlink");
            std::os::unix::fs::symlink(&stale_skill_dir, tool_skills_dir.join("stale-skill"))
                .expect("create stale symlink");
            std::os::unix::fs::symlink(
                home_dir.join(".skilldock/cache"),
                tool_skills_dir.join("cache"),
            )
            .expect("create cache symlink");
            std::os::unix::fs::symlink(&external_skill_dir, tool_skills_dir.join("external-skill"))
                .expect("create external symlink");
        }

        let original_home = std::env::var_os("HOME");
        // SAFETY: test restores HOME after the temporary override.
        unsafe {
            std::env::set_var("HOME", &home_dir);
        }

        reconcile_tool_skill_symlinks(
            tool_skills_dir.to_string_lossy().as_ref(),
            &[SkillSummary {
                name: "kept-skill".into(),
                source_label: "GitHub".into(),
                source_type: "github".into(),
                source_url: "https://github.com/demo/kept-skill".into(),
                description: "kept".into(),
                local_path: kept_skill_dir.to_string_lossy().to_string(),
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
                tools: vec![],
            }],
        )
        .expect("reconcile tool skill symlinks");

        assert!(tool_skills_dir.join("kept-skill").exists());
        assert!(!tool_skills_dir.join("stale-skill").exists());
        assert!(!tool_skills_dir.join("cache").exists());
        assert!(tool_skills_dir.join("external-skill").exists());

        if let Some(home) = original_home {
            // SAFETY: restore HOME after the test mutation above.
            unsafe {
                std::env::set_var("HOME", home);
            }
        } else {
            // SAFETY: restore HOME after the test mutation above.
            unsafe {
                std::env::remove_var("HOME");
            }
        }
        let _ = fs::remove_dir_all(temp_dir);
    }
}
