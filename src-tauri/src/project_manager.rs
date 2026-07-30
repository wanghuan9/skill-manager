use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::mcp_manager::{load_project_mcp_records, upsert_project_mcp_record, McpServerRecord};
use crate::state::load_installed_skills;
use crate::workspace::{managed_skill_library_root, skill_root_paths, workspace_file_path};

const PROJECT_STATE_FILE_NAME: &str = "projects.json";
const PROJECT_STATE_VERSION: u32 = 1;
const PROJECT_CAPABILITY_BIDIRECTIONAL: &str = "bidirectional";
const PROJECT_CAPABILITY_EXPORT_ONLY: &str = "export-only";
const PROJECT_CAPABILITY_UNSUPPORTED: &str = "unsupported";
const SYNC_DIRECTION_MANAGED_TO_PROJECT: &str = "managed-to-project";
const SYNC_DIRECTION_PROJECT_TO_MANAGED: &str = "project-to-managed";
const MCP_SERVERS_FIELD: &str = "mcpServers";
const IGNORED_SKILL_NAMES: [&str; 7] = [
    ".git",
    ".DS_Store",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
];

#[derive(Clone, Copy)]
enum ProjectSkillPathFallback {
    PreferEnabled,
    RequireExisting,
}

#[derive(Clone, Copy)]
struct ProjectToolSpec {
    id: &'static str,
    name: &'static str,
    skill_relative_path: &'static str,
    detect_relative_path: &'static str,
    target_key: &'static str,
    mcp_relative_path: Option<&'static str>,
}

