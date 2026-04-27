use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::models::SkillSummary;

const SKILL_LIBRARY_DIR: &str = ".skillm/skills";
const REPO_CACHE_DIR: &str = ".skillm/repo-cache";

pub fn install_market_skill_from_source(skill: &SkillSummary, skill_path: Option<&str>) -> Result<String, String> {
    let source_spec = parse_market_source_url(&skill.source_url)?;
    let repo_dir = skill_directory(&skill.name)?;

    if repo_dir.exists() {
        fs::remove_dir_all(&repo_dir)
            .map_err(|error| format!("清理旧 skill 目录失败: {error}"))?;
    }
    let parent_dir = repo_dir
        .parent()
        .ok_or_else(|| "无法确定 skill 目录的父目录".to_string())?;
    fs::create_dir_all(parent_dir)
        .map_err(|error| format!("创建 skill 目录失败: {error}"))?;

    // 优先使用传入的 skill_path，其次使用从 source_url 解析的 relative_path
    let relative_path = skill_path
        .map(|path| PathBuf::from(path.trim_matches('/')))
        .or(source_spec.relative_path.clone());

    if let Some(path) = relative_path.as_ref() {
        // 使用 sparse checkout 只拉取 skill 目录
        let mut sparse_paths = vec![path.clone()];
        let fallback_relative_path = PathBuf::from("skills").join(path);
        if *path != fallback_relative_path {
            sparse_paths.push(fallback_relative_path);
        }
        clone_repo_with_sparse_paths(
            &source_spec.clone_url,
            source_spec.branch.as_deref(),
            &repo_dir,
            &sparse_paths,
        )?;

        // 找到 skill 子目录，但不移动文件，直接使用子目录作为 skill 目录
        let skill_subdir = resolve_market_skill_source_dir(
            &repo_dir,
            relative_path.as_deref(),
            &skill.name,
        )?;

        // 如果 skill 在子目录中，需要更新 local_path 指向子目录
        if skill_subdir != repo_dir {
            return Ok(skill_subdir.to_string_lossy().to_string());
        }
    } else {
        clone_repo_with_optional_branch(
            &source_spec.clone_url,
            source_spec.branch.as_deref(),
            &repo_dir,
        )?;
    }

    Ok(repo_dir.to_string_lossy().to_string())
}

pub fn lift_dir_contents(src: &Path, dst: &Path) -> Result<(), String> {
    let entries = fs::read_dir(src)
        .map_err(|error| format!("读取 skill 子目录失败: {error}"))?;

    // 使用 git mv 移动文件，保持 git 索引正确
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取目录条目失败: {error}"))?;
        let file_name = entry.file_name();
        let dst_path = dst.join(&file_name);
        if dst_path.exists() {
            continue;
        }

        // 计算相对于 dst 的源路径
        let src_relative = src.strip_prefix(dst)
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
                fs::rename(&src_path, &dst_path)
                    .map_err(|error| format!("文件系统移动文件 {} 失败: {error}", file_name.to_string_lossy()))?;
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
        let skill_subdir = resolve_market_skill_source_dir(&skill_dir, Some(relative_path), skill_name)?;
        if skill_subdir != skill_dir {
            Ok(skill_subdir.to_string_lossy().to_string())
        } else {
            Ok(skill_dir.to_string_lossy().to_string())
        }
    } else {
        // 如果 URL 不包含 /tree/ 路径，先克隆整个仓库查找 skill 目录
        clone_repo_with_optional_branch(&source_spec.clone_url, source_spec.branch.as_deref(), &skill_dir)?;

        // 查找 skill 目录
        let skill_subdir = resolve_market_skill_source_dir(&skill_dir, None, skill_name)?;

        if skill_subdir != skill_dir {
            // skill 在子目录中，清理并使用 sparse checkout 重新克隆
            let relative_path = skill_subdir.strip_prefix(&skill_dir)
                .map_err(|_| "无法计算 skill 相对路径".to_string())?;

            fs::remove_dir_all(&skill_dir)
                .map_err(|error| format!("清理目录失败: {error}"))?;
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
            let new_skill_subdir = resolve_market_skill_source_dir(&skill_dir, Some(relative_path), skill_name)?;
            Ok(new_skill_subdir.to_string_lossy().to_string())
        } else {
            // skill 在根目录，返回根目录
            Ok(skill_dir.to_string_lossy().to_string())
        }
    }
}

pub fn clone_repo_for_discovery(repo_url: &str, repo_key: &str) -> Result<PathBuf, String> {
    let repo_dir = repo_cache_directory(repo_key)?;
    if repo_dir.exists() {
        fs::remove_dir_all(&repo_dir).map_err(|error| format!("清理旧仓库缓存失败: {error}"))?;
    }

    let parent_dir = repo_dir
        .parent()
        .ok_or_else(|| "无法确定仓库缓存目录的父目录".to_string())?;
    fs::create_dir_all(parent_dir).map_err(|error| format!("创建仓库缓存目录失败: {error}"))?;

    clone_repo_into(repo_url, &repo_dir)?;
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
            return Ok(skill_dir.to_string_lossy().to_string());
        }
        fs::remove_dir_all(&skill_dir).map_err(|error| format!("清理旧 skill 目录失败: {error}"))?;
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
    run_git_in_dir(target_dir, &["checkout"])?;
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
        if append { "add".to_string() } else { "set".to_string() },
        "--no-cone".to_string(),
    ];
    for path in sparse_paths {
        let normalized = path.trim_matches('/').to_string();
        if normalized.is_empty() {
            continue;
        }
        args.push(format!("/{normalized}"));
        args.push(format!("/{normalized}/**"));
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
    if let Some(path) = hinted_relative_path {
        let hinted_path = repo_root.join(path);
        if hinted_path.is_dir() && hinted_path.join("SKILL.md").is_file() {
            return Ok(hinted_path);
        }
    }

    let mut candidates = Vec::new();
    collect_skill_directories(repo_root, repo_root, &mut candidates)?;
    if candidates.is_empty() {
        return Err("安装失败：仓库中未找到任何包含 SKILL.md 的目录".into());
    }
    if candidates.len() == 1 {
        return Ok(candidates.remove(0));
    }

    let normalized_skill_name = normalize_slug(skill_name);
    let hinted_slug = hinted_relative_path
        .and_then(|path| path.file_name())
        .and_then(|value| value.to_str())
        .map(normalize_slug);

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

    Err("安装失败：仓库中存在多个技能目录，且无法自动匹配目标技能".into())
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
        "windsurf" => home_path.join(".windsurf/skills"),
        "openclaw" => home_path.join(".openclaw/skills"),
        "continue" => home_path.join(".continue/skills"),
        "iflow" => home_path.join(".iflow/skills"),
        "codebuddy" => home_path.join(".codebuddy/skills"),
        "trae" => home_path.join(".trae/skills"),
        "droid" => home_path.join(".factory/skills"),
        "augment" => home_path.join(".augment/skills"),
        "cline" => home_path.join(".agents/skills"),
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

