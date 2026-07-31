use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSyncStatus {
    pub name: String,
    pub status_label: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginComponentSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub asset_type: String,
    pub owner_plugin_id: String,
    pub package_item_id: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginComponentPreview {
    pub path: String,
    pub title: String,
    pub asset_type: String,
    pub content: String,
    #[serde(default)]
    pub root_name: String,
    #[serde(default)]
    pub entries: Vec<SkillFileEntry>,
    #[serde(default)]
    pub initial_file_path: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginScopeSummary {
    pub scope_id: String,
    pub scope_label: String,
    pub enabled_state: String,
    pub location: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    #[serde(default)]
    pub package_id: String,
    #[serde(default)]
    pub manifest_name: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub host_tool: String,
    #[serde(default)]
    pub related_host_tools: Vec<String>,
    pub kind: String,
    pub root_path: String,
    #[serde(default)]
    pub display_root_path: String,
    #[serde(default)]
    pub repo_root_path: String,
    #[serde(default)]
    pub plugin_relative_path: String,
    pub manifest_path: String,
    pub source_type: String,
    #[serde(default)]
    pub source_label: String,
    pub source_url: String,
    #[serde(default)]
    pub source_ref: String,
    #[serde(default)]
    pub source_revision: String,
    pub current_version: String,
    pub current_branch: String,
    pub current_commit: String,
    #[serde(default)]
    pub collab_status: String,
    #[serde(default)]
    pub status_text: String,
    pub is_git_repo: bool,
    pub update_mode: String,
    #[serde(default)]
    pub update_strategy: String,
    pub update_available: bool,
    #[serde(default)]
    pub baseline_hash: String,
    #[serde(default)]
    pub local_modified: bool,
    #[serde(default)]
    pub local_modified_source: String,
    pub installed_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub remote_updated_at: String,
    #[serde(default)]
    pub local_updated_at: String,
    #[serde(default)]
    pub last_editor: String,
    pub last_scanned_at: String,
    pub status: String,
    pub install_state: String,
    #[serde(default)]
    pub install_source: String,
    pub enabled_state: String,
    pub scopes: Vec<PluginScopeSummary>,
    pub components: Vec<PluginComponentSummary>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProbeResult {
    pub tool: String,
    #[serde(default)]
    pub compatible_host_tools: Vec<String>,
    pub kind: String,
    #[serde(default)]
    pub manifest_name: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub plugin_root: String,
    #[serde(default)]
    pub repo_root: String,
    #[serde(default)]
    pub plugin_relative_path: String,
    pub manifest_path: String,
    pub marketplace_manifest_path: String,
    pub components: Vec<PluginComponentSummary>,
    pub source_type: String,
    pub source_url: String,
    #[serde(default)]
    pub source_ref: String,
    pub is_git_repo: bool,
    pub git_root: String,
    pub confidence: String,
    pub install_strategy: String,
    pub warnings: Vec<String>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliToolSummary {
    pub id: String,
    pub name: String,
    pub owner_plugin_id: Option<String>,
    pub owner_plugin_name: Option<String>,
    pub lifecycle_source: String,
    pub command: String,
    pub executable_path: Option<String>,
    pub status_label: Option<String>,
    pub update_command: Option<String>,
    pub update_strategy: Option<String>,
    pub bundled_skills: Vec<String>,
    pub description: String,
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
    #[serde(default)]
    pub local_change_count: usize,
    #[serde(default)]
    pub lifecycle_source: String,
    #[serde(default)]
    pub owner_plugin_id: String,
    #[serde(default)]
    pub owner_plugin_name: String,
    #[serde(flatten, default)]
    pub instance: SkillInstanceMetadata,
    pub tools: Vec<ToolSyncStatus>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstanceMetadata {
    #[serde(default)]
    pub backup_id: String,
    #[serde(default)]
    pub entry_path: String,
    #[serde(default)]
    pub canonical_path: String,
    #[serde(default)]
    pub management_owner: String,
    #[serde(default)]
    pub update_driver: String,
    #[serde(default)]
    pub skill_entries: Vec<String>,
    #[serde(default)]
    pub path_error: String,
    #[serde(default)]
    pub marketplace_owner: String,
    #[serde(default)]
    pub marketplace_slug: String,
    #[serde(default)]
    pub marketplace_version: String,
    #[serde(default)]
    pub marketplace_content_hash: String,
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
    #[serde(default)]
    pub topic_label: String,
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub skill_path: String,
    #[serde(default)]
    pub marketplace_url: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub install_driver: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSkillsPage {
    pub skills: Vec<MarketplaceSkill>,
    pub has_more: bool,
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
pub struct ToolSkillEntry {
    pub tool_id: String,
    pub tool_name: String,
    pub name: String,
    pub description: String,
    pub local_path: String,
    pub resolved_path: String,
    pub management_status: String,
    #[serde(default)]
    pub managed_root: String,
    #[serde(default)]
    pub entry_kind: String,
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
pub struct GitBranchOption {
    pub name: String,
    pub is_default: bool,
    pub is_selected: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInstallSkillCandidate {
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
    pub supports_mcp: bool,
    pub mcp_config_path_recognized: bool,
    pub status_label: String,
    #[serde(default)]
    pub is_installed: bool,
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
    pub tool_skill_entries: Vec<ToolSkillEntry>,
    pub git_account: GitAccountSummary,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub storage_path: String,
    pub skill_library_path: String,
    pub skill_library_provider: String,
    #[serde(default)]
    pub agent_skills_compatibility_enabled: bool,
    #[serde(default)]
    pub agent_skills_compatibility_configured: bool,
    pub default_open_tool_id: String,
    pub skill_install_activation: String,
    pub mcp_install_activation: String,
    #[serde(default)]
    pub skill_source_view_style: String,
    pub language: String,
    pub language_source: String,
    pub theme: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubConnectionMetadata {
    pub auth_method: String,
    pub user_id: Option<u64>,
    pub username: String,
    pub avatar_url: String,
    pub credential_persisted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubConnection {
    pub connected: bool,
    pub auth_method: String,
    pub user_id: Option<u64>,
    pub username: String,
    pub avatar_url: String,
    pub credential_persisted: bool,
    pub warning: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubBackupSettings {
    pub enabled: bool,
    pub repository_owner: String,
    pub repository_name: String,
    pub repository_url: String,
    pub last_sync_at: String,
    pub last_error: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupPhase {
    Disabled,
    Enabling,
    BackingUp,
    Restoring,
    Enabled,
    Error,
}

impl Default for BackupPhase {
    fn default() -> Self {
        Self::Disabled
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub enabled: bool,
    pub repository_owner: String,
    pub repository_name: String,
    pub repository_url: String,
    pub last_sync_at: String,
    pub last_error: String,
    pub phase: BackupPhase,
    pub syncing: bool,
    pub pending_conflicts: usize,
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
    pub staged_diff: String,
    pub unstaged_diff: String,
    pub original_content: Option<String>,
    pub current_content: Option<String>,
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
    pub preview_mode: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileDocument {
    pub path: String,
    pub content: String,
}