const PROJECT_TOOL_SPECS: [ProjectToolSpec; 28] = [
    ProjectToolSpec {
        id: "claude-code",
        name: "Claude Code",
        skill_relative_path: ".claude/skills",
        detect_relative_path: ".claude",
        target_key: ".claude/skills",
        mcp_relative_path: Some(".mcp.json"),
    },
    ProjectToolSpec {
        id: "codex",
        name: "Codex",
        skill_relative_path: ".codex/skills",
        detect_relative_path: ".codex",
        target_key: ".codex/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "opencode",
        name: "OpenCode",
        skill_relative_path: ".opencode/skills",
        detect_relative_path: ".opencode",
        target_key: ".opencode/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "cursor",
        name: "Cursor",
        skill_relative_path: ".cursor/skills",
        detect_relative_path: ".cursor",
        target_key: ".cursor/skills",
        mcp_relative_path: Some(".cursor/mcp.json"),
    },
    ProjectToolSpec {
        id: "gemini",
        name: "Gemini CLI",
        skill_relative_path: ".gemini/skills",
        detect_relative_path: ".gemini",
        target_key: ".gemini/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "antigravity",
        name: "Antigravity",
        skill_relative_path: ".gemini/antigravity/skills",
        detect_relative_path: ".gemini/antigravity",
        target_key: ".gemini/antigravity/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "windsurf",
        name: "Devin",
        skill_relative_path: ".codeium/windsurf/skills",
        detect_relative_path: ".codeium/windsurf",
        target_key: ".codeium/windsurf/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "openclaw",
        name: "OpenClaw",
        skill_relative_path: ".openclaw/skills",
        detect_relative_path: ".openclaw",
        target_key: ".openclaw/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "continue",
        name: "Continue",
        skill_relative_path: ".continue/skills",
        detect_relative_path: ".continue",
        target_key: ".continue/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "iflow",
        name: "iFlow",
        skill_relative_path: ".iflow/skills",
        detect_relative_path: ".iflow",
        target_key: ".iflow/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "codebuddy",
        name: "CodeBuddy",
        skill_relative_path: ".codebuddy/skills",
        detect_relative_path: ".codebuddy",
        target_key: ".codebuddy/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "trae",
        name: "Trae",
        skill_relative_path: ".trae/skills",
        detect_relative_path: ".trae",
        target_key: ".trae/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "droid",
        name: "Droid",
        skill_relative_path: ".factory/skills",
        detect_relative_path: ".factory",
        target_key: ".factory/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "augment",
        name: "Augment",
        skill_relative_path: ".augment/skills",
        detect_relative_path: ".augment",
        target_key: ".augment/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "cline",
        name: "Cline",
        skill_relative_path: ".agents/skills",
        detect_relative_path: ".cline",
        target_key: ".agents/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "commandcode",
        name: "CommandCode",
        skill_relative_path: ".commandcode/skills",
        detect_relative_path: ".commandcode",
        target_key: ".commandcode/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "crush",
        name: "Crush",
        skill_relative_path: ".config/crush/skills",
        detect_relative_path: ".config/crush",
        target_key: ".config/crush/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "goose",
        name: "Goose",
        skill_relative_path: ".config/goose/skills",
        detect_relative_path: ".config/goose",
        target_key: ".config/goose/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "junie",
        name: "Junie",
        skill_relative_path: ".junie/skills",
        detect_relative_path: ".junie",
        target_key: ".junie/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "kilo-code",
        name: "Kilo Code",
        skill_relative_path: ".kilocode/skills",
        detect_relative_path: ".kilocode",
        target_key: ".kilocode/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "kiro",
        name: "Kiro",
        skill_relative_path: ".kiro/skills",
        detect_relative_path: ".kiro",
        target_key: ".kiro/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "qoder",
        name: "Qoder",
        skill_relative_path: ".qoder/skills",
        detect_relative_path: ".qoder",
        target_key: ".qoder/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "qwen-code",
        name: "Qwen Code",
        skill_relative_path: ".qwen/skills",
        detect_relative_path: ".qwen",
        target_key: ".qwen/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "roo-code",
        name: "Roo Code",
        skill_relative_path: ".roo/skills",
        detect_relative_path: ".roo",
        target_key: ".roo/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "zencoder",
        name: "Zencoder",
        skill_relative_path: ".zencoder/skills",
        detect_relative_path: ".zencoder",
        target_key: ".zencoder/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "trae-cn",
        name: "Trae CN",
        skill_relative_path: ".trae-cn/skills",
        detect_relative_path: ".trae-cn",
        target_key: ".trae-cn/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "hermes",
        name: "Hermes",
        skill_relative_path: ".hermes/skills",
        detect_relative_path: ".hermes",
        target_key: ".hermes/skills",
        mcp_relative_path: None,
    },
    ProjectToolSpec {
        id: "github-copilot",
        name: "GitHub Copilot",
        skill_relative_path: ".copilot/skills",
        detect_relative_path: ".copilot",
        target_key: ".copilot/skills",
        mcp_relative_path: None,
    },
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProject {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub canonical_root_path: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillBinding {
    pub project_id: String,
    pub tool_id: String,
    pub project_relative_path: String,
    pub managed_skill_path: String,
    pub project_capability: String,
    pub baseline_hash: String,
    pub last_synced_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMcpBinding {
    pub project_id: String,
    pub tool_id: String,
    pub config_relative_path: String,
    pub server_name: String,
    pub managed_mcp_id: String,
    pub baseline_hash: String,
    pub last_synced_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPersistence {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    projects: Vec<ManagedProject>,
    #[serde(default)]
    skill_bindings: Vec<ProjectSkillBinding>,
    #[serde(default)]
    mcp_bindings: Vec<ProjectMcpBinding>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManagedSkill {
    pub name: String,
    pub description: String,
    pub local_path: String,
    pub management_owner: String,
    pub project_capability: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManagedMcp {
    pub id: String,
    pub name: String,
    pub server_json: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillInstance {
    pub tool_id: String,
    pub tool_name: String,
    pub name: String,
    pub description: String,
    pub relative_path: String,
    pub local_path: String,
    pub entry_kind: String,
    pub is_enabled: bool,
    pub managed_skill_path: String,
    pub project_capability: String,
    pub content_hash: String,
    pub sync_status: String,
    pub error: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillTarget {
    pub tool_id: String,
    pub tool_name: String,
    pub skill_relative_path: String,
    pub target_key: String,
    pub is_detected: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMcpInstance {
    pub tool_id: String,
    pub tool_name: String,
    pub server_name: String,
    pub config_relative_path: String,
    pub managed_mcp_id: String,
    pub normalized_hash: String,
    pub server_json: String,
    pub sync_status: String,
    pub secret_risk: String,
    pub error: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub canonical_root_path: String,
    pub availability: String,
    pub skill_targets: Vec<ProjectSkillTarget>,
    pub skills: Vec<ProjectSkillInstance>,
    pub mcp_servers: Vec<ProjectMcpInstance>,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkspaceSnapshot {
    pub storage_path: String,
    pub projects: Vec<ProjectDetail>,
    pub managed_skills: Vec<ProjectManagedSkill>,
    pub managed_mcp_servers: Vec<ProjectManagedMcp>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillDistributionResult {
    pub managed_skill_path: String,
    pub skill_name: String,
    pub tool_id: String,
    pub tool_name: String,
    pub status: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillDistributionBatch {
    pub workspace: ProjectWorkspaceSnapshot,
    pub results: Vec<ProjectSkillDistributionResult>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiffFile {
    pub path: String,
    pub status: String,
    pub is_binary: bool,
    pub original_content: Option<String>,
    pub current_content: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillDiffSnapshot {
    pub direction: String,
    pub source_hash: String,
    pub target_hash: String,
    pub files: Vec<ProjectDiffFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMcpDiffField {
    pub path: String,
    pub status: String,
    pub before: Option<Value>,
    pub after: Option<Value>,
    pub sensitive: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMcpDiffSnapshot {
    pub direction: String,
    pub source_hash: String,
    pub target_hash: String,
    pub operation: String,
    pub fields: Vec<ProjectMcpDiffField>,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub fn list_project_workspaces() -> Result<ProjectWorkspaceSnapshot, String> {
    build_project_workspace_snapshot()
}

#[tauri::command]
pub fn add_managed_project(root_path: String) -> Result<ProjectWorkspaceSnapshot, String> {
    let root = PathBuf::from(root_path.trim());
    if !root.is_dir() {
        return Err("请选择存在且可读取的项目目录。".into());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("解析项目目录失败: {error}"))?;
    let mut persistence = load_project_persistence()?;
    let canonical_key = path_key(&canonical_root);
    if persistence
        .projects
        .iter()
        .any(|project| path_key(Path::new(&project.canonical_root_path)) == canonical_key)
    {
        return build_project_workspace_snapshot();
    }

    let name = canonical_root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("project")
        .to_string();
    let timestamp = now_label();
    persistence.projects.push(ManagedProject {
        id: project_id_for_root(&canonical_root),
        name,
        root_path: root.to_string_lossy().to_string(),
        canonical_root_path: canonical_root.to_string_lossy().to_string(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
    });
    persistence
        .projects
        .sort_by(|left, right| left.name.cmp(&right.name));
    save_project_persistence(&persistence)?;
    build_project_workspace_snapshot()
}

#[tauri::command]
pub fn remove_managed_project(project_id: String) -> Result<ProjectWorkspaceSnapshot, String> {
    let mut persistence = load_project_persistence()?;
    persistence
        .projects
        .retain(|project| project.id != project_id);
    persistence
        .skill_bindings
        .retain(|binding| binding.project_id != project_id);
    persistence
        .mcp_bindings
        .retain(|binding| binding.project_id != project_id);
    save_project_persistence(&persistence)?;
    build_project_workspace_snapshot()
}

#[tauri::command]
pub fn distribute_skill_to_project(
    project_id: String,
    tool_id: String,
    managed_skill_path: String,
    target_name: String,
) -> Result<ProjectWorkspaceSnapshot, String> {
    validate_entry_name(&target_name, "Skill 名称")?;
    let mut persistence = load_project_persistence()?;
    let project_root = project_root(&persistence, &project_id)?;
    let tool = project_tool_spec(&tool_id)?;
    let managed_skill = managed_skill_source(&managed_skill_path)?;
    distribute_skill_to_project_entry(
        &mut persistence,
        &project_root,
        &project_id,
        tool,
        &managed_skill,
        target_name.trim(),
    )?;
    save_project_persistence(&persistence)?;
    build_project_workspace_snapshot()
}

#[tauri::command]
pub fn distribute_skills_to_project(
    project_id: String,
    tool_ids: Vec<String>,
    managed_skill_paths: Vec<String>,
) -> Result<ProjectSkillDistributionBatch, String> {
    if tool_ids.is_empty() || managed_skill_paths.is_empty() {
        return Err("请至少选择一个目标工具和一个托管 Skill。".into());
    }

    let mut persistence = load_project_persistence()?;
    let project_root = project_root(&persistence, &project_id)?;
    let unique_tool_ids = tool_ids.into_iter().collect::<BTreeSet<_>>();
    let unique_skill_paths = managed_skill_paths.into_iter().collect::<BTreeSet<_>>();
    let mut results = Vec::new();

    for managed_skill_path in unique_skill_paths {
        let managed_skill = match managed_skill_source(&managed_skill_path) {
            Ok(skill) => skill,
            Err(error) => {
                for tool_id in &unique_tool_ids {
                    results.push(distribution_result(
                        &managed_skill_path,
                        "",
                        tool_id,
                        tool_id,
                        "failed",
                        &error,
                    ));
                }
                continue;
            }
        };
        let mut processed_targets = BTreeMap::<String, (String, String)>::new();

        for tool_id in &unique_tool_ids {
            let tool = match project_tool_spec(tool_id) {
                Ok(tool) => tool,
                Err(error) => {
                    results.push(distribution_result(
                        &managed_skill_path,
                        &managed_skill.name,
                        tool_id,
                        tool_id,
                        "failed",
                        &error,
                    ));
                    continue;
                }
            };
            if let Some((status, message)) = processed_targets.get(tool.target_key) {
                results.push(distribution_result(
                    &managed_skill_path,
                    &managed_skill.name,
                    tool.id,
                    tool.name,
                    status,
                    message,
                ));
                continue;
            }

            let outcome = distribute_skill_to_project_batch_entry(
                &mut persistence,
                &project_root,
                &project_id,
                tool,
                &managed_skill,
            );
            processed_targets.insert(tool.target_key.into(), outcome.clone());
            results.push(distribution_result(
                &managed_skill_path,
                &managed_skill.name,
                tool.id,
                tool.name,
                &outcome.0,
                &outcome.1,
            ));
        }
    }

    let workspace = build_project_workspace_snapshot()?;
    Ok(ProjectSkillDistributionBatch { workspace, results })
}

fn distribute_skill_to_project_batch_entry(
    persistence: &mut ProjectPersistence,
    project_root: &Path,
    project_id: &str,
    tool: ProjectToolSpec,
    managed_skill: &ManagedSkillSource,
) -> (String, String) {
    if let Err(error) = validate_entry_name(&managed_skill.name, "Skill 名称") {
        return ("failed".into(), error);
    }

    let target_root = match safe_project_path(project_root, tool.skill_relative_path) {
        Ok(path) => path,
        Err(error) => return ("failed".into(), error),
    };
    let disabled_root = match project_disabled_skill_root(project_root, tool) {
        Ok(path) => path,
        Err(error) => return ("failed".into(), error),
    };
    let target_path = target_root.join(&managed_skill.name);
    let disabled_path = disabled_root.join(&managed_skill.name);
    let existing_paths = [&target_path, &disabled_path]
        .into_iter()
        .filter(|path| fs::symlink_metadata(path).is_ok())
        .collect::<Vec<_>>();

    if existing_paths.len() > 1 {
        return (
            "conflict".into(),
            "启用和关闭目录中都存在同名 Skill。".into(),
        );
    }
    if let Some(existing_path) = existing_paths.first() {
        let existing_hash = hash_skill_directory(existing_path);
        let managed_hash = hash_skill_directory(&managed_skill.path);
        if existing_hash.is_err() || managed_hash.is_err() || existing_hash != managed_hash {
            return (
                "conflict".into(),
                "项目中已存在同名但内容不同的 Skill。".into(),
            );
        }
        let relative_path = match relative_path_string(project_root, &target_path) {
            Ok(path) => path,
            Err(error) => return ("failed".into(), error),
        };
        upsert_project_skill_binding(
            persistence,
            project_id,
            tool.id,
            &relative_path,
            managed_skill,
            &existing_hash.unwrap_or_default(),
        );
        return match save_project_persistence(persistence) {
            Ok(()) => (
                "skipped".into(),
                "项目中已存在相同内容，已保留现有文件。".into(),
            ),
            Err(error) => ("failed".into(), error),
        };
    }

    let distributed = distribute_skill_to_project_entry(
        persistence,
        project_root,
        project_id,
        tool,
        managed_skill,
        &managed_skill.name,
    );
    if let Err(error) = distributed {
        return ("failed".into(), error);
    }
    match save_project_persistence(persistence) {
        Ok(()) => ("distributed".into(), "已下发到项目。".into()),
        Err(error) => ("failed".into(), error),
    }
}

fn distribute_skill_to_project_entry(
    persistence: &mut ProjectPersistence,
    project_root: &Path,
    project_id: &str,
    tool: ProjectToolSpec,
    managed_skill: &ManagedSkillSource,
    target_name: &str,
) -> Result<(), String> {
    let target_root = safe_project_path(project_root, tool.skill_relative_path)?;
    let target_path = target_root.join(target_name);
    let disabled_root = project_disabled_skill_root(project_root, tool)?;
    let disabled_path = disabled_root.join(target_name);
    if fs::symlink_metadata(&target_path).is_ok() || fs::symlink_metadata(&disabled_path).is_ok() {
        return Err("项目目标位置已存在，请先比较或选择其他名称。".into());
    }

    replace_skill_directory(&managed_skill.path, &target_path, false)?;
    let baseline_hash = hash_skill_directory(&target_path)?;
    let relative_path = relative_path_string(project_root, &target_path)?;
    upsert_project_skill_binding(
        persistence,
        project_id,
        tool.id,
        &relative_path,
        managed_skill,
        &baseline_hash,
    );
    Ok(())
}

fn upsert_project_skill_binding(
    persistence: &mut ProjectPersistence,
    project_id: &str,
    tool_id: &str,
    project_relative_path: &str,
    managed_skill: &ManagedSkillSource,
    baseline_hash: &str,
) {
    persistence.skill_bindings.retain(|binding| {
        !(binding.project_id == project_id
            && binding.tool_id == tool_id
            && binding.project_relative_path == project_relative_path)
    });
    persistence.skill_bindings.push(ProjectSkillBinding {
        project_id: project_id.into(),
        tool_id: tool_id.into(),
        project_relative_path: project_relative_path.into(),
        managed_skill_path: managed_skill.path.to_string_lossy().to_string(),
        project_capability: managed_skill.capability.clone(),
        baseline_hash: baseline_hash.into(),
        last_synced_at: now_label(),
    });
}

fn distribution_result(
    managed_skill_path: &str,
    skill_name: &str,
    tool_id: &str,
    tool_name: &str,
    status: &str,
    message: &str,
) -> ProjectSkillDistributionResult {
    ProjectSkillDistributionResult {
        managed_skill_path: managed_skill_path.into(),
        skill_name: skill_name.into(),
        tool_id: tool_id.into(),
        tool_name: tool_name.into(),
        status: status.into(),
        message: message.into(),
    }
}

#[tauri::command]
pub fn import_project_skill(
    project_id: String,
    tool_id: String,
    project_relative_path: String,
) -> Result<ProjectWorkspaceSnapshot, String> {
    let mut persistence = load_project_persistence()?;
    let project_root = project_root(&persistence, &project_id)?;
    let tool = project_tool_spec(&tool_id)?;
    let project_path = resolve_project_skill_path(
        &project_root,
        tool,
        &project_relative_path,
        ProjectSkillPathFallback::RequireExisting,
    )?;
    ensure_real_skill_directory(&project_path, "项目 Skill")?;
    let skill_name = project_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if load_installed_skills(&[])
        .iter()
        .any(|skill| skill.name.eq_ignore_ascii_case(skill_name))
    {
        return Err("托管库中已存在同名 Skill，请先比较或换名。".into());
    }

    let imported = crate::commands::import_local_skill(&project_path.to_string_lossy())?;
    let baseline_hash = hash_skill_directory(&project_path)?;
    persistence.skill_bindings.retain(|binding| {
        !(binding.project_id == project_id
            && binding.tool_id == tool_id
            && binding.project_relative_path == project_relative_path)
    });
    persistence.skill_bindings.push(ProjectSkillBinding {
        project_id,
        tool_id,
        project_relative_path,
        managed_skill_path: imported.local_path,
        project_capability: PROJECT_CAPABILITY_BIDIRECTIONAL.into(),
        baseline_hash,
        last_synced_at: now_label(),
    });
    save_project_persistence(&persistence)?;
    build_project_workspace_snapshot()
}

#[tauri::command]
pub fn preview_project_skill_sync(
    project_id: String,
    tool_id: String,
    project_relative_path: String,
    direction: String,
) -> Result<ProjectSkillDiffSnapshot, String> {
    let persistence = load_project_persistence()?;
    let binding = find_skill_binding(&persistence, &project_id, &tool_id, &project_relative_path)?;
    let project_root = project_root(&persistence, &project_id)?;
    let tool = project_tool_spec(&tool_id)?;
    let project_path = resolve_project_skill_path(
        &project_root,
        tool,
        &project_relative_path,
        ProjectSkillPathFallback::PreferEnabled,
    )?;
    let managed_path = PathBuf::from(&binding.managed_skill_path);
    let capability = managed_skill_capability(&managed_path)?;
    if direction == SYNC_DIRECTION_PROJECT_TO_MANAGED
        && capability != PROJECT_CAPABILITY_BIDIRECTIONAL
    {
        return Err("Agent Skills CLI 托管的 Skill 只支持下发到项目，不能反向同步。".into());
    }
    let (source, target) = skill_sync_paths(&direction, &project_path, &managed_path)?;
    build_skill_diff_snapshot(&direction, source, target)
}

#[tauri::command]
pub fn sync_project_skill(
    project_id: String,
    tool_id: String,
    project_relative_path: String,
    direction: String,
    source_hash: String,
    target_hash: String,
) -> Result<ProjectWorkspaceSnapshot, String> {
    let mut persistence = load_project_persistence()?;
    let binding_index =
        skill_binding_index(&persistence, &project_id, &tool_id, &project_relative_path)?;
    let binding = persistence.skill_bindings[binding_index].clone();
    let managed_path = PathBuf::from(&binding.managed_skill_path);
    let capability = managed_skill_capability(&managed_path)?;
    if direction == SYNC_DIRECTION_PROJECT_TO_MANAGED
        && capability != PROJECT_CAPABILITY_BIDIRECTIONAL
    {
        return Err("Agent Skills CLI 托管的 Skill 只支持下发到项目，不能反向同步。".into());
    }
    let project_root = project_root(&persistence, &project_id)?;
    let tool = project_tool_spec(&tool_id)?;
    let project_path = resolve_project_skill_path(
        &project_root,
        tool,
        &project_relative_path,
        ProjectSkillPathFallback::PreferEnabled,
    )?;
    let (source, target) = skill_sync_paths(&direction, &project_path, &managed_path)?;
    verify_preview_hashes(source, target, &source_hash, &target_hash)?;
    let preserve_git = direction == SYNC_DIRECTION_PROJECT_TO_MANAGED;
    replace_skill_directory(source, target, preserve_git)?;
    let baseline_hash = hash_skill_directory(source)?;
    persistence.skill_bindings[binding_index].project_capability = capability.into();
    persistence.skill_bindings[binding_index].baseline_hash = baseline_hash;
    persistence.skill_bindings[binding_index].last_synced_at = now_label();
    save_project_persistence(&persistence)?;
    build_project_workspace_snapshot()
}

#[tauri::command]
pub fn toggle_project_skill(
    project_id: String,
    tool_id: String,
    project_relative_path: String,
    enabled: bool,
) -> Result<ProjectWorkspaceSnapshot, String> {
    let persistence = load_project_persistence()?;
    let project_root = project_root(&persistence, &project_id)?;
    let tool = project_tool_spec(&tool_id)?;
    set_project_skill_enabled_state(&project_root, tool, &project_relative_path, enabled)?;
    build_project_workspace_snapshot()
}

fn set_project_skill_enabled_state(
    project_root: &Path,
    tool: ProjectToolSpec,
    project_relative_path: &str,
    enabled: bool,
) -> Result<(), String> {
    let enabled_root = safe_project_path(&project_root, tool.skill_relative_path)?;
    let disabled_root = project_disabled_skill_root(&project_root, tool)?;
    let enabled_path = project_skill_enabled_path(&project_root, tool, &project_relative_path)?;
    let disabled_path = project_skill_disabled_path(&project_root, tool, &project_relative_path)?;
    let (source, target, source_root, source_label, target_label) = if enabled {
        (
            &disabled_path,
            &enabled_path,
            &disabled_root,
            "关闭目录",
            "启用目录",
        )
    } else {
        (
            &enabled_path,
            &disabled_path,
            &enabled_root,
            "启用目录",
            "关闭目录",
        )
    };

    ensure_real_skill_directory(source, source_label)?;
    if fs::symlink_metadata(target).is_ok() {
        return Err(format!(
            "{target_label}中已存在同名 Skill，请先处理目录冲突。"
        ));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建项目 Skill 目录失败: {error}"))?;
    }
    fs::rename(source, target).map_err(|error| format!("切换项目 Skill 状态失败: {error}"))?;
    cleanup_empty_project_skill_parents(source.parent(), source_root);
    Ok(())
}

#[tauri::command]
pub fn distribute_mcp_to_project(
    project_id: String,
    tool_id: String,
    managed_mcp_id: String,
    server_name: String,
) -> Result<ProjectWorkspaceSnapshot, String> {
    validate_entry_name(&server_name, "MCP Server 名称")?;
    let mut persistence = load_project_persistence()?;
    let project_root = project_root(&persistence, &project_id)?;
    let tool = project_tool_spec(&tool_id)?;
    let config_relative_path = tool
        .mcp_relative_path
        .ok_or_else(|| "该工具尚未开放项目级 MCP。".to_string())?;
    let record = managed_mcp_record(&managed_mcp_id)?;
    ensure_mcp_server_distributable(&record.server)?;
    let config_path = safe_project_path(&project_root, config_relative_path)?;
    let servers = read_project_mcp_servers(&config_path)?;
    if servers.contains_key(server_name.trim()) {
        return Err("项目配置中已存在同名 MCP Server，请先比较或换名。".into());
    }
    upsert_project_mcp_server(&config_path, server_name.trim(), &record.server)?;
    let baseline_hash = hash_json_value(&record.server)?;
    persistence.mcp_bindings.push(ProjectMcpBinding {
        project_id,
        tool_id,
        config_relative_path: config_relative_path.into(),
        server_name: server_name.trim().into(),
        managed_mcp_id,
        baseline_hash,
        last_synced_at: now_label(),
    });
    save_project_persistence(&persistence)?;
    build_project_workspace_snapshot()
}

#[tauri::command]
pub fn import_project_mcp(
    project_id: String,
    tool_id: String,
    server_name: String,
) -> Result<ProjectWorkspaceSnapshot, String> {
    let mut persistence = load_project_persistence()?;
    let project_root = project_root(&persistence, &project_id)?;
    let tool = project_tool_spec(&tool_id)?;
    let config_relative_path = tool
        .mcp_relative_path
        .ok_or_else(|| "该工具尚未开放项目级 MCP。".to_string())?;
    let config_path = safe_project_path(&project_root, config_relative_path)?;
    let servers = read_project_mcp_servers(&config_path)?;
    let server = servers
        .get(&server_name)
        .cloned()
        .ok_or_else(|| "项目配置中未找到该 MCP Server。".to_string())?;
    ensure_mcp_server_distributable(&server)?;
    if load_project_mcp_records()?
        .iter()
        .any(|record| record.id == server_name)
    {
        return Err("托管 MCP 中已存在同名 Server，请先比较或换名。".into());
    }
    upsert_project_mcp_record(&server_name, &server_name, server.clone())?;
    let baseline_hash = hash_json_value(&server)?;
    persistence.mcp_bindings.push(ProjectMcpBinding {
        project_id,
        tool_id,
        config_relative_path: config_relative_path.into(),
        server_name: server_name.clone(),
        managed_mcp_id: server_name,
        baseline_hash,
        last_synced_at: now_label(),
    });
    save_project_persistence(&persistence)?;
    build_project_workspace_snapshot()
}

#[tauri::command]
pub fn preview_project_mcp_sync(
    project_id: String,
    tool_id: String,
    server_name: String,
    direction: String,
) -> Result<ProjectMcpDiffSnapshot, String> {
    let persistence = load_project_persistence()?;
    let binding = find_mcp_binding(&persistence, &project_id, &tool_id, &server_name)?;
    let project_root = project_root(&persistence, &project_id)?;
    let config_path = safe_project_path(&project_root, &binding.config_relative_path)?;
    let project_server = read_project_mcp_servers(&config_path)?
        .get(&server_name)
        .cloned();
    let managed_server = load_project_mcp_records()?
        .into_iter()
        .find(|record| record.id == binding.managed_mcp_id)
        .map(|record| record.server);
    build_mcp_diff_snapshot(&direction, project_server, managed_server)
}

#[tauri::command]
pub fn sync_project_mcp(
    project_id: String,
    tool_id: String,
    server_name: String,
    direction: String,
    source_hash: String,
    target_hash: String,
) -> Result<ProjectWorkspaceSnapshot, String> {
    let mut persistence = load_project_persistence()?;
    let binding_index = mcp_binding_index(&persistence, &project_id, &tool_id, &server_name)?;
    let binding = persistence.mcp_bindings[binding_index].clone();
    let project_root = project_root(&persistence, &project_id)?;
    let config_path = safe_project_path(&project_root, &binding.config_relative_path)?;
    let project_server = read_project_mcp_servers(&config_path)?
        .get(&server_name)
        .cloned();
    let managed_record = load_project_mcp_records()?
        .into_iter()
        .find(|record| record.id == binding.managed_mcp_id);
    let (source, target) = if direction == SYNC_DIRECTION_PROJECT_TO_MANAGED {
        (
            project_server.as_ref(),
            managed_record.as_ref().map(|record| &record.server),
        )
    } else if direction == SYNC_DIRECTION_MANAGED_TO_PROJECT {
        (
            managed_record.as_ref().map(|record| &record.server),
            project_server.as_ref(),
        )
    } else {
        return Err("不支持的同步方向。".into());
    };
    let source = source.ok_or_else(|| "同步来源已不存在，请刷新后重试。".to_string())?;
    verify_optional_json_preview_hashes(Some(source), target, &source_hash, &target_hash)?;
    ensure_mcp_server_distributable(source)?;
    if direction == SYNC_DIRECTION_PROJECT_TO_MANAGED {
        upsert_project_mcp_record(
            &binding.managed_mcp_id,
            managed_record
                .as_ref()
                .map(|record| record.name.as_str())
                .unwrap_or(&binding.managed_mcp_id),
            source.clone(),
        )?;
    } else {
        upsert_project_mcp_server(&config_path, &server_name, source)?;
    }
    persistence.mcp_bindings[binding_index].baseline_hash = hash_json_value(source)?;
    persistence.mcp_bindings[binding_index].last_synced_at = now_label();
    save_project_persistence(&persistence)?;
    build_project_workspace_snapshot()
}

#[tauri::command]
pub fn unlink_project_resource(
    project_id: String,
    resource_type: String,
    tool_id: String,
    resource_key: String,
) -> Result<ProjectWorkspaceSnapshot, String> {
    let mut persistence = load_project_persistence()?;
    if resource_type == "skill" {
        persistence.skill_bindings.retain(|binding| {
            !(binding.project_id == project_id
                && binding.tool_id == tool_id
                && binding.project_relative_path == resource_key)
        });
    } else if resource_type == "mcp" {
        persistence.mcp_bindings.retain(|binding| {
            !(binding.project_id == project_id
                && binding.tool_id == tool_id
                && binding.server_name == resource_key)
        });
    } else {
        return Err("不支持的项目资源类型。".into());
    }
    save_project_persistence(&persistence)?;
    build_project_workspace_snapshot()
}

struct ManagedSkillSource {
    name: String,
    path: PathBuf,
    capability: String,
}

fn build_project_workspace_snapshot() -> Result<ProjectWorkspaceSnapshot, String> {
    let persistence = load_project_persistence()?;
    let managed_skills = project_managed_skills();
    let managed_mcp_records = load_project_mcp_records()?;
    let managed_mcp_servers = managed_mcp_records
        .iter()
        .map(|record| ProjectManagedMcp {
            id: record.id.clone(),
            name: record.name.clone(),
            server_json: serde_json::to_string_pretty(&record.server).unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    let projects = persistence
        .projects
        .iter()
        .map(|project| {
            build_project_detail(
                project,
                &persistence.skill_bindings,
                &persistence.mcp_bindings,
                &managed_skills,
                &managed_mcp_records,
            )
        })
        .collect::<Vec<_>>();
    let storage_path = project_state_file()?.to_string_lossy().to_string();
    Ok(ProjectWorkspaceSnapshot {
        storage_path,
        projects,
        managed_skills,
        managed_mcp_servers,
    })
}

fn build_project_detail(
    project: &ManagedProject,
    skill_bindings: &[ProjectSkillBinding],
    mcp_bindings: &[ProjectMcpBinding],
    managed_skills: &[ProjectManagedSkill],
    managed_mcp_records: &[McpServerRecord],
) -> ProjectDetail {
    let root = PathBuf::from(&project.canonical_root_path);
    if !root.is_dir() {
        return ProjectDetail {
            id: project.id.clone(),
            name: project.name.clone(),
            root_path: project.root_path.clone(),
            canonical_root_path: project.canonical_root_path.clone(),
            availability: "missing".into(),
            skill_targets: project_skill_targets(&root),
            skills: Vec::new(),
            mcp_servers: Vec::new(),
            errors: Vec::new(),
        };
    }

    let mut skills = Vec::new();
    let mut mcp_servers = Vec::new();
    let mut errors = Vec::new();
    for tool in PROJECT_TOOL_SPECS {
        match scan_project_skills(&root, tool, &project.id, skill_bindings, managed_skills) {
            Ok(mut values) => skills.append(&mut values),
            Err(error) => errors.push(format!("{} Skill: {error}", tool.name)),
        }
        if tool.mcp_relative_path.is_some() {
            match scan_project_mcp_servers(
                &root,
                tool,
                &project.id,
                mcp_bindings,
                managed_mcp_records,
            ) {
                Ok(mut values) => mcp_servers.append(&mut values),
                Err(error) => errors.push(format!("{} MCP: {error}", tool.name)),
            }
        }
    }
    skills.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.tool_name.cmp(&right.tool_name))
    });
    mcp_servers.sort_by(|left, right| {
        left.server_name
            .cmp(&right.server_name)
            .then(left.tool_name.cmp(&right.tool_name))
    });
    ProjectDetail {
        id: project.id.clone(),
        name: project.name.clone(),
        root_path: project.root_path.clone(),
        canonical_root_path: project.canonical_root_path.clone(),
        availability: "available".into(),
        skill_targets: project_skill_targets(&root),
        skills,
        mcp_servers,
        errors,
    }
}

fn project_skill_targets(project_root: &Path) -> Vec<ProjectSkillTarget> {
    PROJECT_TOOL_SPECS
        .iter()
        .map(|tool| ProjectSkillTarget {
            tool_id: tool.id.into(),
            tool_name: tool.name.into(),
            skill_relative_path: tool.skill_relative_path.into(),
            target_key: tool.target_key.into(),
            is_detected: project_root.join(tool.skill_relative_path).exists()
                || project_root.join(tool.detect_relative_path).exists(),
        })
        .collect()
}

fn project_managed_skills() -> Vec<ProjectManagedSkill> {
    let mut skills = load_installed_skills(&[])
        .into_iter()
        .filter_map(|skill| {
            let path = managed_skill_path(&skill.instance.canonical_path, &skill.local_path);
            if !path.is_dir() || !path.join("SKILL.md").is_file() {
                return None;
            }
            let capability = project_capability_for_owner(&skill.instance.management_owner);
            if capability == PROJECT_CAPABILITY_UNSUPPORTED {
                return None;
            }
            Some(ProjectManagedSkill {
                name: skill.name,
                description: skill.description,
                local_path: path.to_string_lossy().to_string(),
                management_owner: skill.instance.management_owner,
                project_capability: capability.into(),
            })
        })
        .collect::<Vec<_>>();
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    skills
}

fn managed_skill_path(canonical_path: &str, local_path: &str) -> PathBuf {
    if canonical_path.trim().is_empty() {
        PathBuf::from(local_path)
    } else {
        PathBuf::from(canonical_path)
    }
}

fn project_capability_for_owner(owner: &str) -> &'static str {
    match owner {
        "skilldock" => PROJECT_CAPABILITY_BIDIRECTIONAL,
        "agent-skills-cli" => PROJECT_CAPABILITY_EXPORT_ONLY,
        _ => PROJECT_CAPABILITY_UNSUPPORTED,
    }
}

fn scan_project_skills(
    project_root: &Path,
    tool: ProjectToolSpec,
    project_id: &str,
    bindings: &[ProjectSkillBinding],
    managed_skills: &[ProjectManagedSkill],
) -> Result<Vec<ProjectSkillInstance>, String> {
    let enabled_root = safe_project_path(project_root, tool.skill_relative_path)?;
    let disabled_root = project_disabled_skill_root(project_root, tool)?;
    let mut instances = scan_project_skill_root(
        &enabled_root,
        tool,
        project_id,
        bindings,
        managed_skills,
        true,
    )?;
    instances.extend(scan_project_skill_root(
        &disabled_root,
        tool,
        project_id,
        bindings,
        managed_skills,
        false,
    )?);
    append_missing_project_skill_bindings(
        project_root,
        tool,
        project_id,
        bindings,
        managed_skills,
        &mut instances,
    );
    Ok(instances)
}

fn scan_project_skill_root(
    root: &Path,
    tool: ProjectToolSpec,
    project_id: &str,
    bindings: &[ProjectSkillBinding],
    managed_skills: &[ProjectManagedSkill],
    is_enabled: bool,
) -> Result<Vec<ProjectSkillInstance>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    if !root.is_dir() {
        return Err("项目 Skill 路径不是目录。".into());
    }
    let mut skill_paths = Vec::new();
    collect_project_skill_paths(root, root, 0, &mut skill_paths)?;
    let mut instances = Vec::new();
    for (path, entry_kind) in skill_paths {
        let relative_path = project_skill_binding_relative_path(root, &path, tool)?;
        let content_hash = if entry_kind == "directory" {
            hash_skill_directory(&path).unwrap_or_default()
        } else {
            String::new()
        };
        let binding = bindings.iter().find(|binding| {
            binding.project_id == project_id
                && binding.tool_id == tool.id
                && binding.project_relative_path == relative_path
        });
        let managed_skill = binding.and_then(|binding| {
            managed_skills.iter().find(|skill| {
                path_key(Path::new(&skill.local_path))
                    == path_key(Path::new(&binding.managed_skill_path))
            })
        });
        let managed_hash =
            managed_skill.and_then(|skill| hash_skill_directory(Path::new(&skill.local_path)).ok());
        let sync_status = binding
            .map(|binding| {
                sync_status(
                    Some(content_hash.as_str()),
                    managed_hash.as_deref(),
                    &binding.baseline_hash,
                )
            })
            .unwrap_or("project-only");
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("skill")
            .to_string();
        let description = read_skill_description(&path.join("SKILL.md"));
        instances.push(ProjectSkillInstance {
            tool_id: tool.id.into(),
            tool_name: tool.name.into(),
            name,
            description,
            relative_path,
            local_path: path.to_string_lossy().to_string(),
            entry_kind: entry_kind.into(),
            is_enabled,
            managed_skill_path: binding
                .map(|binding| binding.managed_skill_path.clone())
                .unwrap_or_default(),
            project_capability: binding
                .map(|binding| binding.project_capability.clone())
                .unwrap_or_default(),
            content_hash,
            sync_status: if entry_kind == "directory" {
                sync_status.into()
            } else {
                "unavailable".into()
            },
            error: if entry_kind == "directory" {
                String::new()
            } else {
                "项目 Skill 是符号链接，首版只读展示。".into()
            },
        });
    }
    Ok(instances)
}

fn append_missing_project_skill_bindings(
    project_root: &Path,
    tool: ProjectToolSpec,
    project_id: &str,
    bindings: &[ProjectSkillBinding],
    managed_skills: &[ProjectManagedSkill],
    instances: &mut Vec<ProjectSkillInstance>,
) {
    let existing_paths = instances
        .iter()
        .map(|instance| instance.relative_path.clone())
        .collect::<BTreeSet<_>>();
    for binding in bindings.iter().filter(|binding| {
        binding.project_id == project_id
            && binding.tool_id == tool.id
            && !existing_paths.contains(&binding.project_relative_path)
    }) {
        let Ok(path) =
            project_skill_enabled_path(project_root, tool, &binding.project_relative_path)
        else {
            continue;
        };
        let managed_skill = managed_skills.iter().find(|skill| {
            path_key(Path::new(&skill.local_path))
                == path_key(Path::new(&binding.managed_skill_path))
        });
        let managed_hash =
            managed_skill.and_then(|skill| hash_skill_directory(Path::new(&skill.local_path)).ok());
        instances.push(ProjectSkillInstance {
            tool_id: tool.id.into(),
            tool_name: tool.name.into(),
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("skill")
                .into(),
            description: managed_skill
                .map(|skill| skill.description.clone())
                .unwrap_or_default(),
            relative_path: binding.project_relative_path.clone(),
            local_path: path.to_string_lossy().to_string(),
            entry_kind: "missing".into(),
            is_enabled: true,
            managed_skill_path: binding.managed_skill_path.clone(),
            project_capability: binding.project_capability.clone(),
            content_hash: String::new(),
            sync_status: sync_status(None, managed_hash.as_deref(), &binding.baseline_hash).into(),
            error: "项目 Skill 已不存在，可从托管端恢复。".into(),
        });
    }
}

fn collect_project_skill_paths(
    root: &Path,
    current: &Path,
    depth: usize,
    output: &mut Vec<(PathBuf, &'static str)>,
) -> Result<(), String> {
    if depth > 5 {
        return Ok(());
    }
    let mut entries = fs::read_dir(current)
        .map_err(|error| format!("读取项目 Skill 目录失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取项目 Skill 条目失败: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if should_ignore_skill_name(&name) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("读取项目 Skill 元数据失败: {error}"))?;
        if metadata.file_type().is_symlink() {
            if path.join("SKILL.md").is_file() {
                output.push((path, "symlink"));
            }
            continue;
        }
        if !metadata.is_dir() {
            continue;
        }
        if path.join("SKILL.md").is_file() {
            output.push((path, "directory"));
            continue;
        }
        if path.starts_with(root) {
            collect_project_skill_paths(root, &path, depth + 1, output)?;
        }
    }
    Ok(())
}

fn scan_project_mcp_servers(
    project_root: &Path,
    tool: ProjectToolSpec,
    project_id: &str,
    bindings: &[ProjectMcpBinding],
    managed_records: &[McpServerRecord],
) -> Result<Vec<ProjectMcpInstance>, String> {
    let config_relative_path = tool.mcp_relative_path.unwrap_or_default();
    let config_path = safe_project_path(project_root, config_relative_path)?;
    let servers = read_project_mcp_servers(&config_path)?;
    let existing_server_names = servers.keys().cloned().collect::<BTreeSet<_>>();
    let mut instances = servers
        .into_iter()
        .map(|(server_name, server)| {
            let normalized_hash = hash_json_value(&server)?;
            let binding = bindings.iter().find(|binding| {
                binding.project_id == project_id
                    && binding.tool_id == tool.id
                    && binding.server_name == server_name
            });
            let managed_server = binding.and_then(|binding| {
                managed_records
                    .iter()
                    .find(|record| record.id == binding.managed_mcp_id)
                    .map(|record| &record.server)
            });
            let managed_hash = managed_server.and_then(|value| hash_json_value(value).ok());
            let status = binding
                .map(|binding| {
                    sync_status(
                        Some(normalized_hash.as_str()),
                        managed_hash.as_deref(),
                        &binding.baseline_hash,
                    )
                })
                .unwrap_or("project-only");
            let secret_risk = if mcp_secret_paths(&server).is_empty() {
                "none"
            } else {
                "literal-secret-suspected"
            };
            Ok(ProjectMcpInstance {
                tool_id: tool.id.into(),
                tool_name: tool.name.into(),
                server_name,
                config_relative_path: config_relative_path.into(),
                managed_mcp_id: binding
                    .map(|binding| binding.managed_mcp_id.clone())
                    .unwrap_or_default(),
                normalized_hash,
                server_json: serde_json::to_string_pretty(&server).unwrap_or_default(),
                sync_status: status.into(),
                secret_risk: secret_risk.into(),
                error: String::new(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    for binding in bindings.iter().filter(|binding| {
        binding.project_id == project_id
            && binding.tool_id == tool.id
            && !existing_server_names.contains(&binding.server_name)
    }) {
        let managed_server = managed_records
            .iter()
            .find(|record| record.id == binding.managed_mcp_id)
            .map(|record| &record.server);
        let managed_hash = managed_server.and_then(|value| hash_json_value(value).ok());
        instances.push(ProjectMcpInstance {
            tool_id: tool.id.into(),
            tool_name: tool.name.into(),
            server_name: binding.server_name.clone(),
            config_relative_path: binding.config_relative_path.clone(),
            managed_mcp_id: binding.managed_mcp_id.clone(),
            normalized_hash: String::new(),
            server_json: String::new(),
            sync_status: sync_status(None, managed_hash.as_deref(), &binding.baseline_hash).into(),
            secret_risk: "none".into(),
            error: "项目 MCP Server 已不存在，可从托管端恢复。".into(),
        });
    }
    Ok(instances)
}

fn sync_status(
    project_hash: Option<&str>,
    managed_hash: Option<&str>,
    baseline: &str,
) -> &'static str {
    match (project_hash, managed_hash) {
        (None, Some(_)) => "project-missing",
        (Some(_), None) => "managed-missing",
        (None, None) => "unavailable",
        (Some(project), Some(managed)) if project == managed => "in-sync",
        (Some(project), Some(managed)) if project != baseline && managed == baseline => {
            "project-changed"
        }
        (Some(project), Some(managed)) if project == baseline && managed != baseline => {
            "managed-changed"
        }
        (Some(_), Some(_)) => "diverged",
    }
}

fn managed_skill_source(path: &str) -> Result<ManagedSkillSource, String> {
    let requested = PathBuf::from(path.trim());
    let requested_key = path_key(&requested);
    let skill = project_managed_skills()
        .into_iter()
        .find(|skill| path_key(Path::new(&skill.local_path)) == requested_key)
        .ok_or_else(|| "未找到可下发的托管 Skill。".to_string())?;
    Ok(ManagedSkillSource {
        name: skill.name,
        path: PathBuf::from(skill.local_path),
        capability: skill.project_capability,
    })
}

fn managed_skill_capability(path: &Path) -> Result<&'static str, String> {
    if let Some(skill) = project_managed_skills()
        .into_iter()
        .find(|skill| path_key(Path::new(&skill.local_path)) == path_key(path))
    {
        return Ok(project_capability_for_owner(&skill.management_owner));
    }

    let skilldock_root = managed_skill_library_root()?;
    if is_safe_managed_skill_path(path, &skilldock_root) {
        return Ok(PROJECT_CAPABILITY_BIDIRECTIONAL);
    }
    let agent_root = skill_root_paths(true)?
        .into_iter()
        .find(|root| root != &skilldock_root)
        .ok_or_else(|| "无法确定 Agent Skills CLI 托管目录。".to_string())?;
    if is_safe_managed_skill_path(path, &agent_root) {
        return Ok(PROJECT_CAPABILITY_EXPORT_ONLY);
    }
    Err("关联的托管 Skill 路径不在受支持的托管目录中。".into())
}

fn is_safe_managed_skill_path(path: &Path, root: &Path) -> bool {
    if !path.is_absolute()
        || path == root
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return false;
    }
    let Ok(canonical_root) = root.canonicalize() else {
        return false;
    };
    let Some(existing_ancestor) = path.ancestors().find(|ancestor| ancestor.exists()) else {
        return false;
    };
    existing_ancestor
        .canonicalize()
        .is_ok_and(|ancestor| ancestor.starts_with(canonical_root))
}

fn managed_mcp_record(id: &str) -> Result<McpServerRecord, String> {
    load_project_mcp_records()?
        .into_iter()
        .find(|record| record.id == id)
        .ok_or_else(|| "未找到可下发的托管 MCP Server。".to_string())
}

fn build_skill_diff_snapshot(
    direction: &str,
    source: &Path,
    target: &Path,
) -> Result<ProjectSkillDiffSnapshot, String> {
    let source_files = collect_skill_files(source)?;
    let target_files = collect_optional_skill_files(target)?;
    let source_hash = hash_collected_files(&source_files);
    let target_hash = if target.exists() {
        hash_collected_files(&target_files)
    } else {
        String::new()
    };
    let mut paths = source_files.keys().cloned().collect::<BTreeSet<_>>();
    paths.extend(target_files.keys().cloned());
    let files = paths
        .into_iter()
        .filter_map(|path| {
            let source_value = source_files.get(&path);
            let target_value = target_files.get(&path);
            if source_value == target_value {
                return None;
            }
            let status = match (source_value, target_value) {
                (Some(_), None) => "added",
                (None, Some(_)) => "deleted",
                (Some(_), Some(_)) => "modified",
                (None, None) => return None,
            };
            let is_binary = source_value.is_some_and(|value| std::str::from_utf8(value).is_err())
                || target_value.is_some_and(|value| std::str::from_utf8(value).is_err());
            Some(ProjectDiffFile {
                path,
                status: status.into(),
                is_binary,
                original_content: if is_binary {
                    None
                } else {
                    target_value.and_then(|value| String::from_utf8(value.clone()).ok())
                },
                current_content: if is_binary {
                    None
                } else {
                    source_value.and_then(|value| String::from_utf8(value.clone()).ok())
                },
            })
        })
        .collect();
    Ok(ProjectSkillDiffSnapshot {
        direction: direction.into(),
        source_hash,
        target_hash,
        files,
    })
}

fn build_mcp_diff_snapshot(
    direction: &str,
    project_server: Option<Value>,
    managed_server: Option<Value>,
) -> Result<ProjectMcpDiffSnapshot, String> {
    let (source, target) = if direction == SYNC_DIRECTION_PROJECT_TO_MANAGED {
        (project_server, managed_server)
    } else if direction == SYNC_DIRECTION_MANAGED_TO_PROJECT {
        (managed_server, project_server)
    } else {
        return Err("不支持的同步方向。".into());
    };
    let source_hash = source
        .as_ref()
        .map(hash_json_value)
        .transpose()?
        .unwrap_or_default();
    let target_hash = target
        .as_ref()
        .map(hash_json_value)
        .transpose()?
        .unwrap_or_default();
    let operation = match (&source, &target) {
        (Some(_), None) => "add",
        (None, Some(_)) => "remove",
        _ => "update",
    };
    let mut fields = Vec::new();
    collect_json_diff_fields("", target.as_ref(), source.as_ref(), &mut fields);
    let secret_paths = source.as_ref().map(mcp_secret_paths).unwrap_or_default();
    let warnings = if secret_paths.is_empty() {
        Vec::new()
    } else {
        vec!["检测到疑似明文密钥，请改用环境变量引用后再同步。".into()]
    };
    Ok(ProjectMcpDiffSnapshot {
        direction: direction.into(),
        source_hash,
        target_hash,
        operation: operation.into(),
        fields,
        warnings,
    })
}

fn collect_json_diff_fields(
    path: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    output: &mut Vec<ProjectMcpDiffField>,
) {
    if before == after {
        return;
    }
    if let (Some(Value::Object(before_map)), Some(Value::Object(after_map))) = (before, after) {
        let mut keys = before_map.keys().cloned().collect::<BTreeSet<_>>();
        keys.extend(after_map.keys().cloned());
        for key in keys {
            let child_path = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            collect_json_diff_fields(
                &child_path,
                before_map.get(&key),
                after_map.get(&key),
                output,
            );
        }
        return;
    }
    let sensitive = is_sensitive_field_path(path);
    let status = match (before, after) {
        (None, Some(_)) => "added",
        (Some(_), None) => "deleted",
        _ => "modified",
    };
    output.push(ProjectMcpDiffField {
        path: path.into(),
        status: status.into(),
        before: before.map(|value| redact_mcp_value(value, sensitive)),
        after: after.map(|value| redact_mcp_value(value, sensitive)),
        sensitive,
    });
}

fn redact_mcp_value(value: &Value, sensitive: bool) -> Value {
    if sensitive
        && value
            .as_str()
            .is_some_and(|text| !is_environment_reference(text))
    {
        Value::String("••••••".into())
    } else {
        value.clone()
    }
}

fn read_project_mcp_servers(path: &Path) -> Result<BTreeMap<String, Value>, String> {
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let content =
        fs::read_to_string(path).map_err(|error| format!("读取项目 MCP 配置失败: {error}"))?;
    let root = serde_json::from_str::<Value>(&content)
        .map_err(|error| format!("解析项目 MCP 配置失败: {error}"))?;
    let Some(root_object) = root.as_object() else {
        return Err("项目 MCP 配置根节点必须是对象。".into());
    };
    let Some(servers) = root_object.get(MCP_SERVERS_FIELD) else {
        return Ok(BTreeMap::new());
    };
    let Some(server_object) = servers.as_object() else {
        return Err("项目 MCP 配置的 mcpServers 必须是对象。".into());
    };
    Ok(server_object
        .iter()
        .map(|(name, server)| (name.clone(), server.clone()))
        .collect())
}

fn upsert_project_mcp_server(path: &Path, server_name: &str, server: &Value) -> Result<(), String> {
    let mut root = if path.exists() {
        let content =
            fs::read_to_string(path).map_err(|error| format!("读取项目 MCP 配置失败: {error}"))?;
        serde_json::from_str::<Value>(&content)
            .map_err(|error| format!("解析项目 MCP 配置失败: {error}"))?
    } else {
        json!({})
    };
    let root_object = root
        .as_object_mut()
        .ok_or_else(|| "项目 MCP 配置根节点必须是对象。".to_string())?;
    if !root_object.contains_key(MCP_SERVERS_FIELD) {
        root_object.insert(MCP_SERVERS_FIELD.into(), Value::Object(Map::new()));
    }
    let server_object = root_object
        .get_mut(MCP_SERVERS_FIELD)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "项目 MCP 配置的 mcpServers 必须是对象。".to_string())?;
    server_object.insert(server_name.into(), server.clone());
    atomic_write_json(path, &root)
}

fn ensure_mcp_server_distributable(server: &Value) -> Result<(), String> {
    let secret_paths = mcp_secret_paths(server);
    if secret_paths.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "检测到疑似明文密钥字段：{}。请改用环境变量引用。",
            secret_paths.join("、")
        ))
    }
}

fn mcp_secret_paths(server: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    collect_mcp_secret_paths("", server, &mut paths);
    paths
}

fn collect_mcp_secret_paths(path: &str, value: &Value, output: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                if child
                    .as_str()
                    .is_some_and(|text| is_literal_secret(&child_path, text))
                {
                    output.push(child_path);
                } else {
                    collect_mcp_secret_paths(&child_path, child, output);
                }
            }
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                collect_mcp_secret_paths(&format!("{path}[{index}]"), child, output);
            }
        }
        _ => {}
    }
}

fn is_literal_secret(path: &str, value: &str) -> bool {
    if value.trim().is_empty() || is_environment_reference(value) {
        return false;
    }
    let normalized_path = path.to_ascii_lowercase().replace(['-', '_'], "");
    let sensitive_key = [
        "token",
        "password",
        "passwd",
        "secret",
        "authorization",
        "apikey",
        "privatekey",
        "cookie",
    ]
    .iter()
    .any(|needle| normalized_path.contains(needle));
    sensitive_key || value.contains("BEGIN PRIVATE KEY")
}

fn is_sensitive_field_path(path: &str) -> bool {
    let normalized_path = path.to_ascii_lowercase().replace(['-', '_'], "");
    [
        "token",
        "password",
        "passwd",
        "secret",
        "authorization",
        "apikey",
        "privatekey",
        "cookie",
    ]
    .iter()
    .any(|needle| normalized_path.contains(needle))
}

fn is_environment_reference(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.starts_with('$')
        && !trimmed.starts_with("${")
        && trimmed.len() > 1
        && trimmed[1..]
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return true;
    }

    let placeholder = ["Bearer ", "Basic ", "Token ", ""]
        .into_iter()
        .find_map(|prefix| trimmed.strip_prefix(prefix));
    let Some(placeholder) = placeholder else {
        return false;
    };
    let variable = placeholder
        .strip_prefix("${")
        .and_then(|value| value.strip_suffix('}'));
    variable.is_some_and(|variable| {
        !variable.is_empty()
            && variable
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
    })
}

fn verify_preview_hashes(
    source: &Path,
    target: &Path,
    expected_source: &str,
    expected_target: &str,
) -> Result<(), String> {
    let actual_source = hash_skill_directory(source)?;
    let actual_target = if target.exists() {
        hash_skill_directory(target)?
    } else {
        String::new()
    };
    if actual_source != expected_source || actual_target != expected_target {
        return Err("预览后文件已发生变化，请重新预览。".into());
    }
    Ok(())
}

fn verify_optional_json_preview_hashes(
    source: Option<&Value>,
    target: Option<&Value>,
    expected_source: &str,
    expected_target: &str,
) -> Result<(), String> {
    let actual_source = source.map(hash_json_value).transpose()?.unwrap_or_default();
    let actual_target = target.map(hash_json_value).transpose()?.unwrap_or_default();
    if actual_source != expected_source || actual_target != expected_target {
        return Err("预览后 MCP 配置已发生变化，请重新预览。".into());
    }
    Ok(())
}

fn skill_sync_paths<'a>(
    direction: &str,
    project_path: &'a Path,
    managed_path: &'a Path,
) -> Result<(&'a Path, &'a Path), String> {
    match direction {
        SYNC_DIRECTION_MANAGED_TO_PROJECT => Ok((managed_path, project_path)),
        SYNC_DIRECTION_PROJECT_TO_MANAGED => Ok((project_path, managed_path)),
        _ => Err("不支持的同步方向。".into()),
    }
}

fn replace_skill_directory(source: &Path, target: &Path, preserve_git: bool) -> Result<(), String> {
    ensure_real_skill_directory(source, "同步来源")?;
    let parent = target
        .parent()
        .ok_or_else(|| "Skill 目标目录无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建 Skill 目标目录失败: {error}"))?;
    let unique = unique_suffix();
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("skill");
    let staging = parent.join(format!(".{name}.skilldock-staging-{unique}"));
    let backup = parent.join(format!(".{name}.skilldock-backup-{unique}"));
    if let Err(error) = copy_skill_tree(source, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let target_exists = fs::symlink_metadata(target).is_ok();
    if target_exists {
        let metadata = fs::symlink_metadata(target)
            .map_err(|error| format!("读取 Skill 目标失败: {error}"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            let _ = fs::remove_dir_all(&staging);
            return Err("Skill 目标不是可安全替换的真实目录。".into());
        }
        fs::rename(target, &backup).map_err(|error| format!("备份 Skill 目标失败: {error}"))?;
        if preserve_git {
            let git_path = backup.join(".git");
            if fs::symlink_metadata(&git_path).is_ok() {
                if let Err(error) = fs::rename(&git_path, staging.join(".git")) {
                    let _ = fs::rename(&backup, target);
                    let _ = fs::remove_dir_all(&staging);
                    return Err(format!("保护托管 Skill Git 元数据失败: {error}"));
                }
            }
        }
    }

    if let Err(error) = fs::rename(&staging, target) {
        if preserve_git {
            let staged_git = staging.join(".git");
            if fs::symlink_metadata(&staged_git).is_ok() {
                let _ = fs::rename(&staged_git, backup.join(".git"));
            }
        }
        if target_exists {
            let _ = fs::rename(&backup, target);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("替换 Skill 目录失败: {error}"));
    }
    if target_exists {
        let _ = fs::remove_dir_all(&backup);
    }
    Ok(())
}

fn copy_skill_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("创建 Skill 临时目录失败: {error}"))?;
    let mut entries = fs::read_dir(source)
        .map_err(|error| format!("读取 Skill 来源失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取 Skill 来源条目失败: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let source_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if should_ignore_skill_name(&name) {
            continue;
        }
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("读取 Skill 来源元数据失败: {error}"))?;
        if metadata.file_type().is_symlink() {
            let _ = fs::remove_dir_all(target);
            return Err(format!("Skill 包含不支持的符号链接：{name}"));
        }
        let target_path = target.join(&name);
        if metadata.is_dir() {
            copy_skill_tree(&source_path, &target_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &target_path)
                .map_err(|error| format!("复制 Skill 文件失败: {error}"))?;
        }
    }
    Ok(())
}

fn collect_skill_files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    if !root.is_dir() {
        return Err("Skill 目录不存在。".into());
    }
    let mut files = BTreeMap::new();
    collect_skill_files_recursive(root, root, &mut files)?;
    Ok(files)
}

fn collect_optional_skill_files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    if root.exists() {
        collect_skill_files(root)
    } else {
        Ok(BTreeMap::new())
    }
}

fn ensure_real_skill_directory(path: &Path, label: &str) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("{label}目录不可用: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{label}必须是真实目录。"));
    }
    if !path.join("SKILL.md").is_file() {
        return Err(format!("{label}缺少 SKILL.md。"));
    }
    Ok(())
}

fn collect_skill_files_recursive(
    root: &Path,
    current: &Path,
    output: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(current)
        .map_err(|error| format!("读取 Skill 目录失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取 Skill 条目失败: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if should_ignore_skill_name(&name) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("读取 Skill 文件元数据失败: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("Skill 包含不支持的符号链接：{name}"));
        }
        if metadata.is_dir() {
            collect_skill_files_recursive(root, &path, output)?;
        } else if metadata.is_file() {
            let relative = relative_path_string(root, &path)?;
            let content =
                fs::read(&path).map_err(|error| format!("读取 Skill 文件失败: {error}"))?;
            output.insert(relative, content);
        }
    }
    Ok(())
}

fn hash_skill_directory(root: &Path) -> Result<String, String> {
    let files = collect_skill_files(root)?;
    Ok(hash_collected_files(&files))
}

fn hash_collected_files(files: &BTreeMap<String, Vec<u8>>) -> String {
    let mut hasher = Sha256::new();
    for (path, content) in files {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update(content);
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

fn hash_json_value(value: &Value) -> Result<String, String> {
    let bytes =
        serde_json::to_vec(value).map_err(|error| format!("序列化 MCP Server 失败: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn should_ignore_skill_name(name: &str) -> bool {
    IGNORED_SKILL_NAMES.contains(&name) || name.starts_with(".skilldock-")
}

fn read_skill_description(path: &Path) -> String {
    let Ok(content) = fs::read_to_string(path) else {
        return String::new();
    };
    content
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("description:")
                .map(|value| value.trim().trim_matches(['\'', '"']).to_string())
        })
        .unwrap_or_default()
}

fn find_skill_binding<'a>(
    persistence: &'a ProjectPersistence,
    project_id: &str,
    tool_id: &str,
    project_relative_path: &str,
) -> Result<&'a ProjectSkillBinding, String> {
    persistence
        .skill_bindings
        .iter()
        .find(|binding| {
            binding.project_id == project_id
                && binding.tool_id == tool_id
                && binding.project_relative_path == project_relative_path
        })
        .ok_or_else(|| "项目 Skill 尚未关联托管 Skill。".to_string())
}

fn skill_binding_index(
    persistence: &ProjectPersistence,
    project_id: &str,
    tool_id: &str,
    project_relative_path: &str,
) -> Result<usize, String> {
    persistence
        .skill_bindings
        .iter()
        .position(|binding| {
            binding.project_id == project_id
                && binding.tool_id == tool_id
                && binding.project_relative_path == project_relative_path
        })
        .ok_or_else(|| "项目 Skill 尚未关联托管 Skill。".to_string())
}

fn find_mcp_binding<'a>(
    persistence: &'a ProjectPersistence,
    project_id: &str,
    tool_id: &str,
    server_name: &str,
) -> Result<&'a ProjectMcpBinding, String> {
    persistence
        .mcp_bindings
        .iter()
        .find(|binding| {
            binding.project_id == project_id
                && binding.tool_id == tool_id
                && binding.server_name == server_name
        })
        .ok_or_else(|| "项目 MCP 尚未关联托管 Server。".to_string())
}

