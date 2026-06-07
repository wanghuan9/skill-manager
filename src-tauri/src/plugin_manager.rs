use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use toml_edit::{DocumentMut, Item, Table};

use crate::library::{
    clone_repo_for_discovery_with_ref_and_sparse_paths, parse_market_source_url,
    sanitize_storage_name, tree_relative_path_for_branch,
};
use crate::models::{
    CliToolSummary, PluginComponentPreview, PluginComponentSummary, PluginProbeResult,
    PluginScopeSummary, PluginSummary,
};
use crate::state;
use crate::workspace::{
    self, remove_legacy_workspace_file, workspace_file_candidates, workspace_file_path,
};

const CLAUDE_PLUGIN_MANIFEST: &str = ".claude-plugin/plugin.json";
const CLAUDE_MARKETPLACE_MANIFEST: &str = ".claude-plugin/marketplace.json";
const CURSOR_PLUGIN_MANIFEST: &str = ".cursor-plugin/plugin.json";
const CODEX_PLUGIN_MANIFEST: &str = ".codex-plugin/plugin.json";
const CODEX_MARKETPLACE_MANIFEST: &str = ".agents/plugins/marketplace.json";
const PLUGIN_PACKAGE_DIR: &str = "plugins";
const GIT_BINARY: &str = "git";
const REMOTE_BRANCH_PREFIX: &str = "origin/";
const PLUGIN_PACKAGE_IDENTITY_FILE: &str = ".skilldock-package.json";
const PLUGIN_UPDATE_METADATA_FILE: &str = ".skilldock-update.json";
const SKILLDOCK_GIT_METADATA_DIR: &str = "skilldock";
const SKILLDOCK_PACKAGE_IDENTITY_METADATA_FILE: &str = "package.json";
const SKILLDOCK_PLUGIN_SOURCE_METADATA_DIR: &str = "plugin-source";
const SKILLDOCK_PLUGIN_UPDATE_METADATA_DIR: &str = "update";
const PLUGIN_PACKAGE_HASH_LEN: usize = 8;
const PLUGIN_UPDATE_CACHE_FILE_NAME: &str = "plugin-update-cache.json";

static PLUGIN_UPDATE_CACHE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PLUGIN_GIT_FETCH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Deserialize, Default)]
struct CodexConfigFile {
    #[serde(default)]
    plugins: BTreeMap<String, CodexPluginConfig>,
    #[serde(default)]
    marketplaces: BTreeMap<String, CodexMarketplaceConfig>,
}

#[derive(Debug, Deserialize, Default)]
struct CodexPluginConfig {
    #[serde(default)]
    enabled: bool,
}

#[derive(Debug, Deserialize, Default)]
struct CodexMarketplaceConfig {
    #[serde(default)]
    source: String,
    #[serde(default, rename = "ref")]
    source_ref: String,
    #[serde(default)]
    last_revision: String,
}

#[derive(Debug, Deserialize, Serialize, Default)]
struct MarketplaceManifest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    interface: MarketplaceInterface,
    #[serde(default)]
    plugins: Vec<MarketplacePluginEntry>,
}

#[derive(Debug, Deserialize, Serialize, Default)]
struct MarketplaceInterface {
    #[serde(default, rename = "displayName")]
    display_name: String,
}

#[derive(Debug, Deserialize, Serialize, Default)]
struct MarketplacePluginEntry {
    #[serde(default)]
    name: String,
    #[serde(default)]
    source: MarketplacePluginSource,
    #[serde(default)]
    policy: MarketplacePluginPolicy,
    #[serde(default)]
    category: String,
}

#[derive(Debug, Deserialize, Serialize, Default)]
struct MarketplacePluginSource {
    #[serde(default)]
    source: String,
    #[serde(default)]
    path: String,
}

#[derive(Debug, Deserialize, Serialize, Default)]
struct MarketplacePluginPolicy {
    #[serde(default)]
    installation: String,
    #[serde(default)]
    authentication: String,
}

#[derive(Debug, Default)]
struct ClaudeMarketplaceManifest {
    name: String,
    description: String,
    owner_name: String,
    plugins: Vec<ClaudeMarketplacePluginEntry>,
}

#[derive(Debug, Default)]
struct ClaudeMarketplacePluginEntry {
    name: String,
    source_path: String,
    description: String,
    category: String,
}

#[derive(Debug, Default)]
struct ClaudeMarketplaceInstalledPluginEntry {
    description: String,
    version: String,
    display_name: Option<String>,
    source_url: String,
    lsp_servers: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
struct PluginManifest {
    #[serde(default)]
    name: String,
    #[serde(default, rename = "displayName")]
    display_name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    homepage: String,
    #[serde(default)]
    repository: String,
    #[serde(default)]
    interface: PluginInterface,
}

#[derive(Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SkillDockPluginSourceMetadata {
    #[serde(default)]
    source_url: String,
    #[serde(default)]
    source_type: String,
    #[serde(default)]
    source_ref: String,
    #[serde(default)]
    source_revision: String,
}

#[derive(Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SkillDockPluginUpdateMetadata {
    #[serde(default)]
    baseline_hash: String,
}

#[derive(Debug, Deserialize, Default)]
struct PluginInterface {
    #[serde(default, rename = "displayName")]
    display_name: String,
    #[serde(default, rename = "shortDescription")]
    short_description: String,
    #[serde(default, rename = "longDescription")]
    long_description: String,
}

#[derive(Debug, Deserialize, Default)]
struct ClaudeInstalledPluginsFile {
    #[serde(default)]
    plugins: BTreeMap<String, Vec<ClaudeInstalledPluginEntry>>,
}

#[derive(Debug, Deserialize, Default)]
struct ClaudeSettingsFile {
    #[serde(default, rename = "enabledPlugins")]
    enabled_plugins: BTreeMap<String, bool>,
}

#[derive(Debug, Deserialize, Default)]
struct ClaudeInstalledPluginEntry {
    #[serde(default, rename = "installPath")]
    install_path: String,
    #[serde(default)]
    version: String,
    #[serde(default, rename = "installedAt")]
    installed_at: String,
    #[serde(default, rename = "lastUpdated")]
    last_updated: String,
    #[serde(default, rename = "gitCommitSha")]
    git_commit_sha: String,
}

#[derive(Debug)]
struct InstalledPluginDescriptor {
    host_tool: String,
    root: PathBuf,
    display_root: PathBuf,
    manifest_path: PathBuf,
    source_type: String,
    source_label: String,
    source_url: String,
    source_ref: String,
    source_revision: String,
    current_version: String,
    current_commit: String,
    installed_at: String,
    updated_at: String,
    install_state: String,
    install_source: String,
    scopes: Vec<PluginScopeSummary>,
}

#[derive(Debug)]
struct SharedPluginPackage {
    plugin_root: PathBuf,
}

#[derive(Debug, Default)]
struct PluginGitState {
    branch: String,
    commit: String,
    collab_status: String,
    status_text: String,
    update_available: bool,
    remote_updated_at: String,
    local_updated_at: String,
    last_editor: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PluginScanMode {
    Local,
    Startup,
    Refresh,
}

#[derive(Debug, Deserialize, Serialize, Default)]
struct PluginUpdateCache {
    #[serde(default)]
    git_entries: Vec<PluginGitCacheEntry>,
    #[serde(default)]
    git_pending_entries: Vec<PluginPendingPushCacheEntry>,
    #[serde(default)]
    hash_entries: Vec<PluginHashCacheEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PluginGitCacheEntry {
    host_tool: String,
    root_path: String,
    branch: String,
    head: String,
    behind: usize,
    ahead: usize,
    remote_updated_at: String,
    last_editor: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PluginPendingPushCacheEntry {
    host_tool: String,
    root_path: String,
    branch: String,
    head: String,
    working_tree_signature: String,
    ahead: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PluginHashCacheEntry {
    host_tool: String,
    root_path: String,
    baseline_hash: String,
    current_hash: String,
    update_available: bool,
}

const PLUGIN_STATUS_CLEAN: &str = "clean";
const PLUGIN_STATUS_UPDATE_AVAILABLE: &str = "update-available";
const PLUGIN_STATUS_PENDING_PUSH: &str = "pending-push";
const PLUGIN_STATUS_DIVERGED: &str = "diverged";

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ManagedPluginPackageIdentity {
    source: String,
    plugin_relative_path: String,
}

#[derive(Clone, Debug)]
struct RepoNameParts {
    owner: String,
    repo: String,
}

#[derive(Clone, Copy)]
struct PluginHostDetectionSpec {
    label: &'static str,
    app_names: &'static [&'static str],
    executable_names: &'static [&'static str],
}

#[tauri::command]
pub fn probe_plugin_repo(
    path: String,
    hint_host_tool: Option<String>,
) -> Result<PluginProbeResult, String> {
    let root = canonicalize_existing_dir(Path::new(&path))?;
    Ok(probe_plugin_root(&root, hint_host_tool))
}

#[tauri::command]
pub async fn probe_plugin_source(
    source: String,
    git_ref: Option<String>,
    sparse_path: Option<String>,
    hint_host_tool: Option<String>,
) -> Result<PluginProbeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        probe_plugin_source_blocking(
            &source,
            git_ref.as_deref(),
            sparse_path.as_deref(),
            hint_host_tool,
        )
    })
    .await
    .map_err(|error| format!("插件来源探测任务失败: {error}"))?
}

#[tauri::command]
pub async fn probe_plugin_source_candidates(
    source: String,
    git_ref: Option<String>,
    sparse_path: Option<String>,
    hint_host_tool: Option<String>,
) -> Result<Vec<PluginProbeResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        probe_plugin_source_candidates_blocking(
            &source,
            git_ref.as_deref(),
            sparse_path.as_deref(),
            hint_host_tool,
        )
    })
    .await
    .map_err(|error| format!("插件来源批量探测任务失败: {error}"))?
}

#[tauri::command]
pub async fn list_installed_plugins() -> Result<Vec<PluginSummary>, String> {
    tauri::async_runtime::spawn_blocking(|| list_installed_plugins_blocking_with_mode(PluginScanMode::Refresh))
        .await
        .map_err(|error| format!("插件列表扫描任务失败: {error}"))?
}

#[tauri::command]
pub async fn list_startup_installed_plugins() -> Result<Vec<PluginSummary>, String> {
    tauri::async_runtime::spawn_blocking(|| list_installed_plugins_blocking_with_mode(PluginScanMode::Startup))
        .await
        .map_err(|error| format!("插件启动列表扫描任务失败: {error}"))?
}

#[tauri::command]
pub async fn refresh_plugin_states() -> Result<Vec<PluginSummary>, String> {
    tauri::async_runtime::spawn_blocking(|| list_installed_plugins_blocking_with_mode(PluginScanMode::Refresh))
        .await
        .map_err(|error| format!("插件列表扫描任务失败: {error}"))?
}

fn list_installed_plugins_blocking() -> Result<Vec<PluginSummary>, String> {
    list_installed_plugins_blocking_with_mode(PluginScanMode::Refresh)
}

fn list_installed_plugins_blocking_with_mode(
    scan_mode: PluginScanMode,
) -> Result<Vec<PluginSummary>, String> {
    let mut plugins = Vec::new();
    plugins.extend(scan_codex_installed_plugins(scan_mode));
    plugins.extend(scan_claude_installed_plugins(scan_mode));
    plugins.extend(scan_cursor_installed_plugins(scan_mode));
    dedupe_and_sort_plugins(plugins)
}

#[tauri::command]
pub async fn install_selected_plugin_probes(
    probes: Vec<PluginProbeResult>,
    host_tools: Vec<String>,
) -> Result<Vec<PluginSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_selected_plugin_probes_blocking(probes, host_tools)
    })
    .await
    .map_err(|error| format!("插件安装任务失败: {error}"))?
}

fn install_selected_plugin_probes_blocking(
    probes: Vec<PluginProbeResult>,
    host_tools: Vec<String>,
) -> Result<Vec<PluginSummary>, String> {
    let cleanup_roots = plugin_probe_cleanup_roots(&probes);
    let home_dir = workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let install_result = (|| {
        let mut installed_roots = Vec::new();

        for probe in probes {
            let package = ensure_shared_plugin_package(&probe)?;
            let source_root = canonicalize_existing_dir(&package.plugin_root)?;
            for host_tool in &host_tools {
                if !plugin_probe_supports_host(&probe, host_tool) {
                    continue;
                }
                ensure_plugin_host_tool_installed(host_tool)?;
                let installed_root =
                    install_plugin_probe_for_host(&home_dir, &source_root, &probe, host_tool)?;
                installed_roots.push((host_tool.clone(), installed_root));
            }
        }

        let installed_plugins = list_installed_plugins_blocking()?;
        let mut installed = Vec::new();
        for (host_tool, root) in installed_roots {
            if let Some(plugin) = installed_plugins.iter().find(|plugin| {
                plugin.host_tool == host_tool
                    && paths_refer_to_same_dir(Path::new(&plugin.root_path), &root)
            }) {
                installed.push(plugin.clone());
            }
        }

        Ok(installed)
    })();

    cleanup_plugin_probe_repo_roots(&cleanup_roots);
    install_result
}

#[tauri::command]
pub fn open_plugin_in_editor(root_path: &str, editor_id: &str) -> Result<(), String> {
    let plugin_root = canonicalize_existing_dir(Path::new(root_path))?;
    let target_path = find_git_root(&plugin_root).unwrap_or(plugin_root);
    let target = path_to_string(&target_path);
    open_plugin_path_with_editor(&target, editor_id)
}

#[tauri::command]
pub fn set_plugin_enabled(
    host_tool: String,
    root_path: String,
    enabled: bool,
) -> Result<PluginSummary, String> {
    match host_tool.as_str() {
        "codex" => set_codex_plugin_enabled(&root_path, enabled),
        "claude-code" => set_claude_plugin_enabled(&root_path, enabled),
        "cursor" => Err("Cursor 插件暂不支持在 SkillDock 内切换启用状态".to_string()),
        _ => Err(format!("不支持的插件宿主: {host_tool}")),
    }
}

#[tauri::command]
pub fn update_plugin(host_tool: String, root_path: String) -> Result<PluginSummary, String> {
    let target_root = canonicalize_existing_dir(Path::new(&root_path))?;
    ensure_plugin_manifest_for_host(&host_tool, &target_root)?;
    let plugin = find_plugin_after_enabled_change(&host_tool, &target_root)?;
    match plugin.update_strategy.as_str() {
        "git" => {
            update_plugin_repo(&target_root)?;
            find_plugin_after_enabled_change(&host_tool, &target_root)
        }
        "hash" => update_hash_plugin(&host_tool, &target_root),
        _ => Err("该插件当前不支持更新".to_string()),
    }
}

#[tauri::command]
pub fn delete_plugin(host_tool: String, root_path: String) -> Result<(), String> {
    match host_tool.as_str() {
        "codex" => delete_codex_plugin(&root_path),
        "claude-code" => delete_claude_plugin(&root_path),
        "cursor" => delete_cursor_plugin(&root_path),
        _ => Err(format!("不支持的插件宿主: {host_tool}")),
    }
}

#[tauri::command]
pub fn list_cli_tools() -> Result<Vec<CliToolSummary>, String> {
    let mut cli_tools = Vec::new();
    let installed_skills = state::load_installed_skills(&[]);
    for candidate in direct_cli_candidates() {
        if let Some(cli_tool) = probe_direct_cli_tool(candidate, &installed_skills) {
            cli_tools.push(cli_tool);
        }
    }

    cli_tools.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.command.cmp(&right.command))
    });

    Ok(cli_tools)
}

#[tauri::command]
pub fn get_plugin_component_preview(
    plugin_root: String,
    component_id: String,
    asset_type: String,
) -> Result<PluginComponentPreview, String> {
    let root = canonicalize_existing_dir(Path::new(&plugin_root))?;
    if asset_type == "mcp" {
        if let Some(preview) = mcp_server_component_preview(&root, &component_id, &asset_type)? {
            return Ok(preview);
        }
    }
    let preview_path = resolve_component_preview_path(&root, &component_id, &asset_type)?;
    let content = fs::read_to_string(&preview_path).map_err(|error| {
        format!(
            "读取插件组件预览失败（{}）: {error}",
            preview_path.display()
        )
    })?;
    let relative_path = preview_path
        .strip_prefix(&root)
        .map(normalize_relative_path)
        .unwrap_or_else(|_| path_to_string(&preview_path));

    Ok(PluginComponentPreview {
        path: relative_path.clone(),
        title: component_preview_title(&component_id, &relative_path),
        asset_type,
        content,
    })
}

#[tauri::command]
pub fn save_plugin_component_preview(
    plugin_root: String,
    component_id: String,
    asset_type: String,
    content: String,
) -> Result<PluginComponentPreview, String> {
    let root = canonicalize_existing_dir(Path::new(&plugin_root))?;
    if asset_type == "mcp" {
        if let Some(preview) =
            save_mcp_server_component_preview(&root, &component_id, &asset_type, &content)?
        {
            return Ok(preview);
        }
    }
    let preview_path = resolve_component_preview_path(&root, &component_id, &asset_type)?;
    fs::write(&preview_path, &content)
        .map_err(|error| format!("保存插件组件失败（{}）: {error}", preview_path.display()))?;
    let relative_path = preview_path
        .strip_prefix(&root)
        .map(normalize_relative_path)
        .unwrap_or_else(|_| path_to_string(&preview_path));

    Ok(PluginComponentPreview {
        path: relative_path.clone(),
        title: component_preview_title(&component_id, &relative_path),
        asset_type,
        content,
    })
}

fn mcp_server_component_preview(
    root: &Path,
    component_id: &str,
    asset_type: &str,
) -> Result<Option<PluginComponentPreview>, String> {
    let relative_path = safe_relative_path(component_id)?;
    let Some((config_path, config_relative_path, server_name)) =
        mcp_component_config_and_server(root, &relative_path)
    else {
        return Ok(None);
    };
    let content = fs::read_to_string(&config_path)
        .map_err(|error| format!("读取插件组件预览失败（{}）: {error}", config_path.display()))?;
    let config = serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|error| format!("解析 MCP 配置失败（{}）: {error}", config_path.display()))?;
    let Some(server_config) = config
        .get("mcpServers")
        .and_then(serde_json::Value::as_object)
        .and_then(|servers| servers.get(&server_name))
    else {
        return Ok(None);
    };
    let mut servers = serde_json::Map::new();
    servers.insert(server_name.clone(), server_config.clone());
    let mut preview = serde_json::Map::new();
    preview.insert("mcpServers".to_string(), serde_json::Value::Object(servers));
    let preview_content = serde_json::to_string_pretty(&serde_json::Value::Object(preview))
        .map_err(|error| format!("序列化 MCP 组件预览失败: {error}"))?;

    Ok(Some(PluginComponentPreview {
        path: format!("{config_relative_path}/{server_name}"),
        title: server_name,
        asset_type: asset_type.to_string(),
        content: preview_content,
    }))
}

fn save_mcp_server_component_preview(
    root: &Path,
    component_id: &str,
    asset_type: &str,
    content: &str,
) -> Result<Option<PluginComponentPreview>, String> {
    let relative_path = safe_relative_path(component_id)?;
    let Some((config_path, config_relative_path, server_name)) =
        mcp_component_config_and_server(root, &relative_path)
    else {
        return Ok(None);
    };
    let existing_content = fs::read_to_string(&config_path)
        .map_err(|error| format!("读取插件组件失败（{}）: {error}", config_path.display()))?;
    let mut config = serde_json::from_str::<serde_json::Value>(&existing_content)
        .map_err(|error| format!("解析 MCP 配置失败（{}）: {error}", config_path.display()))?;
    let preview_value = serde_json::from_str::<serde_json::Value>(content)
        .map_err(|error| format!("解析组件内容失败: {error}"))?;
    let next_server_config = preview_value
        .get("mcpServers")
        .and_then(serde_json::Value::as_object)
        .and_then(|servers| servers.get(&server_name))
        .cloned()
        .ok_or_else(|| format!("保存 MCP 组件时缺少 mcpServers.{server_name} 配置。"))?;
    let servers = config
        .get_mut("mcpServers")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| {
            format!(
                "MCP 配置缺少 mcpServers 对象（{}）。",
                config_path.display()
            )
        })?;
    servers.insert(server_name.clone(), next_server_config.clone());
    let next_config_content = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("序列化 MCP 配置失败: {error}"))?;
    fs::write(&config_path, next_config_content)
        .map_err(|error| format!("保存插件组件失败（{}）: {error}", config_path.display()))?;

    let mut preview_servers = serde_json::Map::new();
    preview_servers.insert(server_name.clone(), next_server_config);
    let mut preview = serde_json::Map::new();
    preview.insert(
        "mcpServers".to_string(),
        serde_json::Value::Object(preview_servers),
    );
    let preview_content = serde_json::to_string_pretty(&serde_json::Value::Object(preview))
        .map_err(|error| format!("序列化 MCP 组件预览失败: {error}"))?;

    Ok(Some(PluginComponentPreview {
        path: format!("{config_relative_path}/{server_name}"),
        title: server_name,
        asset_type: asset_type.to_string(),
        content: preview_content,
    }))
}

fn scan_codex_installed_plugins(scan_mode: PluginScanMode) -> Vec<PluginSummary> {
    let Some(home_dir) = workspace::home_dir_option() else {
        return Vec::new();
    };
    let cache_root = home_dir.join(".codex/plugins/cache");
    let config_path = home_dir.join(".codex/config.toml");
    let Ok(config_content) = fs::read_to_string(&config_path) else {
        return scan_codex_cached_plugins(&home_dir, None, &BTreeSet::new(), scan_mode);
    };
    let Ok(config) = parse_codex_config(&config_content) else {
        return scan_codex_cached_plugins(&home_dir, None, &BTreeSet::new(), scan_mode);
    };

    let mut installed = Vec::new();
    let mut installed_roots = BTreeSet::new();
    for (plugin_key, plugin_config) in &config.plugins {
        let Some((plugin_name, marketplace_name)) = split_enabled_plugin_key(&plugin_key) else {
            continue;
        };
        let Some(marketplace_config) = config.marketplaces.get(marketplace_name) else {
            continue;
        };
        if marketplace_config.source.trim().is_empty() {
            continue;
        }

        let Some(plugin_root) = resolve_configured_codex_plugin_root(
            &cache_root,
            marketplace_name,
            marketplace_config,
            plugin_name,
        ) else {
            continue;
        };
        let manifest_path = plugin_root.join(CODEX_PLUGIN_MANIFEST);
        if !manifest_path.is_file() {
            continue;
        }

        let source_metadata = read_skilldock_plugin_source_metadata(&plugin_root);
        let source_type =
            resolve_plugin_source_type(&plugin_root, source_metadata.as_ref(), "marketplace");
        let source_url = read_plugin_manifest(&manifest_path)
            .ok()
            .map(|manifest| source_url_from_manifest(&manifest))
            .unwrap_or_default();

        let enabled_state = if plugin_config.enabled {
            "enabled"
        } else {
            "disabled"
        };
        let scopes = vec![build_plugin_scope_summary(
            "user",
            "用户级",
            enabled_state,
            &config_path,
        )];

        if let Some(summary) = build_installed_plugin_summary(InstalledPluginDescriptor {
            host_tool: "codex".to_string(),
            root: plugin_root.clone(),
            display_root: plugin_root,
            manifest_path,
            source_type,
            source_label: marketplace_name.to_string(),
            source_url: source_metadata
                .as_ref()
                .and_then(|metadata| non_empty_trimmed_string(&metadata.source_url))
                .unwrap_or_else(|| {
                    if marketplace_config.source.trim().is_empty() {
                        source_url
                    } else {
                        marketplace_config.source.clone()
                    }
                }),
            source_ref: source_metadata
                .as_ref()
                .and_then(|metadata| non_empty_trimmed_string(&metadata.source_ref))
                .unwrap_or_else(|| marketplace_config.source_ref.clone()),
            source_revision: source_metadata
                .as_ref()
                .and_then(|metadata| non_empty_trimmed_string(&metadata.source_revision))
                .unwrap_or_else(|| marketplace_config.last_revision.clone()),
            current_version: String::new(),
            current_commit: String::new(),
            installed_at: String::new(),
            updated_at: String::new(),
            install_state: "installed".to_string(),
            install_source: if source_metadata.is_some() {
                "skilldock".to_string()
            } else {
                "host".to_string()
            },
            scopes,
        }, scan_mode) {
            installed_roots.insert(summary.root_path.clone());
            installed.push(summary);
        }
    }
    installed.extend(scan_codex_cached_plugins(
        &home_dir,
        Some(&config_path),
        &installed_roots,
        scan_mode,
    ));

    installed
}

fn resolve_configured_codex_plugin_root(
    cache_root: &Path,
    marketplace_name: &str,
    marketplace_config: &CodexMarketplaceConfig,
    plugin_name: &str,
) -> Option<PathBuf> {
    if let Ok(marketplace_root) = canonicalize_existing_dir(Path::new(&marketplace_config.source)) {
        if let Ok(marketplace_manifest) =
            read_marketplace_manifest(&marketplace_root.join(CODEX_MARKETPLACE_MANIFEST))
        {
            if let Some(plugin_root) =
                resolve_codex_plugin_root(&marketplace_root, &marketplace_manifest, plugin_name)
            {
                return Some(plugin_root);
            }
        }
    }

    find_codex_cached_plugin_root(cache_root, marketplace_name, plugin_name)
}

fn find_codex_cached_plugin_root(
    cache_root: &Path,
    marketplace_name: &str,
    plugin_name: &str,
) -> Option<PathBuf> {
    let preferred_root = cache_root.join(marketplace_name).join(plugin_name);
    if let Some(root) = newest_codex_plugin_root_under(&preferred_root) {
        return Some(root);
    }

    let mut candidates = Vec::new();
    collect_codex_plugin_roots(&cache_root.join(marketplace_name), 0, &mut candidates);
    candidates
        .into_iter()
        .filter(|root| cached_codex_plugin_matches(root, plugin_name))
        .max_by_key(|root| file_modified_timestamp(&root.join(CODEX_PLUGIN_MANIFEST)))
}

fn collect_codex_cached_plugin_roots(
    cache_root: &Path,
    marketplace_name: &str,
    plugin_name: &str,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    collect_codex_plugin_roots(&cache_root.join(marketplace_name), 0, &mut candidates);
    candidates
        .into_iter()
        .filter(|root| cached_codex_plugin_matches(root, plugin_name))
        .collect()
}

fn newest_codex_plugin_root_under(root: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    collect_codex_plugin_roots(root, 0, &mut candidates);
    candidates
        .into_iter()
        .max_by_key(|candidate| file_modified_timestamp(&candidate.join(CODEX_PLUGIN_MANIFEST)))
}

fn scan_codex_cached_plugins(
    home_dir: &Path,
    config_path: Option<&Path>,
    installed_roots: &BTreeSet<String>,
    scan_mode: PluginScanMode,
) -> Vec<PluginSummary> {
    let mut plugin_roots = Vec::new();
    collect_codex_plugin_roots(&home_dir.join(".codex/plugins/cache"), 0, &mut plugin_roots);

    let mut plugins = Vec::new();
    let mut seen_roots = installed_roots.clone();
    for plugin_root in plugin_roots {
        let manifest_path = plugin_root.join(CODEX_PLUGIN_MANIFEST);
        let Ok(canonical_root) = canonicalize_existing_dir(&plugin_root) else {
            continue;
        };
        let root_key = path_to_string(&canonical_root);
        if seen_roots.contains(&root_key) {
            continue;
        }
        seen_roots.insert(root_key);

        let source_label = plugin_source_label_from_cache_root(home_dir, &canonical_root);
        let (install_state, scopes) = resolve_cached_codex_plugin_state(
            home_dir,
            &canonical_root,
            &manifest_path,
            config_path,
            &source_label,
        );
        let source_type = if find_git_root(&canonical_root).is_some() {
            "git".to_string()
        } else {
            "marketplace".to_string()
        };
        let source_url = read_plugin_manifest(&manifest_path)
            .ok()
            .map(|manifest| source_url_from_manifest(&manifest))
            .unwrap_or_default();

        if let Some(summary) = build_installed_plugin_summary(InstalledPluginDescriptor {
            host_tool: "codex".to_string(),
            root: canonical_root,
            display_root: plugin_root,
            manifest_path,
            source_type,
            source_label,
            source_url,
            source_ref: String::new(),
            source_revision: String::new(),
            current_version: String::new(),
            current_commit: String::new(),
            installed_at: String::new(),
            updated_at: String::new(),
            install_state,
            install_source: "host".to_string(),
            scopes,
        }, scan_mode) {
            plugins.push(summary);
        }
    }

    plugins
}

fn resolve_cached_codex_plugin_state(
    home_dir: &Path,
    plugin_root: &Path,
    manifest_path: &Path,
    config_path: Option<&Path>,
    source_label: &str,
) -> (String, Vec<PluginScopeSummary>) {
    let Some(config_path) = config_path else {
        return (
            "detected".to_string(),
            vec![build_plugin_scope_summary(
                "cache",
                "缓存",
                "unknown",
                manifest_path,
            )],
        );
    };
    let Ok(config_content) = fs::read_to_string(config_path) else {
        return (
            "detected".to_string(),
            vec![build_plugin_scope_summary(
                "cache",
                "缓存",
                "unknown",
                manifest_path,
            )],
        );
    };
    let Ok(config) = parse_codex_config(&config_content) else {
        return (
            "detected".to_string(),
            vec![build_plugin_scope_summary(
                "cache",
                "缓存",
                "unknown",
                manifest_path,
            )],
        );
    };

    for (plugin_key, plugin_config) in &config.plugins {
        let Some((plugin_name, _)) = split_enabled_plugin_key(&plugin_key) else {
            continue;
        };
        if !cached_codex_plugin_matches(plugin_root, plugin_name) {
            continue;
        }
        let enabled_state = if plugin_config.enabled {
            "enabled"
        } else {
            "disabled"
        };
        return (
            "installed".to_string(),
            vec![build_plugin_scope_summary(
                "user",
                "用户级",
                enabled_state,
                config_path,
            )],
        );
    }

    if infer_codex_plugin_key_for_root(home_dir, &config, plugin_root, Some(source_label)).is_some()
    {
        return (
            "installed".to_string(),
            vec![build_plugin_scope_summary(
                "user",
                "用户级",
                "disabled",
                config_path,
            )],
        );
    }

    (
        "detected".to_string(),
        vec![build_plugin_scope_summary(
            "cache",
            "缓存",
            "unknown",
            manifest_path,
        )],
    )
}

fn cached_codex_plugin_matches(plugin_root: &Path, plugin_name: &str) -> bool {
    let manifest_path = plugin_root.join(CODEX_PLUGIN_MANIFEST);
    if let Ok(manifest) = read_plugin_manifest(&manifest_path) {
        if plugin_name_matches(plugin_name, &manifest.name)
            || plugin_name_matches(plugin_name, &manifest.interface.display_name)
        {
            return true;
        }
    }
    plugin_root
        .file_name()
        .and_then(|value| value.to_str())
        .map(|root_name| plugin_name_matches(plugin_name, root_name))
        .unwrap_or(false)
        || plugin_root
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|value| value.to_str())
            .map(|parent_name| plugin_name_matches(plugin_name, parent_name))
            .unwrap_or(false)
}

fn collect_codex_plugin_roots(root: &Path, depth: usize, roots: &mut Vec<PathBuf>) {
    const MAX_CODEX_PLUGIN_SCAN_DEPTH: usize = 8;
    if depth > MAX_CODEX_PLUGIN_SCAN_DEPTH || !root.is_dir() {
        return;
    }
    if root.join(CODEX_PLUGIN_MANIFEST).is_file() {
        roots.push(root.to_path_buf());
        return;
    }

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_codex_plugin_roots(&path, depth + 1, roots);
        }
    }
}

fn scan_claude_installed_plugins(scan_mode: PluginScanMode) -> Vec<PluginSummary> {
    let Some(home_dir) = workspace::home_dir_option() else {
        return Vec::new();
    };
    let mut installed = Vec::new();
    let installed_state_path = home_dir.join(".claude/plugins/installed_plugins.json");
    let settings_path = home_dir.join(".claude/settings.json");
    let enabled_plugins = read_claude_enabled_plugins(&settings_path).unwrap_or_default();

    if let Ok(installed_state) = read_claude_installed_plugins(&installed_state_path) {
        for (plugin_key, install_entries) in installed_state.plugins {
            for install_entry in install_entries {
                if install_entry.install_path.trim().is_empty() {
                    continue;
                }
                let plugin_root =
                    match canonicalize_existing_dir(Path::new(&install_entry.install_path)) {
                        Ok(path) => path,
                        Err(_) => continue,
                    };
                let manifest_path = plugin_root.join(CLAUDE_PLUGIN_MANIFEST);
                let source_metadata = read_skilldock_plugin_source_metadata(&plugin_root);
                let source_type = resolve_plugin_source_type(
                    &plugin_root,
                    source_metadata.as_ref(),
                    "marketplace",
                );
                let enabled_state = if enabled_plugins.get(&plugin_key).copied().unwrap_or(false) {
                    "enabled"
                } else {
                    "disabled"
                };
                let scopes = vec![build_plugin_scope_summary(
                    "user",
                    "用户级",
                    enabled_state,
                    &settings_path,
                )];

                let source_label = plugin_key
                    .rsplit_once('@')
                    .map(|(_, marketplace_name)| marketplace_name.to_string())
                    .unwrap_or_default();

                let summary = if manifest_path.is_file() {
                    let source_url = read_plugin_manifest(&manifest_path)
                        .ok()
                        .map(|manifest| source_url_from_manifest(&manifest))
                        .unwrap_or_default();
                    build_installed_plugin_summary(InstalledPluginDescriptor {
                        host_tool: "claude-code".to_string(),
                        root: plugin_root.clone(),
                        display_root: PathBuf::from(&install_entry.install_path),
                        manifest_path,
                        source_type,
                        source_label,
                        source_url: source_metadata
                            .as_ref()
                            .and_then(|metadata| non_empty_trimmed_string(&metadata.source_url))
                            .unwrap_or(source_url),
                        source_ref: source_metadata
                            .as_ref()
                            .map(|metadata| metadata.source_ref.clone())
                            .unwrap_or_default(),
                        source_revision: source_metadata
                            .as_ref()
                            .and_then(|metadata| {
                                non_empty_trimmed_string(&metadata.source_revision)
                            })
                            .unwrap_or_default(),
                        current_version: install_entry.version,
                        current_commit: install_entry.git_commit_sha,
                        installed_at: install_entry.installed_at,
                        updated_at: install_entry.last_updated,
                        install_state: "installed".to_string(),
                        install_source: if source_metadata.is_some() {
                            "skilldock".to_string()
                        } else {
                            "host".to_string()
                        },
                        scopes,
                    }, scan_mode)
                } else {
                    build_claude_marketplace_entry_summary(
                        &home_dir,
                        &plugin_root,
                        &plugin_key,
                        install_entry,
                        scopes,
                    )
                };

                if let Some(summary) = summary {
                    installed.push(summary);
                }
            }
        }
    }

    if installed.is_empty() {
        installed.extend(scan_claude_marketplace_roots(&home_dir, scan_mode));
    }

    installed
}

