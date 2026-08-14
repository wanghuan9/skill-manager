use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::library::git_command;
use crate::models::GitChangeFile;

fn run_git_with_allowed_codes(
    scope_path: &str,
    args: &[&str],
    allowed_codes: &[i32],
) -> Result<String, String> {
    let output = git_command()
        .args(["-C", scope_path])
        .args(args)
        .output()
        .map_err(|error| format!("执行 git 命令失败: {error}"))?;
    let status_code = output.status.code().unwrap_or(-1);
    if !allowed_codes.contains(&status_code) {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("git {} 失败: {message}", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git(scope_path: &str, args: &[&str]) -> Result<String, String> {
    run_git_with_allowed_codes(scope_path, args, &[0])
}

fn run_git_with_input(scope_path: &str, args: &[&str], input: &str) -> Result<(), String> {
    let mut child = git_command()
        .args(["-C", scope_path])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("执行 git 命令失败: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法写入 git 命令输入".to_string())?;
    stdin
        .write_all(input.as_bytes())
        .map_err(|error| format!("写入 git 命令输入失败: {error}"))?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .map_err(|error| format!("读取 git 命令输出失败: {error}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if stderr.is_empty() { stdout } else { stderr };
    Err(format!("git {} 失败: {message}", args.join(" ")))
}

fn validate_change_path(path: &str) -> Result<(), String> {
    let relative_path = Path::new(path);
    let has_only_normal_components = relative_path
        .components()
        .all(|component| matches!(component, std::path::Component::Normal(_)));
    if path.trim().is_empty() || relative_path.is_absolute() || !has_only_normal_components {
        return Err("变更文件路径无效".into());
    }
    Ok(())
}

pub fn extract_diff_hunk_patch(diff: &str, target_hunk_index: usize) -> Option<String> {
    let lines = diff.lines().collect::<Vec<_>>();
    let mut section_start = 0;
    let mut hunk_index = 0;
    let mut line_index = 0;

    while line_index < lines.len() {
        if lines[line_index].starts_with("diff --git ") {
            section_start = line_index;
        }
        if !lines[line_index].starts_with("@@ ") {
            line_index += 1;
            continue;
        }

        let hunk_start = line_index;
        let mut hunk_end = hunk_start + 1;
        while hunk_end < lines.len()
            && !lines[hunk_end].starts_with("@@ ")
            && !lines[hunk_end].starts_with("diff --git ")
        {
            hunk_end += 1;
        }
        if hunk_index == target_hunk_index {
            let header_end = (section_start..hunk_start)
                .find(|index| lines[*index].starts_with("@@ "))
                .unwrap_or(hunk_start);
            let mut patch_lines = lines[section_start..header_end].to_vec();
            patch_lines.extend_from_slice(&lines[hunk_start..hunk_end]);
            return Some(format!("{}\n", patch_lines.join("\n")));
        }

        hunk_index += 1;
        line_index = hunk_end;
    }

    None
}

fn revert_untracked_file(scope_path: &str, relative_path: &str) -> Result<(), String> {
    let full_path = Path::new(scope_path).join(relative_path);
    if full_path.is_dir() {
        return Err("仅支持回退单个新增文件".into());
    }
    if full_path.exists() {
        fs::remove_file(&full_path).map_err(|error| format!("删除新增文件失败: {error}"))?;
    }
    Ok(())
}

fn revert_diff_hunk(scope_path: &str, patch: &str, staged: bool) -> Result<(), String> {
    let worktree_check_args = [
        "apply",
        "--check",
        "--reverse",
        "--recount",
        "--whitespace=nowarn",
    ];
    let worktree_apply_args = ["apply", "--reverse", "--recount", "--whitespace=nowarn"];
    run_git_with_input(scope_path, &worktree_check_args, patch)?;
    if !staged {
        return run_git_with_input(scope_path, &worktree_apply_args, patch);
    }

    let index_check_args = [
        "apply",
        "--cached",
        "--check",
        "--reverse",
        "--recount",
        "--whitespace=nowarn",
    ];
    let index_apply_args = [
        "apply",
        "--cached",
        "--reverse",
        "--recount",
        "--whitespace=nowarn",
    ];
    run_git_with_input(scope_path, &index_check_args, patch)?;
    run_git_with_input(scope_path, &worktree_apply_args, patch)?;
    run_git_with_input(scope_path, &index_apply_args, patch)
}

fn revert_change_file(scope_path: &str, relative_path: &str, status: &str) -> Result<(), String> {
    if status.contains('?') {
        return revert_untracked_file(scope_path, relative_path);
    }

    run_git(
        scope_path,
        &[
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            relative_path,
        ],
    )?;
    Ok(())
}

pub fn revert_working_tree_change(
    scope_path: &str,
    relative_path: &str,
    hunk_index: Option<usize>,
    expected_patch: Option<&str>,
    staged: bool,
) -> Result<(), String> {
    validate_change_path(relative_path)?;
    let changes = collect_working_tree_changes(scope_path)?;
    let change = changes
        .iter()
        .find(|change| change.path == relative_path)
        .ok_or_else(|| "该文件已没有可回退的本地变更".to_string())?;

    if let Some(target_hunk_index) = hunk_index {
        let source_diff = if staged {
            &change.staged_diff
        } else {
            &change.unstaged_diff
        };
        let patch = extract_diff_hunk_patch(source_diff, target_hunk_index)
            .ok_or_else(|| "该变更块已不存在，请刷新后重试".to_string())?;
        if expected_patch != Some(patch.as_str()) {
            return Err("文件内容已变化，请刷新后重试".into());
        }
        if change.status.contains('?') {
            return revert_untracked_file(scope_path, relative_path);
        }
        return revert_diff_hunk(scope_path, &patch, staged);
    }

    revert_change_file(scope_path, relative_path, &change.status)
}

pub fn repository_root_path(scope_path: &str) -> Result<String, String> {
    let root = run_git(scope_path, &["rev-parse", "--show-toplevel"])?;
    if root.trim().is_empty() {
        return Err("无法识别 Git 仓库工作区。".into());
    }

    let canonical_root = fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(root.trim()));
    Ok(canonical_root.to_string_lossy().to_string())
}

pub fn is_supported_text_file(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let normalized_file_name = file_name.to_ascii_lowercase();
    if matches!(
        normalized_file_name.as_str(),
        "skill.md"
            | "dockerfile"
            | "makefile"
            | "gemfile"
            | "rakefile"
            | ".editorconfig"
            | ".gitignore"
            | ".npmrc"
    ) || normalized_file_name == ".env"
        || normalized_file_name.starts_with(".env.")
    {
        return true;
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    matches!(
        extension.as_deref(),
        Some(
            "bash"
                | "c"
                | "cc"
                | "cjs"
                | "conf"
                | "cpp"
                | "cs"
                | "css"
                | "cts"
                | "cxx"
                | "diff"
                | "go"
                | "gql"
                | "graphql"
                | "h"
                | "hpp"
                | "htm"
                | "html"
                | "hxx"
                | "ini"
                | "java"
                | "js"
                | "json"
                | "jsonc"
                | "jsx"
                | "kt"
                | "kts"
                | "less"
                | "log"
                | "lua"
                | "m"
                | "markdown"
                | "md"
                | "mjs"
                | "mm"
                | "mts"
                | "patch"
                | "php"
                | "pl"
                | "pm"
                | "properties"
                | "ps1"
                | "py"
                | "r"
                | "rb"
                | "rs"
                | "scss"
                | "sh"
                | "sql"
                | "svg"
                | "swift"
                | "yaml"
                | "yml"
                | "toml"
                | "ts"
                | "tsx"
                | "txt"
                | "wat"
                | "xml"
                | "zsh"
        )
    )
}

fn parse_name_status_line(line: &str) -> Option<(String, String)> {
    let mut parts = line.splitn(2, '\t');
    let status = parts.next()?.trim().to_string();
    let path = parts.next()?.trim().to_string();
    (!status.is_empty() && !path.is_empty()).then_some((status, path))
}

fn normalize_porcelain_v2_status(status: &str) -> String {
    status
        .chars()
        .map(|character| if character == '.' { ' ' } else { character })
        .collect()
}

fn parse_porcelain_v2_status_record(record: &str) -> Option<(String, String)> {
    if let Some(path) = record.strip_prefix("? ") {
        return Some(("??".into(), path.to_string()));
    }
    if let Some(path) = record.strip_prefix("! ") {
        return Some(("!!".into(), path.to_string()));
    }
    if record.starts_with("1 ") {
        let fields = record.splitn(9, ' ').collect::<Vec<_>>();
        return Some((
            normalize_porcelain_v2_status(fields.get(1)?),
            fields.get(8)?.to_string(),
        ));
    }
    if record.starts_with("u ") {
        let fields = record.splitn(11, ' ').collect::<Vec<_>>();
        return Some((
            normalize_porcelain_v2_status(fields.get(1)?),
            fields.get(10)?.to_string(),
        ));
    }
    None
}

fn git_diff_for_path(scope_path: &str, args: &[&str], path: &str) -> String {
    let mut diff_args = args.to_vec();
    diff_args.extend(["--", path]);
    run_git(scope_path, &diff_args).unwrap_or_default()
}

fn git_diff_for_untracked_path(scope_path: &str, path: &str) -> String {
    run_git_with_allowed_codes(
        scope_path,
        &["diff", "--no-index", "--", "/dev/null", path],
        &[0, 1],
    )
    .unwrap_or_default()
}

fn working_tree_diffs(scope_path: &str, status: &str, path: &str) -> (String, String) {
    if status.contains('?') {
        return (String::new(), git_diff_for_untracked_path(scope_path, path));
    }

    let index_status = status.chars().next().unwrap_or(' ');
    let worktree_status = status.chars().nth(1).unwrap_or(' ');
    let staged_diff = if index_status == ' ' {
        String::new()
    } else {
        git_diff_for_path(scope_path, &["diff", "--cached"], path)
    };
    let unstaged_diff = if worktree_status == ' ' {
        String::new()
    } else {
        git_diff_for_path(scope_path, &["diff"], path)
    };

    (staged_diff, unstaged_diff)
}

fn git_ref_file_content(
    repository_path: &str,
    git_ref: &str,
    repository_relative_path: &str,
) -> Option<String> {
    if !is_supported_text_file(Path::new(repository_relative_path)) {
        return None;
    }

    let object_spec = format!("{git_ref}:{repository_relative_path}");
    let output = git_command()
        .args(["-C", repository_path, "show", &object_spec])
        .output()
        .ok()?;
    if !output.status.success() {
        return Some(String::new());
    }
    String::from_utf8(output.stdout).ok()
}

fn working_tree_file_content(scope_path: &str, relative_path: &str) -> Option<String> {
    if !is_supported_text_file(Path::new(relative_path)) {
        return None;
    }

    match fs::read(Path::new(scope_path).join(relative_path)) {
        Ok(bytes) => String::from_utf8(bytes).ok(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(String::new()),
        Err(_) => None,
    }
}

fn resolve_scope(scope_path: &str) -> Result<(String, String), String> {
    let repository_path = repository_root_path(scope_path)?;
    let canonical_scope_path =
        fs::canonicalize(scope_path).map_err(|error| format!("解析目录失败: {error}"))?;
    let canonical_repository_path =
        fs::canonicalize(&repository_path).map_err(|error| format!("解析仓库目录失败: {error}"))?;
    let relative_path = canonical_scope_path
        .strip_prefix(&canonical_repository_path)
        .map_err(|error| format!("解析仓库相对路径失败: {error}"))?
        .to_string_lossy()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    Ok((repository_path, relative_path))
}

pub fn collect_ref_changes(
    scope_path: &str,
    original_ref: &str,
    current_ref: &str,
) -> Result<Vec<GitChangeFile>, String> {
    let (repository_path, scope_relative_path) = resolve_scope(scope_path)?;
    let pathspec = if scope_relative_path.is_empty() {
        "."
    } else {
        scope_relative_path.as_str()
    };
    let name_status = run_git(
        &repository_path,
        &[
            "diff",
            "--name-status",
            "--no-renames",
            original_ref,
            current_ref,
            "--",
            pathspec,
        ],
    )?;
    let changes = name_status
        .lines()
        .filter_map(|line| {
            let (status, repository_relative_path) = parse_name_status_line(line)?;
            let path = if scope_relative_path.is_empty() {
                repository_relative_path.clone()
            } else {
                repository_relative_path
                    .strip_prefix(&format!("{scope_relative_path}/"))?
                    .to_string()
            };
            let diff = git_diff_for_path(
                &repository_path,
                &["diff", "--no-renames", original_ref, current_ref],
                &repository_relative_path,
            );
            Some(GitChangeFile {
                path,
                status,
                diff,
                staged_diff: String::new(),
                unstaged_diff: String::new(),
                original_content: git_ref_file_content(
                    &repository_path,
                    original_ref,
                    &repository_relative_path,
                ),
                current_content: git_ref_file_content(
                    &repository_path,
                    current_ref,
                    &repository_relative_path,
                ),
            })
        })
        .collect();
    Ok(changes)
}

pub fn collect_working_tree_changes(scope_path: &str) -> Result<Vec<GitChangeFile>, String> {
    let (repository_path, scope_relative_path) = resolve_scope(scope_path)?;
    let pathspec = if scope_relative_path.is_empty() {
        "."
    } else {
        scope_relative_path.as_str()
    };
    let porcelain = run_git(
        &repository_path,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--no-renames",
            "--untracked-files=all",
            "--",
            pathspec,
        ],
    )?;
    let changes = porcelain
        .split('\0')
        .filter_map(|record| {
            let (raw_status, repository_relative_path) = parse_porcelain_v2_status_record(record)?;
            let status = raw_status.trim().to_string();
            let original_content =
                git_ref_file_content(&repository_path, "HEAD", &repository_relative_path);
            let path = if scope_relative_path.is_empty() {
                repository_relative_path.clone()
            } else {
                repository_relative_path
                    .strip_prefix(&format!("{scope_relative_path}/"))?
                    .to_string()
            };
            let current_content = working_tree_file_content(scope_path, &path);
            let (staged_diff, unstaged_diff) = working_tree_diffs(scope_path, &raw_status, &path);
            let diff = [staged_diff.as_str(), unstaged_diff.as_str()]
                .into_iter()
                .filter(|part| !part.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            Some(GitChangeFile {
                path,
                status,
                diff,
                staged_diff,
                unstaged_diff,
                original_content,
                current_content,
            })
        })
        .collect();
    Ok(changes)
}