fn mcp_binding_index(
    persistence: &ProjectPersistence,
    project_id: &str,
    tool_id: &str,
    server_name: &str,
) -> Result<usize, String> {
    persistence
        .mcp_bindings
        .iter()
        .position(|binding| {
            binding.project_id == project_id
                && binding.tool_id == tool_id
                && binding.server_name == server_name
        })
        .ok_or_else(|| "项目 MCP 尚未关联托管 Server。".to_string())
}

fn project_tool_spec(tool_id: &str) -> Result<ProjectToolSpec, String> {
    PROJECT_TOOL_SPECS
        .iter()
        .copied()
        .find(|tool| tool.id == tool_id)
        .ok_or_else(|| "该工具尚未开放项目级资源。".to_string())
}

fn project_root(persistence: &ProjectPersistence, project_id: &str) -> Result<PathBuf, String> {
    let project = persistence
        .projects
        .iter()
        .find(|project| project.id == project_id)
        .ok_or_else(|| "未找到受管理项目。".to_string())?;
    let root = PathBuf::from(&project.canonical_root_path);
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("项目目录不可用: {error}"))?;
    if !canonical.is_dir() || path_key(&canonical) != path_key(&root) {
        return Err("项目目录已变化，请重新添加项目。".into());
    }
    Ok(canonical)
}