fn build_claude_marketplace_entry_summary(
    home_dir: &Path,
    plugin_root: &Path,
    plugin_key: &str,
    install_entry: ClaudeInstalledPluginEntry,
    scopes: Vec<PluginScopeSummary>,
) -> Option<PluginSummary> {
    let (plugin_name, marketplace_name) = split_enabled_plugin_key(plugin_key)?;
    let marketplace_manifest_path = home_dir
        .join(".claude/plugins/marketplaces")
        .join(marketplace_name)
        .join(CLAUDE_MARKETPLACE_MANIFEST);
    let entry =
        read_claude_marketplace_plugin_entry(&marketplace_manifest_path, plugin_name).ok()??;
    let root = canonicalize_existing_dir(plugin_root).ok()?;
    let plugin_id = format!("claude-code:{}", slugify(plugin_name));
    let mut components = collect_asset_components(&root, &plugin_id);
    if components.is_empty() {
        components = claude_marketplace_entry_components(&entry, &plugin_id);
    }

    let modified_at = latest_modified_in_directory(&root)
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().to_string())
        .or_else(|| file_modified_timestamp(&marketplace_manifest_path))
        .unwrap_or_default();
    let last_scanned_at = current_timestamp_millis();
    let git_root = find_git_root(&root);
    let plugin_relative_path = git_root
        .as_ref()
        .and_then(|repo_root| root.strip_prefix(repo_root).ok())
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let git_state = git_root
        .as_ref()
        .map(|repo_root| plugin_git_state(repo_root, &plugin_relative_path))
        .unwrap_or_default();
    let source_url = entry.source_url;
    let update_strategy = if git_root.is_some() {
        "git".to_string()
    } else if !source_url.trim().is_empty()
        && !normalize_relative_path(&plugin_relative_path).is_empty()
    {
        "hash".to_string()
    } else {
        "none".to_string()
    };

    Some(PluginSummary {
        id: plugin_id,
        package_id: plugin_package_id(&source_url, git_root.as_deref(), &plugin_relative_path),
        name: entry
            .display_name
            .clone()
            .unwrap_or_else(|| plugin_name.to_string()),
        description: entry.description,
        host_tool: "claude-code".to_string(),
        related_host_tools: Vec::new(),
        kind: "plugin-repo".to_string(),
        root_path: path_to_string(&root),
        display_root_path: path_to_string(plugin_root),
        repo_root_path: git_root
            .as_ref()
            .map(|path| path_to_string(path))
            .unwrap_or_else(|| path_to_string(&root)),
        plugin_relative_path: normalize_relative_path(&plugin_relative_path),
        manifest_path: path_to_string(&marketplace_manifest_path),
        source_type: "marketplace".to_string(),
        source_label: marketplace_name.to_string(),
        source_url,
        source_ref: String::new(),
        source_revision: String::new(),
        current_version: if install_entry.version.trim().is_empty() {
            entry.version
        } else {
            install_entry.version
        },
        current_branch: git_state.branch,
        current_commit: if install_entry.git_commit_sha.trim().is_empty() {
            git_state.commit
        } else {
            install_entry.git_commit_sha
        },
        collab_status: git_state.collab_status,
        status_text: git_state.status_text,
        is_git_repo: git_root.is_some(),
        update_mode: "auto".to_string(),
        update_strategy,
        update_available: git_state.update_available,
        baseline_hash: String::new(),
        local_modified: false,
        installed_at: if install_entry.installed_at.trim().is_empty() {
            modified_at.clone()
        } else {
            install_entry.installed_at
        },
        updated_at: if install_entry.last_updated.trim().is_empty() {
            modified_at.clone()
        } else {
            install_entry.last_updated
        },
        remote_updated_at: git_state.remote_updated_at,
        local_updated_at: if git_state.local_updated_at.trim().is_empty() {
            modified_at.clone()
        } else {
            git_state.local_updated_at
        },
        last_editor: git_state.last_editor,
        last_scanned_at,
        status: "ready".to_string(),
        install_state: "installed".to_string(),
        install_source: if read_skilldock_plugin_source_metadata(&root).is_some() {
            "skilldock".to_string()
        } else {
            "host".to_string()
        },
        enabled_state: aggregate_plugin_enabled_state(&scopes),
        scopes,
        components,
    })
}

fn scan_claude_marketplace_roots(home_dir: &Path, scan_mode: PluginScanMode) -> Vec<PluginSummary> {
    let marketplace_root = home_dir.join(".claude/plugins/marketplaces");
    let Ok(entries) = fs::read_dir(&marketplace_root) else {
        return Vec::new();
    };

    let mut installed = Vec::new();
    for entry in entries.flatten() {
        let plugin_root = entry.path();
        if !plugin_root.is_dir() {
            continue;
        }
        let manifest_path = plugin_root.join(CLAUDE_PLUGIN_MANIFEST);
        if !manifest_path.is_file() {
            continue;
        }

        let source_metadata = read_skilldock_plugin_source_metadata(&plugin_root);
        let source_type =
            resolve_plugin_source_type(&plugin_root, source_metadata.as_ref(), "marketplace");
        let source_url = read_plugin_manifest(&manifest_path)
            .ok()
            .map(|manifest| source_url_from_manifest(&manifest))
            .unwrap_or_default();
        let source_label = plugin_root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();

        if let Some(summary) = build_installed_plugin_summary(InstalledPluginDescriptor {
            host_tool: "claude-code".to_string(),
            root: plugin_root.clone(),
            display_root: plugin_root,
            manifest_path,
            source_type,
            source_label,
            source_url: source_metadata
                .as_ref()
                .and_then(|metadata| non_empty_trimmed_string(&metadata.source_url))
                .unwrap_or(source_url),
            source_ref: source_metadata
                .as_ref()
                .map(|metadata| metadata.source_ref.clone())
                .unwrap_or_default(),
            source_revision: source_metadata
                .as_ref()
                .and_then(|metadata| non_empty_trimmed_string(&metadata.source_revision))
                .unwrap_or_default(),
            current_version: String::new(),
            current_commit: String::new(),
            installed_at: String::new(),
            updated_at: String::new(),
            install_state: "installed".to_string(),
            install_source: if source_metadata.is_some() {
                "skilldock".to_string()
            } else {
                "host".to_string()
            },
            scopes: vec![build_plugin_scope_summary(
                "user",
                "用户级",
                "unknown",
                &home_dir.join(".claude/settings.json"),
            )],
        }, scan_mode) {
            installed.push(summary);
        }
    }

    installed
}

fn scan_cursor_installed_plugins(scan_mode: PluginScanMode) -> Vec<PluginSummary> {
    let Some(home_dir) = workspace::home_dir_option() else {
        return Vec::new();
    };
    let home_dir = canonicalize_existing_dir(&home_dir).unwrap_or(home_dir);

    let mut plugin_roots = Vec::new();
    collect_cursor_plugin_roots(
        &home_dir.join(".cursor/plugins/local"),
        0,
        &mut plugin_roots,
    );

    let mut installed = Vec::new();
    let mut seen_roots = BTreeSet::new();
    for plugin_root in plugin_roots {
        let Ok(canonical_root) = canonicalize_existing_dir(&plugin_root) else {
            continue;
        };
        let root_key = path_to_string(&canonical_root);
        if !seen_roots.insert(root_key) {
            continue;
        }

        let manifest_path = canonical_root.join(CURSOR_PLUGIN_MANIFEST);
        let source_metadata = read_skilldock_plugin_source_metadata(&canonical_root);
        let source_type = resolve_plugin_source_type(
            &canonical_root,
            source_metadata.as_ref(),
            if is_under_cursor_local_plugins(&home_dir, &canonical_root) {
                "local"
            } else {
                "marketplace"
            },
        );
        let install_source = if source_metadata.is_some() {
            "skilldock"
        } else {
            "host"
        }
        .to_string();
        let source_url = source_metadata
            .as_ref()
            .and_then(|metadata| non_empty_trimmed_string(&metadata.source_url))
            .unwrap_or_else(|| {
                read_plugin_manifest(&manifest_path)
                    .ok()
                    .map(|manifest| source_url_from_manifest(&manifest))
                    .unwrap_or_default()
            });

        if let Some(summary) = build_installed_plugin_summary(InstalledPluginDescriptor {
            host_tool: "cursor".to_string(),
            root: canonical_root.clone(),
            display_root: plugin_root,
            manifest_path: manifest_path.clone(),
            source_type,
            source_label: cursor_plugin_source_label(&home_dir, &canonical_root),
            source_url,
            source_ref: source_metadata
                .as_ref()
                .map(|metadata| metadata.source_ref.clone())
                .unwrap_or_default(),
            source_revision: source_metadata
                .as_ref()
                .and_then(|metadata| non_empty_trimmed_string(&metadata.source_revision))
                .unwrap_or_else(|| cursor_plugin_source_revision(&home_dir, &canonical_root)),
            current_version: String::new(),
            current_commit: String::new(),
            installed_at: String::new(),
            updated_at: String::new(),
            install_state: "installed".to_string(),
            install_source,
            scopes: vec![build_plugin_scope_summary(
                "user",
                "用户级",
                "enabled",
                &manifest_path,
            )],
        }, scan_mode) {
            installed.push(summary);
        }
    }

    installed
}

fn set_codex_plugin_enabled(root_path: &str, enabled: bool) -> Result<PluginSummary, String> {
    let home_dir = workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let config_path = home_dir.join(".codex/config.toml");
    let config_content = fs::read_to_string(&config_path).map_err(|error| {
        format!(
            "读取 Codex config.toml 失败（{}）: {error}",
            config_path.display()
        )
    })?;
    let config = parse_codex_config(&config_content)?;
    let target_root = canonicalize_existing_dir(Path::new(root_path))?;
    let plugin_key = find_codex_plugin_key_for_root(&home_dir, &config, &target_root)?;
    let mut document = config_content.parse::<DocumentMut>().map_err(|error| {
        format!(
            "解析 Codex config.toml 失败（{}）: {error}",
            config_path.display()
        )
    })?;

    if document.get("plugins").is_none() {
        document["plugins"] = Item::Table(Table::new());
    }
    let plugins_table = document
        .get_mut("plugins")
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| "Codex config.toml plugins 配置不是表".to_string())?;
    if !plugins_table.contains_key(&plugin_key) {
        plugins_table.insert(&plugin_key, Item::Table(Table::new()));
    }
    let plugin_item = plugins_table
        .get_mut(&plugin_key)
        .ok_or_else(|| format!("Codex config.toml 中找不到插件配置: {plugin_key}"))?;
    let plugin_table = plugin_item
        .as_table_like_mut()
        .ok_or_else(|| format!("Codex 插件配置格式不支持修改: {plugin_key}"))?;
    plugin_table.insert("enabled", toml_edit::value(enabled));

    fs::write(&config_path, document.to_string()).map_err(|error| {
        format!(
            "写入 Codex config.toml 失败（{}）: {error}",
            config_path.display()
        )
    })?;
    find_codex_plugin_after_enabled_change(&home_dir, &config, &plugin_key, &target_root)
}

fn delete_codex_plugin(root_path: &str) -> Result<(), String> {
    let home_dir = workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let config_path = home_dir.join(".codex/config.toml");
    let requested_root = PathBuf::from(root_path);
    let target_root = canonicalize_existing_dir(Path::new(root_path))?;
    ensure_plugin_manifest_for_host("codex", &target_root)?;
    let managed_package_root = managed_plugin_package_root_for_path(&target_root);
    let should_remove_managed_package = managed_package_root
        .as_ref()
        .is_some_and(|package_root| plugin_root_is_last_host_install(package_root, "codex"));
    let config_content = if config_path.is_file() {
        Some(fs::read_to_string(&config_path).map_err(|error| {
            format!(
                "读取 Codex config.toml 失败（{}）: {error}",
                config_path.display()
            )
        })?)
    } else {
        None
    };
    let mut roots_to_remove = BTreeMap::<String, PathBuf>::new();
    if should_delete_codex_physical_root(&home_dir, &target_root) {
        roots_to_remove.insert(path_to_string(&requested_root), requested_root.clone());
    }
    if should_remove_managed_package {
        if let Some(package_root) = managed_package_root {
            insert_managed_plugin_package_roots_to_remove(&mut roots_to_remove, &package_root);
        }
    }

    let config_update = if let Some(content) = config_content.as_deref() {
        let config = parse_codex_config(content)?;
        find_codex_plugin_key_for_root(&home_dir, &config, &target_root)
            .ok()
            .map(|plugin_key| {
                let (plugin_name, marketplace_name) = split_enabled_plugin_key(&plugin_key)
                    .map(|(plugin_name, marketplace_name)| {
                        (plugin_name.to_string(), marketplace_name.to_string())
                    })
                    .unwrap_or_default();
                let cache_root = home_dir.join(".codex/plugins/cache");
                for cached_root in
                    collect_codex_cached_plugin_roots(&cache_root, &marketplace_name, &plugin_name)
                {
                    roots_to_remove.insert(path_to_string(&cached_root), cached_root);
                }
                let should_remove_marketplace = !marketplace_name.is_empty()
                    && !config.plugins.keys().any(|candidate_key| {
                        if candidate_key == &plugin_key {
                            return false;
                        }
                        split_enabled_plugin_key(candidate_key)
                            .map(|(_, candidate_marketplace)| {
                                candidate_marketplace == marketplace_name.as_str()
                            })
                            .unwrap_or(false)
                    });

                (plugin_key, marketplace_name, should_remove_marketplace)
            })
    } else {
        None
    };

    if let Some((plugin_key, _, _)) = config_update.as_ref() {
        let _ = remove_codex_plugin_via_cli(&home_dir, plugin_key);
    }

    remove_codex_plugin_roots(roots_to_remove.into_values())?;

    let Some((plugin_key, marketplace_name, should_remove_marketplace)) = config_update else {
        return Ok(());
    };
    let content = config_content.unwrap_or_default();
    let mut document = content.parse::<DocumentMut>().map_err(|error| {
        format!(
            "解析 Codex config.toml 失败（{}）: {error}",
            config_path.display()
        )
    })?;
    let plugins_table = document
        .get_mut("plugins")
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| "Codex config.toml 缺少 plugins 配置".to_string())?;
    plugins_table.remove(&plugin_key);
    if should_remove_marketplace {
        if let Some(marketplaces_table) = document
            .get_mut("marketplaces")
            .and_then(Item::as_table_like_mut)
        {
            marketplaces_table.remove(&marketplace_name);
        }
    }
    fs::write(&config_path, document.to_string()).map_err(|error| {
        format!(
            "写入 Codex config.toml 失败（{}）: {error}",
            config_path.display()
        )
    })
}

fn remove_codex_plugin_via_cli(home_dir: &Path, plugin_key: &str) -> Result<(), String> {
    let codex_cli = codex_cli_path();
    if !codex_cli.is_file() {
        return Err(format!("Codex CLI 不存在: {}", codex_cli.display()));
    }

    run_codex_cli(home_dir, &codex_cli, &["plugin", "remove", plugin_key])
}

fn find_codex_plugin_key_for_root(
    home_dir: &Path,
    config: &CodexConfigFile,
    target_root: &Path,
) -> Result<String, String> {
    find_existing_codex_plugin_key_for_root(home_dir, config, target_root).or_else(|_| {
        infer_codex_plugin_key_for_root(home_dir, config, target_root, None).ok_or_else(|| {
            "未能在 Codex config.toml 中匹配到该插件，暂不能切换启用状态".to_string()
        })
    })
}

fn find_existing_codex_plugin_key_for_root(
    home_dir: &Path,
    config: &CodexConfigFile,
    target_root: &Path,
) -> Result<String, String> {
    let cache_root = home_dir.join(".codex/plugins/cache");
    for (plugin_key, _) in &config.plugins {
        let Some((plugin_name, marketplace_name)) = split_enabled_plugin_key(plugin_key) else {
            continue;
        };
        let Some(marketplace_config) = config.marketplaces.get(marketplace_name) else {
            continue;
        };
        let Some(plugin_root) = resolve_configured_codex_plugin_root(
            &cache_root,
            marketplace_name,
            marketplace_config,
            plugin_name,
        ) else {
            continue;
        };
        if paths_refer_to_same_dir(&plugin_root, target_root) {
            return Ok(plugin_key.clone());
        }
    }

    Err("未能在 Codex config.toml 中匹配到该插件，暂不能切换启用状态".to_string())
}

fn infer_codex_plugin_key_for_root(
    home_dir: &Path,
    config: &CodexConfigFile,
    target_root: &Path,
    source_label: Option<&str>,
) -> Option<String> {
    let cache_marketplace_name = source_label
        .and_then(non_empty_trimmed_string)
        .or_else(|| codex_cache_marketplace_name(home_dir, target_root));
    for (marketplace_name, marketplace_config) in &config.marketplaces {
        if cache_marketplace_name
            .as_deref()
            .is_some_and(|name| name != marketplace_name.as_str())
        {
            continue;
        }
        if let Some(plugin_name) =
            infer_codex_marketplace_plugin_name_for_root(marketplace_config, target_root)
        {
            return Some(format!("{plugin_name}@{marketplace_name}"));
        }
    }

    None
}

fn infer_codex_marketplace_plugin_name_for_root(
    marketplace_config: &CodexMarketplaceConfig,
    target_root: &Path,
) -> Option<String> {
    let marketplace_root = canonicalize_existing_dir(Path::new(&marketplace_config.source)).ok()?;
    let marketplace_manifest =
        read_marketplace_manifest(&marketplace_root.join(CODEX_MARKETPLACE_MANIFEST)).ok()?;
    for plugin in marketplace_manifest.plugins {
        let plugin_name = plugin.name.trim();
        if plugin_name.is_empty() {
            continue;
        }
        let source_path = plugin.source.path.trim();
        let local_root_matches = if source_path.is_empty() {
            false
        } else {
            paths_refer_to_same_dir(&marketplace_root.join(source_path), target_root)
        };
        if local_root_matches || cached_codex_plugin_matches(target_root, plugin_name) {
            return Some(plugin_name.to_string());
        }
    }

    None
}

fn codex_cache_marketplace_name(home_dir: &Path, plugin_root: &Path) -> Option<String> {
    let cache_root = home_dir.join(".codex/plugins/cache");
    let cache_root = canonicalize_existing_dir(&cache_root).unwrap_or(cache_root);
    plugin_root
        .strip_prefix(cache_root)
        .ok()
        .and_then(|relative_path| relative_path.components().next())
        .and_then(|component| component.as_os_str().to_str())
        .and_then(non_empty_trimmed_string)
}

fn remove_codex_plugin_roots<I>(roots: I) -> Result<(), String>
where
    I: IntoIterator<Item = PathBuf>,
{
    remove_plugin_roots(roots, "Codex")
}

fn should_delete_codex_physical_root(home_dir: &Path, target_root: &Path) -> bool {
    managed_plugin_package_root_for_path(target_root).is_some()
        || target_root
            .strip_prefix(home_dir.join(".codex/plugins/cache"))
            .is_ok()
}

fn remove_plugin_roots<I>(roots: I, label: &str) -> Result<(), String>
where
    I: IntoIterator<Item = PathBuf>,
{
    for root in roots {
        if fs::symlink_metadata(&root).is_err() {
            continue;
        }
        match remove_path(&root) {
            Ok(()) => {}
            Err(error) => {
                return Err(format!(
                    "删除 {label} 插件目录失败（{}）: {error}",
                    root.display()
                ));
            }
        }
    }

    Ok(())
}

fn managed_plugin_package_root_for_path(path: &Path) -> Option<PathBuf> {
    let managed_plugins_root = workspace::managed_workspace_root()
        .ok()?
        .join(PLUGIN_PACKAGE_DIR);
    let canonical_managed_root = canonicalize_existing_dir(&managed_plugins_root).ok()?;
    let canonical_path = canonicalize_existing_dir(path).ok()?;
    let relative_path = canonical_path.strip_prefix(&canonical_managed_root).ok()?;
    let package_name = relative_path.components().next()?.as_os_str();
    Some(canonical_managed_root.join(package_name))
}

fn plugin_root_is_last_host_install(managed_package_root: &Path, deleting_host_tool: &str) -> bool {
    let Ok(installed_plugins) = list_installed_plugins_blocking() else {
        return false;
    };

    !installed_plugins.iter().any(|plugin| {
        if plugin.host_tool == deleting_host_tool {
            return false;
        }

        let plugin_display_root = if plugin.display_root_path.trim().is_empty() {
            Path::new(&plugin.root_path)
        } else {
            Path::new(&plugin.display_root_path)
        };

        managed_plugin_package_root_for_path(plugin_display_root)
            .or_else(|| managed_plugin_package_root_for_path(Path::new(&plugin.root_path)))
            .is_some_and(|package_root| {
                paths_refer_to_same_dir(&package_root, managed_package_root)
            })
    })
}

fn insert_managed_plugin_package_roots_to_remove(
    roots_to_remove: &mut BTreeMap<String, PathBuf>,
    managed_package_root: &Path,
) {
    roots_to_remove.insert(
        path_to_string(managed_package_root),
        managed_package_root.to_path_buf(),
    );

    let Some(active_identity) = read_plugin_package_identity(managed_package_root) else {
        return;
    };
    let package_parent = workspace::managed_workspace_root()
        .ok()
        .map(|root| root.join(PLUGIN_PACKAGE_DIR));
    let Some(package_parent) = package_parent else {
        return;
    };

    if let Ok(entries) = fs::read_dir(&package_parent) {
        for entry in entries.flatten() {
            let candidate_root = entry.path();
            if read_plugin_package_identity(&candidate_root).as_ref() == Some(&active_identity) {
                roots_to_remove.insert(path_to_string(&candidate_root), candidate_root);
            }
        }
    }

    for package_id in shared_plugin_package_id_candidates(
        &active_identity.source,
        Path::new(&active_identity.plugin_relative_path),
    ) {
        if let Ok(candidate_root) = shared_plugin_package_repo_root(&package_id) {
            if is_unidentified_plugin_package_placeholder(&candidate_root) {
                roots_to_remove.insert(path_to_string(&candidate_root), candidate_root);
            }
        }
    }
}

fn set_claude_plugin_enabled(root_path: &str, enabled: bool) -> Result<PluginSummary, String> {
    let home_dir = workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let installed_state_path = home_dir.join(".claude/plugins/installed_plugins.json");
    let settings_path = home_dir.join(".claude/settings.json");
    let installed_state = read_claude_installed_plugins(&installed_state_path)?;
    let target_root = canonicalize_existing_dir(Path::new(root_path))?;
    let plugin_key = find_claude_plugin_key_for_root(&installed_state, &target_root)?;

    let mut settings = read_json_object_or_empty(&settings_path)?;
    let settings_object = settings
        .as_object_mut()
        .ok_or_else(|| "Claude settings.json 根节点不是对象".to_string())?;
    let enabled_plugins = settings_object
        .entry("enabledPlugins".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !enabled_plugins.is_object() {
        *enabled_plugins = serde_json::json!({});
    }
    enabled_plugins
        .as_object_mut()
        .ok_or_else(|| "Claude enabledPlugins 配置不是对象".to_string())?
        .insert(plugin_key, serde_json::json!(enabled));

    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("创建 Claude 配置目录失败（{}）: {error}", parent.display())
        })?;
    }
    let settings_content = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("序列化 Claude settings.json 失败: {error}"))?;
    fs::write(&settings_path, format!("{settings_content}\n")).map_err(|error| {
        format!(
            "写入 Claude settings.json 失败（{}）: {error}",
            settings_path.display()
        )
    })?;

    find_plugin_after_enabled_change("claude-code", &target_root)
}

fn delete_claude_plugin(root_path: &str) -> Result<(), String> {
    let home_dir = workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let installed_state_path = home_dir.join(".claude/plugins/installed_plugins.json");
    let settings_path = home_dir.join(".claude/settings.json");
    let installed_state = if installed_state_path.is_file() {
        Some(read_claude_installed_plugins(&installed_state_path)?)
    } else {
        None
    };
    let requested_root = PathBuf::from(root_path);
    let target_root = canonicalize_existing_dir(Path::new(root_path))?;
    ensure_plugin_manifest_for_host("claude-code", &target_root)?;
    let plugin_key = installed_state
        .as_ref()
        .and_then(|state| find_claude_plugin_key_for_root(state, &target_root).ok());
    let managed_package_root = managed_plugin_package_root_for_path(&target_root);
    let should_remove_managed_package = managed_package_root
        .as_ref()
        .is_some_and(|package_root| plugin_root_is_last_host_install(package_root, "claude-code"));
    let mut roots_to_remove = BTreeMap::<String, PathBuf>::new();
    roots_to_remove.insert(path_to_string(&requested_root), requested_root.clone());
    if should_remove_managed_package {
        if let Some(package_root) = managed_package_root {
            insert_managed_plugin_package_roots_to_remove(&mut roots_to_remove, &package_root);
        }
    }
    if let Some(state) = installed_state.as_ref() {
        for root in collect_claude_plugin_roots_for_target(state, &target_root) {
            roots_to_remove.insert(path_to_string(&root), root);
        }
    }

    if installed_state.is_some() {
        remove_claude_installed_plugin_entry(&installed_state_path, &target_root)?;
    }
    if let Some(plugin_key) = plugin_key {
        remove_claude_enabled_plugin_entry(&settings_path, &plugin_key)?;
    }

    remove_plugin_roots(roots_to_remove.into_values(), "Claude")
}

fn delete_cursor_plugin(root_path: &str) -> Result<(), String> {
    let requested_root = PathBuf::from(root_path);
    let target_root = canonicalize_existing_dir(Path::new(root_path))?;
    ensure_plugin_manifest_for_host("cursor", &target_root)?;
    let managed_package_root = managed_plugin_package_root_for_path(&target_root);
    let should_remove_managed_package = managed_package_root
        .as_ref()
        .is_some_and(|package_root| plugin_root_is_last_host_install(package_root, "cursor"));
    let mut roots_to_remove = BTreeMap::<String, PathBuf>::new();
    roots_to_remove.insert(path_to_string(&requested_root), requested_root.clone());
    if should_remove_managed_package {
        if let Some(package_root) = managed_package_root {
            insert_managed_plugin_package_roots_to_remove(&mut roots_to_remove, &package_root);
        }
    }
    if let Some(home_dir) = workspace::home_dir_option() {
        for root in collect_cursor_plugin_roots_for_target(&home_dir, &target_root) {
            roots_to_remove.insert(path_to_string(&root), root);
        }
    }
    remove_plugin_roots(roots_to_remove.into_values(), "Cursor")
}

fn collect_cursor_plugin_roots_for_target(home_dir: &Path, target_root: &Path) -> Vec<PathBuf> {
    let cursor_root = home_dir.join(".cursor/plugins/local");
    let mut roots = Vec::new();
    let Ok(entries) = fs::read_dir(cursor_root) else {
        return roots;
    };
    for entry in entries.flatten() {
        let candidate_root = entry.path();
        if paths_refer_to_same_dir(&candidate_root, target_root) {
            roots.push(candidate_root);
        }
    }
    roots
}

fn find_claude_plugin_key_for_root(
    installed_state: &ClaudeInstalledPluginsFile,
    target_root: &Path,
) -> Result<String, String> {
    for (plugin_key, install_entries) in &installed_state.plugins {
        for install_entry in install_entries {
            if install_entry.install_path.trim().is_empty() {
                continue;
            }
            if paths_refer_to_same_dir(Path::new(&install_entry.install_path), target_root) {
                return Ok(plugin_key.clone());
            }
        }
    }

    Err("未能在 Claude installed_plugins.json 中匹配到该插件，暂不能切换启用状态".to_string())
}

fn collect_claude_plugin_roots_for_target(
    installed_state: &ClaudeInstalledPluginsFile,
    target_root: &Path,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for install_entries in installed_state.plugins.values() {
        for install_entry in install_entries {
            if install_entry.install_path.trim().is_empty() {
                continue;
            }
            let candidate_root = PathBuf::from(&install_entry.install_path);
            if paths_refer_to_same_dir(&candidate_root, target_root) {
                roots.push(candidate_root);
            }
        }
    }
    roots
}

fn remove_claude_installed_plugin_entry(
    installed_state_path: &Path,
    target_root: &Path,
) -> Result<(), String> {
    let mut installed_state = read_json_object_or_empty(installed_state_path)?;
    let state_object = installed_state
        .as_object_mut()
        .ok_or_else(|| "Claude installed_plugins.json 根节点不是对象".to_string())?;
    let Some(plugins_value) = state_object.get_mut("plugins") else {
        return Ok(());
    };
    let plugins_object = plugins_value
        .as_object_mut()
        .ok_or_else(|| "Claude installed_plugins.json plugins 不是对象".to_string())?;
    let mut empty_plugin_keys = Vec::new();

    for (plugin_key, entries_value) in plugins_object.iter_mut() {
        let Some(entries) = entries_value.as_array_mut() else {
            continue;
        };
        entries.retain(|entry| {
            entry
                .get("installPath")
                .and_then(serde_json::Value::as_str)
                .map(|install_path| !paths_refer_to_same_dir(Path::new(install_path), target_root))
                .unwrap_or(true)
        });
        if entries.is_empty() {
            empty_plugin_keys.push(plugin_key.clone());
        }
    }

    for plugin_key in empty_plugin_keys {
        plugins_object.remove(&plugin_key);
    }

    write_json_config(
        installed_state_path,
        &installed_state,
        "Claude installed_plugins.json",
    )
}

fn remove_claude_enabled_plugin_entry(
    settings_path: &Path,
    plugin_key: &str,
) -> Result<(), String> {
    if !settings_path.is_file() {
        return Ok(());
    }

    let mut settings = read_json_object_or_empty(settings_path)?;
    if let Some(enabled_plugins) = settings
        .as_object_mut()
        .and_then(|object| object.get_mut("enabledPlugins"))
        .and_then(serde_json::Value::as_object_mut)
    {
        enabled_plugins.remove(plugin_key);
    }
    write_json_config(settings_path, &settings, "Claude settings.json")
}

fn write_json_config(path: &Path, value: &serde_json::Value, label: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 {label} 目录失败（{}）: {error}", parent.display()))?;
    }
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("序列化 {label} 失败: {error}"))?;
    fs::write(path, format!("{content}\n"))
        .map_err(|error| format!("写入 {label} 失败（{}）: {error}", path.display()))
}

fn legacy_plugin_update_metadata_path(plugin_root: &Path) -> PathBuf {
    plugin_root.join(PLUGIN_UPDATE_METADATA_FILE)
}

fn plugin_update_metadata_path(plugin_root: &Path) -> PathBuf {
    git_scoped_skilldock_metadata_path(
        plugin_root,
        SKILLDOCK_PLUGIN_UPDATE_METADATA_DIR,
        PLUGIN_UPDATE_METADATA_FILE,
    )
    .unwrap_or_else(|| legacy_plugin_update_metadata_path(plugin_root))
}

fn read_plugin_update_metadata(plugin_root: &Path) -> SkillDockPluginUpdateMetadata {
    let metadata_path = plugin_update_metadata_path(plugin_root);
    let metadata_path = if metadata_path.is_file() {
        metadata_path
    } else {
        legacy_plugin_update_metadata_path(plugin_root)
    };
    if !metadata_path.is_file() {
        return SkillDockPluginUpdateMetadata::default();
    }

    let content = match fs::read_to_string(&metadata_path) {
        Ok(value) => value,
        Err(_) => return SkillDockPluginUpdateMetadata::default(),
    };
    if content.trim().is_empty() {
        return SkillDockPluginUpdateMetadata::default();
    }

    serde_json::from_str::<SkillDockPluginUpdateMetadata>(&content).unwrap_or_default()
}

fn write_plugin_update_metadata(
    plugin_root: &Path,
    metadata: &SkillDockPluginUpdateMetadata,
) -> Result<(), String> {
    let metadata_path = plugin_update_metadata_path(plugin_root);
    if let Some(parent) = metadata_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "创建插件更新元数据目录失败（{}）: {error}",
                parent.display()
            )
        })?;
    }
    let content = serde_json::to_string_pretty(metadata)
        .map_err(|error| format!("序列化插件更新元数据失败: {error}"))?;
    fs::write(&metadata_path, format!("{content}\n")).map_err(|error| {
        format!(
            "写入插件更新元数据失败（{}）: {error}",
            metadata_path.display()
        )
    })?;
    let legacy_path = legacy_plugin_update_metadata_path(plugin_root);
    if metadata_path != legacy_path {
        remove_file_if_exists(&legacy_path)?;
    }
    Ok(())
}

fn read_json_object_or_empty(path: &Path) -> Result<serde_json::Value, String> {
    if !path.is_file() {
        return Ok(serde_json::json!({}));
    }

    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取 JSON 配置失败（{}）: {error}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }

    let value = serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|error| format!("解析 JSON 配置失败（{}）: {error}", path.display()))?;
    if value.is_object() {
        Ok(value)
    } else {
        Ok(serde_json::json!({}))
    }
}

fn find_plugin_after_enabled_change(
    host_tool: &str,
    target_root: &Path,
) -> Result<PluginSummary, String> {
    list_installed_plugins_blocking()?
        .into_iter()
        .find(|plugin| {
            plugin.host_tool == host_tool
                && paths_refer_to_same_dir(Path::new(&plugin.root_path), target_root)
        })
        .ok_or_else(|| "插件启用状态已写入，但重新扫描后未找到该插件".to_string())
}

fn find_codex_plugin_after_enabled_change(
    home_dir: &Path,
    config: &CodexConfigFile,
    plugin_key: &str,
    target_root: &Path,
) -> Result<PluginSummary, String> {
    let cache_root = home_dir.join(".codex/plugins/cache");
    let mut expected_roots = vec![target_root.to_path_buf()];
    if let Some((plugin_name, marketplace_name)) = split_enabled_plugin_key(plugin_key) {
        if let Some(marketplace_config) = config.marketplaces.get(marketplace_name) {
            if let Some(configured_root) = resolve_configured_codex_plugin_root(
                &cache_root,
                marketplace_name,
                marketplace_config,
                plugin_name,
            ) {
                expected_roots.push(configured_root);
            }
        }
    }

    list_installed_plugins_blocking()?
        .into_iter()
        .find(|plugin| {
            plugin.host_tool == "codex"
                && expected_roots
                    .iter()
                    .any(|root| paths_refer_to_same_dir(Path::new(&plugin.root_path), root))
        })
        .ok_or_else(|| "插件启用状态已写入，但重新扫描后未找到该插件".to_string())
}

fn ensure_plugin_manifest_for_host(host_tool: &str, plugin_root: &Path) -> Result<(), String> {
    let manifest_path = match host_tool {
        "codex" => plugin_root.join(CODEX_PLUGIN_MANIFEST),
        "claude-code" => plugin_root.join(CLAUDE_PLUGIN_MANIFEST),
        "cursor" => plugin_root.join(CURSOR_PLUGIN_MANIFEST),
        _ => return Err(format!("不支持的插件宿主: {host_tool}")),
    };
    if manifest_path.is_file() {
        return Ok(());
    }

    Err(format!(
        "目录不是有效的 {host_tool} 插件目录: {}",
        plugin_root.display()
    ))
}

fn update_hash_plugin(host_tool: &str, target_root: &Path) -> Result<PluginSummary, String> {
    let plugin = find_plugin_after_enabled_change(host_tool, target_root)?;
    if plugin.update_strategy != "hash" {
        return Err("该插件当前不支持 hash 更新".to_string());
    }

    let plugin_relative_path = plugin.plugin_relative_path.trim().to_string();
    let repo_key = format!(
        "plugin-update-{}",
        short_stable_hash(&format!(
            "{}#{}#{}",
            plugin.source_url, plugin.source_ref, plugin_relative_path
        ))
    );
    let sparse_paths = if plugin_relative_path.is_empty() {
        Vec::new()
    } else {
        vec![plugin_relative_path.clone()]
    };
    let repo_root = clone_repo_for_discovery_with_ref_and_sparse_paths(
        &plugin.source_url,
        non_empty_trimmed_string(&plugin.source_ref).as_deref(),
        &repo_key,
        &sparse_paths,
    )?;
    let remote_plugin_root = if plugin_relative_path.is_empty() {
        repo_root.clone()
    } else {
        repo_root.join(&plugin_relative_path)
    };
    if !remote_plugin_root.is_dir() {
        let _ = fs::remove_dir_all(&repo_root);
        return Err(format!(
            "远端插件目录不存在: {}",
            remote_plugin_root.display()
        ));
    }

    let manifest_relative_path = match host_tool {
        "codex" => PathBuf::from(CODEX_PLUGIN_MANIFEST),
        "claude-code" => PathBuf::from(CLAUDE_PLUGIN_MANIFEST),
        "cursor" => PathBuf::from(CURSOR_PLUGIN_MANIFEST),
        _ => {
            let _ = fs::remove_dir_all(&repo_root);
            return Err(format!("不支持的插件宿主: {host_tool}"));
        }
    };
    if !remote_plugin_root.join(&manifest_relative_path).is_file() {
        let _ = fs::remove_dir_all(&repo_root);
        return Err("远端插件目录缺少宿主 manifest，无法更新".to_string());
    }

    let parent_dir = target_root
        .parent()
        .ok_or_else(|| "无法确定插件目录父路径".to_string())?;
    let temp_target = parent_dir.join(format!(
        ".skilldock-update-{}",
        short_stable_hash(&path_to_string(target_root))
    ));
    if temp_target.exists() || fs::symlink_metadata(&temp_target).is_ok() {
        remove_path(&temp_target)?;
    }
    copy_dir_all(&remote_plugin_root, &temp_target)?;
    if target_root.exists() || fs::symlink_metadata(target_root).is_ok() {
        remove_path(target_root)?;
    }
    fs::rename(&temp_target, target_root).map_err(|error| {
        format!(
            "替换插件目录失败（{} -> {}）: {error}",
            temp_target.display(),
            target_root.display()
        )
    })?;

    let new_baseline_hash = compute_plugin_dir_hash(target_root)?;
    write_plugin_update_metadata(
        target_root,
        &SkillDockPluginUpdateMetadata {
            baseline_hash: new_baseline_hash,
        },
    )?;

    let _ = fs::remove_dir_all(&repo_root);
    find_plugin_after_enabled_change(host_tool, target_root)
}

