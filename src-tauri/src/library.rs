use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::models::SkillSummary;
use serde::de::DeserializeOwned;
use serde::Deserialize;

const SKILL_LIBRARY_DIR: &str = ".skillm/skills";
const REPO_CACHE_DIR: &str = ".skillm/repo-cache";
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

    // 优先使用传入的 skill_path，其次使用从 source_url 解析的 relative_path
    let relative_path = skill_path
        .map(|path| PathBuf::from(path.trim_matches('/')))
        .or(source_spec.relative_path.clone());
    let remote_skill_path =
        resolve_remote_skill_path(&source_spec, relative_path.as_deref(), &skill.name);
    let resolved_relative_path = remote_skill_path
        .as_ref()
        .map(|resolved| resolved.path.clone())
        .or(relative_path);
    let clone_branch = remote_skill_path
        .as_ref()
        .and_then(|resolved| resolved.branch.as_deref())
        .or(source_spec.branch.as_deref());

    if let Some(path) = resolved_relative_path.as_ref() {
        // 使用 sparse checkout 只拉取 skill 目录；避免大仓库安装时回退为全量克隆。
        let sparse_paths = skill_path_variants(path);
        clone_repo_with_sparse_paths(
            &source_spec.clone_url,
            clone_branch,
            &repo_dir,
            &sparse_paths,
        )?;

        // 找到 skill 子目录，但不移动文件，直接使用子目录作为 skill 目录
        let skill_subdir = resolve_market_skill_source_dir(
            &repo_dir,
            resolved_relative_path.as_deref(),
            &skill.name,
        )?;

        // 如果 skill 在子目录中，需要更新 local_path 指向子目录
        if skill_subdir != repo_dir {
            // 忽略非必要文件
            ignore_unnecessary_files(&skill_subdir)?;
            return Ok(skill_subdir.to_string_lossy().to_string());
        }
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

struct ResolvedRemoteSkillPath {
    path: PathBuf,
    branch: Option<String>,
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
        for branch in &branch_candidates {
            for path in &hinted_paths {
                if remote_skill_file_exists(&owner_repo, branch, path) {
                    return Some(ResolvedRemoteSkillPath {
                        path: path.clone(),
                        branch: branch_for_clone(branch),
                    });
                }
            }
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
            "User-Agent: skillm/0.1",
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
            "User-Agent: skillm/0.1",
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
    let home_dir = env::var("HOME").map_err(|_| "无法读取 HOME 环境变量".to_string())?;
    Ok(PathBuf::from(home_dir)
        .join(SKILL_LIBRARY_DIR)
        .join(skill_name))
}

pub fn repo_cache_directory(repo_key: &str) -> Result<PathBuf, String> {
    let home_dir = env::var("HOME").map_err(|_| "无法读取 HOME 环境变量".to_string())?;
    Ok(PathBuf::from(home_dir).join(REPO_CACHE_DIR).join(repo_key))
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
    let output = Command::new("git")
        .args([
            "clone",
            "--depth",
            "1",
            source,
            target_dir.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|error| format!("执行 git clone 失败: {error}"))?;

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
    if let Some(branch_name) = branch.filter(|value| !value.trim().is_empty()) {
        command.arg("--branch").arg(branch_name);
    }
    let output = command
        .arg(source)
        .arg(target_dir.to_string_lossy().as_ref())
        .output()
        .map_err(|error| format!("执行 git clone 失败: {error}"))?;

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
        .arg("--depth=1")
        .arg("--sparse")
        .arg("--no-checkout");
    if let Some(branch_name) = branch.filter(|value| !value.trim().is_empty()) {
        clone_command.arg("--branch").arg(branch_name);
    }
    let clone_output = clone_command
        .arg(source)
        .arg(target_dir.to_string_lossy().as_ref())
        .output()
        .map_err(|error| format!("执行 git sparse clone 失败: {error}"))?;
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
    let output = Command::new("git")
        .arg("-C")
        .arg(target_dir.to_string_lossy().as_ref())
        .args(args)
        .output()
        .map_err(|error| format!("执行 git 命令失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "执行 git 命令失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn run_git_in_dir_owned(target_dir: &Path, args: &[String]) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(target_dir.to_string_lossy().as_ref())
        .args(args)
        .output()
        .map_err(|error| format!("执行 git 命令失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "执行 git 命令失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
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

pub fn create_skill_symlink(skill_local_path: &str, tool_skills_path: &str) -> Result<(), String> {
    let skill_path = PathBuf::from(skill_local_path);
    let tool_path = PathBuf::from(tool_skills_path);
    
    // 确保工具的 skills 目录存在
    if !tool_path.exists() {
        fs::create_dir_all(&tool_path)
            .map_err(|error| format!("创建工具 skills 目录失败: {error}"))?;
    }
    
    // 获取 skill 目录名
    let skill_name = skill_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "无法获取 skill 目录名".to_string())?;
    
    let symlink_path = tool_path.join(skill_name);
    
    // 如果符号链接已存在，先删除
    if symlink_path.exists() || symlink_path.is_symlink() {
        fs::remove_file(&symlink_path)
            .map_err(|error| format!("删除现有符号链接失败: {error}"))?;
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

pub fn remove_skill_symlink(tool_skills_path: &str, skill_name: &str) -> Result<(), String> {
    let tool_path = PathBuf::from(tool_skills_path);
    let symlink_path = tool_path.join(skill_name);
    
    // 如果符号链接存在，删除它
    if symlink_path.exists() || symlink_path.is_symlink() {
        fs::remove_file(&symlink_path)
            .map_err(|error| format!("删除符号链接失败: {error}"))?;
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

pub fn remove_skill_symlinks_from_all_tools(skill_name: &str) -> Result<(), String> {
    let tool_ids = vec![
        "claude-code", "codex", "opencode", "cursor", "gemini", "antigravity",
        "windsurf", "openclaw", "continue", "iflow", "codebuddy", "trae",
        "droid", "augment", "cline", "commandcode", "crush", "goose",
        "junie", "kilo-code", "kiro", "qoder", "qwen-code", "roo-code",
        "zencoder", "trae-cn", "hermes", "github-copilot",
    ];

    for tool_id in tool_ids {
        if let Ok(tool_skills_path) = get_tool_skills_path(tool_id) {
            // 忽略错误，因为某些工具可能没有安装或目录不存在
            let _ = remove_skill_symlink(&tool_skills_path, skill_name);
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

    // 从 git 索引中移除匹配的已跟踪文件
    // 对于目录模式，需要递归查找并移除
    for pattern in &ignore_patterns {
        let pattern_without_slash = pattern.trim_start_matches('/');

        if pattern.ends_with('/') || *pattern == ".vscode" || *pattern == ".idea" {
            // 处理目录
            let dir_path = repo_root.join(pattern_without_slash);
            if dir_path.is_dir() {
                let _ =
                    run_git_in_dir(&repo_root, &["rm", "--cached", "-r", pattern_without_slash]);
            }
        } else if pattern.contains('*') {
            // 处理通配符模式
            let _ = run_git_in_dir(&repo_root, &["rm", "--cached", pattern_without_slash]);
        } else {
            // 处理具体文件
            let file_path = repo_root.join(pattern_without_slash);
            if file_path.exists() {
                let _ = run_git_in_dir(&repo_root, &["rm", "--cached", pattern_without_slash]);
            }
        }
    }

    Ok(())
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