fn safe_project_path(project_root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("项目相对路径无效。".into());
    }
    let target = project_root.join(relative);
    let ancestor = target
        .ancestors()
        .find(|path| path.exists())
        .ok_or_else(|| "无法验证项目目标路径。".to_string())?;
    let canonical_ancestor = ancestor
        .canonicalize()
        .map_err(|error| format!("验证项目目标路径失败: {error}"))?;
    if !canonical_ancestor.starts_with(project_root) {
        return Err("项目目标路径超出项目根目录。".into());
    }
    Ok(target)
}

fn project_disabled_skill_root(
    project_root: &Path,
    tool: ProjectToolSpec,
) -> Result<PathBuf, String> {
    safe_project_path(
        project_root,
        &format!("{}-disabled", tool.skill_relative_path),
    )
}

fn project_skill_binding_relative_path(
    scanned_root: &Path,
    skill_path: &Path,
    tool: ProjectToolSpec,
) -> Result<String, String> {
    let nested_path = relative_path_string(scanned_root, skill_path)?;
    Ok(format!("{}/{}", tool.skill_relative_path, nested_path))
}

fn project_skill_enabled_path(
    project_root: &Path,
    tool: ProjectToolSpec,
    project_relative_path: &str,
) -> Result<PathBuf, String> {
    let path = safe_project_path(project_root, project_relative_path)?;
    ensure_path_within_tool_root(project_root, &path, tool.skill_relative_path)?;
    Ok(path)
}