fn plugin_probe_supports_host(probe: &PluginProbeResult, host_tool: &str) -> bool {
    if probe.tool == host_tool {
        return true;
    }

    probe
        .compatible_host_tools
        .iter()
        .any(|tool| tool == host_tool)
}

fn update_plugin_repo(plugin_root: &Path) -> Result<(), String> {
    let repo_root = find_git_root(plugin_root)
        .ok_or_else(|| "插件目录未关联 Git 仓库，无法自动更新。".to_string())?;
    let plugin_relative_path = plugin_root
        .strip_prefix(&repo_root)
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let scoped_path = normalize_relative_path(&plugin_relative_path);
    let status_args = scoped_git_args(&["status", "--porcelain"], &scoped_path);
    let local_changes = run_git_dynamic_at(&repo_root, &status_args)?;
    if !local_changes.trim().is_empty() {
        return Err("插件目录存在本地未提交改动，请先推送或清理后再更新。".to_string());
    }

    let branch = run_git_at(&repo_root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if branch.is_empty() || branch == "HEAD" {
        return Err("当前插件仓库处于 detached HEAD，无法自动更新。".to_string());
    }

    run_git_at(&repo_root, &["fetch", "origin", "--quiet"])?;
    let remote_branch = format!("{REMOTE_BRANCH_PREFIX}{branch}");
    run_git_at(&repo_root, &["merge", "--ff-only", &remote_branch])?;
    Ok(())
}

fn install_plugin_probe_for_host(
    home_dir: &Path,
    source_root: &Path,
    probe: &PluginProbeResult,
    host_tool: &str,
) -> Result<PathBuf, String> {
    ensure_plugin_manifest_for_host(host_tool, source_root)?;
    match host_tool {
        "codex" => install_codex_plugin_probe(home_dir, source_root, probe),
        "claude-code" => install_claude_plugin_probe(home_dir, source_root, probe),
        "cursor" => install_cursor_plugin_probe(home_dir, source_root, probe),
        _ => Err(format!("不支持的插件宿主: {host_tool}")),
    }
}

fn ensure_shared_plugin_package(probe: &PluginProbeResult) -> Result<SharedPluginPackage, String> {
    let source_root = canonicalize_existing_dir(Path::new(&probe.plugin_root))?;
    let source_git_root = non_empty_trimmed_string(&probe.git_root)
        .and_then(|value| canonicalize_existing_dir(Path::new(&value)).ok())
        .filter(|path| path.join(".git").is_dir())
        .or_else(|| find_git_root(&source_root));
    let plugin_relative_path =
        plugin_relative_path_for_probe(probe, source_git_root.as_deref(), &source_root);

    if let Some(git_root) = source_git_root.as_ref() {
        let source = canonical_plugin_package_source(probe, git_root);
        let source_spec = parse_market_source_url(&source).ok();
        let identity_source = source_spec
            .as_ref()
            .map(|spec| spec.clone_url.as_str())
            .unwrap_or(source.as_str());
        let package_id = resolve_shared_plugin_package_id(identity_source, &plugin_relative_path)?;
        let repo_root = shared_plugin_package_repo_root(&package_id)?;
        ensure_shared_plugin_repo_from_existing(
            git_root,
            &repo_root,
            identity_source,
            &plugin_relative_path,
        )?;
        cleanup_duplicate_plugin_package_roots(&repo_root, identity_source, &plugin_relative_path)?;
        let plugin_root = if plugin_relative_path.as_os_str().is_empty() {
            repo_root
        } else {
            repo_root.join(&plugin_relative_path)
        };
        return Ok(SharedPluginPackage { plugin_root });
    }

    if let Some(source_url) = non_empty_trimmed_string(&probe.source_url) {
        if source_url.starts_with("http://")
            || source_url.starts_with("https://")
            || source_url.contains('@')
        {
            let source_spec = parse_market_source_url(&source_url)?;
            let package_id =
                resolve_shared_plugin_package_id(&source_spec.clone_url, &plugin_relative_path)?;
            let repo_root = shared_plugin_package_repo_root(&package_id)?;
            if !source_root.join(".git").is_dir() && !find_git_root(&source_root).is_some() {
                let plugin_root = if plugin_relative_path.as_os_str().is_empty() {
                    repo_root.clone()
                } else {
                    repo_root.join(&plugin_relative_path)
                };
                copy_plugin_dir(&source_root, &plugin_root)?;
                write_plugin_package_identity(
                    &repo_root,
                    &source_spec.clone_url,
                    &plugin_relative_path,
                )?;
                cleanup_duplicate_plugin_package_roots(
                    &repo_root,
                    &source_spec.clone_url,
                    &plugin_relative_path,
                )?;
                return Ok(SharedPluginPackage { plugin_root });
            }
            ensure_shared_plugin_repo(
                &source_spec.clone_url,
                source_spec.branch.as_deref(),
                &repo_root,
                &plugin_relative_path,
            )?;
            cleanup_duplicate_plugin_package_roots(
                &repo_root,
                &source_spec.clone_url,
                &plugin_relative_path,
            )?;
            let plugin_root = if plugin_relative_path.as_os_str().is_empty() {
                repo_root.clone()
            } else {
                repo_root.join(&plugin_relative_path)
            };
            return Ok(SharedPluginPackage { plugin_root });
        }
    }

    let package_id =
        resolve_shared_plugin_package_id(&path_to_string(&source_root), Path::new(""))?;
    let repo_root = shared_plugin_package_repo_root(&package_id)?;
    copy_plugin_dir(&source_root, &repo_root)?;
    write_plugin_package_identity(&repo_root, &path_to_string(&source_root), Path::new(""))?;
    cleanup_duplicate_plugin_package_roots(
        &repo_root,
        &path_to_string(&source_root),
        Path::new(""),
    )?;
    Ok(SharedPluginPackage {
        plugin_root: repo_root,
    })
}

fn plugin_relative_path_for_probe(
    probe: &PluginProbeResult,
    git_root: Option<&Path>,
    plugin_root: &Path,
) -> PathBuf {
    if let Some(relative_path) = non_empty_trimmed_string(&probe.plugin_relative_path) {
        return PathBuf::from(relative_path);
    }
    git_root
        .and_then(|root| plugin_root.strip_prefix(root).ok())
        .map(Path::to_path_buf)
        .unwrap_or_default()
}

fn canonical_plugin_package_source(probe: &PluginProbeResult, git_root: &Path) -> String {
    if let Some(source_url) = non_empty_trimmed_string(&probe.source_url) {
        if let Ok(spec) = parse_market_source_url(&source_url) {
            return spec.clone_url;
        }
        return source_url;
    }
    path_to_string(git_root)
}

fn resolve_shared_plugin_package_id(
    source: &str,
    plugin_relative_path: &Path,
) -> Result<String, String> {
    let identity = managed_plugin_package_identity(source, plugin_relative_path);
    let candidates = shared_plugin_package_id_candidates(source, plugin_relative_path);
    for candidate in candidates {
        let candidate_root = shared_plugin_package_repo_root(&candidate)?;
        if !candidate_root.exists() {
            return Ok(candidate);
        }
        if read_plugin_package_identity(&candidate_root).as_ref() == Some(&identity) {
            return Ok(candidate);
        }
        if is_unidentified_plugin_package_placeholder(&candidate_root) {
            remove_path(&candidate_root)?;
            return Ok(candidate);
        }
    }

    let mut index = 2;
    loop {
        let fallback = sanitize_storage_name(&format!(
            "{}-{index}",
            plugin_base_package_name(source, plugin_relative_path)
        ));
        let candidate_root = shared_plugin_package_repo_root(&fallback)?;
        if !candidate_root.exists() {
            return Ok(fallback);
        }
        index += 1;
    }
}

fn shared_plugin_package_id_candidates(source: &str, plugin_relative_path: &Path) -> Vec<String> {
    let base_name = plugin_base_package_name(source, plugin_relative_path);
    let repo_parts = plugin_repo_name_parts(source);
    let mut candidates = Vec::new();
    push_unique_plugin_package_candidate(&mut candidates, base_name.clone());
    if let Some(parts) = repo_parts.as_ref() {
        push_unique_plugin_package_candidate(
            &mut candidates,
            sanitize_storage_name(&format!("{base_name}-{}", parts.repo)),
        );
        if !parts.owner.is_empty() {
            push_unique_plugin_package_candidate(
                &mut candidates,
                sanitize_storage_name(&format!("{base_name}-{}-{}", parts.owner, parts.repo)),
            );
        }
    }
    push_unique_plugin_package_candidate(
        &mut candidates,
        sanitize_storage_name(&format!(
            "{base_name}-{}",
            short_stable_hash(&format!(
                "{}__{}",
                normalize_plugin_package_source(source),
                normalize_relative_path(plugin_relative_path)
            ))
        )),
    );
    candidates
}

fn plugin_base_package_name(source: &str, plugin_relative_path: &Path) -> String {
    plugin_relative_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(sanitize_storage_name)
        .filter(|value| !value.is_empty() && value != "skill")
        .unwrap_or_else(|| readable_plugin_source_name(source))
}

fn push_unique_plugin_package_candidate(candidates: &mut Vec<String>, candidate: String) {
    if !candidate.is_empty() && !candidates.iter().any(|value| value == &candidate) {
        candidates.push(candidate);
    }
}

fn managed_plugin_package_identity(
    source: &str,
    plugin_relative_path: &Path,
) -> ManagedPluginPackageIdentity {
    ManagedPluginPackageIdentity {
        source: normalize_plugin_package_source(source),
        plugin_relative_path: normalize_relative_path(plugin_relative_path).to_ascii_lowercase(),
    }
}

fn normalize_plugin_package_source(source: &str) -> String {
    source
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_ascii_lowercase()
}

fn legacy_plugin_package_identity_path(path: &Path) -> PathBuf {
    path.join(PLUGIN_PACKAGE_IDENTITY_FILE)
}

fn plugin_package_identity_path(path: &Path) -> PathBuf {
    git_skilldock_metadata_dir(path)
        .map(|metadata_dir| metadata_dir.join(SKILLDOCK_PACKAGE_IDENTITY_METADATA_FILE))
        .unwrap_or_else(|| legacy_plugin_package_identity_path(path))
}

fn read_plugin_package_identity(path: &Path) -> Option<ManagedPluginPackageIdentity> {
    let metadata_path = plugin_package_identity_path(path);
    let metadata_path = if metadata_path.is_file() {
        metadata_path
    } else {
        legacy_plugin_package_identity_path(path)
    };
    let content = fs::read_to_string(metadata_path).ok()?;
    serde_json::from_str(&content).ok()
}

fn is_unidentified_plugin_package_placeholder(path: &Path) -> bool {
    path.is_dir()
        && read_plugin_package_identity(path).is_none()
        && find_git_root(path).is_none()
        && !contains_plugin_manifest(path)
}

fn contains_plugin_manifest(path: &Path) -> bool {
    if path.join(CODEX_PLUGIN_MANIFEST).is_file()
        || path.join(CLAUDE_PLUGIN_MANIFEST).is_file()
        || path.join(CURSOR_PLUGIN_MANIFEST).is_file()
    {
        return true;
    }

    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let entry_path = entry.path();
        entry_path.is_dir() && contains_plugin_manifest(&entry_path)
    })
}

fn write_plugin_package_identity(
    path: &Path,
    source: &str,
    plugin_relative_path: &Path,
) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("创建插件共享目录失败（{}）: {error}", path.display()))?;
    let identity = managed_plugin_package_identity(source, plugin_relative_path);
    let content = serde_json::to_string_pretty(&identity)
        .map_err(|error| format!("序列化插件共享目录元数据失败: {error}"))?;
    let metadata_path = plugin_package_identity_path(path);
    if let Some(parent) = metadata_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "创建插件共享目录元数据目录失败（{}）: {error}",
                parent.display()
            )
        })?;
    }
    fs::write(&metadata_path, content).map_err(|error| {
        format!(
            "写入插件共享目录元数据失败（{}）: {error}",
            metadata_path.display()
        )
    })?;
    let legacy_path = legacy_plugin_package_identity_path(path);
    if metadata_path != legacy_path {
        remove_file_if_exists(&legacy_path)?;
    }
    Ok(())
}

fn cleanup_duplicate_plugin_package_roots(
    active_root: &Path,
    source: &str,
    plugin_relative_path: &Path,
) -> Result<(), String> {
    let active_identity = managed_plugin_package_identity(source, plugin_relative_path);
    let package_parent = workspace::managed_workspace_root()?.join(PLUGIN_PACKAGE_DIR);
    let Ok(entries) = fs::read_dir(&package_parent) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let candidate_root = entry.path();
        if paths_refer_to_same_dir(&candidate_root, active_root) {
            continue;
        }
        if read_plugin_package_identity(&candidate_root).as_ref() == Some(&active_identity) {
            remove_path(&candidate_root).map_err(|error| {
                format!(
                    "清理重复插件共享目录失败（{}）: {error}",
                    candidate_root.display()
                )
            })?;
        }
    }
    Ok(())
}

fn shared_plugin_package_repo_root(package_id: &str) -> Result<PathBuf, String> {
    Ok(workspace::managed_workspace_root()?
        .join(PLUGIN_PACKAGE_DIR)
        .join(package_id))
}

fn readable_plugin_source_name(source: &str) -> String {
    let trimmed = source.trim().trim_end_matches(".git").trim_end_matches('/');
    let path_part = trimmed
        .rsplit_once('/')
        .map(|(_, tail)| tail)
        .unwrap_or(trimmed);
    sanitize_storage_name(path_part)
}

fn plugin_repo_name_parts(source: &str) -> Option<RepoNameParts> {
    let parsed = url::Url::parse(source.trim()).ok()?;
    let segments = parsed
        .path_segments()
        .map(|items| items.filter(|item| !item.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    if segments.len() < 2 {
        return None;
    }
    Some(RepoNameParts {
        owner: sanitize_storage_name(segments[0]),
        repo: sanitize_storage_name(segments[1].trim_end_matches(".git")),
    })
}

fn short_stable_hash(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
        .chars()
        .take(PLUGIN_PACKAGE_HASH_LEN)
        .collect()
}

fn ensure_shared_plugin_repo(
    clone_url: &str,
    git_ref: Option<&str>,
    repo_root: &Path,
    plugin_relative_path: &Path,
) -> Result<(), String> {
    if repo_root.join(".git").is_dir() {
        ensure_managed_plugin_repo_git_excludes(repo_root)?;
        configure_plugin_sparse_checkout(repo_root, plugin_relative_path)?;
        return Ok(());
    }
    if repo_root.exists() {
        fs::remove_dir_all(repo_root).map_err(|error| {
            format!("清理旧插件共享仓库失败（{}）: {error}", repo_root.display())
        })?;
    }
    if let Some(parent) = repo_root.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("创建插件共享仓库目录失败（{}）: {error}", parent.display())
        })?;
    }

    let mut args = vec![
        "clone".to_string(),
        "--filter=blob:none".to_string(),
        "--sparse".to_string(),
    ];
    if let Some(branch) = git_ref.and_then(non_empty_trimmed_string) {
        args.extend(["--branch".to_string(), branch]);
    }
    args.extend([
        clone_url.to_string(),
        repo_root.to_string_lossy().to_string(),
    ]);
    run_git_dynamic_at(Path::new("."), &args)?;
    ensure_managed_plugin_repo_git_excludes(repo_root)?;
    configure_plugin_sparse_checkout(repo_root, plugin_relative_path)?;
    Ok(())
}

fn ensure_shared_plugin_repo_from_existing(
    source_repo_root: &Path,
    target_repo_root: &Path,
    source: &str,
    plugin_relative_path: &Path,
) -> Result<(), String> {
    if paths_refer_to_same_dir(source_repo_root, target_repo_root) {
        write_plugin_package_identity(target_repo_root, source, plugin_relative_path)?;
        ensure_managed_plugin_repo_git_excludes(target_repo_root)?;
        configure_plugin_sparse_checkout(target_repo_root, plugin_relative_path)?;
        return Ok(());
    }
    if target_repo_root.join(".git").is_dir() {
        write_plugin_package_identity(target_repo_root, source, plugin_relative_path)?;
        ensure_managed_plugin_repo_git_excludes(target_repo_root)?;
        configure_plugin_sparse_checkout(target_repo_root, plugin_relative_path)?;
        return Ok(());
    }
    if target_repo_root.exists() || fs::symlink_metadata(target_repo_root).is_ok() {
        remove_path(target_repo_root)?;
    }
    if let Some(parent) = target_repo_root.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("创建插件共享仓库目录失败（{}）: {error}", parent.display())
        })?;
    }
    copy_dir_all(source_repo_root, target_repo_root)?;
    write_plugin_package_identity(target_repo_root, source, plugin_relative_path)?;
    ensure_managed_plugin_repo_git_excludes(target_repo_root)?;
    configure_plugin_sparse_checkout(target_repo_root, plugin_relative_path)?;
    Ok(())
}

fn ensure_managed_plugin_repo_git_excludes(repo_root: &Path) -> Result<(), String> {
    let exclude_path = repo_root.join(".git/info/exclude");
    let Some(parent) = exclude_path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "创建插件共享仓库 Git exclude 目录失败（{}）: {error}",
            parent.display()
        )
    })?;

    let existing_content = fs::read_to_string(&exclude_path).unwrap_or_default();
    let mut lines = existing_content
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    for pattern in [".idea/", ".DS_Store"] {
        if !lines.iter().any(|line| line.trim() == pattern) {
            lines.push(pattern.to_string());
        }
    }
    let next_content = format!("{}\n", lines.join("\n"));
    if next_content != existing_content {
        fs::write(&exclude_path, next_content).map_err(|error| {
            format!(
                "写入插件共享仓库 Git exclude 失败（{}）: {error}",
                exclude_path.display()
            )
        })?;
    }
    Ok(())
}

fn configure_plugin_sparse_checkout(
    repo_root: &Path,
    plugin_relative_path: &Path,
) -> Result<(), String> {
    ensure_managed_plugin_repo_git_excludes(repo_root)?;
    if plugin_relative_path.as_os_str().is_empty() {
        return Ok(());
    }
    let relative_path = normalize_relative_path(plugin_relative_path);
    run_git_at(repo_root, &["sparse-checkout", "init", "--no-cone"])?;
    run_git_at(
        repo_root,
        &[
            "sparse-checkout",
            "set",
            "--no-cone",
            &relative_path,
            &format!("{relative_path}/**"),
        ],
    )?;
    let _ = run_git_at(repo_root, &["sparse-checkout", "reapply"]);
    run_git_at(repo_root, &["checkout", "--quiet"])?;
    Ok(())
}

fn link_or_copy_plugin_dir(source_root: &Path, target_root: &Path) -> Result<(), String> {
    if paths_refer_to_same_dir(source_root, target_root) {
        return Ok(());
    }
    if target_root.exists() || fs::symlink_metadata(target_root).is_ok() {
        remove_path(target_root)?;
    }
    if let Some(parent) = target_root.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建插件安装目录失败（{}）: {error}", parent.display()))?;
    }
    #[cfg(unix)]
    {
        match std::os::unix::fs::symlink(source_root, target_root) {
            Ok(()) => return Ok(()),
            Err(_) => {}
        }
    }
    copy_dir_all(source_root, target_root)
}

fn remove_path(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("读取路径元数据失败（{}）: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path)
            .map_err(|error| format!("删除文件失败（{}）: {error}", path.display()))
    } else {
        fs::remove_dir_all(path)
            .map_err(|error| format!("删除目录失败（{}）: {error}", path.display()))
    }
}

fn compute_plugin_dir_hash(dir: &Path) -> Result<String, String> {
    let mut files = Vec::new();
    collect_plugin_files_for_hash(dir, dir, &mut files)?;
    files.sort();

    let mut hasher = Sha256::new();
    for file_path in &files {
        let relative = file_path.strip_prefix(dir).unwrap_or(file_path);
        let relative_path = normalize_relative_path(relative);
        hasher.update(relative_path.as_bytes());
        hasher.update(b"\0");
        let content = fs::read(file_path)
            .map_err(|error| format!("读取插件文件失败（{}）: {error}", file_path.display()))?;
        hasher.update(&content);
        hasher.update(b"\0");
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_plugin_files_for_hash(
    base: &Path,
    current: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let entries = fs::read_dir(current)
        .map_err(|error| format!("读取插件目录失败（{}）: {error}", current.display()))?;
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("读取插件目录项失败（{}）: {error}", current.display()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != PLUGIN_UPDATE_METADATA_FILE {
            continue;
        }
        if name == ".DS_Store" || name == PLUGIN_UPDATE_METADATA_FILE {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            if name == ".git" {
                continue;
            }
            collect_plugin_files_for_hash(base, &path, files)?;
        } else if path.starts_with(base) {
            files.push(path);
        }
    }
    Ok(())
}

fn run_git_at(path: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new(GIT_BINARY)
        .current_dir(path)
        .args(args)
        .output()
        .map_err(|error| format!("执行 git 命令失败: {error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(format!(
        "git {} 失败: {}",
        args.join(" "),
        if !stderr.is_empty() { stderr } else { stdout }
    ))
}

fn open_plugin_path_with_editor(path: &str, editor_id: &str) -> Result<(), String> {
    if editor_id == "finder" || editor_id.trim().is_empty() {
        return open_plugin_path_with_command("open", &[path]);
    }
    if let Some(app_name) = plugin_editor_app_name(editor_id) {
        if open_plugin_path_with_command("open", &["-a", app_name, path]).is_ok() {
            return Ok(());
        }
    }
    if let Some(cli_name) = plugin_editor_cli_name(editor_id) {
        return open_plugin_path_with_command(cli_name, &[path]);
    }
    open_plugin_path_with_command("open", &[path])
}

fn open_plugin_path_with_command(command: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .map_err(|error| format!("打开插件目录失败: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!("打开插件目录失败: {stderr}"))
}

fn plugin_editor_app_name(editor_id: &str) -> Option<&'static str> {
    match editor_id {
        "cursor" => Some("Cursor"),
        "vscode" | "code" => Some("Visual Studio Code"),
        "windsurf" => Some("Windsurf"),
        "trae" => Some("Trae"),
        "intellij" => Some("IntelliJ IDEA"),
        _ => None,
    }
}

fn plugin_editor_cli_name(editor_id: &str) -> Option<&'static str> {
    match editor_id {
        "cursor" => Some("cursor"),
        "vscode" | "code" => Some("code"),
        "windsurf" => Some("windsurf"),
        "trae" => Some("trae"),
        "intellij" => Some("idea"),
        _ => None,
    }
}

fn ensure_plugin_host_tool_installed(host_tool: &str) -> Result<(), String> {
    let spec = plugin_host_detection_spec(host_tool)
        .ok_or_else(|| format!("不支持的插件宿主: {host_tool}"))?;
    if plugin_host_software_exists(&spec) {
        return Ok(());
    }
    Err(format!(
        "未检测到 {}，安装该插件前请先安装 {}。",
        spec.label, spec.label
    ))
}

fn plugin_host_detection_spec(host_tool: &str) -> Option<PluginHostDetectionSpec> {
    match host_tool {
        "claude-code" => Some(PluginHostDetectionSpec {
            label: "Claude Code",
            app_names: &["Claude"],
            executable_names: &["claude"],
        }),
        "codex" => Some(PluginHostDetectionSpec {
            label: "Codex",
            app_names: &["Codex"],
            executable_names: &["codex"],
        }),
        "cursor" => Some(PluginHostDetectionSpec {
            label: "Cursor",
            app_names: &["Cursor"],
            executable_names: &["cursor"],
        }),
        _ => None,
    }
}

fn plugin_host_software_exists(spec: &PluginHostDetectionSpec) -> bool {
    (!spec.app_names.is_empty() && find_plugin_host_app_bundle(spec.app_names).is_some())
        || spec
            .executable_names
            .iter()
            .any(|executable_name| find_plugin_host_executable_path(executable_name).is_some())
}

fn find_plugin_host_executable_path(executable_name: &str) -> Option<PathBuf> {
    if executable_name.contains('/') {
        let executable_path = PathBuf::from(executable_name);
        return executable_path.exists().then_some(executable_path);
    }

    let mut search_dirs = env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .unwrap_or_default();
    search_dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ]);

    search_dirs.into_iter().find_map(|dir| {
        let executable_path = dir.join(executable_name);
        executable_path.exists().then_some(executable_path)
    })
}

fn find_plugin_host_app_bundle(app_name_candidates: &[&str]) -> Option<PathBuf> {
    let mut app_dirs = vec![PathBuf::from("/Applications")];
    if let Some(home_dir) = env::var_os("HOME") {
        app_dirs.push(PathBuf::from(home_dir).join("Applications"));
    }

    for apps_dir in app_dirs {
        if let Ok(entries) = fs::read_dir(&apps_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if !name_str.ends_with(".app") {
                    continue;
                }
                let stem = name_str.trim_end_matches(".app");
                if app_name_candidates
                    .iter()
                    .any(|candidate| stem.eq_ignore_ascii_case(candidate))
                {
                    return Some(entry.path());
                }
            }
        }
    }
    None
}

fn install_codex_plugin_probe(
    home_dir: &Path,
    source_root: &Path,
    _probe: &PluginProbeResult,
) -> Result<PathBuf, String> {
    const SKILLDOCK_MARKETPLACE_NAME: &str = "skilldock";
    let manifest = read_plugin_manifest(&source_root.join(CODEX_PLUGIN_MANIFEST))?;
    let plugin_name = plugin_install_name(&manifest, source_root);
    let marketplace_root = ensure_skilldock_codex_marketplace(home_dir, source_root, &plugin_name)?;
    if register_and_install_codex_plugin_via_cli(
        home_dir,
        SKILLDOCK_MARKETPLACE_NAME,
        &plugin_name,
        &marketplace_root,
    )
    .is_ok()
    {
        let installed_root = home_dir
            .join(".codex/plugins/cache")
            .join(SKILLDOCK_MARKETPLACE_NAME)
            .join(&plugin_name);
        if let Some(root) = newest_codex_plugin_root_under(&installed_root) {
            return Ok(root);
        }
    }

    let target_root = home_dir
        .join(".codex/plugins/cache")
        .join(SKILLDOCK_MARKETPLACE_NAME)
        .join(&plugin_name);
    link_or_copy_plugin_dir(source_root, &target_root)?;
    write_codex_plugin_install_config(
        home_dir,
        SKILLDOCK_MARKETPLACE_NAME,
        &plugin_name,
        &marketplace_root,
    )?;
    Ok(marketplace_root.join("plugins").join(&plugin_name))
}

fn ensure_skilldock_codex_marketplace(
    home_dir: &Path,
    source_root: &Path,
    plugin_name: &str,
) -> Result<PathBuf, String> {
    let marketplace_root = home_dir.join(".codex/marketplaces/skilldock");
    let linked_plugin_root = marketplace_root.join("plugins").join(plugin_name);
    let manifest_path = marketplace_root.join(CODEX_MARKETPLACE_MANIFEST);
    if let Some(parent) = linked_plugin_root.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "创建 Codex marketplace 插件目录失败（{}）: {error}",
                parent.display()
            )
        })?;
    }
    if let Some(parent) = manifest_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "创建 Codex marketplace 目录失败（{}）: {error}",
                parent.display()
            )
        })?;
    }
    link_or_copy_plugin_dir(source_root, &linked_plugin_root)?;
    sanitize_codex_plugin_install_root(&linked_plugin_root)?;

    let mut manifest = if manifest_path.is_file() {
        read_marketplace_manifest(&manifest_path).unwrap_or_default()
    } else {
        MarketplaceManifest::default()
    };
    if manifest.name.trim().is_empty() {
        manifest.name = "skilldock".to_string();
    }
    if manifest.interface.display_name.trim().is_empty() {
        manifest.interface.display_name = "SkillDock".to_string();
    }
    let plugin_relative_path = format!("./plugins/{plugin_name}");
    let mut updated = false;
    for plugin in &mut manifest.plugins {
        if plugin_name_matches(plugin_name, &plugin.name) {
            plugin.name = plugin_name.to_string();
            plugin.source.source = "local".to_string();
            plugin.source.path = plugin_relative_path.clone();
            plugin.policy.installation = "AVAILABLE".to_string();
            plugin.policy.authentication = "ON_INSTALL".to_string();
            if plugin.category.trim().is_empty() {
                plugin.category = "Design".to_string();
            }
            updated = true;
            break;
        }
    }
    if !updated {
        manifest.plugins.push(MarketplacePluginEntry {
            name: plugin_name.to_string(),
            source: MarketplacePluginSource {
                source: "local".to_string(),
                path: plugin_relative_path,
            },
            policy: MarketplacePluginPolicy {
                installation: "AVAILABLE".to_string(),
                authentication: "ON_INSTALL".to_string(),
            },
            category: "Design".to_string(),
        });
    }

    let manifest_content = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("序列化 Codex marketplace manifest 失败: {error}"))?;
    fs::write(&manifest_path, format!("{manifest_content}\n")).map_err(|error| {
        format!(
            "写入 Codex marketplace manifest 失败（{}）: {error}",
            manifest_path.display()
        )
    })?;

    Ok(marketplace_root)
}

fn sanitize_codex_plugin_install_root(plugin_root: &Path) -> Result<(), String> {
    let manifest_path = plugin_root.join(CODEX_PLUGIN_MANIFEST);
    if !manifest_path.is_file() {
        return Ok(());
    }

    let app_config_path = plugin_root.join(".app.json");
    if !app_config_has_placeholder_values(&app_config_path)? {
        return Ok(());
    }

    let manifest_content = fs::read_to_string(&manifest_path).map_err(|error| {
        format!(
            "读取 Codex 插件 manifest 失败（{}）: {error}",
            manifest_path.display()
        )
    })?;
    let mut manifest = serde_json::from_str::<JsonValue>(&manifest_content).map_err(|error| {
        format!(
            "解析 Codex 插件 manifest 失败（{}）: {error}",
            manifest_path.display()
        )
    })?;

    let Some(manifest_object) = manifest.as_object_mut() else {
        return Err(format!(
            "Codex 插件 manifest 格式无效（{}）",
            manifest_path.display()
        ));
    };

    if manifest_object.remove("apps").is_some() {
        let next_content = serde_json::to_string_pretty(&manifest)
            .map_err(|error| format!("序列化 Codex 插件 manifest 失败: {error}"))?;
        fs::write(&manifest_path, format!("{next_content}\n")).map_err(|error| {
            format!(
                "写入 Codex 插件 manifest 失败（{}）: {error}",
                manifest_path.display()
            )
        })?;
    }

    if app_config_path.is_file() {
        fs::remove_file(&app_config_path).map_err(|error| {
            format!(
                "删除占位符插件 app 配置失败（{}）: {error}",
                app_config_path.display()
            )
        })?;
    }

    Ok(())
}

fn app_config_has_placeholder_values(path: &Path) -> Result<bool, String> {
    if !path.is_file() {
        return Ok(false);
    }

    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取插件 app 配置失败（{}）: {error}", path.display()))?;
    let value = serde_json::from_str::<JsonValue>(&content)
        .map_err(|error| format!("解析插件 app 配置失败（{}）: {error}", path.display()))?;
    Ok(json_contains_placeholder_value(&value))
}

fn json_contains_placeholder_value(value: &JsonValue) -> bool {
    match value {
        JsonValue::String(text) => text.contains("REPLACE_WITH_"),
        JsonValue::Array(items) => items.iter().any(json_contains_placeholder_value),
        JsonValue::Object(entries) => entries.values().any(json_contains_placeholder_value),
        _ => false,
    }
}

fn codex_cli_path() -> PathBuf {
    env::var_os("SKILLDOCK_CODEX_CLI")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"))
}

fn register_and_install_codex_plugin_via_cli(
    home_dir: &Path,
    marketplace_name: &str,
    plugin_name: &str,
    marketplace_root: &Path,
) -> Result<(), String> {
    let codex_cli = codex_cli_path();
    if !codex_cli.is_file() {
        return Err(format!("Codex CLI 不存在: {}", codex_cli.display()));
    }

    run_codex_cli(
        home_dir,
        &codex_cli,
        &[
            "plugin",
            "marketplace",
            "add",
            marketplace_root.to_string_lossy().as_ref(),
        ],
    )?;
    run_codex_cli(
        home_dir,
        &codex_cli,
        &[
            "plugin",
            "add",
            &format!("{plugin_name}@{marketplace_name}"),
        ],
    )?;
    Ok(())
}

fn run_codex_cli(home_dir: &Path, codex_cli: &Path, args: &[&str]) -> Result<(), String> {
    let output = Command::new(codex_cli)
        .args(args)
        .env("HOME", home_dir)
        .output()
        .map_err(|error| {
            format!(
                "执行 Codex CLI 失败（{} {}）: {error}",
                codex_cli.display(),
                args.join(" ")
            )
        })?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(format!(
        "Codex CLI 执行失败（{} {}）: {}",
        codex_cli.display(),
        args.join(" "),
        if !stderr.is_empty() { stderr } else { stdout }
    ))
}

fn write_codex_plugin_install_config(
    home_dir: &Path,
    marketplace_name: &str,
    plugin_name: &str,
    marketplace_root: &Path,
) -> Result<(), String> {
    let config_path = home_dir.join(".codex/config.toml");
    let content = if config_path.is_file() {
        fs::read_to_string(&config_path).map_err(|error| {
            format!(
                "读取 Codex config.toml 失败（{}）: {error}",
                config_path.display()
            )
        })?
    } else {
        String::new()
    };
    let mut document = content.parse::<DocumentMut>().map_err(|error| {
        format!(
            "解析 Codex config.toml 失败（{}）: {error}",
            config_path.display()
        )
    })?;

    if document.get("marketplaces").is_none() {
        document["marketplaces"] = Item::Table(Table::new());
    }
    let marketplaces_table = document
        .get_mut("marketplaces")
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| "Codex config.toml marketplaces 配置不是表".to_string())?;
    if !marketplaces_table.contains_key(marketplace_name) {
        marketplaces_table.insert(marketplace_name, Item::Table(Table::new()));
    }
    let marketplace_table = marketplaces_table
        .get_mut(marketplace_name)
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| format!("Codex marketplace 配置格式不支持修改: {marketplace_name}"))?;
    marketplace_table.insert("source_type", toml_edit::value("local"));
    marketplace_table.insert("source", toml_edit::value(path_to_string(marketplace_root)));

    if document.get("plugins").is_none() {
        document["plugins"] = Item::Table(Table::new());
    }
    let plugin_key = format!("{plugin_name}@{marketplace_name}");
    let plugins_table = document
        .get_mut("plugins")
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| "Codex config.toml plugins 配置不是表".to_string())?;
    if !plugins_table.contains_key(&plugin_key) {
        plugins_table.insert(&plugin_key, Item::Table(Table::new()));
    }
    let plugin_table = plugins_table
        .get_mut(&plugin_key)
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| format!("Codex 插件配置格式不支持修改: {plugin_key}"))?;
    plugin_table.insert("enabled", toml_edit::value(true));

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 Codex 配置目录失败（{}）: {error}", parent.display()))?;
    }
    fs::write(&config_path, document.to_string()).map_err(|error| {
        format!(
            "写入 Codex config.toml 失败（{}）: {error}",
            config_path.display()
        )
    })
}

