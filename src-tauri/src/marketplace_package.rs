use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::models::{GitChangeFile, SkillFileBrowserSnapshot, SkillFileEntry};

const PACKAGE_MAX_FILE_COUNT: usize = 500;
const PACKAGE_MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const PACKAGE_MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024;

pub(crate) fn files_from_zip(package: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut archive = open_archive(package)?;
    let mut total_bytes = 0_u64;
    let mut files = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 Skill 包失败: {error}"))?;
        reject_symlink(&entry)?;
        if entry.is_dir() {
            continue;
        }
        let path = normalize_archive_path(entry.name(), entry.enclosed_name())?;
        if entry.size() > PACKAGE_MAX_FILE_BYTES {
            return Err(format!("Skill 文件过大：{}", entry.name()));
        }
        total_bytes = total_bytes.saturating_add(entry.size());
        if total_bytes > PACKAGE_MAX_TOTAL_BYTES {
            return Err("Skill 解压后总大小超出限制".into());
        }
        let mut content = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut content)
            .map_err(|error| format!("读取 Skill 文件失败: {error}"))?;
        files.push((path, content));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    if !files.iter().any(|(path, _)| path == "SKILL.md") {
        return Err("Skill 包根目录缺少 SKILL.md".into());
    }
    Ok(files)
}

pub(crate) fn file_browser_from_paths(
    skill_name: &str,
    file_paths: impl IntoIterator<Item = String>,
) -> Result<SkillFileBrowserSnapshot, String> {
    let mut path_types = BTreeMap::new();
    for file_path in file_paths {
        let normalized = normalize_relative_path(&file_path)?;
        let segments = normalized.split('/').collect::<Vec<_>>();
        for end in 1..segments.len() {
            path_types
                .entry(segments[..end].join("/"))
                .or_insert_with(|| "directory".to_string());
        }
        path_types.insert(normalized, "file".to_string());
    }
    if path_types.get("SKILL.md").map(String::as_str) != Some("file") {
        return Err("Skill 包根目录缺少 SKILL.md".into());
    }

    let mut entries = vec![SkillFileEntry {
        path: String::new(),
        name: skill_name.to_string(),
        entry_type: "directory".into(),
        depth: 0,
    }];
    entries.extend(path_types.into_iter().map(|(path, entry_type)| {
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        let depth = path.split('/').count();
        SkillFileEntry {
            path,
            name,
            entry_type,
            depth,
        }
    }));
    entries[1..].sort_by(|left, right| {
        let left_type = if left.entry_type == "directory" { 0 } else { 1 };
        let right_type = if right.entry_type == "directory" {
            0
        } else {
            1
        };
        left.path
            .split('/')
            .collect::<Vec<_>>()
            .cmp(&right.path.split('/').collect::<Vec<_>>())
            .then(left_type.cmp(&right_type))
    });

    Ok(SkillFileBrowserSnapshot {
        skill_name: skill_name.to_string(),
        root_name: skill_name.to_string(),
        entries,
        initial_file_path: Some("SKILL.md".into()),
        preview_mode: "full".into(),
    })
}