fn project_skill_disabled_path(
    project_root: &Path,
    tool: ProjectToolSpec,
    project_relative_path: &str,
) -> Result<PathBuf, String> {
    let enabled_root = safe_project_path(project_root, tool.skill_relative_path)?;
    let enabled_path = project_skill_enabled_path(project_root, tool, project_relative_path)?;
    let nested_path = enabled_path
        .strip_prefix(&enabled_root)
        .map_err(|_| "项目 Skill 路径不属于所选工具。".to_string())?;
    Ok(project_disabled_skill_root(project_root, tool)?.join(nested_path))
}

fn resolve_project_skill_path(
    project_root: &Path,
    tool: ProjectToolSpec,
    project_relative_path: &str,
    fallback: ProjectSkillPathFallback,
) -> Result<PathBuf, String> {
    let enabled_path = project_skill_enabled_path(project_root, tool, project_relative_path)?;
    let disabled_path = project_skill_disabled_path(project_root, tool, project_relative_path)?;
    let enabled_exists = fs::symlink_metadata(&enabled_path).is_ok();
    let disabled_exists = fs::symlink_metadata(&disabled_path).is_ok();
    match (enabled_exists, disabled_exists) {
        (true, true) => return Err("启用和关闭目录中同时存在同名 Skill，请先处理目录冲突。".into()),
        (true, false) => return Ok(enabled_path),
        (false, true) => return Ok(disabled_path),
        (false, false) => {}
    }

    match fallback {
        ProjectSkillPathFallback::PreferEnabled => Ok(enabled_path),
        ProjectSkillPathFallback::RequireExisting => Err("项目 Skill 目录不存在。".into()),
    }
}