fn install_claude_plugin_probe(
    home_dir: &Path,
    source_root: &Path,
    probe: &PluginProbeResult,
) -> Result<PathBuf, String> {
    const SKILLDOCK_MARKETPLACE_NAME: &str = "skilldock";
    let manifest = read_plugin_manifest(&source_root.join(CLAUDE_PLUGIN_MANIFEST))?;
    let plugin_name = plugin_install_name(&manifest, source_root);
    let target_root = ensure_skilldock_claude_marketplace(home_dir, source_root, &plugin_name)?;
    write_skilldock_plugin_source_metadata(&target_root, probe)?;
    write_claude_plugin_install_state(
        home_dir,
        &format!("{plugin_name}@{SKILLDOCK_MARKETPLACE_NAME}"),
        &target_root,
        &manifest.version,
        &probe_source_revision(probe),
    )?;
    Ok(target_root)
}

fn ensure_skilldock_claude_marketplace(
    home_dir: &Path,
    source_root: &Path,
    plugin_name: &str,
) -> Result<PathBuf, String> {
    const SKILLDOCK_MARKETPLACE_NAME: &str = "skilldock";
    let marketplace_root = home_dir.join(".claude/plugins/marketplaces/skilldock");
    let plugin_root = marketplace_root.join("plugins").join(plugin_name);
    let manifest_path = marketplace_root.join(CLAUDE_MARKETPLACE_MANIFEST);

    if let Some(parent) = plugin_root.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "创建 Claude marketplace 插件目录失败（{}）: {error}",
                parent.display()
            )
        })?;
    }
    if let Some(parent) = manifest_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "创建 Claude marketplace 目录失败（{}）: {error}",
                parent.display()
            )
        })?;
    }

    link_or_copy_plugin_dir(source_root, &plugin_root)?;

    let mut manifest = if manifest_path.is_file() {
        read_claude_marketplace_manifest(&manifest_path).unwrap_or_default()
    } else {
        ClaudeMarketplaceManifest::default()
    };
    if manifest.name.trim().is_empty() {
        manifest.name = SKILLDOCK_MARKETPLACE_NAME.to_string();
    }
    if manifest.description.trim().is_empty() {
        manifest.description = "SkillDock managed local marketplace".to_string();
    }
    if manifest.owner_name.trim().is_empty() {
        manifest.owner_name = "SkillDock".to_string();
    }

    let plugin_relative_path = format!("./plugins/{plugin_name}");
    let plugin_description = read_plugin_manifest(&plugin_root.join(CLAUDE_PLUGIN_MANIFEST))
        .map(|manifest| manifest.description)
        .unwrap_or_default();
    let mut updated = false;
    for plugin in &mut manifest.plugins {
        if plugin_name_matches(plugin_name, &plugin.name) {
            plugin.name = plugin_name.to_string();
            plugin.source_path = plugin_relative_path.clone();
            if !plugin_description.trim().is_empty() {
                plugin.description = plugin_description.clone();
            }
            updated = true;
            break;
        }
    }
    if !updated {
        manifest.plugins.push(ClaudeMarketplacePluginEntry {
            name: plugin_name.to_string(),
            source_path: plugin_relative_path,
            description: plugin_description,
            category: String::new(),
        });
    }

    let manifest_content = serialize_claude_marketplace_manifest(&manifest)
        .map_err(|error| format!("序列化 Claude marketplace manifest 失败: {error}"))?;
    fs::write(&manifest_path, format!("{manifest_content}\n")).map_err(|error| {
        format!(
            "写入 Claude marketplace manifest 失败（{}）: {error}",
            manifest_path.display()
        )
    })?;

    write_claude_marketplace_registration(home_dir, SKILLDOCK_MARKETPLACE_NAME, &marketplace_root)?;
    Ok(plugin_root)
}

fn write_claude_marketplace_registration(
    home_dir: &Path,
    marketplace_name: &str,
    marketplace_root: &Path,
) -> Result<(), String> {
    write_claude_marketplace_setting(home_dir, marketplace_name, marketplace_root)?;
    write_claude_known_marketplace(home_dir, marketplace_name, marketplace_root)
}

fn write_claude_marketplace_setting(
    home_dir: &Path,
    marketplace_name: &str,
    marketplace_root: &Path,
) -> Result<(), String> {
    let settings_path = home_dir.join(".claude/settings.json");
    let mut settings = read_json_object_or_empty(&settings_path)?;
    let settings_object = settings
        .as_object_mut()
        .ok_or_else(|| "Claude settings.json 根节点不是对象".to_string())?;
    let marketplaces_value = settings_object
        .entry("extraKnownMarketplaces".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !marketplaces_value.is_object() {
        *marketplaces_value = serde_json::json!({});
    }
    marketplaces_value
        .as_object_mut()
        .ok_or_else(|| "Claude extraKnownMarketplaces 配置不是对象".to_string())?
        .insert(
            marketplace_name.to_string(),
            serde_json::json!({
                "source": {
                    "source": "directory",
                    "path": path_to_string(marketplace_root),
                }
            }),
        );
    write_json_config(&settings_path, &settings, "Claude settings.json")
}

fn write_claude_known_marketplace(
    home_dir: &Path,
    marketplace_name: &str,
    marketplace_root: &Path,
) -> Result<(), String> {
    let known_marketplaces_path = home_dir.join(".claude/plugins/known_marketplaces.json");
    let mut known_marketplaces = read_json_object_or_empty(&known_marketplaces_path)?;
    let known_marketplaces_object = known_marketplaces
        .as_object_mut()
        .ok_or_else(|| "Claude known_marketplaces.json 根节点不是对象".to_string())?;
    known_marketplaces_object.insert(
        marketplace_name.to_string(),
        serde_json::json!({
            "source": {
                "source": "directory",
                "path": path_to_string(marketplace_root),
            },
            "installLocation": path_to_string(marketplace_root),
            "lastUpdated": current_timestamp_rfc3339(),
        }),
    );
    write_json_config(
        &known_marketplaces_path,
        &known_marketplaces,
        "Claude known_marketplaces.json",
    )
}

fn write_claude_plugin_install_state(
    home_dir: &Path,
    plugin_key: &str,
    target_root: &Path,
    version: &str,
    git_commit_sha: &str,
) -> Result<(), String> {
    let installed_state_path = home_dir.join(".claude/plugins/installed_plugins.json");
    let settings_path = home_dir.join(".claude/settings.json");
    let now = current_timestamp_millis();
    let mut installed_state = read_json_object_or_empty(&installed_state_path)?;
    let installed_object = installed_state
        .as_object_mut()
        .ok_or_else(|| "Claude installed_plugins.json 根节点不是对象".to_string())?;
    let plugins_value = installed_object
        .entry("plugins".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !plugins_value.is_object() {
        *plugins_value = serde_json::json!({});
    }
    let plugins_object = plugins_value
        .as_object_mut()
        .ok_or_else(|| "Claude installed_plugins.json plugins 不是对象".to_string())?;
    plugins_object.insert(
        plugin_key.to_string(),
        serde_json::json!([
            {
                "scope": "user",
                "installPath": path_to_string(target_root),
                "version": if version.trim().is_empty() { "unknown" } else { version },
                "installedAt": now,
                "lastUpdated": now,
                "gitCommitSha": git_commit_sha,
            }
        ]),
    );
    write_json_config(
        &installed_state_path,
        &installed_state,
        "Claude installed_plugins.json",
    )?;

    let mut settings = read_json_object_or_empty(&settings_path)?;
    let settings_object = settings
        .as_object_mut()
        .ok_or_else(|| "Claude settings.json 根节点不是对象".to_string())?;
    let enabled_plugins = settings_object
        .entry("enabledPlugins".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !enabled_plugins.is_object() {
        *enabled_plugins = serde_json::json!({});
    }
    enabled_plugins
        .as_object_mut()
        .ok_or_else(|| "Claude enabledPlugins 配置不是对象".to_string())?
        .insert(plugin_key.to_string(), serde_json::json!(true));
    write_json_config(&settings_path, &settings, "Claude settings.json")
}

fn install_cursor_plugin_probe(
    home_dir: &Path,
    source_root: &Path,
    probe: &PluginProbeResult,
) -> Result<PathBuf, String> {
    let manifest = read_plugin_manifest(&source_root.join(CURSOR_PLUGIN_MANIFEST))?;
    let plugin_name = plugin_install_name(&manifest, source_root);
    let target_root = home_dir.join(".cursor/plugins/local").join(plugin_name);
    link_or_copy_plugin_dir(source_root, &target_root)?;
    write_skilldock_plugin_source_metadata(&target_root, probe)?;
    Ok(target_root)
}

fn legacy_skilldock_plugin_source_metadata_path(plugin_root: &Path) -> PathBuf {
    plugin_root.join(".skilldock/plugin-source.json")
}

fn skilldock_plugin_source_metadata_path(plugin_root: &Path) -> PathBuf {
    git_scoped_skilldock_metadata_path(
        plugin_root,
        SKILLDOCK_PLUGIN_SOURCE_METADATA_DIR,
        "plugin-source.json",
    )
    .unwrap_or_else(|| legacy_skilldock_plugin_source_metadata_path(plugin_root))
}

fn write_skilldock_plugin_source_metadata(
    plugin_root: &Path,
    probe: &PluginProbeResult,
) -> Result<(), String> {
    let resolved_source_type = if !probe.source_url.trim().is_empty() && find_git_root(plugin_root).is_none() {
        "marketplace".to_string()
    } else {
        probe.source_type.trim().to_string()
    };
    let metadata = SkillDockPluginSourceMetadata {
        source_url: probe.source_url.trim().to_string(),
        source_type: resolved_source_type,
        source_ref: String::new(),
        source_revision: probe_source_revision(probe),
    };
    if metadata.source_url.is_empty()
        && metadata.source_type.is_empty()
        && metadata.source_revision.is_empty()
    {
        return Ok(());
    }

    let metadata_path = skilldock_plugin_source_metadata_path(plugin_root);
    if let Some(parent) = metadata_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "创建 SkillDock 插件元数据目录失败（{}）: {error}",
                parent.display()
            )
        })?;
    }
    let content = serde_json::to_string_pretty(&metadata)
        .map_err(|error| format!("序列化 SkillDock 插件来源元数据失败: {error}"))?;
    fs::write(&metadata_path, format!("{content}\n")).map_err(|error| {
        format!(
            "写入 SkillDock 插件来源元数据失败（{}）: {error}",
            metadata_path.display()
        )
    })?;
    let legacy_path = legacy_skilldock_plugin_source_metadata_path(plugin_root);
    if metadata_path != legacy_path {
        remove_file_if_exists(&legacy_path)?;
        remove_empty_dir_if_exists(&plugin_root.join(".skilldock"))?;
    }
    Ok(())
}

fn read_skilldock_plugin_source_metadata(
    plugin_root: &Path,
) -> Option<SkillDockPluginSourceMetadata> {
    let metadata_path = skilldock_plugin_source_metadata_path(plugin_root);
    let metadata_path = if metadata_path.is_file() {
        metadata_path
    } else {
        legacy_skilldock_plugin_source_metadata_path(plugin_root)
    };
    let content = fs::read_to_string(metadata_path).ok()?;
    serde_json::from_str::<SkillDockPluginSourceMetadata>(&content).ok()
}

fn resolve_plugin_source_type(
    plugin_root: &Path,
    source_metadata: Option<&SkillDockPluginSourceMetadata>,
    fallback_source_type: &str,
) -> String {
    if let Some(source_type) =
        source_metadata.and_then(|metadata| non_empty_trimmed_string(&metadata.source_type))
    {
        return source_type;
    }

    if find_git_root(plugin_root).is_some() {
        return "git".to_string();
    }

    fallback_source_type.to_string()
}

fn plugin_install_name(manifest: &PluginManifest, root: &Path) -> String {
    let display_name = plugin_display_name(manifest, root);
    let slug = slugify(&display_name);
    if slug.is_empty() {
        "plugin".to_string()
    } else {
        slug
    }
}

fn probe_source_revision(probe: &PluginProbeResult) -> String {
    if !probe.git_root.trim().is_empty() {
        return current_git_commit(Path::new(&probe.git_root)).unwrap_or_default();
    }
    current_git_commit(Path::new(&probe.plugin_root)).unwrap_or_default()
}

fn current_git_commit(root: &Path) -> Option<String> {
    let git_root = find_git_root(root)?;
    let output = Command::new("git")
        .arg("-C")
        .arg(git_root)
        .arg("rev-parse")
        .arg("HEAD")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let commit = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if commit.is_empty() {
        None
    } else {
        Some(commit)
    }
}

fn copy_plugin_dir(source_root: &Path, target_root: &Path) -> Result<(), String> {
    if paths_refer_to_same_dir(source_root, target_root) {
        return Ok(());
    }
    if target_root.exists() {
        fs::remove_dir_all(target_root).map_err(|error| {
            format!("清理插件安装目录失败（{}）: {error}", target_root.display())
        })?;
    }
    copy_dir_all(source_root, target_root)
}

fn copy_dir_all(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|error| format!("创建插件安装目录失败（{}）: {error}", target.display()))?;
    let entries = fs::read_dir(source)
        .map_err(|error| format!("读取插件目录失败（{}）: {error}", source.display()))?;
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("读取插件目录条目失败（{}）: {error}", source.display()))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_all(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path).map_err(|error| {
                format!(
                    "复制插件文件失败（{} -> {}）: {error}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn paths_refer_to_same_dir(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn collect_cursor_plugin_roots(root: &Path, depth: usize, roots: &mut Vec<PathBuf>) {
    const MAX_CURSOR_PLUGIN_SCAN_DEPTH: usize = 8;
    if depth > MAX_CURSOR_PLUGIN_SCAN_DEPTH || !root.is_dir() {
        return;
    }
    if root.join(CURSOR_PLUGIN_MANIFEST).is_file() {
        roots.push(root.to_path_buf());
        return;
    }

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_cursor_plugin_roots(&path, depth + 1, roots);
        }
    }
}

fn is_under_cursor_local_plugins(home_dir: &Path, plugin_root: &Path) -> bool {
    plugin_root
        .strip_prefix(home_dir.join(".cursor/plugins/local"))
        .is_ok()
}

fn cursor_plugin_source_label(home_dir: &Path, plugin_root: &Path) -> String {
    let cache_root = home_dir.join(".cursor/plugins/cache");
    if let Ok(relative_path) = plugin_root.strip_prefix(cache_root) {
        return relative_path
            .components()
            .take(2)
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
    }

    let local_root = home_dir.join(".cursor/plugins/local");
    plugin_root
        .strip_prefix(local_root)
        .ok()
        .and_then(|relative_path| relative_path.components().next())
        .and_then(|component| component.as_os_str().to_str())
        .unwrap_or_default()
        .to_string()
}

fn cursor_plugin_source_revision(home_dir: &Path, plugin_root: &Path) -> String {
    let cache_root = home_dir.join(".cursor/plugins/cache");
    plugin_root
        .strip_prefix(cache_root)
        .ok()
        .and_then(|relative_path| relative_path.components().last())
        .and_then(|component| component.as_os_str().to_str())
        .unwrap_or_default()
        .to_string()
}

fn dedupe_and_sort_plugins(plugins: Vec<PluginSummary>) -> Result<Vec<PluginSummary>, String> {
    let mut seen_roots = BTreeSet::new();
    let mut indexes_by_identity = BTreeMap::<String, usize>::new();
    let mut deduped = Vec::new();

    for plugin in plugins {
        let dedupe_key = format!("{}::{}", plugin.host_tool, plugin.root_path);
        if !seen_roots.insert(dedupe_key) {
            continue;
        }

        let install_identities = plugin_install_identities(&plugin);
        if let Some(existing_index) = install_identities
            .iter()
            .find_map(|identity| indexes_by_identity.get(identity).copied())
        {
            for identity in install_identities {
                indexes_by_identity.insert(identity, existing_index);
            }

            if should_replace_duplicate_plugin(&plugin, &deduped[existing_index]) {
                deduped[existing_index] = plugin;
            }
            continue;
        }

        for identity in install_identities {
            indexes_by_identity.insert(identity, deduped.len());
        }

        deduped.push(plugin);
    }

    let mut related_hosts_by_identity = BTreeMap::<String, Vec<String>>::new();
    for plugin in &deduped {
        let Some(identity) = plugin_package_identity(plugin) else {
            continue;
        };
        related_hosts_by_identity
            .entry(identity)
            .or_default()
            .push(plugin.host_tool.clone());
    }

    for hosts in related_hosts_by_identity.values_mut() {
        hosts.sort_by(|left, right| compare_host_tools(left.as_str(), right.as_str()));
        hosts.dedup();
    }

    for plugin in &mut deduped {
        plugin.related_host_tools = plugin_package_identity(plugin)
            .and_then(|identity| related_hosts_by_identity.get(&identity).cloned())
            .unwrap_or_default()
            .into_iter()
            .filter(|host| host != &plugin.host_tool)
            .collect();
    }

    deduped.sort_by(|left, right| {
        compare_host_tools(left.host_tool.as_str(), right.host_tool.as_str())
            .then(left.name.cmp(&right.name))
            .then(left.root_path.cmp(&right.root_path))
    });

    Ok(deduped)
}

fn compare_host_tools(left: &str, right: &str) -> Ordering {
    host_tool_sort_order(left)
        .cmp(&host_tool_sort_order(right))
        .then(left.cmp(right))
}

fn host_tool_sort_order(host_tool: &str) -> usize {
    match host_tool {
        "claude-code" => 0,
        "codex" => 1,
        "cursor" => 2,
        _ => 99,
    }
}

fn plugin_package_identity(plugin: &PluginSummary) -> Option<String> {
    let normalized_name = normalize_plugin_source_identity(&plugin_package_name(plugin));
    if normalized_name.is_empty() {
        return None;
    }

    let normalized_source = normalize_plugin_source_identity(&plugin.source_url);
    if !normalized_source.is_empty() {
        return Some(format!("source:{normalized_source}:name:{normalized_name}"));
    }

    let normalized_package_id = normalize_plugin_source_identity(&plugin.package_id);
    if !normalized_package_id.is_empty() {
        return Some(format!(
            "package:{normalized_package_id}:name:{normalized_name}"
        ));
    }

    let normalized_repo = normalize_plugin_source_identity(&plugin.repo_root_path);
    if !normalized_repo.is_empty() {
        return Some(format!("repo:{normalized_repo}:name:{normalized_name}"));
    }

    let normalized_label = normalize_plugin_source_identity(&plugin.source_label);
    if !normalized_label.is_empty() {
        return Some(format!("label:{normalized_label}:name:{normalized_name}"));
    }

    Some(format!("name:{normalized_name}"))
}

fn plugin_package_name(plugin: &PluginSummary) -> String {
    let prefix = format!("{}:", plugin.host_tool);
    plugin
        .id
        .strip_prefix(&prefix)
        .unwrap_or(plugin.id.as_str())
        .to_string()
}

fn plugin_install_identity(plugin: &PluginSummary) -> Option<String> {
    plugin_package_identity(plugin)
        .map(|package_identity| format!("{}::{package_identity}", plugin.host_tool))
}

fn plugin_install_identities(plugin: &PluginSummary) -> Vec<String> {
    let mut identities = Vec::new();
    if let Some(identity) = plugin_install_identity(plugin) {
        identities.push(identity);
    }
    if let Some(identity) = plugin_catalog_identity(plugin) {
        identities.push(format!("{}::{identity}", plugin.host_tool));
    }
    identities
}

fn plugin_catalog_identity(plugin: &PluginSummary) -> Option<String> {
    let normalized_source_label = normalize_plugin_source_identity(&plugin.source_label);
    let normalized_plugin_id = normalize_plugin_source_identity(&plugin.id);
    if normalized_source_label.is_empty() || normalized_plugin_id.is_empty() {
        return None;
    }

    Some(format!(
        "catalog:{normalized_source_label}:{normalized_plugin_id}"
    ))
}

fn should_replace_duplicate_plugin(candidate: &PluginSummary, existing: &PluginSummary) -> bool {
    duplicate_plugin_priority(candidate) > duplicate_plugin_priority(existing)
}

fn duplicate_plugin_priority(plugin: &PluginSummary) -> (usize, usize, usize, usize) {
    (
        plugin_install_state_priority(&plugin.install_state),
        plugin_enabled_state_priority(&plugin.enabled_state),
        plugin_source_type_priority(&plugin.source_type),
        plugin.components.len(),
    )
}

fn plugin_install_state_priority(install_state: &str) -> usize {
    match install_state {
        "installed" => 3,
        "detected" => 2,
        "broken" => 1,
        _ => 0,
    }
}

fn plugin_enabled_state_priority(enabled_state: &str) -> usize {
    match enabled_state {
        "enabled" => 3,
        "disabled" => 2,
        "unknown" => 1,
        _ => 0,
    }
}

fn plugin_source_type_priority(source_type: &str) -> usize {
    match source_type {
        "local" => 4,
        "git" => 3,
        "marketplace" => 2,
        _ => 1,
    }
}

fn normalize_plugin_source_identity(value: &str) -> String {
    value.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn split_enabled_plugin_key(value: &str) -> Option<(&str, &str)> {
    let (plugin_name, marketplace_name) = value.rsplit_once('@')?;
    let normalized_plugin = plugin_name.trim();
    let normalized_marketplace = marketplace_name.trim();
    if normalized_plugin.is_empty() || normalized_marketplace.is_empty() {
        return None;
    }
    Some((normalized_plugin, normalized_marketplace))
}

fn parse_codex_config(content: &str) -> Result<CodexConfigFile, String> {
    let document = content
        .parse::<DocumentMut>()
        .map_err(|error| format!("解析 Codex config.toml 失败: {error}"))?;

    let mut config = CodexConfigFile::default();

    if let Some(plugins_table) = document.get("plugins").and_then(Item::as_table_like) {
        for (key, item) in plugins_table.iter() {
            let enabled = item
                .as_table_like()
                .and_then(|table| table.get("enabled"))
                .and_then(Item::as_bool)
                .unwrap_or(false);
            config
                .plugins
                .insert(key.to_string(), CodexPluginConfig { enabled });
        }
    }

    if let Some(marketplaces_table) = document.get("marketplaces").and_then(Item::as_table_like) {
        for (key, item) in marketplaces_table.iter() {
            let source = item
                .as_table_like()
                .and_then(|table| table.get("source"))
                .and_then(Item::as_str)
                .unwrap_or_default()
                .to_string();
            let source_ref = item
                .as_table_like()
                .and_then(|table| table.get("ref"))
                .and_then(Item::as_str)
                .unwrap_or_default()
                .to_string();
            let last_revision = item
                .as_table_like()
                .and_then(|table| table.get("last_revision"))
                .and_then(Item::as_str)
                .unwrap_or_default()
                .to_string();
            config.marketplaces.insert(
                key.to_string(),
                CodexMarketplaceConfig {
                    source,
                    source_ref,
                    last_revision,
                },
            );
        }
    }

    Ok(config)
}

fn read_claude_installed_plugins(path: &Path) -> Result<ClaudeInstalledPluginsFile, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "读取 Claude installed_plugins 失败（{}）: {error}",
            path.display()
        )
    })?;
    serde_json::from_str::<ClaudeInstalledPluginsFile>(&content).map_err(|error| {
        format!(
            "解析 Claude installed_plugins 失败（{}）: {error}",
            path.display()
        )
    })
}

fn read_claude_enabled_plugins(path: &Path) -> Result<BTreeMap<String, bool>, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取 Claude settings 失败（{}）: {error}", path.display()))?;
    let settings = serde_json::from_str::<ClaudeSettingsFile>(&content)
        .map_err(|error| format!("解析 Claude settings 失败（{}）: {error}", path.display()))?;
    Ok(settings.enabled_plugins)
}

fn read_marketplace_manifest(path: &Path) -> Result<MarketplaceManifest, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "读取 marketplace manifest 失败（{}）: {error}",
            path.display()
        )
    })?;
    serde_json::from_str::<MarketplaceManifest>(&content).map_err(|error| {
        format!(
            "解析 marketplace manifest 失败（{}）: {error}",
            path.display()
        )
    })
}

fn read_claude_marketplace_manifest(path: &Path) -> Result<ClaudeMarketplaceManifest, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "读取 Claude marketplace manifest 失败（{}）: {error}",
            path.display()
        )
    })?;
    let value = serde_json::from_str::<JsonValue>(&content).map_err(|error| {
        format!(
            "解析 Claude marketplace manifest 失败（{}）: {error}",
            path.display()
        )
    })?;

    let name = value
        .get("name")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();
    let description = value
        .get("description")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();
    let owner_name = value
        .get("owner")
        .and_then(JsonValue::as_object)
        .and_then(|owner| owner.get("name"))
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();
    let mut plugins = Vec::new();
    if let Some(plugin_values) = value.get("plugins").and_then(JsonValue::as_array) {
        for plugin_value in plugin_values {
            let Some(plugin_object) = plugin_value.as_object() else {
                continue;
            };
            let name = plugin_object
                .get("name")
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .to_string();
            if name.trim().is_empty() {
                continue;
            }
            let source_path = match plugin_object.get("source") {
                Some(JsonValue::String(path)) => path.clone(),
                Some(JsonValue::Object(source)) => source
                    .get("path")
                    .and_then(JsonValue::as_str)
                    .unwrap_or_default()
                    .to_string(),
                _ => String::new(),
            };
            plugins.push(ClaudeMarketplacePluginEntry {
                name,
                source_path,
                description: plugin_object
                    .get("description")
                    .and_then(JsonValue::as_str)
                    .unwrap_or_default()
                    .to_string(),
                category: plugin_object
                    .get("category")
                    .and_then(JsonValue::as_str)
                    .unwrap_or_default()
                    .to_string(),
            });
        }
    }

    Ok(ClaudeMarketplaceManifest {
        name,
        description,
        owner_name,
        plugins,
    })
}

fn read_claude_marketplace_plugin_entry(
    path: &Path,
    plugin_name: &str,
) -> Result<Option<ClaudeMarketplaceInstalledPluginEntry>, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "读取 Claude marketplace manifest 失败（{}）: {error}",
            path.display()
        )
    })?;
    let value = serde_json::from_str::<JsonValue>(&content).map_err(|error| {
        format!(
            "解析 Claude marketplace manifest 失败（{}）: {error}",
            path.display()
        )
    })?;
    let Some(plugin_values) = value.get("plugins").and_then(JsonValue::as_array) else {
        return Ok(None);
    };
    let Some(plugin_value) = plugin_values.iter().find(|plugin_value| {
        plugin_value
            .get("name")
            .and_then(JsonValue::as_str)
            .map(|name| plugin_name_matches(plugin_name, name))
            .unwrap_or(false)
    }) else {
        return Ok(None);
    };

    let description = plugin_value
        .get("description")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();
    let version = plugin_value
        .get("version")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();
    let source_url = match plugin_value.get("source") {
        Some(JsonValue::Object(source)) => source
            .get("url")
            .and_then(JsonValue::as_str)
            .or_else(|| source.get("repo").and_then(JsonValue::as_str))
            .unwrap_or_default()
            .to_string(),
        _ => plugin_value
            .get("homepage")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_string(),
    };
    let lsp_servers = plugin_value
        .get("lspServers")
        .and_then(JsonValue::as_object)
        .map(|servers| servers.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();

    Ok(Some(ClaudeMarketplaceInstalledPluginEntry {
        description,
        version,
        display_name: plugin_value
            .get("displayName")
            .and_then(JsonValue::as_str)
            .map(str::to_string),
        source_url,
        lsp_servers,
    }))
}

fn serialize_claude_marketplace_manifest(
    manifest: &ClaudeMarketplaceManifest,
) -> Result<String, serde_json::Error> {
    let plugins = manifest
        .plugins
        .iter()
        .map(|plugin| {
            let mut plugin_value = serde_json::Map::new();
            plugin_value.insert("name".to_string(), serde_json::json!(plugin.name));
            plugin_value.insert("source".to_string(), serde_json::json!(plugin.source_path));
            if !plugin.description.trim().is_empty() {
                plugin_value.insert(
                    "description".to_string(),
                    serde_json::json!(plugin.description),
                );
            }
            if !plugin.category.trim().is_empty() {
                plugin_value.insert("category".to_string(), serde_json::json!(plugin.category));
            }
            JsonValue::Object(plugin_value)
        })
        .collect::<Vec<_>>();

    serde_json::to_string_pretty(&serde_json::json!({
        "name": manifest.name,
        "description": manifest.description,
        "owner": {
            "name": manifest.owner_name,
        },
        "plugins": plugins,
    }))
}

fn claude_marketplace_entry_components(
    entry: &ClaudeMarketplaceInstalledPluginEntry,
    owner_plugin_id: &str,
) -> Vec<PluginComponentSummary> {
    let mut components = entry
        .lsp_servers
        .iter()
        .map(|server_name| PluginComponentSummary {
            id: format!("lsp/{server_name}"),
            name: server_name.clone(),
            description: "LSP 组件".to_string(),
            asset_type: "lsp".to_string(),
            owner_plugin_id: owner_plugin_id.to_string(),
            package_item_id: format!("lsp/{server_name}"),
        })
        .collect::<Vec<_>>();
    components.sort_by(|left, right| left.name.cmp(&right.name));
    components
}

fn resolve_codex_plugin_root(
    marketplace_root: &Path,
    marketplace_manifest: &MarketplaceManifest,
    enabled_plugin_name: &str,
) -> Option<PathBuf> {
    let mut matched_roots = Vec::new();

    for plugin in &marketplace_manifest.plugins {
        if !plugin_name_matches(enabled_plugin_name, &plugin.name) {
            continue;
        }
        let normalized_path = plugin.source.path.trim();
        if normalized_path.is_empty() {
            continue;
        }
        let candidate_root = marketplace_root.join(normalized_path);
        if candidate_root.join(CODEX_PLUGIN_MANIFEST).is_file() {
            matched_roots.push(candidate_root);
        }
    }

    if matched_roots.len() == 1 {
        return matched_roots.pop();
    }

    if matched_roots.is_empty() {
        let direct_candidate = marketplace_root.join("plugins").join(enabled_plugin_name);
        if direct_candidate.join(CODEX_PLUGIN_MANIFEST).is_file() {
            return Some(direct_candidate);
        }
    }

    matched_roots.into_iter().next()
}

fn plugin_name_matches(enabled_name: &str, candidate_name: &str) -> bool {
    let left = normalize_plugin_name(enabled_name);
    let right = normalize_plugin_name(candidate_name);
    if left.is_empty() || right.is_empty() {
        return false;
    }

    left == right || left.starts_with(&right) || right.starts_with(&left)
}

fn normalize_plugin_name(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect()
}

fn build_plugin_scope_summary(
    scope_id: &str,
    scope_label: &str,
    enabled_state: &str,
    location: &Path,
) -> PluginScopeSummary {
    PluginScopeSummary {
        scope_id: scope_id.to_string(),
        scope_label: scope_label.to_string(),
        enabled_state: enabled_state.to_string(),
        location: path_to_string(location),
    }
}

fn aggregate_plugin_enabled_state(scopes: &[PluginScopeSummary]) -> String {
    if scopes.iter().any(|scope| scope.enabled_state == "enabled") {
        return "enabled".to_string();
    }
    if scopes.iter().any(|scope| scope.enabled_state == "disabled") {
        return "disabled".to_string();
    }
    "unknown".to_string()
}

fn resolve_plugin_update_strategy(
    git_root: Option<&Path>,
    source_url: &str,
    plugin_relative_path: &Path,
) -> String {
    if git_root.is_some() {
        return "git".to_string();
    }
    if !source_url.trim().is_empty() && !normalize_relative_path(plugin_relative_path).is_empty() {
        return "hash".to_string();
    }
    "none".to_string()
}

fn ensure_plugin_baseline_hash(plugin_root: &Path) -> Result<String, String> {
    let mut metadata = read_plugin_update_metadata(plugin_root);
    if !metadata.baseline_hash.trim().is_empty() {
        return Ok(metadata.baseline_hash);
    }

    let baseline_hash = compute_plugin_dir_hash(plugin_root)?;
    metadata.baseline_hash = baseline_hash.clone();
    write_plugin_update_metadata(plugin_root, &metadata)?;
    Ok(baseline_hash)
}

fn resolve_hash_plugin_state(
    plugin_root: &Path,
    baseline_hash: &str,
    remote_hash: Option<&str>,
) -> Result<(String, String, bool, bool), String> {
    let current_hash = compute_plugin_dir_hash(plugin_root)?;
    let local_modified = current_hash != baseline_hash;
    let update_available = remote_hash
        .map(|hash| hash != baseline_hash)
        .unwrap_or(false);
    Ok((
        if update_available {
            "update-available".to_string()
        } else {
            "clean".to_string()
        },
        if update_available {
            "远端存在插件目录更新。".to_string()
        } else {
            "插件目录已是最新。".to_string()
        },
        update_available,
        local_modified,
    ))
}

fn remote_plugin_hash(
    source_url: &str,
    source_ref: &str,
    plugin_relative_path: &str,
) -> Result<String, String> {
    let repo_key = format!(
        "plugin-update-{}",
        short_stable_hash(&format!("{source_url}#{source_ref}#{plugin_relative_path}"))
    );
    let sparse_paths = if plugin_relative_path.trim().is_empty() {
        Vec::new()
    } else {
        vec![plugin_relative_path.to_string()]
    };
    let repo_root = clone_repo_for_discovery_with_ref_and_sparse_paths(
        source_url,
        non_empty_trimmed_string(source_ref).as_deref(),
        &repo_key,
        &sparse_paths,
    )?;
    let target_root = if plugin_relative_path.trim().is_empty() {
        repo_root.clone()
    } else {
        repo_root.join(plugin_relative_path)
    };
    if !target_root.is_dir() {
        let _ = fs::remove_dir_all(&repo_root);
        return Err(format!(
            "远端插件目录不存在: {}",
            target_root.to_string_lossy()
        ));
    }
    let hash = compute_plugin_dir_hash(&target_root);
    let _ = fs::remove_dir_all(&repo_root);
    hash
}

fn build_installed_plugin_summary(
    descriptor: InstalledPluginDescriptor,
    scan_mode: PluginScanMode,
) -> Option<PluginSummary> {
    let root = canonicalize_existing_dir(&descriptor.root).ok()?;
    let display_root = descriptor.display_root;
    let manifest = read_plugin_manifest(&descriptor.manifest_path).ok()?;
    let git_root = find_git_root(&root);
    let plugin_relative_path = git_root
        .as_ref()
        .and_then(|repo_root| root.strip_prefix(repo_root).ok())
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let git_state = git_root
        .as_ref()
        .map(|repo_root| plugin_git_state(repo_root, &plugin_relative_path))
        .unwrap_or_default();
    let plugin_id = build_plugin_id(&descriptor.host_tool, &manifest, &root);
    let mut components = collect_asset_components(&root, &plugin_id);

    if components.is_empty() {
        components = collect_asset_components(&root, &plugin_id);
    }

    let modified_at = latest_modified_in_directory(&root)
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().to_string())
        .or_else(|| file_modified_timestamp(&descriptor.manifest_path))
        .unwrap_or_default();
    let last_scanned_at = current_timestamp_millis();
    let source_url = if descriptor.source_url.trim().is_empty() {
        source_url_from_manifest(&manifest)
    } else {
        descriptor.source_url
    };
    let update_mode = if git_root.is_some()
        || descriptor.source_type == "marketplace"
        || !source_url.trim().is_empty()
    {
        "auto"
    } else {
        "unsupported"
    };
    let update_strategy =
        resolve_plugin_update_strategy(git_root.as_deref(), &source_url, &plugin_relative_path);
    let base_summary = PluginSummary {
        id: plugin_id,
        package_id: plugin_package_id(&source_url, git_root.as_deref(), &plugin_relative_path),
        name: plugin_display_name(&manifest, &root),
        description: plugin_description(&manifest),
        host_tool: descriptor.host_tool,
        related_host_tools: Vec::new(),
        kind: "plugin-repo".to_string(),
        root_path: path_to_string(&root),
        display_root_path: path_to_string(&display_root),
        repo_root_path: git_root
            .as_ref()
            .map(|path| path_to_string(path))
            .unwrap_or_else(|| path_to_string(&root)),
        plugin_relative_path: normalize_relative_path(&plugin_relative_path),
        manifest_path: path_to_string(&descriptor.manifest_path),
        source_type: descriptor.source_type,
        source_label: descriptor.source_label,
        source_url,
        source_ref: descriptor.source_ref,
        source_revision: descriptor.source_revision,
        current_version: if descriptor.current_version.trim().is_empty() {
            manifest.version
        } else {
            descriptor.current_version
        },
        current_branch: git_state.branch,
        current_commit: if descriptor.current_commit.trim().is_empty() {
            git_state.commit
        } else {
            descriptor.current_commit
        },
        collab_status: git_state.collab_status.clone(),
        status_text: git_state.status_text.clone(),
        is_git_repo: git_root.is_some(),
        update_mode: update_mode.to_string(),
        update_strategy: update_strategy.clone(),
        update_available: git_state.update_available,
        baseline_hash: String::new(),
        local_modified: false,
        installed_at: if descriptor.installed_at.trim().is_empty() {
            modified_at.clone()
        } else {
            descriptor.installed_at
        },
        updated_at: if descriptor.updated_at.trim().is_empty() {
            modified_at.clone()
        } else {
            descriptor.updated_at
        },
        remote_updated_at: git_state.remote_updated_at,
        local_updated_at: if git_state.local_updated_at.trim().is_empty() {
            modified_at.clone()
        } else {
            git_state.local_updated_at
        },
        last_editor: git_state.last_editor,
        last_scanned_at,
        status: "ready".to_string(),
        install_state: descriptor.install_state,
        install_source: descriptor.install_source,
        enabled_state: aggregate_plugin_enabled_state(&descriptor.scopes),
        scopes: descriptor.scopes,
        components,
    };

    Some(enrich_plugin_summary_with_update_state(
        base_summary,
        scan_mode,
        git_root.as_deref(),
        &root,
        &plugin_relative_path,
    ))
}

