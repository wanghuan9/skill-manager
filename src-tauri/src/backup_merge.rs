use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::backup_repository::{git, git_success, NODE_NOTES_PATH};
use crate::backup_snapshot::{read_library_snapshot, BackupLibrary, BackupSkillMetadata};

const PORTABLE_MERGE_PATHS: [&str; 6] = [
    ".skilldock/preferences.json",
    ".skilldock/mcp-servers.json",
    ".skilldock/plugin-targets.json",
    "skill-filesystem",
    "plugins",
    "cursor-disabled",
];

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConflict {
    pub conflict_id: String,
    pub backup_id: String,
    pub skill_name: String,
    pub created_at: String,
    pub local_commit: String,
    pub remote_commit: String,
    pub local: Option<BackupSkillMetadata>,
    pub remote: Option<BackupSkillMetadata>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConflictFile {
    pub conflicts: Vec<BackupConflict>,
}

#[derive(Clone, Copy)]
enum ObjectSource {
    Local,
    Remote,
}

#[derive(Clone)]
struct MergedObject {
    metadata: BackupSkillMetadata,
    source: ObjectSource,
}

struct PortablePathSelection {
    relative_path: &'static str,
    source: ObjectSource,
}

struct WorktreeGuard {
    repository: PathBuf,
    path: PathBuf,
}

impl Drop for WorktreeGuard {
    fn drop(&mut self) {
        let path = self.path.to_string_lossy().to_string();
        let _ = git(
            &self.repository,
            &["worktree", "remove", "--force", &path],
            None,
        );
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn materialize_commit(
    repository: &Path,
    commit: &str,
    label: &str,
) -> Result<WorktreeGuard, String> {
    let path = repository
        .parent()
        .ok_or_else(|| "备份仓库目录无效".to_string())?
        .join("staging")
        .join(format!("merge-{label}-{}", uuid::Uuid::new_v4()));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建合并暂存区失败: {error}"))?;
    }
    let path_value = path.to_string_lossy().to_string();
    git(
        repository,
        &["worktree", "add", "--detach", &path_value, commit],
        None,
    )?;
    Ok(WorktreeGuard {
        repository: repository.to_path_buf(),
        path,
    })
}

pub(crate) fn with_materialized_commit<T>(
    repository: &Path,
    commit: &str,
    label: &str,
    operation: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let worktree = materialize_commit(repository, commit, label)?;
    operation(&worktree.path)
}

fn index_library(library: BackupLibrary) -> BTreeMap<String, BackupSkillMetadata> {
    library
        .skills
        .into_iter()
        .map(|skill| (skill.backup_id.clone(), skill))
        .collect()
}

fn metadata_without_content(skill: &BackupSkillMetadata) -> BackupSkillMetadata {
    let mut metadata = skill.clone();
    metadata.content_hash.clear();
    metadata
}

fn choose_changed_object(
    base: Option<&BackupSkillMetadata>,
    local: Option<&BackupSkillMetadata>,
    remote: Option<&BackupSkillMetadata>,
) -> Option<MergedObject> {
    if local == remote {
        return local.cloned().map(|metadata| MergedObject {
            metadata,
            source: ObjectSource::Local,
        });
    }
    if local == base {
        return remote.cloned().map(|metadata| MergedObject {
            metadata,
            source: ObjectSource::Remote,
        });
    }
    if remote == base {
        return local.cloned().map(|metadata| MergedObject {
            metadata,
            source: ObjectSource::Local,
        });
    }
    let (Some(base), Some(local), Some(remote)) = (base, local, remote) else {
        return None;
    };
    let local_content_changed = local.content_hash != base.content_hash;
    let remote_content_changed = remote.content_hash != base.content_hash;
    let local_metadata_changed = metadata_without_content(local) != metadata_without_content(base);
    let remote_metadata_changed =
        metadata_without_content(remote) != metadata_without_content(base);
    if local_content_changed
        && !remote_content_changed
        && !local_metadata_changed
        && remote_metadata_changed
    {
        let mut metadata = remote.clone();
        metadata.content_hash = local.content_hash.clone();
        return Some(MergedObject {
            metadata,
            source: ObjectSource::Local,
        });
    }
    if remote_content_changed
        && !local_content_changed
        && !remote_metadata_changed
        && local_metadata_changed
    {
        let mut metadata = local.clone();
        metadata.content_hash = remote.content_hash.clone();
        return Some(MergedObject {
            metadata,
            source: ObjectSource::Remote,
        });
    }
    None
}

fn read_existing_conflicts(repository: &Path) -> BackupConflictFile {
    fs::read_to_string(repository.join(".skilldock/conflicts.json"))
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn hash_path_entry(root: &Path, path: &Path, hasher: &mut Sha256) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("读取便携合并路径失败 {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    let relative = path.strip_prefix(root).unwrap_or(path);
    hasher.update(relative.to_string_lossy().as_bytes());
    hasher.update([0]);
    if metadata.is_dir() {
        let mut entries = fs::read_dir(path)
            .map_err(|error| format!("读取便携合并目录失败 {}: {error}", path.display()))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            hash_path_entry(root, &entry.path(), hasher)?;
        }
    } else if metadata.is_file() {
        hasher.update(
            fs::read(path)
                .map_err(|error| format!("读取便携合并文件失败 {}: {error}", path.display()))?,
        );
    }
    Ok(())
}

fn portable_path_hash(root: &Path, relative_path: &str) -> Result<Option<String>, String> {
    let path = root.join(relative_path);
    if !path.exists() {
        return Ok(None);
    }
    let mut hasher = Sha256::new();
    hash_path_entry(&path, &path, &mut hasher)?;
    Ok(Some(format!("{:x}", hasher.finalize())))
}

fn select_portable_path_source(
    base: Option<&Path>,
    local: &Path,
    remote: &Path,
    relative_path: &'static str,
) -> Result<PortablePathSelection, String> {
    let base_hash = base
        .map(|root| portable_path_hash(root, relative_path))
        .transpose()?
        .flatten();
    let local_hash = portable_path_hash(local, relative_path)?;
    let remote_hash = portable_path_hash(remote, relative_path)?;
    let source = if local_hash == base_hash && remote_hash != base_hash {
        ObjectSource::Remote
    } else {
        ObjectSource::Local
    };
    Ok(PortablePathSelection {
        relative_path,
        source,
    })
}

fn index_conflicts(conflicts: BackupConflictFile) -> BTreeMap<String, BackupConflict> {
    conflicts
        .conflicts
        .into_iter()
        .map(|conflict| (conflict.conflict_id.clone(), conflict))
        .collect()
}

fn merge_conflict_files(
    base: BackupConflictFile,
    local: BackupConflictFile,
    remote: BackupConflictFile,
) -> BackupConflictFile {
    let base = index_conflicts(base);
    let local = index_conflicts(local);
    let remote = index_conflicts(remote);
    let ids = base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut conflicts = Vec::new();
    for conflict_id in ids {
        let base_conflict = base.get(&conflict_id);
        let local_conflict = local.get(&conflict_id);
        let remote_conflict = remote.get(&conflict_id);
        let selected = if local_conflict == remote_conflict {
            local_conflict
        } else if local_conflict == base_conflict {
            remote_conflict
        } else if remote_conflict == base_conflict {
            local_conflict
        } else {
            local_conflict.or(remote_conflict)
        };
        if let Some(conflict) = selected {
            conflicts.push(conflict.clone());
        }
    }
    BackupConflictFile { conflicts }
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("读取合并对象失败 {}: {error}", source.display()))?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        fs::create_dir_all(target)
            .map_err(|error| format!("创建合并目录失败 {}: {error}", target.display()))?;
        let mut entries = fs::read_dir(source)
            .map_err(|error| format!("读取合并目录失败 {}: {error}", source.display()))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if metadata.is_file() {
        fs::copy(source, target)
            .map_err(|error| format!("复制合并文件失败 {}: {error}", source.display()))?;
    }
    Ok(())
}

fn replace_directory(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        fs::remove_dir_all(target)
            .map_err(|error| format!("清理合并目标失败 {}: {error}", target.display()))?;
    }
    fs::rename(source, target)
        .map_err(|error| format!("应用合并目标失败 {}: {error}", target.display()))
}