fn cleanup_empty_project_skill_parents(start: Option<&Path>, root: &Path) {
    let Some(mut current) = start else {
        return;
    };
    while current.starts_with(root) {
        if current == root || fs::remove_dir(current).is_err() {
            return;
        }
        let Some(parent) = current.parent() else {
            return;
        };
        current = parent;
    }
}

fn ensure_path_within_tool_root(
    project_root: &Path,
    path: &Path,
    tool_relative_path: &str,
) -> Result<(), String> {
    let tool_root = safe_project_path(project_root, tool_relative_path)?;
    if path.starts_with(tool_root) {
        Ok(())
    } else {
        Err("项目 Skill 路径不属于所选工具。".into())
    }
}

fn validate_entry_name(value: &str, label: &str) -> Result<(), String> {
    let path = Path::new(value.trim());
    let valid = !value.trim().is_empty()
        && path.components().count() == 1
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    if valid {
        Ok(())
    } else {
        Err(format!("{label}无效。"))
    }
}

fn relative_path_string(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "路径超出允许范围。".to_string())
}

fn project_id_for_root(root: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path_key(root).as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("project-{}", &digest[..16])
}

fn path_key(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

fn load_project_persistence() -> Result<ProjectPersistence, String> {
    let path = project_state_file()?;
    if !path.exists() {
        return Ok(ProjectPersistence {
            version: PROJECT_STATE_VERSION,
            ..Default::default()
        });
    }
    let content =
        fs::read_to_string(&path).map_err(|error| format!("读取项目状态失败: {error}"))?;
    let mut persistence = serde_json::from_str::<ProjectPersistence>(&content)
        .map_err(|error| format!("解析项目状态失败: {error}"))?;
    persistence.version = PROJECT_STATE_VERSION;
    Ok(persistence)
}

fn save_project_persistence(persistence: &ProjectPersistence) -> Result<(), String> {
    let path = project_state_file()?;
    let mut normalized = persistence.clone();
    normalized.version = PROJECT_STATE_VERSION;
    let value =
        serde_json::to_value(normalized).map_err(|error| format!("序列化项目状态失败: {error}"))?;
    atomic_write_json(&path, &value)
}

fn project_state_file() -> Result<PathBuf, String> {
    workspace_file_path(PROJECT_STATE_FILE_NAME)
}

fn atomic_write_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "配置文件目录无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败: {error}"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("config.json");
    let temporary = parent.join(format!(".{file_name}.skilldock-{}", unique_suffix()));
    let payload =
        serde_json::to_string_pretty(value).map_err(|error| format!("序列化配置失败: {error}"))?;
    fs::write(&temporary, format!("{payload}\n"))
        .map_err(|error| format!("写入临时配置失败: {error}"))?;
    replace_file(&temporary, path)
}