pub(crate) fn build_update_changes(
    local_path: &Path,
    target_files: Vec<(String, Vec<u8>)>,
) -> Result<Vec<GitChangeFile>, String> {
    let local_files = collect_directory_files(local_path)?;
    let target_files = target_files.into_iter().collect::<BTreeMap<_, _>>();
    let paths = local_files
        .keys()
        .chain(target_files.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut changes = Vec::new();
    for path in paths {
        let local = local_files.get(&path);
        let target = target_files.get(&path);
        if local == target {
            continue;
        }
        let status = match (local, target) {
            (None, Some(_)) => "A",
            (Some(_), None) => "D",
            (Some(_), Some(_)) => "M",
            (None, None) => continue,
        };
        changes.push(GitChangeFile {
            path,
            status: status.into(),
            diff: String::new(),
            staged_diff: String::new(),
            unstaged_diff: String::new(),
            original_content: local.map(|content| String::from_utf8_lossy(content).to_string()),
            current_content: target.map(|content| String::from_utf8_lossy(content).to_string()),
        });
    }
    Ok(changes)
}

pub(crate) fn directory_content_hash(root: &Path) -> Result<String, String> {
    let files = collect_directory_files(root)?;
    let mut digest = Sha256::new();
    for (path, content) in files {
        digest.update((path.len() as u64).to_be_bytes());
        digest.update(path.as_bytes());
        digest.update((content.len() as u64).to_be_bytes());
        digest.update(content);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub(crate) fn replace_directory_from_zip(package: &[u8], target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "无法定位 Skill 托管目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建 Skill 托管目录失败: {error}"))?;
    let suffix = unique_suffix()?;
    let temporary = parent.join(format!(".skilldock-package-{suffix}.tmp"));
    let backup = parent.join(format!(".skilldock-package-{suffix}.backup"));
    extract_zip(package, &temporary)?;

    let had_existing = fs::symlink_metadata(target).is_ok();
    if had_existing {
        fs::rename(target, &backup).map_err(|error| format!("备份旧 Skill 失败: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, target) {
        if had_existing {
            let _ = fs::rename(&backup, target);
        }
        let _ = remove_path(&temporary);
        return Err(format!("替换 Skill 目录失败: {error}"));
    }
    if had_existing {
        let _ = remove_path(&backup);
    }
    Ok(())
}

fn extract_zip(package: &[u8], target: &Path) -> Result<(), String> {
    let files = files_from_zip(package)?;
    if fs::symlink_metadata(target).is_ok() {
        remove_path(target)?;
    }
    fs::create_dir_all(target).map_err(|error| format!("创建 Skill 临时目录失败: {error}"))?;
    for (path, content) in files {
        let output_path = target.join(path);
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建 Skill 目录失败: {error}"))?;
        }
        let mut output = fs::File::create(&output_path)
            .map_err(|error| format!("创建 Skill 文件失败: {error}"))?;
        output
            .write_all(&content)
            .map_err(|error| format!("写入 Skill 文件失败: {error}"))?;
    }
    Ok(())
}

fn open_archive(package: &[u8]) -> Result<ZipArchive<Cursor<&[u8]>>, String> {
    let archive = ZipArchive::new(Cursor::new(package))
        .map_err(|error| format!("解析 Skill 包失败: {error}"))?;
    if archive.len() == 0 || archive.len() > PACKAGE_MAX_FILE_COUNT {
        return Err("Skill 包文件数量超出限制".into());
    }
    Ok(archive)
}

fn reject_symlink(entry: &zip::read::ZipFile<'_>) -> Result<(), String> {
    if entry
        .unix_mode()
        .is_some_and(|mode| mode & 0o170000 == 0o120000)
    {
        return Err(format!("Skill 包不允许符号链接：{}", entry.name()));
    }
    Ok(())
}

fn normalize_archive_path(
    file_name: &str,
    enclosed_path: Option<PathBuf>,
) -> Result<String, String> {
    let path = enclosed_path.ok_or_else(|| format!("Skill 包含不安全路径：{file_name}"))?;
    let normalized = path.to_string_lossy().replace('\\', "/");
    normalize_relative_path(normalized.trim_matches('/'))
        .map_err(|_| format!("Skill 包含不安全路径：{file_name}"))
}

fn normalize_relative_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim().trim_matches('/');
    let relative = Path::new(trimmed);
    if trimmed.is_empty()
        || trimmed.contains('\\')
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("不允许访问 Skill 目录之外的文件".into());
    }
    Ok(trimmed.to_string())
}

fn collect_directory_files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut files = BTreeMap::new();
    collect_directory_files_into(root, root, &mut files)?;
    Ok(files)
}

fn collect_directory_files_into(
    root: &Path,
    current: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
    for entry in
        fs::read_dir(current).map_err(|error| format!("读取本地 Skill 目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取本地 Skill 文件失败: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("读取本地 Skill 文件失败: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "本地 Skill 包含不支持的符号链接：{}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            collect_directory_files_into(root, &path, files)?;
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "读取本地 Skill 相对路径失败".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let content =
            fs::read(&path).map_err(|error| format!("读取本地 Skill 文件失败: {error}"))?;
        files.insert(relative, content);
    }
    Ok(())
}

fn remove_path(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取临时 Skill 路径失败: {error}")),
    };
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path).map_err(|error| format!("清理临时 Skill 目录失败: {error}"))
    } else {
        fs::remove_file(path).map_err(|error| format!("清理临时 Skill 文件失败: {error}"))
    }
}