fn apply_merge_plan(
    repository: &Path,
    remote_path: &Path,
    objects: Vec<MergedObject>,
    conflicts: BackupConflictFile,
    portable_paths: Vec<PortablePathSelection>,
) -> Result<(), String> {
    let staging = repository
        .parent()
        .ok_or_else(|| "备份仓库目录无效".to_string())?
        .join("staging")
        .join(format!("merge-result-{}", uuid::Uuid::new_v4()));
    let skills_dir = staging.join("skills");
    let metadata_dir = staging.join(".skilldock/skills");
    fs::create_dir_all(&skills_dir).map_err(|error| format!("创建合并结果失败: {error}"))?;
    fs::create_dir_all(&metadata_dir).map_err(|error| format!("创建合并元数据失败: {error}"))?;
    fs::create_dir_all(staging.join("plugins"))
        .map_err(|error| format!("创建插件合并结果失败: {error}"))?;
    fs::create_dir_all(staging.join("cursor-disabled"))
        .map_err(|error| format!("创建 Cursor 插件合并结果失败: {error}"))?;
    for selection in portable_paths {
        let source_root = match selection.source {
            ObjectSource::Local => repository,
            ObjectSource::Remote => remote_path,
        };
        let source = source_root.join(selection.relative_path);
        if source.exists() {
            copy_tree(&source, &staging.join(selection.relative_path))?;
        }
        if selection.relative_path == "skill-filesystem" {
            let manifest = source_root.join(".skilldock/skill-filesystem.json");
            if manifest.is_file() {
                copy_tree(&manifest, &staging.join(".skilldock/skill-filesystem.json"))?;
            }
        }
    }
    let mut library = BackupLibrary {
        schema_version: 1,
        skills: Vec::new(),
    };
    for object in objects {
        let source_root = match object.source {
            ObjectSource::Local => repository,
            ObjectSource::Remote => remote_path,
        };
        copy_tree(
            &source_root.join("skills").join(&object.metadata.backup_id),
            &skills_dir.join(&object.metadata.backup_id),
        )?;
        let payload = serde_json::to_string_pretty(&object.metadata)
            .map_err(|error| format!("序列化合并元数据失败: {error}"))?;
        fs::write(
            metadata_dir.join(format!("{}.json", object.metadata.backup_id)),
            payload,
        )
        .map_err(|error| format!("写入合并元数据失败: {error}"))?;
        library.skills.push(object.metadata);
    }
    library
        .skills
        .sort_by(|left, right| left.backup_id.cmp(&right.backup_id));
    fs::write(
        staging.join(".skilldock/library.json"),
        serde_json::to_string_pretty(&library)
            .map_err(|error| format!("序列化合并清单失败: {error}"))?,
    )
    .map_err(|error| format!("写入合并清单失败: {error}"))?;
    fs::write(
        staging.join(".skilldock/conflicts.json"),
        serde_json::to_string_pretty(&conflicts)
            .map_err(|error| format!("序列化备份冲突失败: {error}"))?,
    )
    .map_err(|error| format!("写入备份冲突失败: {error}"))?;
    replace_directory(&skills_dir, &repository.join("skills"))?;
    replace_directory(&staging.join(".skilldock"), &repository.join(".skilldock"))?;
    replace_directory(&staging.join("plugins"), &repository.join("plugins"))?;
    replace_directory(
        &staging.join("cursor-disabled"),
        &repository.join("cursor-disabled"),
    )?;
    let staged_skill_filesystem = staging.join("skill-filesystem");
    let repository_skill_filesystem = repository.join("skill-filesystem");
    if staged_skill_filesystem.is_dir() {
        replace_directory(&staged_skill_filesystem, &repository_skill_filesystem)?;
    } else if repository_skill_filesystem.exists() {
        fs::remove_dir_all(&repository_skill_filesystem).map_err(|error| {
            format!(
                "清理旧 Skill 文件系统快照失败 {}: {error}",
                repository_skill_filesystem.display()
            )
        })?;
    }
    // Notes are edited directly in the cloud; a stale local snapshot must not overwrite them.
    let remote_notes = remote_path.join(NODE_NOTES_PATH);
    if remote_notes.is_file() {
        fs::create_dir_all(repository.join(".skilldock-control"))
            .map_err(|error| format!("创建备份备注目录失败: {error}"))?;
        copy_tree(&remote_notes, &repository.join(NODE_NOTES_PATH))?;
    }
    let _ = fs::remove_dir_all(staging);
    Ok(())
}