fn replace_file(temporary: &Path, target: &Path) -> Result<(), String> {
    let target_exists = fs::symlink_metadata(target).is_ok();
    let backup = target.with_extension(format!("skilldock-backup-{}", unique_suffix()));
    if target_exists {
        let metadata =
            fs::symlink_metadata(target).map_err(|error| format!("读取原配置文件失败: {error}"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            let _ = fs::remove_file(temporary);
            return Err("目标配置不是可安全替换的真实文件。".into());
        }
        fs::rename(target, &backup).map_err(|error| {
            let _ = fs::remove_file(temporary);
            format!("备份原配置文件失败: {error}")
        })?;
    }
    if let Err(error) = fs::rename(temporary, target) {
        if target_exists {
            let _ = fs::rename(&backup, target);
        }
        let _ = fs::remove_file(temporary);
        return Err(format!("替换配置文件失败: {error}"));
    }
    if target_exists {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn now_label() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn unique_suffix() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::TEST_ENV_LOCK;

    fn test_temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("skilldock-{label}-{}", unique_suffix()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn run_with_temp_home<T>(label: &str, callback: impl FnOnce(PathBuf) -> T) -> T {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_home = test_temp_dir(label);
        let original_home = std::env::var_os("HOME");
        // SAFETY: tests serialize HOME mutation with a process-wide mutex.
        unsafe {
            std::env::set_var("HOME", &temp_home);
        }
        let result = callback(temp_home.clone());
        match original_home {
            Some(home) => unsafe {
                std::env::set_var("HOME", home);
            },
            None => unsafe {
                std::env::remove_var("HOME");
            },
        }
        let _ = fs::remove_dir_all(temp_home);
        result
    }

    #[test]
    fn exposes_all_project_skill_targets_and_detects_existing_tool_directories() {
        let temp = test_temp_dir("project-skill-targets");
        fs::create_dir_all(temp.join(".cursor")).unwrap();
        fs::create_dir_all(temp.join(".gemini/antigravity/skills")).unwrap();

        let targets = project_skill_targets(&temp);

        assert_eq!(targets.len(), 28);
        assert!(
            targets
                .iter()
                .find(|target| target.tool_id == "cursor")
                .unwrap()
                .is_detected
        );
        assert!(
            targets
                .iter()
                .find(|target| target.tool_id == "antigravity")
                .unwrap()
                .is_detected
        );
        assert!(
            !targets
                .iter()
                .find(|target| target.tool_id == "claude-code")
                .unwrap()
                .is_detected
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn batch_distribution_skips_equal_content_and_reports_different_content_as_conflict() {
        run_with_temp_home("project-skill-batch", |_| {
            let temp = test_temp_dir("project-skill-batch-root");
            let project_root = temp.canonicalize().unwrap();
            let managed_path = temp.join("managed/demo");
            fs::create_dir_all(&managed_path).unwrap();
            fs::write(managed_path.join("SKILL.md"), "# Demo\n").unwrap();
            let managed_skill = ManagedSkillSource {
                name: "demo".into(),
                path: managed_path,
                capability: PROJECT_CAPABILITY_BIDIRECTIONAL.into(),
            };
            let mut persistence = ProjectPersistence::default();

            let equal_target = project_root.join(".claude/skills/demo");
            fs::create_dir_all(&equal_target).unwrap();
            fs::write(equal_target.join("SKILL.md"), "# Demo\n").unwrap();
            let skipped = distribute_skill_to_project_batch_entry(
                &mut persistence,
                &project_root,
                "project-demo",
                project_tool_spec("claude-code").unwrap(),
                &managed_skill,
            );
            assert_eq!(skipped.0, "skipped");
            assert_eq!(persistence.skill_bindings.len(), 1);

            let conflicting_target = project_root.join(".cursor/skills/demo");
            fs::create_dir_all(&conflicting_target).unwrap();
            fs::write(conflicting_target.join("SKILL.md"), "# Different\n").unwrap();
            let conflict = distribute_skill_to_project_batch_entry(
                &mut persistence,
                &project_root,
                "project-demo",
                project_tool_spec("cursor").unwrap(),
                &managed_skill,
            );
            assert_eq!(conflict.0, "conflict");
            assert_eq!(persistence.skill_bindings.len(), 1);
            fs::remove_dir_all(temp).unwrap();
        });
    }

    #[test]
    fn classifies_agent_cli_as_export_only_even_when_git_backed() {
        assert_eq!(
            project_capability_for_owner("agent-skills-cli"),
            PROJECT_CAPABILITY_EXPORT_ONLY
        );
        assert_eq!(
            project_capability_for_owner("skilldock"),
            PROJECT_CAPABILITY_BIDIRECTIONAL
        );
    }

    #[test]
    fn detects_literal_mcp_secrets_but_allows_environment_references() {
        let literal = json!({"env": {"API_TOKEN": "secret-value"}});
        let reference = json!({"env": {"API_TOKEN": "${API_TOKEN}"}});
        let authorization = json!({"headers": {"Authorization": "Bearer ${API_TOKEN}"}});

        assert_eq!(mcp_secret_paths(&literal), vec!["env.API_TOKEN"]);
        assert!(mcp_secret_paths(&reference).is_empty());
        assert!(mcp_secret_paths(&authorization).is_empty());
    }

    #[test]
    fn computes_three_way_sync_status() {
        assert_eq!(sync_status(Some("a"), Some("a"), "old"), "in-sync");
        assert_eq!(
            sync_status(Some("project"), Some("base"), "base"),
            "project-changed"
        );
        assert_eq!(
            sync_status(Some("base"), Some("managed"), "base"),
            "managed-changed"
        );
        assert_eq!(
            sync_status(Some("project"), Some("managed"), "base"),
            "diverged"
        );
    }

    #[test]
    fn rejects_project_path_traversal() {
        let root = std::env::temp_dir();
        assert!(safe_project_path(&root, "../outside").is_err());
        assert!(safe_project_path(&root, "/tmp/outside").is_err());
    }

    #[test]
    fn compares_mcp_objects_without_key_order_noise() {
        let left = json!({"command": "npx", "args": ["-y", "demo"]});
        let right = json!({"args": ["-y", "demo"], "command": "npx"});
        assert_eq!(
            hash_json_value(&left).unwrap(),
            hash_json_value(&right).unwrap()
        );
    }

    #[test]
    fn previews_and_restores_a_missing_project_skill() {
        let temp = test_temp_dir("missing-project-skill");
        let source = temp.join("managed");
        let target = temp.join("project");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "# Demo\n").unwrap();

        let preview =
            build_skill_diff_snapshot(SYNC_DIRECTION_MANAGED_TO_PROJECT, &source, &target).unwrap();
        assert!(preview.target_hash.is_empty());
        assert_eq!(preview.files.len(), 1);
        assert_eq!(preview.files[0].status, "added");

        verify_preview_hashes(&source, &target, &preview.source_hash, &preview.target_hash)
            .unwrap();
        replace_skill_directory(&source, &target, false).unwrap();
        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "# Demo\n"
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn toggles_project_skill_by_moving_the_real_directory() {
        let temp = test_temp_dir("toggle-project-skill");
        let project_root = temp.canonicalize().unwrap();
        let enabled = project_root.join(".claude/skills/demo");
        let disabled = project_root.join(".claude/skills-disabled/demo");
        fs::create_dir_all(&enabled).unwrap();
        fs::write(enabled.join("SKILL.md"), "# Demo\n").unwrap();

        set_project_skill_enabled_state(
            &project_root,
            PROJECT_TOOL_SPECS[0],
            ".claude/skills/demo",
            false,
        )
        .unwrap();
        assert!(!enabled.exists());
        assert_eq!(
            fs::read_to_string(disabled.join("SKILL.md")).unwrap(),
            "# Demo\n"
        );

        set_project_skill_enabled_state(
            &project_root,
            PROJECT_TOOL_SPECS[0],
            ".claude/skills/demo",
            true,
        )
        .unwrap();
        assert!(enabled.join("SKILL.md").is_file());
        assert!(!disabled.exists());
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn refuses_to_toggle_over_an_existing_project_skill() {
        let temp = test_temp_dir("toggle-project-skill-conflict");
        let project_root = temp.canonicalize().unwrap();
        let enabled = project_root.join(".cursor/skills/demo");
        let disabled = project_root.join(".cursor/skills-disabled/demo");
        fs::create_dir_all(&enabled).unwrap();
        fs::create_dir_all(&disabled).unwrap();
        fs::write(enabled.join("SKILL.md"), "# Enabled\n").unwrap();
        fs::write(disabled.join("SKILL.md"), "# Disabled\n").unwrap();

        let error = set_project_skill_enabled_state(
            &project_root,
            project_tool_spec("cursor").unwrap(),
            ".cursor/skills/demo",
            false,
        )
        .unwrap_err();
        assert!(error.contains("已存在同名 Skill"));
        assert_eq!(
            fs::read_to_string(enabled.join("SKILL.md")).unwrap(),
            "# Enabled\n"
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn refuses_to_resolve_duplicate_enabled_and_disabled_project_skills() {
        let temp = test_temp_dir("resolve-project-skill-conflict");
        let project_root = temp.canonicalize().unwrap();
        fs::create_dir_all(project_root.join(".codex/skills/demo")).unwrap();
        fs::create_dir_all(project_root.join(".codex/skills-disabled/demo")).unwrap();

        let error = resolve_project_skill_path(
            &project_root,
            PROJECT_TOOL_SPECS[1],
            ".codex/skills/demo",
            ProjectSkillPathFallback::RequireExisting,
        )
        .unwrap_err();
        assert!(error.contains("同时存在同名 Skill"));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn reverse_skill_sync_preserves_managed_git_metadata() {
        let temp = test_temp_dir("preserve-skill-git");
        let source = temp.join("project");
        let target = temp.join("managed");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(target.join(".git")).unwrap();
        fs::write(source.join("SKILL.md"), "# Updated\n").unwrap();
        fs::write(target.join("SKILL.md"), "# Old\n").unwrap();
        fs::write(target.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();

        replace_skill_directory(&source, &target, true).unwrap();

        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "# Updated\n"
        );
        assert_eq!(
            fs::read_to_string(target.join(".git/HEAD")).unwrap(),
            "ref: refs/heads/main\n"
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn mcp_upsert_preserves_other_servers_and_top_level_fields() {
        let temp = test_temp_dir("mcp-upsert");
        let config = temp.join(".mcp.json");
        fs::write(
            &config,
            serde_json::to_string_pretty(&json!({
                "custom": true,
                "mcpServers": {
                    "keep": {"command": "keep"},
                    "update": {"command": "old"}
                }
            }))
            .unwrap(),
        )
        .unwrap();

        upsert_project_mcp_server(&config, "update", &json!({"command": "new"})).unwrap();

        let value: Value = serde_json::from_str(&fs::read_to_string(config).unwrap()).unwrap();
        assert_eq!(value["custom"], json!(true));
        assert_eq!(value["mcpServers"]["keep"]["command"], json!("keep"));
        assert_eq!(value["mcpServers"]["update"]["command"], json!("new"));
        fs::remove_dir_all(temp).unwrap();
    }
}