fn build_plugin_id(host_tool: &str, manifest: &PluginManifest, root: &Path) -> String {
    let base_name = if !manifest.name.trim().is_empty() {
        manifest.name.trim().to_string()
    } else if !manifest.display_name.trim().is_empty() {
        manifest.display_name.trim().to_string()
    } else if !manifest.interface.display_name.trim().is_empty() {
        manifest.interface.display_name.trim().to_string()
    } else {
        root.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("plugin")
            .to_string()
    };
    format!("{host_tool}:{}", slugify(&base_name))
}

fn plugin_display_name(manifest: &PluginManifest, root: &Path) -> String {
    if !manifest.interface.display_name.trim().is_empty() {
        return manifest.interface.display_name.trim().to_string();
    }
    if !manifest.display_name.trim().is_empty() {
        return manifest.display_name.trim().to_string();
    }
    if !manifest.name.trim().is_empty() {
        return manifest.name.trim().to_string();
    }
    root.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Plugin")
        .to_string()
}

fn plugin_description(manifest: &PluginManifest) -> String {
    if !manifest.interface.short_description.trim().is_empty() {
        return manifest.interface.short_description.trim().to_string();
    }
    if !manifest.description.trim().is_empty() {
        return manifest.description.trim().to_string();
    }
    if !manifest.interface.long_description.trim().is_empty() {
        return manifest.interface.long_description.trim().to_string();
    }
    String::new()
}

fn plugin_package_id(
    source_url: &str,
    git_root: Option<&Path>,
    plugin_relative_path: &Path,
) -> String {
    if !source_url.trim().is_empty() {
        return shared_plugin_package_id_candidates(source_url, plugin_relative_path)
            .into_iter()
            .next()
            .unwrap_or_default();
    }
    git_root
        .map(path_to_string)
        .and_then(|path| {
            shared_plugin_package_id_candidates(&path, plugin_relative_path)
                .into_iter()
                .next()
        })
        .unwrap_or_default()
}

fn plugin_update_cache_file() -> Option<PathBuf> {
    workspace_file_path(PLUGIN_UPDATE_CACHE_FILE_NAME).ok()
}

fn plugin_update_cache_lock() -> &'static Mutex<()> {
    PLUGIN_UPDATE_CACHE_LOCK.get_or_init(|| Mutex::new(()))
}

fn lock_plugin_update_cache() -> MutexGuard<'static, ()> {
    plugin_update_cache_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn plugin_git_fetch_lock() -> &'static Mutex<()> {
    PLUGIN_GIT_FETCH_LOCK.get_or_init(|| Mutex::new(()))
}

fn git_fetch_plugin_remote(repo_root: &Path) {
    let _guard = plugin_git_fetch_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let repo_key = path_to_string(repo_root);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = Command::new(GIT_BINARY)
            .args(["-C", &repo_key, "fetch", "origin", "--quiet", "--no-tags"])
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "Never")
            .output();
        let _ = tx.send(result);
    });
    let _ = rx.recv_timeout(Duration::from_secs(5));
}

fn load_plugin_update_cache() -> PluginUpdateCache {
    let Some((_, contents)) = workspace_file_candidates(PLUGIN_UPDATE_CACHE_FILE_NAME)
        .into_iter()
        .find_map(|path| fs::read_to_string(&path).ok().map(|contents| (path, contents)))
    else {
        return PluginUpdateCache::default();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

fn save_plugin_update_cache(cache: &PluginUpdateCache) -> Result<(), String> {
    let cache_file = plugin_update_cache_file().ok_or_else(|| "无法定位用户目录".to_string())?;
    let parent_dir = cache_file
        .parent()
        .ok_or_else(|| "插件更新缓存目录无效".to_string())?;
    fs::create_dir_all(parent_dir)
        .map_err(|error| format!("创建插件更新缓存目录失败: {error}"))?;
    let payload = serde_json::to_string_pretty(cache)
        .map_err(|error| format!("序列化插件更新缓存失败: {error}"))?;
    fs::write(cache_file, payload).map_err(|error| format!("写入插件更新缓存失败: {error}"))?;
    remove_legacy_workspace_file(PLUGIN_UPDATE_CACHE_FILE_NAME);
    Ok(())
}

fn plugin_root_cache_key(plugin: &PluginSummary) -> String {
    plugin.root_path.clone()
}

fn plugin_cache_matches_host_and_root(host_tool: &str, root_path: &str, plugin: &PluginSummary) -> bool {
    plugin.host_tool == host_tool && plugin_root_cache_key(plugin) == root_path
}

fn cached_git_update_entry(
    plugin: &PluginSummary,
    branch: &str,
    head: &str,
) -> Option<PluginGitCacheEntry> {
    let _guard = lock_plugin_update_cache();
    let cache = load_plugin_update_cache();
    cache.git_entries.into_iter().find(|entry| {
        entry.host_tool == plugin.host_tool
            && entry.root_path == plugin_root_cache_key(plugin)
            && entry.branch == branch
            && entry.head == head
    })
}

fn cached_pending_push_entry(
    plugin: &PluginSummary,
    branch: &str,
    head: &str,
    working_tree_signature: &str,
) -> Option<PluginPendingPushCacheEntry> {
    let _guard = lock_plugin_update_cache();
    let cache = load_plugin_update_cache();
    cache.git_pending_entries.into_iter().find(|entry| {
        entry.host_tool == plugin.host_tool
            && entry.root_path == plugin_root_cache_key(plugin)
            && entry.branch == branch
            && entry.head == head
            && entry.working_tree_signature == working_tree_signature
    })
}

fn cached_hash_entry(plugin: &PluginSummary) -> Option<PluginHashCacheEntry> {
    let _guard = lock_plugin_update_cache();
    let cache = load_plugin_update_cache();
    cache.hash_entries.into_iter().find(|entry| {
        entry.host_tool == plugin.host_tool
            && entry.root_path == plugin_root_cache_key(plugin)
    })
}

fn save_git_update_cache_entry(
    plugin: &PluginSummary,
    branch: &str,
    head: &str,
    behind: usize,
    ahead: usize,
    remote_updated_at: &str,
    last_editor: &str,
) {
    let _guard = lock_plugin_update_cache();
    let mut cache = load_plugin_update_cache();
    cache.git_entries.retain(|entry| {
        !(plugin_cache_matches_host_and_root(&entry.host_tool, &entry.root_path, plugin))
    });
    cache.git_entries.push(PluginGitCacheEntry {
        host_tool: plugin.host_tool.clone(),
        root_path: plugin_root_cache_key(plugin),
        branch: branch.to_string(),
        head: head.to_string(),
        behind,
        ahead,
        remote_updated_at: remote_updated_at.to_string(),
        last_editor: last_editor.to_string(),
    });
    let _ = save_plugin_update_cache(&cache);
}

fn save_pending_push_cache_entry(
    plugin: &PluginSummary,
    branch: &str,
    head: &str,
    working_tree_signature: &str,
    ahead: usize,
) {
    let _guard = lock_plugin_update_cache();
    let mut cache = load_plugin_update_cache();
    cache.git_pending_entries.retain(|entry| {
        !(plugin_cache_matches_host_and_root(&entry.host_tool, &entry.root_path, plugin))
    });
    cache.git_pending_entries.push(PluginPendingPushCacheEntry {
        host_tool: plugin.host_tool.clone(),
        root_path: plugin_root_cache_key(plugin),
        branch: branch.to_string(),
        head: head.to_string(),
        working_tree_signature: working_tree_signature.to_string(),
        ahead,
    });
    let _ = save_plugin_update_cache(&cache);
}

fn save_hash_cache_entry(
    plugin: &PluginSummary,
    baseline_hash: &str,
    current_hash: &str,
    update_available: bool,
) {
    let _guard = lock_plugin_update_cache();
    let mut cache = load_plugin_update_cache();
    cache.hash_entries.retain(|entry| {
        !(plugin_cache_matches_host_and_root(&entry.host_tool, &entry.root_path, plugin))
    });
    cache.hash_entries.push(PluginHashCacheEntry {
        host_tool: plugin.host_tool.clone(),
        root_path: plugin_root_cache_key(plugin),
        baseline_hash: baseline_hash.to_string(),
        current_hash: current_hash.to_string(),
        update_available,
    });
    let _ = save_plugin_update_cache(&cache);
}

fn clear_plugin_update_cache_entries(plugin: &PluginSummary) {
    let _guard = lock_plugin_update_cache();
    let mut cache = load_plugin_update_cache();
    let root_key = plugin_root_cache_key(plugin);
    cache.git_entries.retain(|entry| !(entry.host_tool == plugin.host_tool && entry.root_path == root_key));
    cache
        .git_pending_entries
        .retain(|entry| !(entry.host_tool == plugin.host_tool && entry.root_path == root_key));
    cache.hash_entries.retain(|entry| !(entry.host_tool == plugin.host_tool && entry.root_path == root_key));
    let _ = save_plugin_update_cache(&cache);
}

fn plugin_git_state(repo_root: &Path, plugin_relative_path: &Path) -> PluginGitState {
    let branch = run_git_at(repo_root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let commit = run_git_at(repo_root, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
    let scoped_path = normalize_relative_path(plugin_relative_path);
    let status_args = scoped_git_args(&["status", "--porcelain"], &scoped_path);
    let working_tree_dirty = run_git_dynamic_at(repo_root, &status_args)
        .map(|output| !output.trim().is_empty())
        .unwrap_or(false);

    let remote_counts = if !branch.is_empty() && branch != "HEAD" {
        resolve_plugin_remote_branch(repo_root, &branch)
            .and_then(|remote_branch| plugin_branch_divergence_counts(repo_root, &remote_branch, &scoped_path))
    } else {
        None
    };
    let (collab_status, status_text, update_available) =
        derive_plugin_collab_status(working_tree_dirty, remote_counts);
    let latest_local_commit_metadata =
        latest_plugin_commit_metadata_for_ref(repo_root, None, &scoped_path).unwrap_or_default();
    let latest_remote_commit_metadata = if !branch.is_empty() && branch != "HEAD" {
        resolve_plugin_remote_branch(repo_root, &branch).and_then(|remote_branch| {
            latest_plugin_commit_metadata_for_ref(repo_root, Some(remote_branch.as_str()), &scoped_path)
        })
    } else {
        None
    }
    .unwrap_or_default();
    let remote_updated_at = latest_remote_commit_metadata
        .updated_at
        .clone()
        .or_else(|| latest_local_commit_metadata.updated_at.clone())
        .unwrap_or_default();
    let local_updated_at = plugin_local_updated_at_candidate(
        repo_root,
        &scoped_path,
        working_tree_dirty,
        latest_local_commit_metadata.updated_at.clone(),
    )
    .unwrap_or_default();
    let last_editor = latest_remote_commit_metadata
        .author
        .clone()
        .or_else(|| latest_local_commit_metadata.author.clone())
        .unwrap_or_default();

    PluginGitState {
        branch,
        commit,
        collab_status: collab_status.to_string(),
        status_text,
        update_available,
        remote_updated_at,
        local_updated_at,
        last_editor,
    }
}

fn enrich_plugin_summary_with_update_state(
    plugin: PluginSummary,
    scan_mode: PluginScanMode,
    git_root: Option<&Path>,
    plugin_root: &Path,
    plugin_relative_path: &Path,
) -> PluginSummary {
    match plugin.update_strategy.as_str() {
        "git" => enrich_git_plugin_summary(plugin, scan_mode, git_root, plugin_relative_path),
        "hash" => enrich_hash_plugin_summary(plugin, scan_mode, plugin_root, plugin_relative_path),
        _ => {
            clear_plugin_update_cache_entries(&plugin);
            plugin
        }
    }
}

fn enrich_git_plugin_summary(
    plugin: PluginSummary,
    scan_mode: PluginScanMode,
    git_root: Option<&Path>,
    plugin_relative_path: &Path,
) -> PluginSummary {
    let Some(repo_root) = git_root else {
        return plugin;
    };

    let branch = if plugin.current_branch.trim().is_empty() {
        run_git_at(repo_root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default()
    } else {
        plugin.current_branch.clone()
    };
    let commit = if plugin.current_commit.trim().is_empty() {
        run_git_at(repo_root, &["rev-parse", "--short", "HEAD"]).unwrap_or_default()
    } else {
        plugin.current_commit.clone()
    };
    let head = run_git_at(repo_root, &["rev-parse", "HEAD"]).unwrap_or_else(|_| commit.clone());
    let scoped_path = normalize_relative_path(plugin_relative_path);
    let status_args = scoped_git_args(&["status", "--porcelain"], &scoped_path);
    let working_tree_signature = run_git_dynamic_at(repo_root, &status_args).unwrap_or_default();
    let working_tree_dirty = !working_tree_signature.trim().is_empty();
    let local_updated_at = plugin_local_updated_at_candidate(
        repo_root,
        &scoped_path,
        working_tree_dirty,
        latest_plugin_commit_metadata_for_ref(repo_root, None, &scoped_path)
            .and_then(|metadata| metadata.updated_at),
    )
    .unwrap_or_else(|| plugin.local_updated_at.clone());

    if scan_mode == PluginScanMode::Startup {
        if cached_pending_push_entry(&plugin, &branch, &head, &working_tree_signature).is_some() {
            let mut enriched = plugin.clone();
            enriched.current_branch = branch;
            enriched.current_commit = commit;
            enriched.collab_status = PLUGIN_STATUS_PENDING_PUSH.to_string();
            enriched.status_text = "本地存在待推送内容，已使用上次检测结果。".to_string();
            enriched.local_updated_at = local_updated_at;
            enriched.last_scanned_at = "已缓存".to_string();
            return enriched;
        }

        if let Some(entry) = cached_git_update_entry(&plugin, &branch, &head) {
            let mut enriched = plugin.clone();
            enriched.current_branch = branch;
            enriched.current_commit = commit;
            enriched.collab_status = if entry.behind > 0 && (entry.ahead > 0 || working_tree_dirty) {
                PLUGIN_STATUS_DIVERGED.to_string()
            } else if entry.behind > 0 {
                PLUGIN_STATUS_UPDATE_AVAILABLE.to_string()
            } else {
                plugin.collab_status.clone()
            };
            enriched.status_text = if enriched.collab_status == PLUGIN_STATUS_UPDATE_AVAILABLE
                || enriched.collab_status == PLUGIN_STATUS_DIVERGED
            {
                "远端存在更新，已使用上次检测结果。".to_string()
            } else {
                plugin.status_text.clone()
            };
            enriched.update_available = entry.behind > 0;
            enriched.remote_updated_at = if entry.remote_updated_at.trim().is_empty() {
                plugin.remote_updated_at.clone()
            } else {
                entry.remote_updated_at
            };
            enriched.local_updated_at = local_updated_at;
            enriched.last_editor = if entry.last_editor.trim().is_empty() {
                plugin.last_editor.clone()
            } else {
                entry.last_editor
            };
            enriched.last_scanned_at = "已缓存".to_string();
            return enriched;
        }
    }

    if scan_mode == PluginScanMode::Refresh {
        git_fetch_plugin_remote(repo_root);
    }

    let git_state = plugin_git_state(repo_root, plugin_relative_path);
    let remote_counts = if !git_state.branch.is_empty() && git_state.branch != "HEAD" {
        resolve_plugin_remote_branch(repo_root, &git_state.branch).and_then(|remote_branch| {
            plugin_branch_divergence_counts(repo_root, &remote_branch, &scoped_path)
        })
    } else {
        None
    };

    if let Some((behind, ahead)) = remote_counts {
        save_git_update_cache_entry(
            &plugin,
            &git_state.branch,
            &head,
            behind,
            ahead,
            &git_state.remote_updated_at,
            &git_state.last_editor,
        );
        if ahead > 0 || working_tree_dirty {
            save_pending_push_cache_entry(
                &plugin,
                &git_state.branch,
                &head,
                &working_tree_signature,
                ahead,
            );
        }
    } else if working_tree_dirty {
        save_pending_push_cache_entry(&plugin, &branch, &head, &working_tree_signature, 0);
    } else {
        clear_plugin_update_cache_entries(&plugin);
    }

    let mut enriched = plugin;
    enriched.current_branch = git_state.branch;
    enriched.current_commit = if enriched.current_commit.trim().is_empty() {
        git_state.commit
    } else {
        enriched.current_commit
    };
    enriched.collab_status = git_state.collab_status;
    enriched.status_text = git_state.status_text;
    enriched.update_available = git_state.update_available;
    enriched.remote_updated_at = git_state.remote_updated_at;
    enriched.local_updated_at = git_state.local_updated_at;
    enriched.last_editor = git_state.last_editor;
    enriched
}

fn enrich_hash_plugin_summary(
    plugin: PluginSummary,
    scan_mode: PluginScanMode,
    plugin_root: &Path,
    plugin_relative_path: &Path,
) -> PluginSummary {
    let baseline_hash = match ensure_plugin_baseline_hash(plugin_root) {
        Ok(hash) => hash,
        Err(_) => return plugin,
    };
    let current_hash = match compute_plugin_dir_hash(plugin_root) {
        Ok(hash) => hash,
        Err(_) => return plugin,
    };

    if scan_mode == PluginScanMode::Startup {
        if let Some(entry) = cached_hash_entry(&plugin) {
            let mut enriched = plugin.clone();
            enriched.baseline_hash = if entry.baseline_hash.trim().is_empty() {
                baseline_hash.clone()
            } else {
                entry.baseline_hash
            };
            enriched.local_modified = current_hash != enriched.baseline_hash;
            enriched.update_available = entry.update_available;
            enriched.collab_status = if entry.update_available {
                PLUGIN_STATUS_UPDATE_AVAILABLE.to_string()
            } else {
                PLUGIN_STATUS_CLEAN.to_string()
            };
            enriched.status_text = if entry.update_available {
                "远端存在更新，已使用上次检测结果。".to_string()
            } else {
                "插件目录已是最新。".to_string()
            };
            enriched.last_scanned_at = "已缓存".to_string();
            return enriched;
        }
    }

    let remote_hash = remote_plugin_hash(
        &plugin.source_url,
        &plugin.source_ref,
        &normalize_relative_path(plugin_relative_path),
    )
    .ok();
    let (collab_status, status_text, update_available, local_modified) =
        match resolve_hash_plugin_state(plugin_root, &baseline_hash, remote_hash.as_deref()) {
            Ok(result) => result,
            Err(_) => return plugin,
        };
    save_hash_cache_entry(&plugin, &baseline_hash, &current_hash, update_available);

    let mut enriched = plugin;
    enriched.collab_status = collab_status;
    enriched.status_text = status_text;
    enriched.update_available = update_available;
    enriched.baseline_hash = baseline_hash;
    enriched.local_modified = local_modified;
    enriched
}

#[derive(Debug, Default)]
struct PluginCommitMetadata {
    updated_at: Option<String>,
    author: Option<String>,
}

fn latest_plugin_commit_metadata_for_ref(
    repo_root: &Path,
    git_ref: Option<&str>,
    scoped_path: &str,
) -> Option<PluginCommitMetadata> {
    let mut args = vec!["log".to_string()];
    if let Some(reference) = git_ref.filter(|value| !value.trim().is_empty()) {
        args.push(reference.to_string());
    }
    args.push("-1".to_string());
    args.push("--date=format-local:%Y/%-m/%-d %H:%M:%S".to_string());
    args.push("--pretty=format:%cd%x00%an".to_string());
    if !scoped_path.is_empty() {
      args.push("--".to_string());
      args.push(scoped_path.to_string());
    }

    let output = run_git_dynamic_at(repo_root, &args).ok()?;
    if output.trim().is_empty() {
        return None;
    }

    let mut parts = output.splitn(2, '\0');
    let updated_at = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let author = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    Some(PluginCommitMetadata { updated_at, author })
}

fn plugin_local_updated_at_candidate(
    repo_root: &Path,
    scoped_path: &str,
    working_tree_dirty: bool,
    commit_updated_at: Option<String>,
) -> Option<String> {
    if working_tree_dirty {
        latest_plugin_local_content_modified_at(repo_root, scoped_path).or(commit_updated_at)
    } else {
        commit_updated_at.or_else(|| latest_plugin_local_content_modified_at(repo_root, scoped_path))
    }
}

fn latest_plugin_local_content_modified_at(repo_root: &Path, scoped_path: &str) -> Option<String> {
    let target_path = if scoped_path.is_empty() {
        repo_root.to_path_buf()
    } else {
        repo_root.join(scoped_path)
    };
    let latest = latest_modified_in_directory(&target_path)?;
    let duration = latest.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_millis().to_string())
}

fn latest_modified_in_directory(path: &Path) -> Option<SystemTime> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.is_file() {
        return metadata.modified().ok();
    }

    if !metadata.is_dir() {
        return None;
    }

    let mut latest = metadata.modified().ok();
    let entries = fs::read_dir(path).ok()?;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == ".git")
        {
            continue;
        }
        let candidate = latest_modified_in_directory(&entry_path);
        latest = match (latest, candidate) {
            (Some(current), Some(next)) => Some(current.max(next)),
            (None, Some(next)) => Some(next),
            (current, None) => current,
        };
    }
    latest
}

fn resolve_plugin_remote_branch(repo_root: &Path, branch: &str) -> Option<String> {
    let remote_branch = format!("{REMOTE_BRANCH_PREFIX}{branch}");
    let exists = run_git_at(
        repo_root,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{remote_branch}"),
        ],
    )
    .is_ok();
    if exists {
        Some(remote_branch)
    } else {
        None
    }
}

fn plugin_branch_divergence_counts(
    repo_root: &Path,
    remote_branch: &str,
    scoped_path: &str,
) -> Option<(usize, usize)> {
    let mut args = vec![
        "rev-list".to_string(),
        "--left-right".to_string(),
        "--count".to_string(),
        format!("{remote_branch}...HEAD"),
    ];
    if !scoped_path.is_empty() {
        args.push("--".to_string());
        args.push(scoped_path.to_string());
    }
    let output = run_git_dynamic_at(repo_root, &args).ok()?;
    let mut parts = output.split_whitespace();
    let behind = parts.next()?.parse::<usize>().ok()?;
    let ahead = parts.next()?.parse::<usize>().ok()?;
    Some((behind, ahead))
}

fn derive_plugin_collab_status(
    working_tree_dirty: bool,
    remote_counts: Option<(usize, usize)>,
) -> (&'static str, String, bool) {
    let Some((behind, ahead)) = remote_counts else {
        if working_tree_dirty {
            return (
                PLUGIN_STATUS_PENDING_PUSH,
                "插件目录存在本地未提交改动。".to_string(),
                false,
            );
        }
        return (
            PLUGIN_STATUS_CLEAN,
            "插件目录已是最新。".to_string(),
            false,
        );
    };

    if behind > 0 && (ahead > 0 || working_tree_dirty) {
        return (
            PLUGIN_STATUS_DIVERGED,
            "本地与远端均有变化，建议先处理本地改动，再同步插件目录。".to_string(),
            false,
        );
    }
    if behind > 0 {
        return (
            PLUGIN_STATUS_UPDATE_AVAILABLE,
            "远端存在插件目录更新。".to_string(),
            true,
        );
    }
    if ahead > 0 || working_tree_dirty {
        return (
            PLUGIN_STATUS_PENDING_PUSH,
            if ahead > 0 {
                "本地存在待推送提交。".to_string()
            } else {
                "插件目录存在本地未提交改动。".to_string()
            },
            false,
        );
    }

    (
        PLUGIN_STATUS_CLEAN,
        "插件目录已是最新。".to_string(),
        false,
    )
}

fn scoped_git_args(base_args: &[&str], scoped_path: &str) -> Vec<String> {
    let mut args = base_args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    if !scoped_path.is_empty() {
        args.push("--".to_string());
        args.push(scoped_path.to_string());
    }
    args
}

fn run_git_dynamic_at(repo_root: &Path, args: &[String]) -> Result<String, String> {
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_git_at(repo_root, &arg_refs)
}

fn source_url_from_manifest(manifest: &PluginManifest) -> String {
    if !manifest.repository.trim().is_empty() {
        return manifest.repository.trim().to_string();
    }
    if !manifest.homepage.trim().is_empty() {
        return manifest.homepage.trim().to_string();
    }
    String::new()
}

fn plugin_source_label_from_cache_root(home_dir: &Path, plugin_root: &Path) -> String {
    let cache_root = home_dir.join(".codex/plugins/cache");
    let cache_root = canonicalize_existing_dir(&cache_root).unwrap_or(cache_root);
    plugin_root
        .strip_prefix(cache_root)
        .ok()
        .and_then(|relative_path| relative_path.components().next())
        .and_then(|component| component.as_os_str().to_str())
        .unwrap_or_default()
        .to_string()
}

fn read_plugin_manifest(path: &Path) -> Result<PluginManifest, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取插件 manifest 失败（{}）: {error}", path.display()))?;
    serde_json::from_str::<PluginManifest>(&content)
        .map_err(|error| format!("解析插件 manifest 失败（{}）: {error}", path.display()))
}

fn probe_plugin_root(root: &Path, hint_host_tool: Option<String>) -> PluginProbeResult {
    let git_root = find_git_root(root);
    let normalized_hint = normalize_host_tool(hint_host_tool.as_deref());

    if let Some(result) = detect_plugin_repo(root, git_root.as_deref(), normalized_hint.as_deref())
    {
        return result;
    }

    if let Some(result) = detect_marketplace_root(root, git_root.as_deref()) {
        return result;
    }

    let components = collect_asset_components(root, "");
    if !components.is_empty() {
        let tool = normalized_hint.as_deref().unwrap_or("unknown").to_string();
        let confidence = if tool == "unknown" { "low" } else { "medium" };
        return build_probe_result(ProbeBuildArgs {
            tool: tool.as_str(),
            compatible_host_tools: normalized_hint
                .as_ref()
                .map(|value| vec![value.clone()])
                .unwrap_or_default(),
            kind: "standalone-assets",
            description: String::new(),
            root,
            manifest_path: None,
            marketplace_manifest_path: None,
            components,
            git_root: git_root.as_deref(),
            confidence,
            install_strategy: "unsupported",
            warnings: Vec::new(),
        });
    }

    build_probe_result(ProbeBuildArgs {
        tool: normalized_hint.as_deref().unwrap_or("unknown"),
        compatible_host_tools: normalized_hint
            .as_ref()
            .map(|value| vec![value.clone()])
            .unwrap_or_default(),
        kind: "unknown",
        description: String::new(),
        root,
        manifest_path: None,
        marketplace_manifest_path: None,
        components: Vec::new(),
        git_root: git_root.as_deref(),
        confidence: "low",
        install_strategy: "unsupported",
        warnings: Vec::new(),
    })
}

fn probe_plugin_source_blocking(
    source: &str,
    git_ref: Option<&str>,
    sparse_path: Option<&str>,
    hint_host_tool: Option<String>,
) -> Result<PluginProbeResult, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("插件来源不能为空".to_string());
    }

    let source_path = Path::new(trimmed_source);
    if source_path.exists() {
        return probe_plugin_local_source(source_path, hint_host_tool);
    }

    let mut source_spec = parse_market_source_url(trimmed_source)?;
    let explicit_ref = git_ref.and_then(non_empty_trimmed_string);
    if explicit_ref.is_some() {
        source_spec.branch = explicit_ref;
        if let Some(resolved_path) =
            tree_relative_path_for_branch(&source_spec.tree_segments, source_spec.branch.as_deref())
        {
            source_spec.relative_path = resolved_path;
        }
    }
    let explicit_sparse_path = sparse_path.and_then(normalized_optional_path);
    if explicit_sparse_path.is_some() {
        source_spec.relative_path = explicit_sparse_path.map(PathBuf::from);
    }

    let repo_key = plugin_discovery_repo_key(
        &source_spec.clone_url,
        source_spec.branch.as_deref(),
        source_spec.relative_path.as_ref(),
    );
    let sparse_paths = source_spec
        .relative_path
        .as_ref()
        .map(|path| vec![normalize_relative_path(path)])
        .unwrap_or_default();
    let repo_root = clone_repo_for_discovery_with_ref_and_sparse_paths(
        &source_spec.clone_url,
        source_spec.branch.as_deref(),
        &repo_key,
        &sparse_paths,
    )?;
    let probe_root = source_spec
        .relative_path
        .as_ref()
        .map(|path| repo_root.join(path))
        .unwrap_or_else(|| repo_root.clone());
    canonicalize_existing_dir(&probe_root).map(|root| {
        annotate_plugin_probe_source(
            probe_plugin_root(&root, hint_host_tool),
            trimmed_source,
            &repo_root,
        )
    })
}

fn probe_plugin_source_candidates_blocking(
    source: &str,
    git_ref: Option<&str>,
    sparse_path: Option<&str>,
    hint_host_tool: Option<String>,
) -> Result<Vec<PluginProbeResult>, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("插件来源不能为空".to_string());
    }

    let source_path = Path::new(trimmed_source);
    if source_path.exists() {
        return probe_plugin_local_source_candidates(source_path, hint_host_tool);
    }

    let mut source_spec = parse_market_source_url(trimmed_source)?;
    let explicit_ref = git_ref.and_then(non_empty_trimmed_string);
    if explicit_ref.is_some() {
        source_spec.branch = explicit_ref;
        if let Some(resolved_path) =
            tree_relative_path_for_branch(&source_spec.tree_segments, source_spec.branch.as_deref())
        {
            source_spec.relative_path = resolved_path;
        }
    }
    let explicit_sparse_path = sparse_path.and_then(normalized_optional_path);
    if explicit_sparse_path.is_some() {
        source_spec.relative_path = explicit_sparse_path.map(PathBuf::from);
    }

    let repo_key = plugin_discovery_repo_key(
        &source_spec.clone_url,
        source_spec.branch.as_deref(),
        source_spec.relative_path.as_ref(),
    );
    let sparse_paths = source_spec
        .relative_path
        .as_ref()
        .map(|path| vec![normalize_relative_path(path)])
        .unwrap_or_default();
    let repo_root = clone_repo_for_discovery_with_ref_and_sparse_paths(
        &source_spec.clone_url,
        source_spec.branch.as_deref(),
        &repo_key,
        &sparse_paths,
    )?;
    let probe_root = source_spec
        .relative_path
        .as_ref()
        .map(|path| repo_root.join(path))
        .unwrap_or_else(|| repo_root.clone());
    canonicalize_existing_dir(&probe_root).map(|root| {
        probe_plugin_candidates(&root, hint_host_tool)
            .into_iter()
            .map(|probe| annotate_plugin_probe_source(probe, trimmed_source, &repo_root))
            .collect()
    })
}

fn annotate_plugin_probe_source(
    mut probe: PluginProbeResult,
    source_url: &str,
    repo_root: &Path,
) -> PluginProbeResult {
    probe.source_url = source_url.trim().to_string();
    probe.repo_root = path_to_string(repo_root);
    probe.git_root = path_to_string(repo_root);
    if probe.plugin_relative_path.trim().is_empty() {
        if let Ok(plugin_root) = canonicalize_existing_dir(Path::new(&probe.plugin_root)) {
            if let Ok(relative_path) = plugin_root.strip_prefix(repo_root) {
                probe.plugin_relative_path = normalize_relative_path(relative_path);
            }
        }
    }
    probe
}

fn probe_plugin_local_source(
    source_path: &Path,
    hint_host_tool: Option<String>,
) -> Result<PluginProbeResult, String> {
    let root = canonicalize_existing_dir(source_path)?;
    Ok(probe_plugin_root(&root, hint_host_tool))
}

fn probe_plugin_local_source_candidates(
    source_path: &Path,
    hint_host_tool: Option<String>,
) -> Result<Vec<PluginProbeResult>, String> {
    let root = canonicalize_existing_dir(source_path)?;
    Ok(probe_plugin_candidates(&root, hint_host_tool))
}

fn probe_plugin_candidates(root: &Path, hint_host_tool: Option<String>) -> Vec<PluginProbeResult> {
    let root_probe = probe_plugin_root(root, hint_host_tool.clone());
    if root_probe.kind == "plugin-repo" {
        return vec![root_probe];
    }

    let mut candidates = collect_plugin_candidate_roots(root)
        .into_iter()
        .map(|candidate_root| probe_plugin_root(&candidate_root, hint_host_tool.clone()))
        .filter(is_plugin_package_probe)
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        candidates.push(root_probe);
    }

    candidates
}

fn is_plugin_package_probe(probe: &PluginProbeResult) -> bool {
    probe.kind == "plugin-repo" || probe.kind == "marketplace-root"
}

fn collect_plugin_candidate_roots(root: &Path) -> Vec<PathBuf> {
    let mut candidate_roots = BTreeSet::new();
    collect_direct_child_dirs(root, &mut candidate_roots);
    collect_direct_child_dirs(&root.join("plugins"), &mut candidate_roots);
    candidate_roots.into_iter().collect()
}

fn collect_direct_child_dirs(parent: &Path, candidate_roots: &mut BTreeSet<PathBuf>) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            candidate_roots.insert(path);
        }
    }
}