pub fn merge_remote_branch(repository: &Path) -> Result<(), String> {
    let local_commit = git(repository, &["rev-parse", "HEAD"], None)?;
    let remote_commit = git(repository, &["rev-parse", "origin/main"], None)?;
    let base_commit = git(repository, &["merge-base", "HEAD", "origin/main"], None).ok();
    let remote = materialize_commit(repository, &remote_commit, "remote")?;
    let base = match base_commit.as_deref() {
        Some(commit) => Some(materialize_commit(repository, commit, "base")?),
        None => None,
    };
    let local_skills = index_library(read_library_snapshot(repository)?);
    let remote_skills = index_library(read_library_snapshot(&remote.path)?);
    let base_skills = match base.as_ref() {
        Some(worktree) => index_library(read_library_snapshot(&worktree.path)?),
        None => BTreeMap::new(),
    };
    let portable_paths = PORTABLE_MERGE_PATHS
        .into_iter()
        .map(|relative_path| {
            select_portable_path_source(
                base.as_ref().map(|worktree| worktree.path.as_path()),
                repository,
                &remote.path,
                relative_path,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let ids = local_skills
        .keys()
        .chain(remote_skills.keys())
        .chain(base_skills.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut objects = Vec::new();
    let base_conflicts = base
        .as_ref()
        .map(|worktree| read_existing_conflicts(&worktree.path))
        .unwrap_or_default();
    let mut conflict_file = merge_conflict_files(
        base_conflicts,
        read_existing_conflicts(repository),
        read_existing_conflicts(&remote.path),
    );
    let existing_conflict_ids = conflict_file
        .conflicts
        .iter()
        .map(|conflict| conflict.backup_id.clone())
        .collect::<BTreeSet<_>>();
    for backup_id in ids {
        let local = local_skills.get(&backup_id);
        let remote_skill = remote_skills.get(&backup_id);
        let base_skill = base_skills.get(&backup_id);
        if existing_conflict_ids.contains(&backup_id) {
            if let Some(metadata) = local.cloned() {
                objects.push(MergedObject {
                    metadata,
                    source: ObjectSource::Local,
                });
            }
            continue;
        }
        if let Some(object) = choose_changed_object(base_skill, local, remote_skill) {
            objects.push(object);
            continue;
        }
        let preferred = local.cloned().or_else(|| remote_skill.cloned());
        if let Some(metadata) = preferred {
            let source = if local.is_some() {
                ObjectSource::Local
            } else {
                ObjectSource::Remote
            };
            objects.push(MergedObject {
                metadata: metadata.clone(),
                source,
            });
            conflict_file.conflicts.push(BackupConflict {
                conflict_id: uuid::Uuid::new_v4().to_string(),
                backup_id: backup_id.clone(),
                skill_name: metadata.name,
                created_at: Utc::now().to_rfc3339(),
                local_commit: local_commit.clone(),
                remote_commit: remote_commit.clone(),
                local: local.cloned(),
                remote: remote_skill.cloned(),
            });
        }
    }
    git(
        repository,
        &[
            "merge",
            "-s",
            "ours",
            "--no-commit",
            "--no-ff",
            "--allow-unrelated-histories",
            "origin/main",
        ],
        None,
    )?;
    if let Err(error) = apply_merge_plan(
        repository,
        &remote.path,
        objects,
        conflict_file,
        portable_paths,
    ) {
        let _ = git(repository, &["merge", "--abort"], None);
        return Err(error);
    }
    git(repository, &["add", "--all"], None)?;
    if git_success(repository, &["diff", "--cached", "--quiet"]) {
        git(repository, &["commit", "--no-edit"], None)?;
    } else {
        git(
            repository,
            &["commit", "-m", "SkillDock object-level backup merge"],
            None,
        )?;
    }
    Ok(())
}

pub fn list_conflicts() -> Result<Vec<BackupConflict>, String> {
    let repository = crate::backup_snapshot::backup_repo_path()?;
    Ok(read_existing_conflicts(&repository).conflicts)
}

fn write_resolved_object(
    staging: &Path,
    source_root: &Path,
    metadata: &BackupSkillMetadata,
) -> Result<(), String> {
    let backup_id = &metadata.backup_id;
    copy_tree(
        &source_root.join("skills").join(backup_id),
        &staging.join("skills").join(backup_id),
    )?;
    let payload = serde_json::to_string_pretty(metadata)
        .map_err(|error| format!("序列化冲突解决元数据失败: {error}"))?;
    fs::write(
        staging
            .join(".skilldock/skills")
            .join(format!("{backup_id}.json")),
        payload,
    )
    .map_err(|error| format!("写入冲突解决元数据失败: {error}"))
}

fn remove_staged_object(staging: &Path, backup_id: &str) -> Result<(), String> {
    let skill_path = staging.join("skills").join(backup_id);
    if skill_path.exists() {
        fs::remove_dir_all(&skill_path)
            .map_err(|error| format!("清理冲突 Skill 失败 {}: {error}", skill_path.display()))?;
    }
    let metadata_path = staging
        .join(".skilldock/skills")
        .join(format!("{backup_id}.json"));
    if metadata_path.exists() {
        fs::remove_file(&metadata_path).map_err(|error| {
            format!(
                "清理冲突 Skill 元数据失败 {}: {error}",
                metadata_path.display()
            )
        })?;
    }
    Ok(())
}

fn write_resolved_library(
    staging: &Path,
    library: &BackupLibrary,
    conflicts: &BackupConflictFile,
) -> Result<(), String> {
    let library_payload = serde_json::to_string_pretty(library)
        .map_err(|error| format!("序列化冲突解决清单失败: {error}"))?;
    fs::write(staging.join(".skilldock/library.json"), library_payload)
        .map_err(|error| format!("写入冲突解决清单失败: {error}"))?;
    let conflicts_payload = serde_json::to_string_pretty(conflicts)
        .map_err(|error| format!("序列化剩余冲突失败: {error}"))?;
    fs::write(staging.join(".skilldock/conflicts.json"), conflicts_payload)
        .map_err(|error| format!("写入剩余冲突失败: {error}"))
}

pub fn resolve_conflict(
    repository: &Path,
    conflict_id: &str,
    resolution: &str,
) -> Result<(), String> {
    if !matches!(resolution, "keepLocal" | "useRemote" | "keepBoth") {
        return Err("不支持的冲突解决方式".to_string());
    }
    let mut conflict_file = read_existing_conflicts(repository);
    let conflict_index = conflict_file
        .conflicts
        .iter()
        .position(|conflict| conflict.conflict_id == conflict_id)
        .ok_or_else(|| "未找到指定备份冲突".to_string())?;
    let conflict = conflict_file.conflicts[conflict_index].clone();
    let local = materialize_commit(repository, &conflict.local_commit, "resolve-local")?;
    let remote = materialize_commit(repository, &conflict.remote_commit, "resolve-remote")?;
    let staging = repository
        .parent()
        .ok_or_else(|| "备份仓库目录无效".to_string())?
        .join("staging")
        .join(format!("resolve-{}", uuid::Uuid::new_v4()));
    copy_tree(&repository.join("skills"), &staging.join("skills"))?;
    copy_tree(&repository.join(".skilldock"), &staging.join(".skilldock"))?;
    remove_staged_object(&staging, &conflict.backup_id)?;

    let mut library = read_library_snapshot(repository)?;
    library
        .skills
        .retain(|skill| skill.backup_id != conflict.backup_id);
    match resolution {
        "keepLocal" => {
            if let Some(metadata) = conflict.local.clone() {
                write_resolved_object(&staging, &local.path, &metadata)?;
                library.skills.push(metadata);
            }
        }
        "useRemote" => {
            if let Some(metadata) = conflict.remote.clone() {
                write_resolved_object(&staging, &remote.path, &metadata)?;
                library.skills.push(metadata);
            }
        }
        "keepBoth" => {
            if let Some(metadata) = conflict.local.clone() {
                write_resolved_object(&staging, &local.path, &metadata)?;
                library.skills.push(metadata);
            }
            if let Some(mut metadata) = conflict.remote.clone() {
                if conflict.local.is_some() {
                    let original_backup_id = metadata.backup_id.clone();
                    metadata.backup_id = uuid::Uuid::new_v4().to_string();
                    metadata.name = format!("{} (远端)", metadata.name);
                    metadata.directory_name = format!("{}-remote", metadata.directory_name);
                    copy_tree(
                        &remote.path.join("skills").join(original_backup_id),
                        &staging.join("skills").join(&metadata.backup_id),
                    )?;
                    let payload = serde_json::to_string_pretty(&metadata)
                        .map_err(|error| format!("序列化远端副本元数据失败: {error}"))?;
                    fs::write(
                        staging
                            .join(".skilldock/skills")
                            .join(format!("{}.json", metadata.backup_id)),
                        payload,
                    )
                    .map_err(|error| format!("写入远端副本元数据失败: {error}"))?;
                } else {
                    write_resolved_object(&staging, &remote.path, &metadata)?;
                }
                library.skills.push(metadata);
            }
        }
        _ => unreachable!(),
    }
    library
        .skills
        .sort_by(|left, right| left.backup_id.cmp(&right.backup_id));
    conflict_file.conflicts.remove(conflict_index);
    write_resolved_library(&staging, &library, &conflict_file)?;
    replace_directory(&staging.join("skills"), &repository.join("skills"))?;
    replace_directory(&staging.join(".skilldock"), &repository.join(".skilldock"))?;
    let _ = fs::remove_dir_all(staging);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        choose_changed_object, merge_conflict_files, resolve_conflict, BackupConflict,
        BackupConflictFile,
    };
    use crate::backup_repository::git;
    use crate::backup_snapshot::{read_library_snapshot, BackupLibrary, BackupSkillMetadata};
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn metadata(content_hash: &str, name: &str) -> BackupSkillMetadata {
        BackupSkillMetadata {
            schema_version: 1,
            backup_id: "skill-1".into(),
            name: name.into(),
            directory_name: name.into(),
            source_type: "github".into(),
            source_url: "https://github.com/example/skill".into(),
            branch: "main".into(),
            update_driver: "git".into(),
            description: String::new(),
            tools: BTreeMap::new(),
            content_hash: content_hash.into(),
            ..Default::default()
        }
    }

    fn write_snapshot(repository: &Path, skill: &BackupSkillMetadata, content: &str) {
        let skill_path = repository.join("skills").join(&skill.backup_id);
        let metadata_path = repository.join(".skilldock/skills");
        let _ = fs::remove_dir_all(repository.join("skills"));
        let _ = fs::remove_dir_all(repository.join(".skilldock"));
        fs::create_dir_all(&skill_path).expect("create skill path");
        fs::create_dir_all(&metadata_path).expect("create metadata path");
        fs::write(skill_path.join("SKILL.md"), content).expect("write skill content");
        fs::write(
            metadata_path.join(format!("{}.json", skill.backup_id)),
            serde_json::to_string_pretty(skill).expect("serialize metadata"),
        )
        .expect("write metadata");
        let library = BackupLibrary {
            schema_version: 1,
            skills: vec![skill.clone()],
        };
        fs::write(
            repository.join(".skilldock/library.json"),
            serde_json::to_string_pretty(&library).expect("serialize library"),
        )
        .expect("write library");
    }

    fn create_conflicted_repository() -> (PathBuf, PathBuf, String) {
        let temp_root = std::env::temp_dir().join(format!(
            "skilldock-backup-conflict-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let repository = temp_root.join("repository");
        fs::create_dir_all(&repository).expect("create repository");
        git(&repository, &["init", "-b", "main"], None).expect("initialize repository");
        git(
            &repository,
            &["config", "user.name", "SkillDock Backup"],
            None,
        )
        .expect("configure user name");
        git(
            &repository,
            &["config", "user.email", "backup@skilldock.local"],
            None,
        )
        .expect("configure user email");
        let local = metadata("local", "skill-local");
        write_snapshot(&repository, &local, "# local");
        git(&repository, &["add", "--all"], None).expect("stage local snapshot");
        git(&repository, &["commit", "-m", "local"], None).expect("commit local snapshot");
        let local_commit =
            git(&repository, &["rev-parse", "HEAD"], None).expect("read local commit");
        let remote = metadata("remote", "skill-remote");
        write_snapshot(&repository, &remote, "# remote");
        git(&repository, &["add", "--all"], None).expect("stage remote snapshot");
        git(&repository, &["commit", "-m", "remote"], None).expect("commit remote snapshot");
        let remote_commit =
            git(&repository, &["rev-parse", "HEAD"], None).expect("read remote commit");
        git(&repository, &["reset", "--hard", &local_commit], None)
            .expect("restore local snapshot");
        let conflict_id = "conflict-1".to_string();
        let conflicts = BackupConflictFile {
            conflicts: vec![BackupConflict {
                conflict_id: conflict_id.clone(),
                backup_id: "skill-1".into(),
                skill_name: "skill".into(),
                created_at: "2026-07-29T00:00:00Z".into(),
                local_commit,
                remote_commit,
                local: Some(local),
                remote: Some(remote),
            }],
        };
        fs::write(
            repository.join(".skilldock/conflicts.json"),
            serde_json::to_string_pretty(&conflicts).expect("serialize conflicts"),
        )
        .expect("write conflicts");
        (temp_root, repository, conflict_id)
    }

    #[test]
    fn merges_local_content_with_remote_rename() {
        let base = metadata("base", "old-name");
        let local = metadata("local", "old-name");
        let remote = metadata("base", "new-name");

        let merged = choose_changed_object(Some(&base), Some(&local), Some(&remote))
            .expect("merge independent changes");

        assert_eq!(merged.metadata.name, "new-name");
        assert_eq!(merged.metadata.content_hash, "local");
    }

    #[test]
    fn reports_overlapping_content_changes_as_conflict() {
        let base = metadata("base", "skill");
        let local = metadata("local", "skill");
        let remote = metadata("remote", "skill");

        assert!(choose_changed_object(Some(&base), Some(&local), Some(&remote)).is_none());
    }

    #[test]
    fn propagates_resolved_conflict_removal_across_devices() {
        let conflict = BackupConflict {
            conflict_id: "conflict-1".into(),
            backup_id: "skill-1".into(),
            skill_name: "skill".into(),
            created_at: "2026-07-29T00:00:00Z".into(),
            local_commit: "local".into(),
            remote_commit: "remote".into(),
            local: Some(metadata("local", "skill")),
            remote: Some(metadata("remote", "skill")),
        };
        let base = BackupConflictFile {
            conflicts: vec![conflict.clone()],
        };
        let local = BackupConflictFile::default();
        let remote = BackupConflictFile {
            conflicts: vec![conflict],
        };

        let merged = merge_conflict_files(base, local, remote);

        assert!(merged.conflicts.is_empty());
    }

    #[test]
    fn resolves_conflict_with_remote_version() {
        let (temp_root, repository, conflict_id) = create_conflicted_repository();

        resolve_conflict(&repository, &conflict_id, "useRemote").expect("resolve remote version");

        let library = read_library_snapshot(&repository).expect("read resolved library");
        assert_eq!(library.skills[0].name, "skill-remote");
        assert_eq!(
            fs::read_to_string(repository.join("skills/skill-1/SKILL.md"))
                .expect("read remote content"),
            "# remote"
        );
        assert!(super::read_existing_conflicts(&repository)
            .conflicts
            .is_empty());
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn resolves_conflict_by_preserving_both_versions() {
        let (temp_root, repository, conflict_id) = create_conflicted_repository();

        resolve_conflict(&repository, &conflict_id, "keepBoth").expect("preserve both versions");

        let library = read_library_snapshot(&repository).expect("read resolved library");
        assert_eq!(library.skills.len(), 2);
        assert!(library
            .skills
            .iter()
            .any(|skill| skill.name == "skill-local"));
        assert!(library
            .skills
            .iter()
            .any(|skill| skill.name == "skill-remote (远端)"));
        assert!(super::read_existing_conflicts(&repository)
            .conflicts
            .is_empty());
        let _ = fs::remove_dir_all(temp_root);
    }
}
