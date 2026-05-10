use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSyncStatus {
    pub name: String,
    pub status_label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub name: String,
    pub source_label: String,
    pub source_type: String,
    pub source_url: String,
    pub description: String,
    pub local_path: String,
    pub branch: String,
    pub collab_status: String,
    pub status_text: String,
    #[serde(default)]
    pub remote_updated_at: String,
    #[serde(default)]
    pub local_updated_at: String,
    #[serde(default)]
    pub last_synced_at: String,
    pub last_checked_at: String,
    pub synced_tool_count: usize,
    pub last_editor: String,
    pub commit_label: String,
    #[serde(default)]
    pub git_linked: bool,
    pub tools: Vec<ToolSyncStatus>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSkill {
    pub id: String,
    pub name: String,
    pub source_type: String,
    pub source_site: String,
    pub description: String,
    pub maintainer: String,
    pub updated_at: String,
    pub install_label: String,
    pub source_url: String,
    pub popularity_label: String,
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub skill_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkillCandidate {
    pub name: String,
    pub description: String,
    pub local_path: String,
    pub detected_from: String,
    pub source_hint: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSkillCandidate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub relative_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolConfig {
    pub id: String,
    pub name: String,
    pub skills_path: String,
    pub mcp_config_path: String,
    pub status_label: String,
    pub is_enabled: bool,
    pub primary_type: String,
    pub surface_types: Vec<String>,
    pub supports_direct_open: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAccountSummary {
    pub provider: String,
    pub account_name: String,
    pub status_label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub installed_skills: Vec<SkillSummary>,
    pub marketplace_skills: Vec<MarketplaceSkill>,
    pub local_candidates: Vec<LocalSkillCandidate>,
    pub tool_configs: Vec<ToolConfig>,
    pub git_account: GitAccountSummary,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub storage_path: String,
    pub default_open_tool_id: String,
    pub skill_install_activation: String,
    pub mcp_install_activation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePersistence {
    pub installed_skills: Vec<SkillSummary>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushBranchOption {
    pub name: String,
    pub is_current: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushTargetSnapshot {
    pub current_branch: String,
    pub branches: Vec<PushBranchOption>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangeFile {
    pub path: String,
    pub status: String,
    pub diff: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPreviewSnapshot {
    pub target_branch: String,
    pub will_create_branch: bool,
    pub repository_path: String,
    pub uncommitted_files: Vec<GitChangeFile>,
    pub unpushed_commit_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreviewSnapshot {
    pub current_branch: String,
    pub remote_branch: String,
    pub commits_to_pull: usize,
    pub changed_files: Vec<GitChangeFile>,
    pub has_local_changes: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileEntry {
    pub path: String,
    pub name: String,
    pub entry_type: String,
    pub depth: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileBrowserSnapshot {
    pub skill_name: String,
    pub root_name: String,
    pub entries: Vec<SkillFileEntry>,
    pub initial_file_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileDocument {
    pub path: String,
    pub content: String,
}