fn non_empty_trimmed_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalized_optional_path(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_matches('/');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn plugin_discovery_repo_key(
    clone_url: &str,
    git_ref: Option<&str>,
    sparse_path: Option<&PathBuf>,
) -> String {
    let path_key = sparse_path
        .map(|path| normalize_relative_path(path))
        .unwrap_or_default();
    sanitize_storage_name(&format!(
        "plugin-{}-{}-{}",
        clone_url,
        git_ref.unwrap_or_default(),
        path_key
    ))
}

fn plugin_probe_cleanup_roots(probes: &[PluginProbeResult]) -> Vec<PathBuf> {
    let Some(repo_cache_root) =
        workspace::managed_workspace_root_option().map(|root| root.join("repo-cache"))
    else {
        return Vec::new();
    };
    let repo_cache_root = canonicalize_existing_dir(&repo_cache_root).unwrap_or(repo_cache_root);
    let mut cleanup_roots = BTreeSet::new();
    for probe in probes {
        let Some(repo_root) = non_empty_trimmed_string(&probe.repo_root) else {
            continue;
        };
        let Ok(repo_root) = canonicalize_existing_dir(Path::new(&repo_root)) else {
            continue;
        };
        if repo_root.strip_prefix(&repo_cache_root).is_ok() {
            cleanup_roots.insert(repo_root);
        }
    }

    cleanup_roots.into_iter().collect()
}

fn cleanup_plugin_probe_repo_roots(roots: &[PathBuf]) {
    for root in roots {
        let _ = fs::remove_dir_all(root);
    }
}

fn canonicalize_existing_dir(path: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err(format!("插件目录不存在: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("插件探测仅支持目录路径: {}", path.display()));
    }
    fs::canonicalize(path)
        .map_err(|error| format!("解析插件目录失败（{}）: {error}", path.display()))
}

fn detect_plugin_repo(
    root: &Path,
    git_root: Option<&Path>,
    hint_host_tool: Option<&str>,
) -> Option<PluginProbeResult> {
    let manifest_candidates = [
        ("claude-code", root.join(CLAUDE_PLUGIN_MANIFEST)),
        ("cursor", root.join(CURSOR_PLUGIN_MANIFEST)),
        ("codex", root.join(CODEX_PLUGIN_MANIFEST)),
    ];
    let detected = manifest_candidates
        .iter()
        .filter(|(_, path)| path.is_file())
        .collect::<Vec<_>>();

    if detected.is_empty() {
        return None;
    }

    let selected = hint_host_tool
        .and_then(|hint| detected.iter().find(|(tool, _)| *tool == hint).copied())
        .unwrap_or(detected[0]);
    let warnings = if detected.len() > 1 {
        vec![format!("发现多个官方插件清单，已优先使用 {}", selected.0)]
    } else {
        Vec::new()
    };

    Some(build_probe_result(ProbeBuildArgs {
        tool: selected.0,
        compatible_host_tools: detected
            .iter()
            .map(|(tool, _)| (*tool).to_string())
            .collect(),
        kind: "plugin-repo",
        description: read_plugin_manifest(selected.1.as_path())
            .map(|manifest| plugin_description(&manifest))
            .unwrap_or_default(),
        root,
        manifest_path: Some(selected.1.as_path()),
        marketplace_manifest_path: None,
        components: collect_asset_components(root, ""),
        git_root,
        confidence: "high",
        install_strategy: install_strategy_for_plugin_tool(selected.0),
        warnings,
    }))
}

fn detect_marketplace_root(root: &Path, git_root: Option<&Path>) -> Option<PluginProbeResult> {
    let marketplace_candidates = [
        ("claude-code", root.join(CLAUDE_MARKETPLACE_MANIFEST)),
        ("codex", root.join(CODEX_MARKETPLACE_MANIFEST)),
    ];

    marketplace_candidates
        .iter()
        .find(|(_, path)| path.is_file())
        .map(|(tool, manifest_path)| {
            build_probe_result(ProbeBuildArgs {
                tool,
                compatible_host_tools: vec![(*tool).to_string()],
                kind: "marketplace-root",
                description: String::new(),
                root,
                manifest_path: None,
                marketplace_manifest_path: Some(manifest_path.as_path()),
                components: Vec::new(),
                git_root,
                confidence: "high",
                install_strategy: install_strategy_for_marketplace_tool(tool),
                warnings: Vec::new(),
            })
        })
}

fn install_strategy_for_plugin_tool(tool: &str) -> &'static str {
    match tool {
        "claude-code" => "claude-plugin-dir",
        "cursor" => "cursor-registration",
        "codex" => "codex-marketplace",
        _ => "unsupported",
    }
}

fn install_strategy_for_marketplace_tool(tool: &str) -> &'static str {
    match tool {
        "claude-code" => "claude-plugin-dir",
        "codex" => "codex-marketplace",
        _ => "unsupported",
    }
}

fn build_probe_result(args: ProbeBuildArgs<'_>) -> PluginProbeResult {
    PluginProbeResult {
        tool: args.tool.to_string(),
        compatible_host_tools: args.compatible_host_tools,
        kind: args.kind.to_string(),
        name: probe_display_name(args.root, args.manifest_path),
        description: args.description,
        plugin_root: path_to_string(args.root),
        repo_root: args.git_root.map(path_to_string).unwrap_or_default(),
        plugin_relative_path: args
            .git_root
            .and_then(|git_root| args.root.strip_prefix(git_root).ok())
            .map(normalize_relative_path)
            .unwrap_or_default(),
        manifest_path: args.manifest_path.map(path_to_string).unwrap_or_default(),
        marketplace_manifest_path: args
            .marketplace_manifest_path
            .map(path_to_string)
            .unwrap_or_default(),
        components: args.components,
        source_type: if args.git_root.is_some() {
            "git".to_string()
        } else {
            "local".to_string()
        },
        source_url: String::new(),
        is_git_repo: args.git_root.is_some(),
        git_root: args.git_root.map(path_to_string).unwrap_or_default(),
        confidence: args.confidence.to_string(),
        install_strategy: args.install_strategy.to_string(),
        warnings: args.warnings,
    }
}

fn probe_display_name(root: &Path, manifest_path: Option<&Path>) -> String {
    manifest_path
        .and_then(|path| read_plugin_manifest(path).ok())
        .map(|manifest| plugin_display_name(&manifest, root))
        .unwrap_or_else(|| {
            root.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Plugin")
                .to_string()
        })
}

fn collect_asset_components(root: &Path, owner_plugin_id: &str) -> Vec<PluginComponentSummary> {
    let mut components = Vec::new();
    collect_named_asset_dirs(
        root,
        "skills",
        "skill",
        "SKILL.md",
        owner_plugin_id,
        &mut components,
    );
    collect_entry_assets(root, "agents", "subagent", owner_plugin_id, &mut components);
    collect_entry_assets(
        root,
        "subagents",
        "subagent",
        owner_plugin_id,
        &mut components,
    );
    collect_entry_assets(
        root,
        "commands",
        "command",
        owner_plugin_id,
        &mut components,
    );
    collect_entry_assets(root, "bin", "command", owner_plugin_id, &mut components);
    collect_entry_assets(root, "rules", "rule", owner_plugin_id, &mut components);
    collect_entry_assets(root, "hooks", "hook", owner_plugin_id, &mut components);
    collect_mcp_assets(root, owner_plugin_id, &mut components);
    components.sort_by(|left, right| {
        left.asset_type
            .cmp(&right.asset_type)
            .then(left.name.cmp(&right.name))
            .then(left.id.cmp(&right.id))
    });
    components
}

fn collect_named_asset_dirs(
    root: &Path,
    dir_name: &str,
    asset_type: &str,
    marker_file: &str,
    owner_plugin_id: &str,
    components: &mut Vec<PluginComponentSummary>,
) {
    let asset_root = root.join(dir_name);
    let Ok(entries) = fs::read_dir(&asset_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !path.join(marker_file).is_file() {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map(PathBuf::from)
            .unwrap_or(path.clone());
        components.push(build_component(
            &path,
            &relative,
            entry.file_name().to_string_lossy().as_ref(),
            asset_type,
            owner_plugin_id,
        ));
    }
}

fn collect_entry_assets(
    root: &Path,
    dir_name: &str,
    asset_type: &str,
    owner_plugin_id: &str,
    components: &mut Vec<PluginComponentSummary>,
) {
    let asset_root = root.join(dir_name);
    let Ok(entries) = fs::read_dir(&asset_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() && !path.is_dir() {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map(PathBuf::from)
            .unwrap_or(path.clone());
        components.push(build_component(
            &path,
            &relative,
            entry.file_name().to_string_lossy().as_ref(),
            asset_type,
            owner_plugin_id,
        ));
    }
}

fn collect_mcp_assets(
    root: &Path,
    owner_plugin_id: &str,
    components: &mut Vec<PluginComponentSummary>,
) {
    for relative in ["mcp.json", ".mcp.json", ".cursor/mcp.json"] {
        let path = root.join(relative);
        if !path.is_file() {
            continue;
        }
        let collected_count =
            collect_mcp_server_components(&path, Path::new(relative), owner_plugin_id, components);
        if collected_count == 0 {
            components.push(build_component(
                &path,
                Path::new(relative),
                relative,
                "mcp",
                owner_plugin_id,
            ));
        }
    }
}

fn collect_mcp_server_components(
    full_path: &Path,
    relative_path: &Path,
    owner_plugin_id: &str,
    components: &mut Vec<PluginComponentSummary>,
) -> usize {
    let Ok(content) = fs::read_to_string(full_path) else {
        return 0;
    };
    let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) else {
        return 0;
    };
    let Some(servers) = config
        .get("mcpServers")
        .and_then(serde_json::Value::as_object)
    else {
        return 0;
    };

    for (server_name, server_config) in servers {
        let component_id = normalize_relative_path(&relative_path.join(server_name));
        let package_item_id = normalize_relative_path(relative_path);
        components.push(PluginComponentSummary {
            id: component_id,
            name: server_name.to_string(),
            description: mcp_server_description(server_config),
            asset_type: "mcp".to_string(),
            owner_plugin_id: owner_plugin_id.to_string(),
            package_item_id,
        });
    }

    servers.len()
}

fn mcp_server_description(server_config: &serde_json::Value) -> String {
    if let Some(url) = server_config
        .get("url")
        .and_then(serde_json::Value::as_str)
        .filter(|url| !url.trim().is_empty())
    {
        return url.to_string();
    }

    let Some(command) = server_config
        .get("command")
        .and_then(serde_json::Value::as_str)
        .filter(|command| !command.trim().is_empty())
    else {
        return component_fallback_description("mcp").to_string();
    };
    let args = server_config
        .get("args")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if args.is_empty() {
        command.to_string()
    } else {
        format!("{command} {}", args.join(" "))
    }
}

fn build_component(
    full_path: &Path,
    relative_path: &Path,
    name: &str,
    asset_type: &str,
    owner_plugin_id: &str,
) -> PluginComponentSummary {
    let id = normalize_relative_path(relative_path);
    PluginComponentSummary {
        id: id.clone(),
        name: name.to_string(),
        description: component_description(full_path, asset_type),
        asset_type: asset_type.to_string(),
        owner_plugin_id: owner_plugin_id.to_string(),
        package_item_id: id,
    }
}

fn component_description(path: &Path, asset_type: &str) -> String {
    let preview_path = if asset_type == "skill" {
        path.join("SKILL.md")
    } else {
        path.to_path_buf()
    };
    let Ok(content) = fs::read_to_string(preview_path) else {
        return component_fallback_description(asset_type).to_string();
    };
    parse_skill_description_from_content(&content)
        .or_else(|| first_markdown_summary(&content))
        .unwrap_or_else(|| component_fallback_description(asset_type).to_string())
}

fn component_fallback_description(asset_type: &str) -> &'static str {
    match asset_type {
        "skill" => "Skill 组件",
        "subagent" => "Subagent 组件",
        "mcp" => "MCP 配置",
        "rule" => "Rule 组件",
        "hook" => "Hook 组件",
        "command" => "Command 组件",
        _ => "插件组件",
    }
}

fn resolve_component_preview_path(
    root: &Path,
    component_id: &str,
    asset_type: &str,
) -> Result<PathBuf, String> {
    let relative_path = safe_relative_path(component_id)?;
    let candidate = root.join(&relative_path);
    if asset_type == "skill" {
        let skill_file = candidate.join("SKILL.md");
        if skill_file.is_file() {
            return Ok(skill_file);
        }
    }
    if candidate.is_file() {
        return Ok(candidate);
    }
    if asset_type == "mcp" {
        if let Some(mcp_config_path) = mcp_config_path_for_component_id(root, &relative_path) {
            return Ok(mcp_config_path);
        }
    }
    if candidate.is_dir() {
        for file_name in ["SKILL.md", "README.md", "README.mdx"] {
            let preview_path = candidate.join(file_name);
            if preview_path.is_file() {
                return Ok(preview_path);
            }
        }
        if let Some(first_file) = first_preview_file_in_dir(&candidate) {
            return Ok(first_file);
        }
    }

    Err("未找到可预览的插件组件文件。".into())
}

fn mcp_config_path_for_component_id(root: &Path, relative_path: &Path) -> Option<PathBuf> {
    mcp_component_config_and_server(root, relative_path).map(|(config_path, _, _)| config_path)
}

fn mcp_component_config_and_server(
    root: &Path,
    relative_path: &Path,
) -> Option<(PathBuf, String, String)> {
    for config_relative in ["mcp.json", ".mcp.json", ".cursor/mcp.json"] {
        let config_path = Path::new(config_relative);
        let Ok(server_relative) = relative_path.strip_prefix(config_path) else {
            continue;
        };
        if server_relative.components().next().is_none() {
            continue;
        }
        let candidate = root.join(config_path);
        if candidate.is_file() {
            return Some((
                candidate,
                normalize_relative_path(config_path),
                normalize_relative_path(server_relative),
            ));
        }
    }

    None
}

fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => result.push(part),
            _ => return Err("插件组件路径不合法。".into()),
        }
    }
    if result.as_os_str().is_empty() {
        return Err("插件组件路径不能为空。".into());
    }
    Ok(result)
}

fn first_preview_file_in_dir(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let mut files = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    files.sort();
    files.into_iter().next()
}

fn component_preview_title(component_id: &str, relative_path: &str) -> String {
    Path::new(relative_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(component_id)
        .to_string()
}

fn parse_skill_description_from_content(content: &str) -> Option<String> {
    let trimmed_content = content.trim_start();
    if !trimmed_content.starts_with("---") {
        return first_markdown_summary(content);
    }

    let mut lines = trimmed_content.lines();
    if lines.next()? != "---" {
        return first_markdown_summary(content);
    }

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        let Some(value) = trimmed.strip_prefix("description:") else {
            continue;
        };
        let normalized = value.trim().trim_matches('"').trim_matches('\'');
        if !normalized.is_empty() {
            return Some(normalized.to_string());
        }
    }

    first_markdown_summary(content)
}

fn first_markdown_summary(content: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with("---")
                && !line.starts_with('#')
                && !line.starts_with("name:")
                && !line.starts_with("description:")
        })
        .find(|line| !line.starts_with("```"))
        .map(|line| line.trim_matches('"').to_string())
}

fn normalize_relative_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize_host_tool(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "claude-code" | "cursor" | "codex" => Some(normalized),
        _ => None,
    }
}

struct DirectCliCandidate {
    id: &'static str,
    command: &'static str,
    description: &'static str,
    bundled_skill_repo: Option<&'static str>,
    update_command: Option<&'static str>,
    update_strategy: &'static str,
}

fn direct_cli_candidates() -> &'static [DirectCliCandidate] {
    &[
        DirectCliCandidate {
            id: "lark-cli",
            command: "lark-cli",
            description: "飞书 CLI 工具入口。",
            bundled_skill_repo: Some("https://github.com/larksuite/cli"),
            update_command: Some("lark-cli update"),
            update_strategy: "linked-skills",
        },
        DirectCliCandidate {
            id: "feishu-cli",
            command: "feishu-cli",
            description: "飞书 CLI 工具入口。",
            bundled_skill_repo: Some("https://github.com/larksuite/cli"),
            update_command: Some("feishu-cli update"),
            update_strategy: "linked-skills",
        },
    ]
}

fn probe_direct_cli_tool(
    candidate: &DirectCliCandidate,
    installed_skills: &[crate::models::SkillSummary],
) -> Option<CliToolSummary> {
    let executable_path = resolve_cli_command_path(candidate.command)?;
    let bundled_skills = resolve_bundled_skills(candidate, installed_skills);
    Some(CliToolSummary {
        id: candidate.id.to_string(),
        name: candidate.command.to_string(),
        owner_plugin_id: None,
        owner_plugin_name: None,
        lifecycle_source: "direct".to_string(),
        command: candidate.command.to_string(),
        executable_path: Some(executable_path),
        status_label: Some("已安装".to_string()),
        update_command: candidate.update_command.map(str::to_string),
        update_strategy: Some(candidate.update_strategy.to_string()),
        bundled_skills,
        description: candidate.description.to_string(),
    })
}

fn resolve_bundled_skills(
    candidate: &DirectCliCandidate,
    installed_skills: &[crate::models::SkillSummary],
) -> Vec<String> {
    let Some(repo_url) = candidate.bundled_skill_repo else {
        return Vec::new();
    };

    let mut bundled_skills = installed_skills
        .iter()
        .filter(|skill| skill_source_belongs_to_repo(skill, repo_url))
        .map(|skill| skill.name.clone())
        .collect::<Vec<_>>();
    bundled_skills.sort();
    bundled_skills.dedup();
    bundled_skills
}

fn skill_source_belongs_to_repo(skill: &crate::models::SkillSummary, repo_url: &str) -> bool {
    let normalized_repo = normalize_repo_url(repo_url);
    let normalized_source = normalize_repo_url(&skill.source_url);
    if normalized_repo.is_empty() || normalized_source.is_empty() {
        return false;
    }
    normalized_source == normalized_repo || normalized_source.starts_with(&(normalized_repo + "/"))
}

fn normalize_repo_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/').trim_end_matches(".git");
    trimmed.to_ascii_lowercase()
}

fn resolve_cli_command_path(command: &str) -> Option<String> {
    let output = Command::new("which").arg(command).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return None;
    }
    Some(path)
}

fn find_git_root(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(dir) = current {
        let marker = dir.join(".git");
        if marker.is_dir() || marker.is_file() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

fn git_skilldock_metadata_dir(repo_root: &Path) -> Option<PathBuf> {
    let marker = repo_root.join(".git");
    if marker.is_dir() {
        return Some(marker.join(SKILLDOCK_GIT_METADATA_DIR));
    }
    if !marker.is_file() {
        return None;
    }

    let content = fs::read_to_string(&marker).ok()?;
    let git_dir = content.trim().strip_prefix("gitdir:")?.trim();
    if git_dir.is_empty() {
        return None;
    }

    let git_dir_path = Path::new(git_dir);
    let resolved_git_dir = if git_dir_path.is_absolute() {
        git_dir_path.to_path_buf()
    } else {
        repo_root.join(git_dir_path)
    };
    Some(resolved_git_dir.join(SKILLDOCK_GIT_METADATA_DIR))
}

fn git_scoped_skilldock_metadata_path(
    plugin_root: &Path,
    category: &str,
    fallback_file_name: &str,
) -> Option<PathBuf> {
    let effective_plugin_root =
        canonicalize_existing_dir(plugin_root).unwrap_or_else(|_| plugin_root.to_path_buf());
    let git_root = find_git_root(&effective_plugin_root)?;
    let metadata_dir = git_skilldock_metadata_dir(&git_root)?;
    let relative_path = effective_plugin_root
        .strip_prefix(&git_root)
        .unwrap_or(&effective_plugin_root);
    let file_name = metadata_file_name_for_relative_path(relative_path, fallback_file_name);
    Some(metadata_dir.join(category).join(file_name))
}

fn metadata_file_name_for_relative_path(relative_path: &Path, fallback_file_name: &str) -> String {
    let normalized_path = normalize_relative_path(relative_path);
    let key = if normalized_path.is_empty() {
        "root".to_string()
    } else {
        normalized_path
    };
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let slug = slugify(&key);
    let prefix = if slug.is_empty() {
        "root"
    } else {
        slug.as_str()
    };
    let extension = Path::new(fallback_file_name)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("json");
    format!(
        "{prefix}-{}.{}",
        &hash[..PLUGIN_PACKAGE_HASH_LEN],
        extension
    )
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(path)
        .map_err(|error| format!("删除旧元数据文件失败（{}）: {error}", path.display()))
}

fn remove_empty_dir_if_exists(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Ok(());
    }
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => Ok(()),
        Err(error) => Err(format!(
            "删除旧元数据目录失败（{}）: {error}",
            path.display()
        )),
    }
}

fn file_modified_timestamp(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_millis().to_string())
}

fn current_timestamp_millis() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_default()
}

fn current_timestamp_rfc3339() -> String {
    let output = Command::new("date")
        .arg("-u")
        .arg("+%Y-%m-%dT%H:%M:%SZ")
        .output();
    match output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => "1970-01-01T00:00:00Z".to_string(),
    }
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_was_dash = false;
            continue;
        }
        if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }
    slug.trim_matches('-').to_string()
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