fn unique_suffix() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .map_err(|error| format!("生成 Skill 临时目录失败: {error}"))
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};
    use std::time::{SystemTime, UNIX_EPOCH};

    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    use super::{
        build_update_changes, directory_content_hash, file_browser_from_paths, files_from_zip,
        replace_directory_from_zip,
    };

    #[test]
    fn reads_complete_skill_package() {
        let package = build_package(&[
            ("SKILL.md", "---\nname: demo\n---\n"),
            ("scripts/run.sh", "echo ok\n"),
        ]);

        let files = files_from_zip(&package).expect("read package");
        let browser = file_browser_from_paths("demo", files.iter().map(|(path, _)| path.clone()))
            .expect("build browser");

        assert_eq!(files.len(), 2);
        assert_eq!(browser.initial_file_path.as_deref(), Some("SKILL.md"));
    }

    #[test]
    fn rejects_path_traversal() {
        let package = build_package(&[("SKILL.md", "valid"), ("../outside.txt", "unsafe")]);

        let error = files_from_zip(&package).expect_err("reject unsafe package");

        assert!(error.contains("不安全路径"));
    }

    #[test]
    fn rejects_symlink() {
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file("SKILL.md", SimpleFileOptions::default())
            .expect("start skill file");
        archive.write_all(b"valid").expect("write skill file");
        archive
            .add_symlink("linked", "SKILL.md", SimpleFileOptions::default())
            .expect("add symlink");
        let package = archive.finish().expect("finish package").into_inner();

        let error = files_from_zip(&package).expect_err("reject symlink");

        assert!(error.contains("符号链接"));
    }

    #[test]
    fn rejects_package_without_root_skill_markdown() {
        let package = build_package(&[("nested/SKILL.md", "nested")]);

        let error = files_from_zip(&package).expect_err("reject missing root skill");

        assert!(error.contains("根目录缺少 SKILL.md"));
    }

    #[test]
    fn builds_directory_change_list() {
        let directory = test_directory("changes");
        std::fs::create_dir_all(&directory).expect("create directory");
        std::fs::write(directory.join("SKILL.md"), "before").expect("write skill");
        std::fs::write(directory.join("removed.md"), "removed").expect("write removed");

        let changes = build_update_changes(
            &directory,
            vec![
                ("SKILL.md".into(), b"after".to_vec()),
                ("added.md".into(), b"added".to_vec()),
            ],
        )
        .expect("build changes");

        assert_eq!(changes.len(), 3);
        assert!(changes
            .iter()
            .any(|change| change.path == "SKILL.md" && change.status == "M"));
        assert!(changes
            .iter()
            .any(|change| change.path == "added.md" && change.status == "A"));
        assert!(changes
            .iter()
            .any(|change| change.path == "removed.md" && change.status == "D"));
        std::fs::remove_dir_all(directory).expect("remove directory");
    }

    #[test]
    fn keeps_existing_directory_when_package_validation_fails() {
        let directory = test_directory("rollback");
        std::fs::create_dir_all(&directory).expect("create directory");
        std::fs::write(directory.join("SKILL.md"), "original").expect("write original");
        let invalid_package = build_package(&[("nested/SKILL.md", "invalid")]);

        replace_directory_from_zip(&invalid_package, &directory).expect_err("reject replacement");

        assert_eq!(
            std::fs::read_to_string(directory.join("SKILL.md")).expect("read original"),
            "original"
        );
        std::fs::remove_dir_all(directory).expect("remove directory");
    }

    #[test]
    fn detects_local_content_changes() {
        let directory = test_directory("content-hash");
        std::fs::create_dir_all(&directory).expect("create directory");
        std::fs::write(directory.join("SKILL.md"), "before").expect("write skill");
        let original_hash = directory_content_hash(&directory).expect("hash original content");

        std::fs::write(directory.join("SKILL.md"), "after").expect("change skill");
        let changed_hash = directory_content_hash(&directory).expect("hash changed content");

        assert_ne!(original_hash, changed_hash);
        std::fs::remove_dir_all(directory).expect("remove directory");
    }

    fn build_package(files: &[(&str, &str)]) -> Vec<u8> {
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        for (path, content) in files {
            archive
                .start_file(path, SimpleFileOptions::default())
                .expect("start file");
            archive.write_all(content.as_bytes()).expect("write file");
        }
        archive.finish().expect("finish package").into_inner()
    }

    fn test_directory(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!("skilldock-marketplace-package-{name}-{unique}"))
    }
}