struct ProbeBuildArgs<'a> {
    tool: &'a str,
    compatible_host_tools: Vec<String>,
    kind: &'a str,
    description: String,
    root: &'a Path,
    manifest_path: Option<&'a Path>,
    marketplace_manifest_path: Option<&'a Path>,
    components: Vec<PluginComponentSummary>,
    git_root: Option<&'a Path>,
    confidence: &'a str,
    install_strategy: &'a str,
    warnings: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::{
        build_plugin_scope_summary, cleanup_duplicate_plugin_package_roots,
        configure_plugin_sparse_checkout, copy_plugin_dir, dedupe_and_sort_plugins, delete_plugin,
        ensure_skilldock_claude_marketplace, ensure_skilldock_codex_marketplace,
        get_plugin_component_preview, install_selected_plugin_probes_blocking,
        legacy_plugin_package_identity_path, legacy_skilldock_plugin_source_metadata_path,
        list_cli_tools, list_installed_plugins_blocking as list_installed_plugins,
        newest_codex_plugin_root_under, paths_refer_to_same_dir, plugin_git_state,
        probe_plugin_repo, probe_plugin_source_candidates_blocking, read_plugin_package_identity,
        read_skilldock_plugin_source_metadata, resolve_shared_plugin_package_id,
        set_plugin_enabled, shared_plugin_package_id_candidates, shared_plugin_package_repo_root,
        write_plugin_package_identity, write_skilldock_plugin_source_metadata,
    };
    use crate::models::{PluginComponentSummary, PluginProbeResult, PluginSummary};
    use crate::workspace::TEST_ENV_LOCK;
    use std::env;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        let path = env::temp_dir().join(format!("skilldock-plugin-manager-{label}-{suffix}"));
        if path.exists() {
            let _ = fs::remove_dir_all(&path);
        }
        fs::create_dir_all(&path).expect("create temp test dir");
        path
    }

    fn run_git_test(current_dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .current_dir(current_dir)
            .args(args)
            .status()
            .expect("git command should run");
        assert!(status.success(), "git {:?} should succeed", args);
    }

    #[test]
    fn shared_plugin_package_id_prefers_plugin_name_without_hash() {
        let package_id = shared_plugin_package_id_candidates(
            "https://github.com/everyinc/compound-engineering-plugin.git",
            Path::new("plugins/coding-tutor"),
        )
        .into_iter()
        .next()
        .expect("package id candidate");

        assert_eq!(package_id, "coding-tutor");
        assert!(!package_id.contains("https-github-com-everyinc"));
    }

    #[test]
    fn shared_plugin_repo_root_is_directly_under_plugins() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("plugin-package-root");
        let home_dir = temp_dir.join("home");
        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let repo_root = shared_plugin_package_repo_root("compound-engineering-plugin-coding-tutor")
            .expect("build shared repo root");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(
            repo_root,
            home_dir.join(".skilldock/plugins/compound-engineering-plugin-coding-tutor")
        );
        assert!(!repo_root.to_string_lossy().contains("/packages/"));
        assert!(!repo_root.ends_with("repo"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn install_reuses_short_package_and_removes_duplicate_package_dirs() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("plugin-package-duplicate-cleanup");
        let home_dir = temp_dir.join("home");
        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);
        let duplicate_root =
            home_dir.join(".skilldock/plugins/coding-tutor-compound-engineering-plugin");
        let source = "https://github.com/everyinc/compound-engineering-plugin.git";
        fs::create_dir_all(&duplicate_root).expect("create duplicate root");
        write_plugin_package_identity(&duplicate_root, source, Path::new("plugins/coding-tutor"))
            .expect("write duplicate identity");

        let package_id =
            resolve_shared_plugin_package_id(source, Path::new("plugins/coding-tutor"))
                .expect("resolve package id");
        let active_root =
            shared_plugin_package_repo_root(&package_id).expect("resolve active root");
        fs::create_dir_all(&active_root).expect("create active root");
        write_plugin_package_identity(&active_root, source, Path::new("plugins/coding-tutor"))
            .expect("write active identity");
        cleanup_duplicate_plugin_package_roots(
            &active_root,
            source,
            Path::new("plugins/coding-tutor"),
        )
        .expect("cleanup duplicates");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(package_id, "coding-tutor");
        assert!(active_root.exists());
        assert!(!duplicate_root.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn resolving_shared_package_id_does_not_create_empty_candidate_dir() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("plugin-package-id-no-empty-dir");
        let home_dir = temp_dir.join("home");
        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);
        let source = "https://github.com/everyinc/compound-engineering-plugin.git";

        let package_id =
            resolve_shared_plugin_package_id(source, Path::new("plugins/coding-tutor"))
                .expect("resolve package id");
        let package_root =
            shared_plugin_package_repo_root(&package_id).expect("resolve package root");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(package_id, "coding-tutor");
        assert!(!package_root.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn resolving_shared_package_id_reuses_unidentified_placeholder_dir() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("plugin-package-id-placeholder");
        let home_dir = temp_dir.join("home");
        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);
        let placeholder_root = home_dir.join(".skilldock/plugins/coding-tutor");
        fs::create_dir_all(placeholder_root.join(".idea")).expect("create placeholder metadata");
        fs::write(placeholder_root.join(".idea/workspace.xml"), "")
            .expect("write placeholder metadata");
        let source = "https://github.com/everyinc/compound-engineering-plugin.git";

        let package_id =
            resolve_shared_plugin_package_id(source, Path::new("plugins/coding-tutor"))
                .expect("resolve package id");
        let package_root =
            shared_plugin_package_repo_root(&package_id).expect("resolve package root");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(package_id, "coding-tutor");
        assert!(!package_root.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn plugin_git_state_does_not_fetch_remote_during_list_scan() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("plugin-git-state-no-fetch");
        let repo_root = temp_dir.join("repo");
        let bin_dir = temp_dir.join("bin");
        let git_log = temp_dir.join("git.log");
        fs::create_dir_all(repo_root.join(".git")).expect("create git dir");
        fs::create_dir_all(repo_root.join("plugins/coding-tutor")).expect("create plugin dir");
        fs::create_dir_all(&bin_dir).expect("create bin dir");
        let git_script = bin_dir.join("git");
        fs::write(
            &git_script,
            r#"#!/bin/sh
echo "$@" >> "$GIT_LOG"
if [ "$1" = "fetch" ]; then
  exit 42
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then
  echo "main"
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--short" ]; then
  echo "abc1234"
  exit 0
fi
exit 0
"#,
        )
        .expect("write fake git");
        let mut permissions = fs::metadata(&git_script)
            .expect("read fake git metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&git_script, permissions).expect("chmod fake git");

        let previous_path = env::var_os("PATH");
        let previous_git_log = env::var_os("GIT_LOG");
        env::set_var(
            "PATH",
            format!(
                "{}:{}",
                bin_dir.to_string_lossy(),
                previous_path
                    .as_ref()
                    .map(|value| value.to_string_lossy())
                    .unwrap_or_default()
            ),
        );
        env::set_var("GIT_LOG", &git_log);

        let state = plugin_git_state(&repo_root, Path::new("plugins/coding-tutor"));

        match previous_path {
            Some(value) => env::set_var("PATH", value),
            None => env::remove_var("PATH"),
        }
        match previous_git_log {
            Some(value) => env::set_var("GIT_LOG", value),
            None => env::remove_var("GIT_LOG"),
        }

        let calls = fs::read_to_string(&git_log).expect("read git log");
        assert_eq!(state.branch, "main");
        assert_eq!(state.commit, "abc1234");
        assert!(!calls.lines().any(|line| line.starts_with("fetch")));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn plugin_sparse_checkout_keeps_only_plugin_subdir_in_worktree() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("plugin-sparse-no-cone");
        let repo_root = temp_dir.join("repo");
        fs::create_dir_all(repo_root.join("plugins/coding-tutor")).expect("create plugin dir");
        fs::write(repo_root.join("README.md"), "# root").expect("write root readme");
        fs::write(repo_root.join("package.json"), "{}").expect("write root package");
        fs::write(repo_root.join("plugins/coding-tutor/README.md"), "# plugin")
            .expect("write plugin readme");
        run_git_test(&temp_dir, &["init", "--quiet", repo_root.to_str().unwrap()]);
        run_git_test(&repo_root, &["checkout", "-b", "main"]);
        run_git_test(&repo_root, &["config", "user.name", "SkillDock Test"]);
        run_git_test(
            &repo_root,
            &["config", "user.email", "skilldock@example.com"],
        );
        run_git_test(&repo_root, &["add", "."]);
        run_git_test(&repo_root, &["commit", "-m", "init"]);

        configure_plugin_sparse_checkout(&repo_root, Path::new("plugins/coding-tutor"))
            .expect("configure sparse checkout");

        assert!(!repo_root.join("README.md").exists());
        assert!(!repo_root.join("package.json").exists());
        assert!(repo_root.join("plugins/coding-tutor/README.md").is_file());
        assert!(repo_root.join(".git").is_dir());
        let git_exclude =
            fs::read_to_string(repo_root.join(".git/info/exclude")).expect("read git exclude");
        assert!(git_exclude.contains(".idea/"));
        assert!(git_exclude.contains(".DS_Store"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn skilldock_metadata_for_git_plugins_stays_out_of_worktree() {
        let temp_dir = temp_test_dir("plugin-metadata-out-of-worktree");
        let repo_root = temp_dir.join("repo");
        let plugin_root = repo_root.join("plugins/coding-tutor");
        fs::create_dir_all(plugin_root.join(".codex-plugin")).expect("create plugin dir");
        fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"Coding Tutor","version":"1.0.0"}"#,
        )
        .expect("write plugin manifest");
        run_git_test(&temp_dir, &["init", "--quiet", repo_root.to_str().unwrap()]);
        run_git_test(&repo_root, &["checkout", "-b", "main"]);
        run_git_test(&repo_root, &["config", "user.name", "SkillDock Test"]);
        run_git_test(
            &repo_root,
            &["config", "user.email", "skilldock@example.com"],
        );
        run_git_test(&repo_root, &["add", "."]);
        run_git_test(&repo_root, &["commit", "-m", "init"]);

        fs::write(
            legacy_plugin_package_identity_path(&repo_root),
            r#"{"source":"old","plugin_relative_path":""}"#,
        )
        .expect("write legacy package identity");
        fs::create_dir_all(plugin_root.join(".skilldock")).expect("create legacy metadata dir");
        fs::write(
            legacy_skilldock_plugin_source_metadata_path(&plugin_root),
            r#"{"source_url":"old","source_type":"git","source_ref":"","source_revision":""}"#,
        )
        .expect("write legacy source metadata");

        let source = "https://github.com/everyinc/compound-engineering-plugin.git";
        write_plugin_package_identity(&repo_root, source, Path::new("plugins/coding-tutor"))
            .expect("write package identity");
        let probe = PluginProbeResult {
            tool: "codex".to_string(),
            compatible_host_tools: Vec::new(),
            kind: "plugin-repo".to_string(),
            name: "Coding Tutor".to_string(),
            description: String::new(),
            plugin_root: plugin_root.to_string_lossy().to_string(),
            repo_root: repo_root.to_string_lossy().to_string(),
            plugin_relative_path: "plugins/coding-tutor".to_string(),
            manifest_path: plugin_root
                .join(".codex-plugin/plugin.json")
                .to_string_lossy()
                .to_string(),
            marketplace_manifest_path: String::new(),
            components: Vec::new(),
            source_type: "git".to_string(),
            source_url: source.to_string(),
            is_git_repo: true,
            git_root: repo_root.to_string_lossy().to_string(),
            confidence: "high".to_string(),
            install_strategy: "codex-plugin-dir".to_string(),
            warnings: Vec::new(),
        };
        write_skilldock_plugin_source_metadata(&plugin_root, &probe)
            .expect("write plugin source metadata");

        assert!(!legacy_plugin_package_identity_path(&repo_root).exists());
        assert!(!legacy_skilldock_plugin_source_metadata_path(&plugin_root).exists());
        assert_eq!(
            read_plugin_package_identity(&repo_root)
                .expect("read package identity")
                .source,
            "https://github.com/everyinc/compound-engineering-plugin"
        );
        assert_eq!(
            read_skilldock_plugin_source_metadata(&plugin_root)
                .expect("read source metadata")
                .source_url,
            source
        );
        assert!(!plugin_root.join(".skilldock").exists());
        assert!(!plugin_root.join("plugin-source.json").exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn skilldock_metadata_for_symlinked_git_plugins_stays_out_of_worktree() {
        let temp_dir = temp_test_dir("plugin-metadata-symlink-out-of-worktree");
        let repo_root = temp_dir.join("repo");
        let plugin_root = repo_root.join("plugins/coding-tutor");
        let install_root = temp_dir.join("installed/coding-tutor");
        fs::create_dir_all(plugin_root.join(".cursor-plugin")).expect("create plugin dir");
        fs::write(
            plugin_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"Coding Tutor","version":"1.0.0"}"#,
        )
        .expect("write plugin manifest");
        run_git_test(&temp_dir, &["init", "--quiet", repo_root.to_str().unwrap()]);
        run_git_test(&repo_root, &["checkout", "-b", "main"]);
        run_git_test(&repo_root, &["config", "user.name", "SkillDock Test"]);
        run_git_test(
            &repo_root,
            &["config", "user.email", "skilldock@example.com"],
        );
        run_git_test(&repo_root, &["add", "."]);
        run_git_test(&repo_root, &["commit", "-m", "init"]);
        fs::create_dir_all(install_root.parent().expect("install parent"))
            .expect("create install parent");
        std::os::unix::fs::symlink(&plugin_root, &install_root).expect("create plugin symlink");

        let source = "https://github.com/everyinc/compound-engineering-plugin.git";
        let probe = PluginProbeResult {
            tool: "cursor".to_string(),
            compatible_host_tools: Vec::new(),
            kind: "plugin-repo".to_string(),
            name: "Coding Tutor".to_string(),
            description: String::new(),
            plugin_root: plugin_root.to_string_lossy().to_string(),
            repo_root: repo_root.to_string_lossy().to_string(),
            plugin_relative_path: "plugins/coding-tutor".to_string(),
            manifest_path: plugin_root
                .join(".cursor-plugin/plugin.json")
                .to_string_lossy()
                .to_string(),
            marketplace_manifest_path: String::new(),
            components: Vec::new(),
            source_type: "git".to_string(),
            source_url: source.to_string(),
            is_git_repo: true,
            git_root: repo_root.to_string_lossy().to_string(),
            confidence: "high".to_string(),
            install_strategy: "cursor-plugin-dir".to_string(),
            warnings: Vec::new(),
        };
        write_skilldock_plugin_source_metadata(&install_root, &probe)
            .expect("write symlinked plugin source metadata");

        assert!(!legacy_skilldock_plugin_source_metadata_path(&plugin_root).exists());
        assert!(!legacy_skilldock_plugin_source_metadata_path(&install_root).exists());
        assert_eq!(
            read_skilldock_plugin_source_metadata(&install_root)
                .expect("read symlinked source metadata")
                .source_url,
            source
        );
        assert!(!plugin_root.join(".skilldock").exists());
        assert!(!install_root.join(".skilldock").exists());
        assert!(!plugin_root.join("plugin-source.json").exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn detects_claude_plugin_repo_from_manifest() {
        let temp_dir = temp_test_dir("claude-plugin-probe");
        let plugin_root = temp_dir.join("repo");
        fs::create_dir_all(plugin_root.join(".claude-plugin")).expect("create claude manifest dir");
        fs::write(
            plugin_root.join(".claude-plugin/plugin.json"),
            r#"{"name":"Repo Scout","version":"1.0.0"}"#,
        )
        .expect("write claude manifest");

        let result = probe_plugin_repo(plugin_root.to_string_lossy().into_owned(), None)
            .expect("probe repo");

        assert_eq!(result.tool, "claude-code");
        assert_eq!(result.kind, "plugin-repo");
        assert_eq!(result.confidence, "high");
        assert_eq!(result.install_strategy, "claude-plugin-dir");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn detects_cursor_plugin_repo_from_manifest() {
        let temp_dir = temp_test_dir("cursor-plugin-probe");
        let plugin_root = temp_dir.join("repo");
        fs::create_dir_all(plugin_root.join(".cursor-plugin")).expect("create cursor manifest dir");
        fs::write(
            plugin_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"Repo Scout","version":"1.0.0"}"#,
        )
        .expect("write cursor manifest");

        let result = probe_plugin_repo(plugin_root.to_string_lossy().into_owned(), None)
            .expect("probe repo");

        assert_eq!(result.tool, "cursor");
        assert_eq!(result.kind, "plugin-repo");
        assert_eq!(result.confidence, "high");
        assert_eq!(result.install_strategy, "cursor-registration");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn detects_codex_plugin_repo_from_manifest() {
        let temp_dir = temp_test_dir("codex-plugin-probe");
        let plugin_root = temp_dir.join("repo");
        fs::create_dir_all(plugin_root.join(".codex-plugin")).expect("create codex manifest dir");
        fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"Repo Scout","version":"1.0.0"}"#,
        )
        .expect("write codex manifest");

        let result = probe_plugin_repo(plugin_root.to_string_lossy().into_owned(), None)
            .expect("probe repo");

        assert_eq!(result.tool, "codex");
        assert_eq!(result.kind, "plugin-repo");
        assert_eq!(result.confidence, "high");
        assert_eq!(result.install_strategy, "codex-marketplace");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn detects_codex_marketplace_root_from_manifest() {
        let temp_dir = temp_test_dir("codex-marketplace-probe");
        let repo_root = temp_dir.join("repo");
        fs::create_dir_all(repo_root.join(".agents/plugins")).expect("create marketplace dir");
        fs::write(
            repo_root.join(".agents/plugins/marketplace.json"),
            r#"{"plugins":[]}"#,
        )
        .expect("write marketplace manifest");

        let result =
            probe_plugin_repo(repo_root.to_string_lossy().into_owned(), None).expect("probe repo");

        assert_eq!(result.tool, "codex");
        assert_eq!(result.kind, "marketplace-root");
        assert_eq!(result.confidence, "high");
        assert_eq!(result.install_strategy, "codex-marketplace");
        assert!(result
            .marketplace_manifest_path
            .ends_with(".agents/plugins/marketplace.json"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn detects_claude_marketplace_root_from_manifest() {
        let temp_dir = temp_test_dir("claude-marketplace-probe");
        let repo_root = temp_dir.join("repo");
        fs::create_dir_all(repo_root.join(".claude-plugin")).expect("create marketplace dir");
        fs::write(
            repo_root.join(".claude-plugin/marketplace.json"),
            r#"{"name":"local-marketplace","version":"1.0.0","plugins":["./plugins/repo-scout"]}"#,
        )
        .expect("write marketplace manifest");

        let result =
            probe_plugin_repo(repo_root.to_string_lossy().into_owned(), None).expect("probe repo");

        assert_eq!(result.tool, "claude-code");
        assert_eq!(result.kind, "marketplace-root");
        assert_eq!(result.confidence, "high");
        assert_eq!(result.install_strategy, "claude-plugin-dir");
        assert!(result
            .marketplace_manifest_path
            .ends_with(".claude-plugin/marketplace.json"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn marks_repo_without_manifest_as_standalone_assets() {
        let temp_dir = temp_test_dir("standalone-assets-probe");
        let repo_root = temp_dir.join("repo");
        fs::create_dir_all(repo_root.join("skills/example-skill")).expect("create skill dir");
        fs::create_dir_all(repo_root.join("agents")).expect("create agents dir");
        fs::write(
            repo_root.join("skills/example-skill/SKILL.md"),
            "---\ndescription: Example description\n---\n# Example",
        )
        .expect("write skill file");
        fs::write(
            repo_root.join("agents/codebase-researcher.md"),
            "---\ndescription: Codebase researcher\n---\n# Agent",
        )
        .expect("write agent file");

        let result =
            probe_plugin_repo(repo_root.to_string_lossy().into_owned(), None).expect("probe repo");

        assert_eq!(result.tool, "unknown");
        assert_eq!(result.kind, "standalone-assets");
        assert_eq!(result.install_strategy, "unsupported");
        assert_eq!(result.components.len(), 2);
        let skill_component = result
            .components
            .iter()
            .find(|component| component.asset_type == "skill")
            .expect("find skill component");
        let subagent_component = result
            .components
            .iter()
            .find(|component| component.asset_type == "subagent")
            .expect("find subagent component");
        assert_eq!(skill_component.id, "skills/example-skill");
        assert_eq!(skill_component.description, "Example description");
        assert_eq!(subagent_component.id, "agents/codebase-researcher.md");
        assert_eq!(subagent_component.description, "Codebase researcher");

        let preview = get_plugin_component_preview(
            repo_root.to_string_lossy().into_owned(),
            skill_component.id.clone(),
            skill_component.asset_type.clone(),
        )
        .expect("preview skill component");
        assert_eq!(preview.path, "skills/example-skill/SKILL.md");
        assert!(preview.content.contains("# Example"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn discovers_plugin_candidates_from_repo_root_children() {
        let temp_dir = temp_test_dir("plugin-root-candidates");
        let repo_root = temp_dir.join("repo");
        let agentic_root = repo_root.join("example-plugin");
        let workflow_root = repo_root.join("plugins/example-plugin");

        fs::create_dir_all(agentic_root.join(".codex-plugin")).expect("create codex manifest dir");
        fs::create_dir_all(agentic_root.join("skills/workflow-code-generation"))
            .expect("create codex skill dir");
        fs::write(
            agentic_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"example-plugin","version":"0.1.0"}"#,
        )
        .expect("write codex manifest");
        fs::write(
            agentic_root.join("skills/workflow-code-generation/SKILL.md"),
            "# workflow-code-generation",
        )
        .expect("write codex skill");

        fs::create_dir_all(workflow_root.join(".claude-plugin"))
            .expect("create claude manifest dir");
        fs::create_dir_all(workflow_root.join("commands")).expect("create command dir");
        fs::write(
            workflow_root.join(".claude-plugin/plugin.json"),
            r#"{"name":"example-plugin","version":"1.0.0"}"#,
        )
        .expect("write claude manifest");
        fs::write(workflow_root.join("commands/init-project.md"), "# init")
            .expect("write command");
        fs::create_dir_all(repo_root.join(".agents/plugins")).expect("create marketplace dir");
        fs::write(
            repo_root.join(".agents/plugins/marketplace.json"),
            r#"{
  "plugins": [
    {
      "name": "example-plugin",
      "source": { "path": "./example-plugin" }
    },
    {
      "name": "example-plugin",
      "source": { "path": "./plugins/example-plugin" }
    }
  ]
}"#,
        )
        .expect("write marketplace manifest");

        let results =
            probe_plugin_source_candidates_blocking(&repo_root.to_string_lossy(), None, None, None)
                .expect("probe plugin candidates");
        let roots = results
            .iter()
            .map(|result| result.plugin_root.as_str())
            .collect::<Vec<_>>();

        assert_eq!(results.len(), 2);
        assert!(roots
            .iter()
            .any(|root| root.ends_with("repo/example-plugin")));
        assert!(roots
            .iter()
            .any(|root| root.ends_with("repo/plugins/example-plugin")));
        assert!(results.iter().any(|result| result.tool == "codex"));
        assert!(results.iter().any(|result| result.tool == "claude-code"));
        assert!(!results
            .iter()
            .any(|result| result.kind == "marketplace-root"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn installs_selected_claude_plugin_probe() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("selected-plugin-install");
        let home_dir = temp_dir.join("home");
        let source_root = temp_dir.join("repo/plugins/example-plugin");
        fs::create_dir_all(source_root.join(".claude-plugin")).expect("create claude manifest dir");
        fs::create_dir_all(source_root.join("commands")).expect("create command dir");
        fs::write(
            source_root.join(".claude-plugin/plugin.json"),
            r#"{"name":"example-plugin","version":"1.0.0","description":"Workflow plugin"}"#,
        )
        .expect("write claude manifest");
        fs::write(source_root.join("commands/init-project.md"), "# init")
            .expect("write command");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);
        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "claude-code".to_string(),
                compatible_host_tools: vec!["claude-code".to_string()],
                kind: "plugin-repo".to_string(),
                name: "example-plugin".to_string(),
                description: "Workflow plugin".to_string(),
                plugin_root: source_root.to_string_lossy().into_owned(),
                manifest_path: source_root
                    .join(".claude-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url: "https://git.example.com/example-org/example-repo".to_string(),
                is_git_repo: true,
                repo_root: temp_dir.join("repo").to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/example-plugin".to_string(),
                git_root: temp_dir.join("repo").to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "claude-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec!["claude-code".to_string()],
        )
        .expect("install selected plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        let installed_state_content =
            fs::read_to_string(home_dir.join(".claude/plugins/installed_plugins.json"))
                .expect("read installed plugins state");
        let settings_content =
            fs::read_to_string(home_dir.join(".claude/settings.json")).expect("read settings");
        let known_marketplaces_content =
            fs::read_to_string(home_dir.join(".claude/plugins/known_marketplaces.json"))
                .expect("read known marketplaces");
        let marketplace_manifest_content = fs::read_to_string(
            home_dir.join(".claude/plugins/marketplaces/skilldock/.claude-plugin/marketplace.json"),
        )
        .expect("read claude marketplace manifest");

        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].host_tool, "claude-code");
        assert_eq!(installed[0].name, "example-plugin");
        let managed_plugin_root =
            home_dir.join(".skilldock/plugins/example-plugin/plugins/example-plugin");
        assert!(paths_refer_to_same_dir(
            Path::new(&installed[0].root_path),
            &managed_plugin_root
        ));
        assert!(managed_plugin_root
            .join(".claude-plugin/plugin.json")
            .is_file());
        assert!(home_dir
            .join(".claude/plugins/installed_plugins.json")
            .is_file());
        assert!(home_dir.join(".claude/settings.json").is_file());
        assert!(installed_state_content.contains("example-plugin@skilldock"));
        assert!(settings_content.contains(r#""skilldock""#));
        assert!(settings_content.contains(r#""source": "directory""#));
        assert!(settings_content.contains(".claude/plugins/marketplaces/skilldock"));
        assert!(known_marketplaces_content.contains(r#""skilldock""#));
        assert!(known_marketplaces_content.contains(r#""installLocation""#));
        assert!(marketplace_manifest_content.contains(r#""name": "skilldock""#));
        assert!(marketplace_manifest_content.contains(r#""owner""#));
        assert!(marketplace_manifest_content.contains(r#""SkillDock""#));
        assert!(marketplace_manifest_content.contains(r#""name": "example-plugin""#));
        assert!(
            marketplace_manifest_content.contains(r#""source": "./plugins/example-plugin""#)
        );
        assert!(
            !marketplace_manifest_content.contains(r#""path": "./plugins/example-plugin""#)
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn repairs_legacy_claude_marketplace_source_shape() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("repair-legacy-claude-marketplace");
        let home_dir = temp_dir.join("home");
        let source_root = temp_dir.join("repo/plugins/agent-sdk-dev");
        let marketplace_root = home_dir.join(".claude/plugins/marketplaces/skilldock");
        let manifest_path = marketplace_root.join(".claude-plugin/marketplace.json");

        fs::create_dir_all(source_root.join(".claude-plugin")).expect("create claude manifest dir");
        fs::write(
            source_root.join(".claude-plugin/plugin.json"),
            r#"{"name":"agent-sdk-dev","version":"1.0.0","description":"Agent SDK development plugin"}"#,
        )
        .expect("write claude manifest");
        fs::create_dir_all(manifest_path.parent().expect("manifest parent"))
            .expect("create marketplace manifest dir");
        fs::write(
            &manifest_path,
            r#"{
  "name": "skilldock",
  "plugins": [
    {
      "name": "agent-sdk-dev",
      "source": {
        "source": "",
        "path": "./plugins/agent-sdk-dev"
      }
    }
  ]
}"#,
        )
        .expect("write legacy manifest");

        ensure_skilldock_claude_marketplace(&home_dir, &source_root, "agent-sdk-dev")
            .expect("repair marketplace manifest");

        let repaired_manifest =
            fs::read_to_string(&manifest_path).expect("read repaired marketplace manifest");

        assert!(repaired_manifest.contains(r#""owner""#));
        assert!(repaired_manifest.contains(r#""source": "./plugins/agent-sdk-dev""#));
        assert!(!repaired_manifest.contains(r#""path": "./plugins/agent-sdk-dev""#));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn scans_claude_lsp_plugin_from_marketplace_entry_when_plugin_manifest_is_missing() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("scan-claude-lsp-marketplace-entry");
        let home_dir = temp_dir.join("home");
        let install_root =
            home_dir.join(".claude/plugins/cache/claude-plugins-official/jdtls-lsp/1.0.0");
        let marketplace_manifest_path = home_dir.join(
            ".claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json",
        );

        fs::create_dir_all(&install_root).expect("create install root");
        fs::write(install_root.join("README.md"), "# JDTLS").expect("write readme");
        fs::create_dir_all(
            marketplace_manifest_path
                .parent()
                .expect("marketplace manifest parent"),
        )
        .expect("create marketplace dir");
        fs::write(
            &marketplace_manifest_path,
            r#"{
  "name": "claude-plugins-official",
  "description": "Official plugins",
  "owner": { "name": "Anthropic" },
  "plugins": [
    {
      "name": "jdtls-lsp",
      "description": "Java language server (Eclipse JDT.LS) for code intelligence",
      "version": "1.0.0",
      "source": "./plugins/jdtls-lsp",
      "lspServers": {
        "jdtls": {
          "command": "jdtls"
        }
      }
    }
  ]
}"#,
        )
        .expect("write marketplace manifest");
        fs::create_dir_all(home_dir.join(".claude/plugins")).expect("create plugins dir");
        fs::write(
            home_dir.join(".claude/plugins/installed_plugins.json"),
            format!(
                r#"{{
  "version": 2,
  "plugins": {{
    "jdtls-lsp@claude-plugins-official": [
      {{
        "scope": "user",
        "installPath": "{}",
        "version": "1.0.0",
        "installedAt": "2026-03-25T14:09:59.787Z",
        "lastUpdated": "2026-03-25T14:09:59.787Z",
        "gitCommitSha": ""
      }}
    ]
  }}
}}"#,
                install_root.to_string_lossy()
            ),
        )
        .expect("write installed plugins state");
        fs::write(
            home_dir.join(".claude/settings.json"),
            r#"{
  "enabledPlugins": {
    "jdtls-lsp@claude-plugins-official": true
  }
}"#,
        )
        .expect("write settings");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].host_tool, "claude-code");
        assert_eq!(plugins[0].name, "jdtls-lsp");
        assert_eq!(plugins[0].enabled_state, "enabled");
        assert_eq!(plugins[0].source_label, "claude-plugins-official");
        assert_eq!(plugins[0].current_version, "1.0.0");
        assert_eq!(
            plugins[0].manifest_path,
            marketplace_manifest_path.to_string_lossy()
        );
        assert_eq!(plugins[0].components.len(), 1);
        assert_eq!(plugins[0].components[0].asset_type, "lsp");
        assert_eq!(plugins[0].components[0].name, "jdtls");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn installs_selected_codex_plugin_probe_with_local_marketplace_manifest() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("selected-codex-plugin-install");
        let home_dir = temp_dir.join("home");
        let source_root = temp_dir.join("repo/plugins/product-design");
        fs::create_dir_all(source_root.join(".codex-plugin")).expect("create codex manifest dir");
        fs::create_dir_all(source_root.join("skills/prototype")).expect("create skill dir");
        fs::write(
            source_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"product-design","version":"0.1.41","interface":{"displayName":"Product Design"}}"#,
        )
        .expect("write codex manifest");
        fs::write(source_root.join("skills/prototype/SKILL.md"), "# Prototype")
            .expect("write skill");

        let previous_home = env::var_os("HOME");
        let previous_codex_cli = env::var_os("SKILLDOCK_CODEX_CLI");
        env::set_var("HOME", &home_dir);
        env::set_var(
            "SKILLDOCK_CODEX_CLI",
            temp_dir
                .join("missing-codex-cli")
                .to_string_lossy()
                .into_owned(),
        );
        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "codex".to_string(),
                compatible_host_tools: vec!["codex".to_string()],
                kind: "plugin-repo".to_string(),
                name: "Product Design".to_string(),
                description: "Product design plugin".to_string(),
                plugin_root: source_root.to_string_lossy().into_owned(),
                manifest_path: source_root
                    .join(".codex-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url: "https://github.com/openai/role-specific-plugins.git".to_string(),
                is_git_repo: true,
                repo_root: temp_dir.join("repo").to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/product-design".to_string(),
                git_root: temp_dir.join("repo").to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "codex-marketplace".to_string(),
                warnings: Vec::new(),
            }],
            vec!["codex".to_string()],
        )
        .expect("install selected plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
        match previous_codex_cli {
            Some(value) => env::set_var("SKILLDOCK_CODEX_CLI", value),
            None => env::remove_var("SKILLDOCK_CODEX_CLI"),
        }

        let installed_root = home_dir.join(".codex/plugins/cache/skilldock/product-design");
        let config_content =
            fs::read_to_string(home_dir.join(".codex/config.toml")).expect("read codex config");
        let manifest_content = fs::read_to_string(
            home_dir.join(".codex/marketplaces/skilldock/.agents/plugins/marketplace.json"),
        )
        .expect("read marketplace manifest");

        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].host_tool, "codex");
        assert_eq!(installed[0].name, "Product Design");
        assert_eq!(installed[0].enabled_state, "enabled");
        assert_eq!(installed[0].install_state, "installed");
        let managed_plugin_root =
            home_dir.join(".skilldock/plugins/product-design/plugins/product-design");
        assert!(paths_refer_to_same_dir(
            Path::new(&installed[0].root_path),
            &managed_plugin_root
        ));
        assert!(managed_plugin_root
            .join(".codex-plugin/plugin.json")
            .is_file());
        assert!(config_content.contains("[marketplaces.skilldock]"));
        assert!(config_content.contains("source_type = \"local\""));
        assert!(config_content.contains(&format!(
            "source = \"{}\"",
            home_dir
                .join(".codex/marketplaces/skilldock")
                .to_string_lossy()
        ),));
        assert!(config_content.contains("[plugins.\"product-design@skilldock\"]"));
        assert!(config_content.contains("enabled = true"));
        assert!(manifest_content.contains("\"name\": \"skilldock\""));
        assert!(manifest_content.contains("\"displayName\": \"SkillDock\""));
        assert!(manifest_content.contains("\"name\": \"product-design\""));
        assert!(manifest_content.contains("\"source\": \"local\""));
        assert!(manifest_content.contains("\"path\": \"./plugins/product-design\""));
        assert!(manifest_content.contains("\"installation\": \"AVAILABLE\""));
        assert!(manifest_content.contains("\"authentication\": \"ON_INSTALL\""));
        assert!(home_dir
            .join(".codex/marketplaces/skilldock/plugins/product-design/.codex-plugin/plugin.json")
            .is_file());
        assert!(newest_codex_plugin_root_under(&installed_root).is_some());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn copy_plugin_dir_keeps_files_when_source_and_target_match() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("copy-plugin-dir-same-root");
        let plugin_root = temp_dir.join("plugin");

        fs::create_dir_all(plugin_root.join(".codex-plugin")).expect("create plugin manifest dir");
        fs::create_dir_all(plugin_root.join("skills/research")).expect("create skill dir");
        fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"product-design","version":"0.1.41"}"#,
        )
        .expect("write plugin manifest");
        fs::write(plugin_root.join("skills/research/SKILL.md"), "# Research").expect("write skill");

        copy_plugin_dir(&plugin_root, &plugin_root).expect("copy plugin dir");

        assert!(plugin_root.join(".codex-plugin/plugin.json").is_file());
        assert!(plugin_root.join("skills/research/SKILL.md").is_file());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn strips_placeholder_app_config_from_codex_plugin_copy() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("codex-plugin-placeholder-app-config");
        let home_dir = temp_dir.join("home");
        let source_root = temp_dir.join("repo/plugins/product-design");
        fs::create_dir_all(source_root.join(".codex-plugin")).expect("create codex manifest dir");
        fs::write(
            source_root.join(".codex-plugin/plugin.json"),
            r##"{
  "name": "product-design",
  "version": "0.1.41",
  "apps": "./.app.json",
  "interface": {
    "displayName": "Product Design",
    "defaultPrompt": ["Help me get started"],
    "capabilities": ["Interactive"],
    "brandColor": "#FF66AD"
  }
}"##,
        )
        .expect("write codex manifest");
        fs::write(
            source_root.join(".app.json"),
            r#"{"apps":{"sites":{"id":"REPLACE_WITH_SITES_APP_OR_CONNECTOR_ID"}}}"#,
        )
        .expect("write app config");

        let marketplace_root =
            ensure_skilldock_codex_marketplace(&home_dir, &source_root, "product-design")
                .expect("ensure marketplace");
        let copied_manifest_path =
            marketplace_root.join("plugins/product-design/.codex-plugin/plugin.json");
        let copied_manifest =
            fs::read_to_string(&copied_manifest_path).expect("read copied plugin manifest");

        assert!(!copied_manifest.contains(r#""apps""#));
        assert!(!marketplace_root
            .join("plugins/product-design/.app.json")
            .exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn installs_probed_git_plugin_candidates_from_repo_cache() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("probed-git-plugin-install");
        let home_dir = temp_dir.join("home");
        let repo_root = home_dir.join(".skilldock/repo-cache/probed-plugin-install");
        let plugin_root = repo_root.join("plugins/product-design");
        fs::create_dir_all(plugin_root.join(".claude-plugin")).expect("create claude manifest dir");
        fs::create_dir_all(plugin_root.join("commands")).expect("create command dir");
        fs::write(
            plugin_root.join(".claude-plugin/plugin.json"),
            r#"{"name":"product-design","version":"1.0.0","description":"Product design plugin"}"#,
        )
        .expect("write claude manifest");
        fs::write(plugin_root.join("commands/design-review.md"), "# review")
            .expect("write command");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);
        let target_probe = PluginProbeResult {
            tool: "claude-code".to_string(),
            compatible_host_tools: vec!["claude-code".to_string()],
            kind: "plugin-repo".to_string(),
            name: "product-design".to_string(),
            description: "Product design plugin".to_string(),
            plugin_root: plugin_root.to_string_lossy().into_owned(),
            manifest_path: plugin_root
                .join(".claude-plugin/plugin.json")
                .to_string_lossy()
                .into_owned(),
            marketplace_manifest_path: String::new(),
            components: Vec::new(),
            source_type: "git".to_string(),
            source_url: "https://github.com/example/product-design.git".to_string(),
            is_git_repo: true,
            repo_root: repo_root.to_string_lossy().into_owned(),
            plugin_relative_path: "plugins/product-design".to_string(),
            git_root: repo_root.to_string_lossy().into_owned(),
            confidence: "high".to_string(),
            install_strategy: "claude-plugin-dir".to_string(),
            warnings: Vec::new(),
        };

        let installed = install_selected_plugin_probes_blocking(
            vec![target_probe],
            vec!["claude-code".to_string()],
        )
        .expect("install selected plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].host_tool, "claude-code");
        assert_eq!(installed[0].name, "product-design");
        assert!(home_dir
            .join(".claude/plugins/installed_plugins.json")
            .is_file());
        assert!(home_dir.join(".claude/settings.json").is_file());
        assert!(!repo_root.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn expands_mcp_config_servers_as_separate_components() {
        let temp_dir = temp_test_dir("mcp-server-components");
        let repo_root = temp_dir.join("repo");
        fs::create_dir_all(&repo_root).expect("create repo dir");
        fs::write(
            repo_root.join(".mcp.json"),
            r#"{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github@2025.4.8"]
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@2.1.4"]
    },
    "exa": {
      "type": "http",
      "url": "https://mcp.exa.ai/mcp"
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory@2026.1.26"]
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@0.0.69", "--extension"]
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking@2025.12.18"]
    }
  }
}"#,
        )
        .expect("write mcp config");

        let result =
            probe_plugin_repo(repo_root.to_string_lossy().into_owned(), None).expect("probe repo");
        let mcp_components = result
            .components
            .iter()
            .filter(|component| component.asset_type == "mcp")
            .collect::<Vec<_>>();

        assert_eq!(mcp_components.len(), 6);
        assert!(mcp_components
            .iter()
            .any(|component| component.name == "github"
                && component.id == ".mcp.json/github"
                && component.package_item_id == ".mcp.json"
                && component
                    .description
                    .contains("@modelcontextprotocol/server-github")));
        assert!(mcp_components
            .iter()
            .any(|component| component.name == "exa"
                && component.id == ".mcp.json/exa"
                && component.description == "https://mcp.exa.ai/mcp"));

        let github_component = mcp_components
            .iter()
            .find(|component| component.name == "github")
            .expect("find github mcp component");
        let preview = get_plugin_component_preview(
            repo_root.to_string_lossy().into_owned(),
            github_component.id.clone(),
            github_component.asset_type.clone(),
        )
        .expect("preview mcp component");
        assert_eq!(preview.path, ".mcp.json/github");
        assert!(preview.content.contains("\"github\""));
        assert!(preview
            .content
            .contains("@modelcontextprotocol/server-github"));
        assert!(!preview.content.contains("\"context7\""));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn lists_codex_installed_plugins_from_home_config() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("codex-installed-scan");
        let home_dir = temp_dir.join("home");
        let marketplace_root = home_dir.join(".codex/marketplaces/openai-bundled");
        let plugin_root = marketplace_root.join("plugins/browser");

        fs::create_dir_all(plugin_root.join(".codex-plugin")).expect("create plugin manifest dir");
        fs::create_dir_all(plugin_root.join("skills/browser")).expect("create plugin skill dir");
        fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"browser","version":"1.0.0","interface":{"displayName":"Browser"}}"#,
        )
        .expect("write plugin manifest");
        fs::write(plugin_root.join("skills/browser/SKILL.md"), "# Browser").expect("write skill");

        fs::create_dir_all(marketplace_root.join(".agents/plugins"))
            .expect("create marketplace dir");
        fs::write(
            marketplace_root.join(".agents/plugins/marketplace.json"),
            r#"{
  "plugins": [
    {
      "name": "browser",
      "source": { "path": "./plugins/browser" }
    }
  ]
}"#,
        )
        .expect("write marketplace manifest");

        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."browser-use@openai-bundled"]
enabled = true

[marketplaces.openai-bundled]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", &marketplace_root.to_string_lossy()),
        )
        .expect("write codex config");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].host_tool, "codex");
        assert_eq!(plugins[0].name, "Browser");
        assert_eq!(plugins[0].enabled_state, "enabled");
        assert_eq!(plugins[0].install_state, "installed");
        assert_eq!(plugins[0].scopes.len(), 1);
        assert_eq!(plugins[0].scopes[0].scope_id, "user");
        assert_eq!(plugins[0].components.len(), 1);
        assert_eq!(plugins[0].components[0].asset_type, "skill");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn dedupes_codex_configured_marketplace_plugin_with_cached_copy() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("codex-config-cache-dedupe");
        let home_dir = temp_dir.join("home");
        let marketplace_root = home_dir.join(".codex/marketplaces/openai-bundled");
        let configured_plugin_root = marketplace_root.join("plugins/browser");
        let cached_plugin_root = home_dir.join(".codex/plugins/cache/openai-bundled/browser/1.0.0");

        for plugin_root in [&configured_plugin_root, &cached_plugin_root] {
            fs::create_dir_all(plugin_root.join(".codex-plugin"))
                .expect("create plugin manifest dir");
            fs::create_dir_all(plugin_root.join("skills/browser"))
                .expect("create plugin skill dir");
            fs::write(
                plugin_root.join(".codex-plugin/plugin.json"),
                r#"{"name":"browser","version":"1.0.0","interface":{"displayName":"Browser"}}"#,
            )
            .expect("write plugin manifest");
            fs::write(plugin_root.join("skills/browser/SKILL.md"), "# Browser")
                .expect("write skill");
        }

        fs::create_dir_all(marketplace_root.join(".agents/plugins"))
            .expect("create marketplace dir");
        fs::write(
            marketplace_root.join(".agents/plugins/marketplace.json"),
            r#"{
  "plugins": [
    {
      "name": "browser",
      "source": { "path": "./plugins/browser" }
    }
  ]
}"#,
        )
        .expect("write marketplace manifest");

        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."browser-use@openai-bundled"]
enabled = true

[marketplaces.openai-bundled]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", &marketplace_root.to_string_lossy()),
        )
        .expect("write codex config");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].host_tool, "codex");
        assert_eq!(plugins[0].name, "Browser");
        assert_eq!(plugins[0].enabled_state, "enabled");
        assert_eq!(plugins[0].install_state, "installed");
        assert!(plugins[0]
            .root_path
            .ends_with(".codex/marketplaces/openai-bundled/plugins/browser"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn keeps_codex_plugins_with_same_marketplace_source_as_separate_packages() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("codex-same-source-packages");
        let home_dir = temp_dir.join("home");
        let marketplace_root = home_dir.join(".codex/marketplaces/openai-bundled");

        for plugin_name in ["browser", "chrome"] {
            let plugin_root = marketplace_root.join("plugins").join(plugin_name);
            fs::create_dir_all(plugin_root.join(".codex-plugin"))
                .expect("create plugin manifest dir");
            fs::write(
                plugin_root.join(".codex-plugin/plugin.json"),
                format!(
                    r#"{{"name":"{plugin_name}","version":"1.0.0","repository":"https://github.com/openai/openai/tree/master/lib/browser_use/plugin","interface":{{"displayName":"{plugin_name}"}}}}"#
                ),
            )
            .expect("write plugin manifest");
        }

        fs::create_dir_all(marketplace_root.join(".agents/plugins"))
            .expect("create marketplace dir");
        fs::write(
            marketplace_root.join(".agents/plugins/marketplace.json"),
            r#"{
  "plugins": [
    {
      "name": "browser",
      "source": { "path": "./plugins/browser" }
    },
    {
      "name": "chrome",
      "source": { "path": "./plugins/chrome" }
    }
  ]
}"#,
        )
        .expect("write marketplace manifest");

        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."browser@openai-bundled"]
enabled = true

[plugins."chrome@openai-bundled"]
enabled = true

[marketplaces.openai-bundled]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", &marketplace_root.to_string_lossy()),
        )
        .expect("write codex config");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugins.len(), 2);
        assert!(plugins.iter().any(|plugin| plugin.id == "codex:browser"));
        assert!(plugins.iter().any(|plugin| plugin.id == "codex:chrome"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn lists_codex_cached_plugins_when_config_source_is_remote() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("codex-cache-scan");
        let home_dir = temp_dir.join("home");
        let configured_plugin_root =
            home_dir.join(".codex/plugins/cache/example-org/example-plugin/0.1.0");
        let detected_plugin_root =
            home_dir.join(".codex/plugins/cache/openai-primary-runtime/documents/26.601.10930");

        fs::create_dir_all(configured_plugin_root.join(".codex-plugin"))
            .expect("create configured plugin manifest dir");
        fs::create_dir_all(configured_plugin_root.join("skills/example-plugin"))
            .expect("create configured plugin skill dir");
        fs::write(
            configured_plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"example-plugin","version":"0.1.0","interface":{"displayName":"Example Plugin"}}"#,
        )
        .expect("write configured plugin manifest");
        fs::write(
            configured_plugin_root.join("skills/example-plugin/SKILL.md"),
            "# Example Plugin",
        )
        .expect("write configured plugin skill");

        fs::create_dir_all(detected_plugin_root.join(".codex-plugin"))
            .expect("create detected plugin manifest dir");
        fs::create_dir_all(detected_plugin_root.join("skills/documents"))
            .expect("create detected plugin skill dir");
        fs::write(
            detected_plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"documents","version":"26.601.10930","interface":{"displayName":"Documents"}}"#,
        )
        .expect("write detected plugin manifest");
        fs::write(
            detected_plugin_root.join("skills/documents/SKILL.md"),
            "# Documents",
        )
        .expect("write detected plugin skill");

        fs::create_dir_all(home_dir.join(".codex")).expect("create codex dir");
        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."example-plugin@example-org"]
enabled = true

[marketplaces.example-org]
source = "https://example.com/example-org.git"
"#,
        )
        .expect("write codex config");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        let configured = plugins
            .iter()
            .find(|plugin| plugin.name == "Example Plugin")
            .expect("configured plugin should be listed from cache");
        assert_eq!(configured.host_tool, "codex");
        assert_eq!(configured.enabled_state, "enabled");
        assert_eq!(configured.install_state, "installed");

        let detected = plugins
            .iter()
            .find(|plugin| plugin.name == "Documents")
            .expect("cache-only plugin should be detected");
        assert_eq!(detected.host_tool, "codex");
        assert_eq!(detected.enabled_state, "unknown");
        assert_eq!(detected.install_state, "detected");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn lists_codex_cached_local_marketplace_plugin_without_plugin_config_as_disabled() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("codex-local-marketplace-default-disabled");
        let home_dir = temp_dir.join("home");
        let marketplace_root = home_dir.join(".codex/.tmp/bundled-marketplaces/openai-bundled");
        let marketplace_plugin_root = marketplace_root.join("plugins/computer-use");
        let cached_plugin_root =
            home_dir.join(".codex/plugins/cache/openai-bundled/computer-use/1.0.799");
        let manifest = r#"{"name":"computer-use","version":"1.0.799","interface":{"displayName":"Computer Use"}}"#;

        for plugin_root in [&marketplace_plugin_root, &cached_plugin_root] {
            fs::create_dir_all(plugin_root.join(".codex-plugin"))
                .expect("create plugin manifest dir");
            fs::write(plugin_root.join(".codex-plugin/plugin.json"), manifest)
                .expect("write plugin manifest");
        }
        fs::create_dir_all(marketplace_root.join(".agents/plugins"))
            .expect("create marketplace dir");
        fs::write(
            marketplace_root.join(".agents/plugins/marketplace.json"),
            r#"{
  "plugins": [
    {
      "name": "computer-use",
      "source": { "path": "./plugins/computer-use" }
    }
  ]
}"#,
        )
        .expect("write marketplace manifest");
        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[marketplaces.openai-bundled]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", &marketplace_root.to_string_lossy()),
        )
        .expect("write codex config");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].host_tool, "codex");
        assert_eq!(plugins[0].name, "Computer Use");
        assert_eq!(plugins[0].enabled_state, "disabled");
        assert_eq!(plugins[0].install_state, "installed");
        assert_eq!(plugins[0].scopes.len(), 1);
        assert_eq!(plugins[0].scopes[0].enabled_state, "disabled");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn toggles_codex_cached_local_marketplace_plugin_without_plugin_config_entry() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("codex-local-marketplace-toggle");
        let home_dir = temp_dir.join("home");
        let marketplace_root = home_dir.join(".codex/.tmp/bundled-marketplaces/openai-bundled");
        let marketplace_plugin_root = marketplace_root.join("plugins/computer-use");
        let cached_plugin_root =
            home_dir.join(".codex/plugins/cache/openai-bundled/computer-use/1.0.799");
        let manifest = r#"{"name":"computer-use","version":"1.0.799","interface":{"displayName":"Computer Use"}}"#;

        for plugin_root in [&marketplace_plugin_root, &cached_plugin_root] {
            fs::create_dir_all(plugin_root.join(".codex-plugin"))
                .expect("create plugin manifest dir");
            fs::write(plugin_root.join(".codex-plugin/plugin.json"), manifest)
                .expect("write plugin manifest");
        }
        fs::create_dir_all(marketplace_root.join(".agents/plugins"))
            .expect("create marketplace dir");
        fs::write(
            marketplace_root.join(".agents/plugins/marketplace.json"),
            r#"{
  "plugins": [
    {
      "name": "computer-use",
      "source": { "path": "./plugins/computer-use" }
    }
  ]
}"#,
        )
        .expect("write marketplace manifest");
        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[marketplaces.openai-bundled]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", &marketplace_root.to_string_lossy()),
        )
        .expect("write codex config");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugin = set_plugin_enabled(
            "codex".to_string(),
            cached_plugin_root.to_string_lossy().into_owned(),
            true,
        )
        .expect("enable plugin");
        let config_content =
            fs::read_to_string(home_dir.join(".codex/config.toml")).expect("read codex config");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugin.enabled_state, "enabled");
        assert!(plugin
            .root_path
            .ends_with(".codex/.tmp/bundled-marketplaces/openai-bundled/plugins/computer-use"));
        assert!(config_content.contains(r#"[plugins."computer-use@openai-bundled"]"#));
        assert!(config_content.contains("enabled = true"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn ignores_codex_tmp_marketplace_plugins_when_listing_installed_plugins() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("codex-tmp-marketplace-scan");
        let home_dir = temp_dir.join("home");
        let tmp_plugin_root = home_dir.join(".codex/.tmp/plugins/plugins/github");

        fs::create_dir_all(tmp_plugin_root.join(".codex-plugin"))
            .expect("create tmp plugin manifest dir");
        fs::write(
            tmp_plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"github","version":"1.0.0","interface":{"displayName":"GitHub"}}"#,
        )
        .expect("write tmp plugin manifest");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(plugins.iter().all(|plugin| plugin.name != "GitHub"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn lists_claude_installed_plugins_from_installed_plugins_state() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("claude-installed-scan");
        let home_dir = temp_dir.join("home");
        let install_root =
            home_dir.join(".claude/plugins/cache/claude-plugins-official/code-review/unknown");

        fs::create_dir_all(install_root.join(".claude-plugin"))
            .expect("create plugin manifest dir");
        fs::create_dir_all(install_root.join("commands")).expect("create commands dir");
        fs::write(
            install_root.join(".claude-plugin/plugin.json"),
            r#"{"name":"code-review","version":"unknown","interface":{"displayName":"Code Review Plugin"}}"#,
        )
        .expect("write plugin manifest");
        fs::write(
            install_root.join("commands/code-review.md"),
            "# Code Review",
        )
        .expect("write command");

        fs::create_dir_all(home_dir.join(".claude/plugins")).expect("create plugins dir");
        fs::write(
            home_dir.join(".claude/plugins/installed_plugins.json"),
            r#"{
  "version": 2,
  "plugins": {
    "code-review@claude-plugins-official": [
      {
        "scope": "user",
        "installPath": "__INSTALL_PATH__",
        "version": "unknown",
        "installedAt": "2026-03-25T14:47:45.632Z",
        "lastUpdated": "2026-04-20T15:35:07.019Z",
        "gitCommitSha": "abc123"
      }
    ]
  }
}"#
            .replace("__INSTALL_PATH__", &install_root.to_string_lossy()),
        )
        .expect("write installed plugins state");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].host_tool, "claude-code");
        assert_eq!(plugins[0].name, "Code Review Plugin");
        assert_eq!(plugins[0].current_commit, "abc123");
        assert_eq!(plugins[0].enabled_state, "disabled");
        assert_eq!(plugins[0].scopes.len(), 1);
        assert_eq!(plugins[0].scopes[0].enabled_state, "disabled");
        assert_eq!(plugins[0].components.len(), 1);
        assert_eq!(plugins[0].components[0].asset_type, "command");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn ignores_cursor_plugin_cache_and_lists_local_plugins() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-installed-scan");
        let home_dir = temp_dir.join("home");
        let cache_root = home_dir.join(
            ".cursor/plugins/cache/cursor-public/prisma/4584a0a9175ba74053d7ee946c6234d3369a5a33",
        );
        let local_root = home_dir.join(".cursor/plugins/local/raisely");

        fs::create_dir_all(cache_root.join(".cursor-plugin"))
            .expect("create cursor plugin manifest dir");
        fs::create_dir_all(cache_root.join(".git")).expect("create cursor plugin git dir");
        fs::create_dir_all(cache_root.join("rules")).expect("create rules dir");
        fs::write(
            cache_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"prisma","displayName":"Prisma","version":"1.0.0","repository":"https://github.com/prisma/prisma","description":"Prisma Cursor plugin"}"#,
        )
        .expect("write cursor plugin manifest");
        fs::write(
            cache_root.join("rules/schema-conventions.mdc"),
            "# Schema conventions",
        )
        .expect("write cursor rule");
        fs::write(cache_root.join("mcp.json"), r#"{"mcpServers":{}}"#).expect("write cursor mcp");
        fs::create_dir_all(local_root.join(".cursor-plugin"))
            .expect("create local cursor plugin manifest dir");
        fs::create_dir_all(local_root.join("rules")).expect("create local rules dir");
        fs::write(
            local_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"raisely","displayName":"Raisely","version":"0.1.0","repository":"https://github.com/raisely/cursor-plugin","description":"Raisely Cursor plugin"}"#,
        )
        .expect("write local cursor plugin manifest");
        fs::write(
            local_root.join("rules/raisely-guardrails.md"),
            "# Raisely guardrails",
        )
        .expect("write local cursor rule");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].host_tool, "cursor");
        assert_eq!(plugins[0].name, "Raisely");
        assert_eq!(plugins[0].source_type, "local");
        assert_eq!(plugins[0].source_label, "raisely");
        assert_eq!(plugins[0].source_revision, "");
        assert_eq!(
            plugins[0].source_url,
            "https://github.com/raisely/cursor-plugin"
        );
        assert_eq!(plugins[0].enabled_state, "enabled");
        assert_eq!(plugins[0].install_state, "installed");
        assert_eq!(plugins[0].scopes.len(), 1);
        assert_eq!(plugins[0].scopes[0].scope_id, "user");
        assert_eq!(plugins[0].scopes[0].enabled_state, "enabled");
        assert_eq!(plugins[0].components.len(), 1);
        assert!(plugins[0]
            .components
            .iter()
            .any(|component| component.asset_type == "rule"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn dedupes_cursor_plugins_with_same_source() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-plugin-dedupe");
        let home_dir = temp_dir.join("home");
        let cache_root =
            home_dir.join(".cursor/plugins/cache/example-org/example-plugin/0.1.0");
        let local_root = home_dir.join(".cursor/plugins/local/example-plugin");
        let manifest = r#"{"name":"example-plugin","displayName":"Example Plugin","version":"0.1.0","repository":"https://git.example.com/example-org/example-repo","description":"Example Plugin"}"#;

        for plugin_root in [&cache_root, &local_root] {
            fs::create_dir_all(plugin_root.join(".cursor-plugin"))
                .expect("create cursor plugin manifest dir");
            fs::write(plugin_root.join(".cursor-plugin/plugin.json"), manifest)
                .expect("write cursor plugin manifest");
        }
        fs::create_dir_all(cache_root.join("skills/cache-only")).expect("create cache skill dir");
        fs::write(
            cache_root.join("skills/cache-only/SKILL.md"),
            "# Cache Only",
        )
        .expect("write cache skill");
        fs::create_dir_all(local_root.join("skills/local-only")).expect("create local skill dir");
        fs::write(
            local_root.join("skills/local-only/SKILL.md"),
            "# Local Only",
        )
        .expect("write local skill");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].host_tool, "cursor");
        assert_eq!(plugins[0].name, "Example Plugin");
        assert_eq!(plugins[0].source_type, "local");
        assert_eq!(plugins[0].enabled_state, "enabled");
        assert!(plugins[0]
            .root_path
            .ends_with(".cursor/plugins/local/example-plugin"));
        assert!(plugins[0]
            .components
            .iter()
            .any(|component| component.id == "skills/local-only"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn installs_selected_cursor_plugin_probe() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("selected-cursor-plugin-install");
        let home_dir = temp_dir.join("home");
        let source_root = temp_dir.join("repo/plugins/example-plugin");
        fs::create_dir_all(source_root.join(".cursor-plugin")).expect("create cursor manifest dir");
        fs::create_dir_all(source_root.join("rules")).expect("create rules dir");
        fs::write(
            source_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"example-plugin","displayName":"Example Plugin","version":"0.1.0","repository":"https://github.com/example/example-plugin","description":"Agent workflows"}"#,
        )
        .expect("write cursor manifest");
        fs::write(
            source_root.join("rules/review-checklist.mdc"),
            "# Review checklist",
        )
        .expect("write cursor rule");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "cursor".to_string(),
                compatible_host_tools: vec!["cursor".to_string()],
                kind: "plugin-repo".to_string(),
                name: "Example Plugin".to_string(),
                description: "Agent workflows".to_string(),
                plugin_root: source_root.to_string_lossy().into_owned(),
                manifest_path: source_root
                    .join(".cursor-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url: "https://github.com/example/example-plugin".to_string(),
                is_git_repo: true,
                repo_root: temp_dir.join("repo").to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/example-plugin".to_string(),
                git_root: temp_dir.join("repo").to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "cursor-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec!["cursor".to_string()],
        )
        .expect("install selected plugin");

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        let installed_root = home_dir.join(".cursor/plugins/local/example-plugin");
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].host_tool, "cursor");
        assert_eq!(installed[0].name, "Example Plugin");
        assert_eq!(installed[0].source_type, "marketplace");
        let managed_plugin_root =
            home_dir.join(".skilldock/plugins/example-plugin/plugins/example-plugin");
        assert!(paths_refer_to_same_dir(
            Path::new(&installed[0].root_path),
            &managed_plugin_root
        ));
        assert!(managed_plugin_root
            .join(".cursor-plugin/plugin.json")
            .is_file());
        assert!(installed_root.join(".cursor-plugin/plugin.json").is_file());
        assert!(installed_root.join("rules/review-checklist.mdc").is_file());
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].host_tool, "cursor");
        assert_eq!(plugins[0].name, "Example Plugin");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn deletes_cursor_local_plugin_directory_and_removes_from_scan() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-delete-plugin");
        let home_dir = temp_dir.join("home");
        let install_root = home_dir.join(".cursor/plugins/local/example-plugin");

        fs::create_dir_all(install_root.join(".cursor-plugin"))
            .expect("create cursor manifest dir");
        fs::create_dir_all(install_root.join("rules")).expect("create rules dir");
        fs::write(
            install_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"example-plugin","displayName":"Example Plugin","version":"0.1.0","repository":"https://github.com/example/example-plugin","description":"Agent workflows"}"#,
        )
        .expect("write cursor manifest");
        fs::write(
            install_root.join("rules/review-checklist.mdc"),
            "# Review checklist",
        )
        .expect("write cursor rule");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        delete_plugin(
            "cursor".to_string(),
            install_root.to_string_lossy().into_owned(),
        )
        .expect("delete cursor plugin");
        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(!install_root.exists());
        assert!(plugins.is_empty());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn deletes_cursor_symlink_and_managed_plugin_package() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-delete-managed-plugin");
        let home_dir = temp_dir.join("home");
        let managed_package_root =
            home_dir.join(".skilldock/plugins/coding-tutor-compound-engineering-plugin");
        let legacy_placeholder_root = home_dir.join(".skilldock/plugins/coding-tutor");
        let managed_plugin_root = managed_package_root.join("plugins/coding-tutor");
        let install_root = home_dir.join(".cursor/plugins/local/coding-tutor");

        fs::create_dir_all(managed_plugin_root.join(".cursor-plugin"))
            .expect("create cursor manifest dir");
        fs::write(
            managed_plugin_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"coding-tutor","displayName":"Coding Tutor","version":"0.1.0"}"#,
        )
        .expect("write cursor manifest");
        write_plugin_package_identity(
            &managed_package_root,
            "https://github.com/everyinc/compound-engineering-plugin.git",
            Path::new("plugins/coding-tutor"),
        )
        .expect("write managed package identity");
        fs::create_dir_all(legacy_placeholder_root.join(".idea"))
            .expect("create legacy placeholder");
        fs::write(legacy_placeholder_root.join(".idea/workspace.xml"), "")
            .expect("write legacy placeholder metadata");
        fs::create_dir_all(install_root.parent().expect("cursor local parent"))
            .expect("create cursor local parent");
        std::os::unix::fs::symlink(&managed_plugin_root, &install_root)
            .expect("create cursor symlink");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        delete_plugin(
            "cursor".to_string(),
            install_root.to_string_lossy().into_owned(),
        )
        .expect("delete cursor plugin");
        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(fs::symlink_metadata(&install_root).is_err());
        assert!(!managed_package_root.exists());
        assert!(!legacy_placeholder_root.exists());
        assert!(plugins.is_empty());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn lists_codex_disabled_plugins_from_home_config() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("codex-disabled-scan");
        let home_dir = temp_dir.join("home");
        let marketplace_root = home_dir.join(".codex/marketplaces/openai-bundled");
        let plugin_root = marketplace_root.join("plugins/browser");

        fs::create_dir_all(plugin_root.join(".codex-plugin")).expect("create plugin manifest dir");
        fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"browser","version":"1.0.0","interface":{"displayName":"Browser"}}"#,
        )
        .expect("write plugin manifest");

        fs::create_dir_all(marketplace_root.join(".agents/plugins"))
            .expect("create marketplace dir");
        fs::write(
            marketplace_root.join(".agents/plugins/marketplace.json"),
            r#"{
  "plugins": [
    {
      "name": "browser",
      "source": { "path": "./plugins/browser" }
    }
  ]
}"#,
        )
        .expect("write marketplace manifest");

        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."browser-use@openai-bundled"]
enabled = false

[marketplaces.openai-bundled]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", &marketplace_root.to_string_lossy()),
        )
        .expect("write codex config");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].host_tool, "codex");
        assert_eq!(plugins[0].enabled_state, "disabled");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn toggles_codex_plugin_enabled_in_home_config() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("codex-toggle-enabled");
        let home_dir = temp_dir.join("home");
        let marketplace_root = home_dir.join(".codex/marketplaces/openai-bundled");
        let plugin_root = marketplace_root.join("plugins/browser");

        fs::create_dir_all(plugin_root.join(".codex-plugin")).expect("create plugin manifest dir");
        fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"browser","version":"1.0.0","interface":{"displayName":"Browser"}}"#,
        )
        .expect("write plugin manifest");
        fs::create_dir_all(marketplace_root.join(".agents/plugins"))
            .expect("create marketplace dir");
        fs::write(
            marketplace_root.join(".agents/plugins/marketplace.json"),
            r#"{
  "plugins": [
    {
      "name": "browser",
      "source": { "path": "./plugins/browser" }
    }
  ]
}"#,
        )
        .expect("write marketplace manifest");
        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."browser-use@openai-bundled"]
enabled = false

[marketplaces.openai-bundled]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", &marketplace_root.to_string_lossy()),
        )
        .expect("write codex config");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugin = set_plugin_enabled(
            "codex".to_string(),
            plugin_root.to_string_lossy().into_owned(),
            true,
        )
        .expect("enable plugin");
        let config_content =
            fs::read_to_string(home_dir.join(".codex/config.toml")).expect("read codex config");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugin.enabled_state, "enabled");
        assert!(config_content.contains("enabled = true"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn toggles_claude_plugin_enabled_in_settings() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("claude-toggle-enabled");
        let home_dir = temp_dir.join("home");
        let install_root =
            home_dir.join(".claude/plugins/cache/claude-plugins-official/code-review/unknown");

        fs::create_dir_all(install_root.join(".claude-plugin"))
            .expect("create plugin manifest dir");
        fs::write(
            install_root.join(".claude-plugin/plugin.json"),
            r#"{"name":"code-review","version":"unknown","interface":{"displayName":"Code Review Plugin"}}"#,
        )
        .expect("write plugin manifest");
        fs::create_dir_all(home_dir.join(".claude/plugins")).expect("create plugins dir");
        fs::write(
            home_dir.join(".claude/plugins/installed_plugins.json"),
            r#"{
  "version": 2,
  "plugins": {
    "code-review@claude-plugins-official": [
      {
        "scope": "user",
        "installPath": "__INSTALL_PATH__",
        "version": "unknown",
        "installedAt": "2026-03-25T14:47:45.632Z",
        "lastUpdated": "2026-04-20T15:35:07.019Z",
        "gitCommitSha": "abc123"
      }
    ]
  }
}"#
            .replace("__INSTALL_PATH__", &install_root.to_string_lossy()),
        )
        .expect("write installed plugins state");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugin = set_plugin_enabled(
            "claude-code".to_string(),
            install_root.to_string_lossy().into_owned(),
            true,
        )
        .expect("enable plugin");
        let settings_content =
            fs::read_to_string(home_dir.join(".claude/settings.json")).expect("read settings");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugin.enabled_state, "enabled");
        assert!(settings_content.contains(r#""code-review@claude-plugins-official": true"#));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn deletes_codex_plugin_config_and_directory() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("codex-delete-plugin");
        let home_dir = temp_dir.join("home");
        let marketplace_root = home_dir.join(".codex/marketplaces/openai-bundled");
        let plugin_root = marketplace_root.join("plugins/browser");

        fs::create_dir_all(plugin_root.join(".codex-plugin")).expect("create plugin manifest dir");
        fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"browser","version":"1.0.0","interface":{"displayName":"Browser"}}"#,
        )
        .expect("write plugin manifest");
        fs::create_dir_all(marketplace_root.join(".agents/plugins"))
            .expect("create marketplace dir");
        fs::write(
            marketplace_root.join(".agents/plugins/marketplace.json"),
            r#"{
  "plugins": [
    {
      "name": "browser",
      "source": { "path": "./plugins/browser" }
    }
  ]
}"#,
        )
        .expect("write marketplace manifest");
        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."browser-use@openai-bundled"]
enabled = true

[marketplaces.openai-bundled]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", &marketplace_root.to_string_lossy()),
        )
        .expect("write codex config");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        delete_plugin(
            "codex".to_string(),
            plugin_root.to_string_lossy().into_owned(),
        )
        .expect("delete codex plugin");
        let config_content =
            fs::read_to_string(home_dir.join(".codex/config.toml")).expect("read codex config");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(plugin_root.exists());
        assert!(!config_content.contains("browser-use@openai-bundled"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn deletes_codex_plugin_via_cli_when_available() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("codex-delete-plugin-cli");
        let home_dir = temp_dir.join("home");
        let marketplace_root = home_dir.join(".codex/.tmp/plugins");
        let plugin_root = marketplace_root.join("plugins/google-drive");
        let cli_path = temp_dir.join("codex-cli");
        let log_path = temp_dir.join("codex-cli.log");

        fs::create_dir_all(plugin_root.join(".codex-plugin")).expect("create plugin manifest dir");
        fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"google-drive","version":"edd96568","interface":{"displayName":"Google Drive"}}"#,
        )
        .expect("write plugin manifest");
        fs::create_dir_all(marketplace_root.join(".agents/plugins"))
            .expect("create marketplace dir");
        fs::write(
            marketplace_root.join(".agents/plugins/marketplace.json"),
            r#"{
  "plugins": [
    {
      "name": "google-drive",
      "source": { "path": "./plugins/google-drive" }
    }
  ]
}"#,
        )
        .expect("write marketplace manifest");
        fs::create_dir_all(home_dir.join(".codex")).expect("create codex home dir");
        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."google-drive@openai-curated"]
enabled = true

[marketplaces.openai-curated]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", &marketplace_root.to_string_lossy()),
        )
        .expect("write codex config");
        fs::write(
            &cli_path,
            format!(
                "#!/bin/sh\nprintf '%s\n' \"$@\" > \"{}\"\n",
                log_path.to_string_lossy()
            ),
        )
        .expect("write cli script");
        let mut permissions = fs::metadata(&cli_path)
            .expect("read cli metadata")
            .permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o755);
        }
        fs::set_permissions(&cli_path, permissions).expect("set cli permissions");

        let previous_home = env::var_os("HOME");
        let previous_codex_cli = env::var_os("SKILLDOCK_CODEX_CLI");
        env::set_var("HOME", &home_dir);
        env::set_var("SKILLDOCK_CODEX_CLI", &cli_path);

        delete_plugin(
            "codex".to_string(),
            plugin_root.to_string_lossy().into_owned(),
        )
        .expect("delete codex plugin");
        let logged_args = fs::read_to_string(&log_path).expect("read cli log");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
        match previous_codex_cli {
            Some(value) => env::set_var("SKILLDOCK_CODEX_CLI", value),
            None => env::remove_var("SKILLDOCK_CODEX_CLI"),
        }

        assert_eq!(logged_args, "plugin\nremove\ngoogle-drive@openai-curated\n");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn deletes_codex_plugin_cache_copies_when_marketplace_remains() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("codex-delete-plugin-cache-copies");
        let home_dir = temp_dir.join("home");
        let marketplace_root = home_dir.join(".codex/.tmp/bundled-marketplaces/openai-bundled");
        let browser_root = marketplace_root.join("plugins/browser");
        let chrome_root = marketplace_root.join("plugins/chrome");
        let browser_cache_root =
            home_dir.join(".codex/plugins/cache/openai-bundled/browser/26.602.30954");

        for (plugin_root, manifest) in [
            (
                &browser_root,
                r#"{"name":"browser","version":"26.602.30954","interface":{"displayName":"Browser"}}"#,
            ),
            (
                &browser_cache_root,
                r#"{"name":"browser","version":"26.602.30954","interface":{"displayName":"Browser"}}"#,
            ),
            (
                &chrome_root,
                r#"{"name":"chrome","version":"26.602.30954","interface":{"displayName":"Chrome"}}"#,
            ),
        ] {
            fs::create_dir_all(plugin_root.join(".codex-plugin"))
                .expect("create plugin manifest dir");
            fs::write(plugin_root.join(".codex-plugin/plugin.json"), manifest)
                .expect("write plugin manifest");
        }
        fs::create_dir_all(marketplace_root.join(".agents/plugins"))
            .expect("create marketplace dir");
        fs::write(
            marketplace_root.join(".agents/plugins/marketplace.json"),
            r#"{
  "plugins": [
    {
      "name": "browser",
      "source": { "path": "./plugins/browser" }
    },
    {
      "name": "chrome",
      "source": { "path": "./plugins/chrome" }
    }
  ]
}"#,
        )
        .expect("write marketplace manifest");
        fs::create_dir_all(home_dir.join(".codex")).expect("create codex home dir");
        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."browser@openai-bundled"]
enabled = true

[plugins."chrome@openai-bundled"]
enabled = true

[marketplaces.openai-bundled]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", &marketplace_root.to_string_lossy()),
        )
        .expect("write codex config");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        delete_plugin(
            "codex".to_string(),
            browser_root.to_string_lossy().into_owned(),
        )
        .expect("delete codex plugin");
        let config_content =
            fs::read_to_string(home_dir.join(".codex/config.toml")).expect("read codex config");
        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(browser_root.exists());
        assert!(chrome_root.exists());
        assert!(!config_content.contains("browser@openai-bundled"));
        assert!(config_content.contains("chrome@openai-bundled"));
        assert!(config_content.contains("marketplaces.openai-bundled"));
        assert!(plugins.iter().all(|plugin| plugin.name != "Browser"));
        assert!(plugins.iter().any(|plugin| plugin.name == "Chrome"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn deletes_claude_plugin_state_settings_and_directory() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("claude-delete-plugin");
        let home_dir = temp_dir.join("home");
        let install_root =
            home_dir.join(".claude/plugins/cache/claude-plugins-official/code-review/unknown");

        fs::create_dir_all(install_root.join(".claude-plugin"))
            .expect("create plugin manifest dir");
        fs::write(
            install_root.join(".claude-plugin/plugin.json"),
            r#"{"name":"code-review","version":"unknown","interface":{"displayName":"Code Review Plugin"}}"#,
        )
        .expect("write plugin manifest");
        fs::create_dir_all(home_dir.join(".claude/plugins")).expect("create plugins dir");
        fs::write(
            home_dir.join(".claude/plugins/installed_plugins.json"),
            r#"{
  "version": 2,
  "plugins": {
    "code-review@claude-plugins-official": [
      {
        "scope": "user",
        "installPath": "__INSTALL_PATH__",
        "version": "unknown",
        "installedAt": "2026-03-25T14:47:45.632Z",
        "lastUpdated": "2026-04-20T15:35:07.019Z",
        "gitCommitSha": "abc123"
      }
    ]
  }
}"#
            .replace("__INSTALL_PATH__", &install_root.to_string_lossy()),
        )
        .expect("write installed plugins state");
        fs::write(
            home_dir.join(".claude/settings.json"),
            r#"{
  "enabledPlugins": {
    "code-review@claude-plugins-official": true
  }
}"#,
        )
        .expect("write settings");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        delete_plugin(
            "claude-code".to_string(),
            install_root.to_string_lossy().into_owned(),
        )
        .expect("delete claude plugin");
        let installed_content =
            fs::read_to_string(home_dir.join(".claude/plugins/installed_plugins.json"))
                .expect("read installed plugins state");
        let settings_content =
            fs::read_to_string(home_dir.join(".claude/settings.json")).expect("read settings");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(!install_root.exists());
        assert!(!installed_content.contains("code-review@claude-plugins-official"));
        assert!(!settings_content.contains("code-review@claude-plugins-official"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn deleting_one_host_keeps_managed_plugin_package_until_last_host_is_removed() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("managed-plugin-package-delete-last-host");
        let home_dir = temp_dir.join("home");
        let managed_root = home_dir.join(".skilldock");
        let shared_package_root = managed_root.join("plugins/repo-scout");
        let claude_install_root =
            home_dir.join(".claude/plugins/cache/claude-plugins-official/repo-scout/1.0.0");
        let codex_marketplace_root = home_dir.join(".codex/marketplaces/skilldock");
        let codex_install_root = codex_marketplace_root.join("plugins/repo-scout");

        fs::create_dir_all(shared_package_root.join(".claude-plugin"))
            .expect("create managed claude manifest dir");
        fs::write(
            shared_package_root.join(".claude-plugin/plugin.json"),
            r#"{"name":"repo-scout","version":"1.0.0","repository":"https://github.com/example/repo-scout","interface":{"displayName":"Repo Scout"}}"#,
        )
        .expect("write managed claude manifest");
        fs::create_dir_all(shared_package_root.join(".codex-plugin"))
            .expect("create managed codex manifest dir");
        fs::write(
            shared_package_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"repo-scout","version":"1.0.0","repository":"https://github.com/example/repo-scout","interface":{"displayName":"Repo Scout"}}"#,
        )
        .expect("write managed codex manifest");

        fs::create_dir_all(claude_install_root.parent().expect("claude parent"))
            .expect("create claude parent");
        std::os::unix::fs::symlink(&shared_package_root, &claude_install_root)
            .expect("link claude install to shared package");
        fs::create_dir_all(codex_install_root.parent().expect("codex parent"))
            .expect("create codex parent");
        std::os::unix::fs::symlink(&shared_package_root, &codex_install_root)
            .expect("link codex install to shared package");

        fs::create_dir_all(home_dir.join(".claude/plugins")).expect("create claude plugins dir");
        fs::write(
            home_dir.join(".claude/plugins/installed_plugins.json"),
            r#"{
  "version": 2,
  "plugins": {
    "repo-scout@claude-plugins-official": [
      {
        "scope": "user",
        "installPath": "__INSTALL_PATH__",
        "version": "1.0.0",
        "installedAt": "2026-03-25T14:47:45.632Z",
        "lastUpdated": "2026-04-20T15:35:07.019Z",
        "gitCommitSha": "abc123"
      }
    ]
  }
}"#
            .replace("__INSTALL_PATH__", &claude_install_root.to_string_lossy()),
        )
        .expect("write claude installed plugins state");
        fs::write(
            home_dir.join(".claude/settings.json"),
            r#"{
  "enabledPlugins": {
    "repo-scout@claude-plugins-official": true
  }
}"#,
        )
        .expect("write claude settings");
        fs::create_dir_all(codex_marketplace_root.join(".agents/plugins"))
            .expect("create codex marketplace dir");
        fs::write(
            codex_marketplace_root.join(".agents/plugins/marketplace.json"),
            r#"{
  "plugins": [
    {
      "name": "repo-scout",
      "source": { "path": "./plugins/repo-scout" }
    }
  ]
}"#,
        )
        .expect("write codex marketplace manifest");
        fs::create_dir_all(home_dir.join(".codex")).expect("create codex dir");
        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."repo-scout@skilldock"]
enabled = true

[marketplaces.skilldock]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", &codex_marketplace_root.to_string_lossy()),
        )
        .expect("write codex config");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        delete_plugin(
            "claude-code".to_string(),
            claude_install_root.to_string_lossy().into_owned(),
        )
        .expect("delete claude plugin");

        assert!(!claude_install_root.exists());
        assert!(codex_install_root.exists());
        assert!(shared_package_root.exists());

        delete_plugin(
            "codex".to_string(),
            codex_install_root.to_string_lossy().into_owned(),
        )
        .expect("delete codex plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(!codex_install_root.exists());
        assert!(!shared_package_root.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn links_related_host_tools_when_same_plugin_source_is_installed_multiple_times() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("plugin-cross-host-scan");
        let home_dir = temp_dir.join("home");
        let shared_source_url = "https://github.com/example/repo-scout";

        let codex_plugin_root = home_dir.join(".codex/plugins/cache/openai-bundled/repo-scout");
        fs::create_dir_all(codex_plugin_root.join(".codex-plugin"))
            .expect("create codex plugin manifest dir");
        fs::write(
            codex_plugin_root.join(".codex-plugin/plugin.json"),
            format!(
                r#"{{"name":"repo-scout","version":"1.0.0","repository":"{shared_source_url}","interface":{{"displayName":"Repo Scout"}}}}"#,
            ),
        )
        .expect("write codex plugin manifest");
        fs::create_dir_all(home_dir.join(".codex")).expect("create codex home dir");
        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."repo-scout@openai-bundled"]
enabled = true

[marketplaces.openai-bundled]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", shared_source_url),
        )
        .expect("write codex config");

        let claude_install_root =
            home_dir.join(".claude/plugins/cache/claude-plugins-official/repo-scout/1.0.0");
        fs::create_dir_all(claude_install_root.join(".claude-plugin"))
            .expect("create claude plugin manifest dir");
        fs::write(
            claude_install_root.join(".claude-plugin/plugin.json"),
            format!(
                r#"{{"name":"repo-scout","version":"1.0.0","repository":"{shared_source_url}","interface":{{"displayName":"Repo Scout"}}}}"#,
            ),
        )
        .expect("write claude plugin manifest");
        fs::create_dir_all(home_dir.join(".claude/plugins")).expect("create claude plugins dir");
        fs::write(
            home_dir.join(".claude/plugins/installed_plugins.json"),
            r#"{
  "version": 2,
  "plugins": {
    "repo-scout@claude-plugins-official": [
      {
        "scope": "user",
        "installPath": "__INSTALL_PATH__",
        "version": "1.0.0",
        "installedAt": "2026-03-25T14:47:45.632Z",
        "lastUpdated": "2026-04-20T15:35:07.019Z",
        "gitCommitSha": "abc123"
      }
    ]
  }
}"#
            .replace("__INSTALL_PATH__", &claude_install_root.to_string_lossy()),
        )
        .expect("write claude installed plugins state");
        fs::write(
            home_dir.join(".claude/settings.json"),
            r#"{
  "enabledPlugins": {
    "repo-scout@claude-plugins-official": true
  }
}"#,
        )
        .expect("write claude settings");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugins.len(), 2);
        let claude_plugin = plugins
            .iter()
            .find(|plugin| plugin.host_tool == "claude-code")
            .expect("find claude plugin");
        let codex_plugin = plugins
            .iter()
            .find(|plugin| plugin.host_tool == "codex")
            .expect("find codex plugin");
        assert_eq!(claude_plugin.related_host_tools, vec!["codex".to_string()]);
        assert_eq!(
            codex_plugin.related_host_tools,
            vec!["claude-code".to_string()]
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn lists_direct_cli_tools_from_shell_path() {
        let cli_tools = list_cli_tools().expect("list cli tools");

        let lark_cli = cli_tools
            .iter()
            .find(|tool| tool.command == "lark-cli")
            .expect("find lark-cli");
        assert_eq!(lark_cli.update_strategy.as_deref(), Some("linked-skills"));
        assert_eq!(lark_cli.update_command.as_deref(), Some("lark-cli update"));
        assert!(cli_tools.iter().all(|tool| tool.command != "codex"));
        assert!(cli_tools.iter().all(|tool| tool.command != "claude"));
        assert!(cli_tools
            .iter()
            .all(|tool| tool.lifecycle_source == "direct"));
        assert!(cli_tools.iter().all(|tool| tool.executable_path.is_some()));
    }

    #[test]
    fn marks_repo_without_plugin_signals_as_unknown() {
        let temp_dir = temp_test_dir("unknown-probe");
        let repo_root = temp_dir.join("repo");
        fs::create_dir_all(&repo_root).expect("create empty repo dir");

        let result =
            probe_plugin_repo(repo_root.to_string_lossy().into_owned(), None).expect("probe repo");

        assert_eq!(result.tool, "unknown");
        assert_eq!(result.kind, "unknown");
        assert_eq!(result.install_strategy, "unsupported");
        assert!(result.components.is_empty());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn keeps_same_host_plugins_separate_when_package_id_matches_but_names_differ() {
        let primary = PluginSummary {
            id: "claude-code:ecc".to_string(),
            package_id: "everything-claude-code".to_string(),
            name: "ecc".to_string(),
            description: "Battle-tested Claude Code plugin".to_string(),
            host_tool: "claude-code".to_string(),
            related_host_tools: Vec::new(),
            kind: "plugin-repo".to_string(),
            root_path: "/Users/demo/.claude/plugins/cache/ecc/ecc/1.10.0".to_string(),
            display_root_path: "/Users/demo/.claude/plugins/cache/ecc/ecc/1.10.0".to_string(),
            repo_root_path: "/Users/demo/.claude/plugins/cache/ecc/ecc/1.10.0".to_string(),
            plugin_relative_path: String::new(),
            manifest_path:
                "/Users/demo/.claude/plugins/cache/ecc/ecc/1.10.0/.claude-plugin/plugin.json"
                    .to_string(),
            source_type: "marketplace".to_string(),
            source_label: "ecc".to_string(),
            source_url: "https://github.com/affaan-m/everything-claude-code".to_string(),
            source_ref: String::new(),
            source_revision: String::new(),
            current_version: "1.10.0".to_string(),
            current_branch: String::new(),
            current_commit: "abc123".to_string(),
            collab_status: "clean".to_string(),
            status_text: String::new(),
            is_git_repo: false,
            update_mode: "auto".to_string(),
            update_strategy: "none".to_string(),
            update_available: false,
            baseline_hash: String::new(),
            local_modified: false,
            installed_at: String::new(),
            updated_at: String::new(),
            remote_updated_at: String::new(),
            local_updated_at: String::new(),
            last_editor: String::new(),
            last_scanned_at: String::new(),
            status: "ready".to_string(),
            install_state: "installed".to_string(),
            install_source: "host".to_string(),
            enabled_state: "enabled".to_string(),
            scopes: vec![build_plugin_scope_summary(
                "user",
                "用户级",
                "enabled",
                Path::new("~/.claude/settings.json"),
            )],
            components: vec![PluginComponentSummary {
                id: "commands/ecc.md".to_string(),
                name: "ecc.md".to_string(),
                description: "ECC command".to_string(),
                asset_type: "command".to_string(),
                owner_plugin_id: "claude-code:ecc".to_string(),
                package_item_id: "commands/ecc.md".to_string(),
            }],
        };
        let alias = PluginSummary {
            id: "claude-code:everything-claude-code".to_string(),
            package_id: "everything-claude-code".to_string(),
            name: "everything-claude-code".to_string(),
            description: "Battle-tested Claude Code plugin".to_string(),
            host_tool: "claude-code".to_string(),
            related_host_tools: Vec::new(),
            kind: "plugin-repo".to_string(),
            root_path: "/Users/demo/.claude/plugins/cache/everything-claude-code/everything-claude-code/1.10.0".to_string(),
            display_root_path:
                "/Users/demo/.claude/plugins/cache/everything-claude-code/everything-claude-code/1.10.0"
                    .to_string(),
            repo_root_path: "/Users/demo/.claude/plugins/cache/everything-claude-code/everything-claude-code/1.10.0".to_string(),
            plugin_relative_path: String::new(),
            manifest_path: "/Users/demo/.claude/plugins/cache/everything-claude-code/everything-claude-code/1.10.0/.claude-plugin/plugin.json".to_string(),
            source_type: "marketplace".to_string(),
            source_label: "everything-claude-code".to_string(),
            source_url: "https://github.com/affaan-m/everything-claude-code".to_string(),
            source_ref: String::new(),
            source_revision: String::new(),
            current_version: "1.10.0".to_string(),
            current_branch: String::new(),
            current_commit: "abc123".to_string(),
            collab_status: "clean".to_string(),
            status_text: String::new(),
            is_git_repo: false,
            update_mode: "auto".to_string(),
            update_strategy: "none".to_string(),
            update_available: false,
            baseline_hash: String::new(),
            local_modified: false,
            installed_at: String::new(),
            updated_at: String::new(),
            remote_updated_at: String::new(),
            local_updated_at: String::new(),
            last_editor: String::new(),
            last_scanned_at: String::new(),
            status: "ready".to_string(),
            install_state: "installed".to_string(),
            install_source: "host".to_string(),
            enabled_state: "disabled".to_string(),
            scopes: vec![build_plugin_scope_summary(
                "user",
                "用户级",
                "disabled",
                Path::new("~/.claude/settings.json"),
            )],
            components: vec![PluginComponentSummary {
                id: "commands/ecc.md".to_string(),
                name: "ecc.md".to_string(),
                description: "ECC command".to_string(),
                asset_type: "command".to_string(),
                owner_plugin_id: "claude-code:everything-claude-code".to_string(),
                package_item_id: "commands/ecc.md".to_string(),
            }],
        };

        let plugins = dedupe_and_sort_plugins(vec![alias, primary]).expect("dedupe plugins");

        assert_eq!(plugins.len(), 2);
    }
}
