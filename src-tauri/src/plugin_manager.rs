use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use toml_edit::{DocumentMut, Item, Table};

use crate::git_divergence::{local_branch_divergence_counts, resolve_remote_branch};
use crate::library::{
    configure_git_network_command, configure_hidden_subprocess, git_command,
    parse_market_source_url, remote_clone_candidates, repo_cache_directory,
    resolve_command_in_path, resolve_command_path, resolve_git_clone_url_with_instead_of,
    run_git_clone_with_progress, sanitize_storage_name, summarize_git_error,
    tree_relative_path_for_branch, with_temporary_discovery_repo_resolved, CloneProgressCallback,
};
use crate::models::{
    CliToolSummary, PluginComponentPreview, PluginComponentSummary, PluginProbeResult,
    PluginScopeSummary, PluginSummary, SkillFileEntry,
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
const OPENCODE_PLUGIN_DIR: &str = ".opencode/plugins";
const OPENCODE_USER_PLUGIN_DIR: &str = ".config/opencode/plugins";
const CODEX_SKILLDOCK_CACHE_VERSION: &str = "latest";
const PLUGIN_PACKAGE_DIR: &str = "plugins";
const REMOTE_BRANCH_PREFIX: &str = "origin/";
const PLUGIN_PACKAGE_IDENTITY_FILE: &str = ".skilldock-package.json";
const PLUGIN_UPDATE_METADATA_FILE: &str = ".skilldock-update.json";
const SKILLDOCK_GIT_METADATA_DIR: &str = "skilldock";
const SKILLDOCK_PACKAGE_IDENTITY_METADATA_FILE: &str = "package.json";
const SKILLDOCK_PLUGIN_SOURCE_METADATA_DIR: &str = "plugin-source";
const SKILLDOCK_PLUGIN_UPDATE_METADATA_DIR: &str = "update";
const PLUGIN_PACKAGE_HASH_LEN: usize = 8;
const PLUGIN_UPDATE_CACHE_FILE_NAME: &str = "plugin-update-cache.json";
const PLUGIN_LIST_CACHE_FILE_NAME: &str = "plugin-list-cache.json";
const CURSOR_DISABLED_PLUGIN_DIR: &str = ".skilldock/disabled-plugins/cursor";
const OPENCODE_DISABLED_PLUGIN_DIR: &str = ".skilldock/disabled-plugins/opencode";

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

#[derive(Debug, Deserialize, Default)]
struct GitHubContentEntry {
    #[serde(default)]
    name: String,
    #[serde(default, rename = "type")]
    entry_type: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    encoding: String,
}

#[derive(Debug, Deserialize, Default)]
struct GitHubTreeEntry {
    #[serde(default)]
    path: String,
    #[serde(default, rename = "type")]
    entry_type: String,
}

#[derive(Debug, Deserialize, Default)]
struct GitHubTreeResponse {
    #[serde(default)]
    tree: Vec<GitHubTreeEntry>,
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
    repo_root_override: Option<PathBuf>,
    plugin_relative_path_override: Option<PathBuf>,
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

#[derive(Clone, Debug)]
pub struct PortablePluginSource {
    pub package_id: String,
    pub directory_name: String,
    pub source_root: PathBuf,
    pub host_tools: Vec<String>,
    pub cursor_was_disabled: bool,
    pub disabled_host_tools: Vec<String>,
    pub plugin_relative_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortablePluginTarget {
    pub schema_version: u32,
    pub package_id: String,
    pub directory_name: String,
    pub host_tools: Vec<String>,
    pub cursor_was_disabled: bool,
    #[serde(default)]
    pub disabled_host_tools: Vec<String>,
    #[serde(default)]
    pub plugin_relative_path: String,
    pub content_hash: String,
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
const PLUGIN_STATUS_PENDING_COMMIT: &str = "pending-commit";
const PLUGIN_STATUS_PENDING_PUSH: &str = "pending-push";
const PLUGIN_STATUS_DIVERGED: &str = "diverged";
const CODEX_APP_NAMES: &[&str] = &["Codex", "ChatGPT"];

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
            None,
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
    app_handle: tauri::AppHandle,
) -> Result<Vec<PluginProbeResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        emit_plugin_status(&app_handle, "preparing", "正在查询插件信息...");
        let progress = make_plugin_progress_emitter(&app_handle);
        let result = probe_plugin_source_candidates_blocking(
            &source,
            git_ref.as_deref(),
            sparse_path.as_deref(),
            hint_host_tool,
            Some(&progress),
        );
        emit_plugin_status(&app_handle, "finalizing", "正在扫描插件目录...");
        result
    })
    .await
    .map_err(|error| format!("插件来源批量探测任务失败: {error}"))?
}

fn emit_plugin_status(app_handle: &tauri::AppHandle, phase: &str, message: &str) {
    use tauri::Emitter;
    let _ = app_handle.emit(
        "repo-clone-progress",
        serde_json::json!({ "phase": phase, "message": message }),
    );
}

fn make_plugin_progress_emitter(app_handle: &tauri::AppHandle) -> CloneProgressCallback {
    use std::sync::Arc;
    use tauri::Emitter;
    let handle = app_handle.clone();
    Arc::new(move |message: &str| {
        let _ = handle.emit(
            "repo-clone-progress",
            serde_json::json!({ "phase": "cloning", "message": message }),
        );
    })
}

#[tauri::command]
pub async fn list_installed_plugins() -> Result<Vec<PluginSummary>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let plugins = list_installed_plugins_blocking_with_mode(PluginScanMode::Refresh)?;
        save_plugin_list_cache(&plugins);
        Ok(plugins)
    })
    .await
    .map_err(|error| format!("插件列表扫描任务失败: {error}"))?
}

#[tauri::command]
pub async fn list_startup_installed_plugins() -> Result<Vec<PluginSummary>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let plugins = list_installed_plugins_blocking_with_mode(PluginScanMode::Startup)?;
        save_plugin_list_cache(&plugins);
        Ok(plugins)
    })
    .await
    .map_err(|error| format!("插件启动列表扫描任务失败: {error}"))?
}

#[tauri::command]
pub async fn refresh_plugin_states() -> Result<Vec<PluginSummary>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let plugins = list_installed_plugins_blocking_with_mode(PluginScanMode::Refresh)?;
        save_plugin_list_cache(&plugins);
        Ok(plugins)
    })
    .await
    .map_err(|error| format!("插件列表扫描任务失败: {error}"))?
}

#[tauri::command]
pub async fn refresh_local_plugin_states() -> Result<Vec<PluginSummary>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let plugins = list_installed_plugins_blocking_with_mode(PluginScanMode::Local)?;
        save_plugin_list_cache(&plugins);
        Ok(plugins)
    })
    .await
    .map_err(|error| format!("插件本地状态刷新任务失败: {error}"))?
}

#[tauri::command]
pub async fn refresh_local_plugin_state(
    host_tool: String,
    root_path: String,
) -> Result<PluginSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        refresh_and_persist_local_plugin_state(&host_tool, &root_path)
    })
    .await
    .map_err(|error| format!("后台刷新插件本地状态失败: {error}"))?
}

fn list_installed_plugins_blocking() -> Result<Vec<PluginSummary>, String> {
    list_installed_plugins_blocking_with_mode(PluginScanMode::Refresh)
}

fn portable_plugin_directory_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn insert_portable_plugin_directories(
    sources: &mut BTreeMap<PathBuf, PortablePluginSource>,
    root: &Path,
    cursor_was_disabled: bool,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let source_root = entry.path();
        if !source_root.is_dir() {
            continue;
        }
        let Some(directory_name) = portable_plugin_directory_name(&source_root) else {
            continue;
        };
        sources
            .entry(source_root.clone())
            .or_insert_with(|| PortablePluginSource {
                package_id: directory_name.clone(),
                directory_name,
                source_root: source_root.clone(),
                host_tools: if cursor_was_disabled {
                    vec!["cursor".to_string()]
                } else {
                    Vec::new()
                },
                cursor_was_disabled,
                disabled_host_tools: Vec::new(),
                plugin_relative_path: read_plugin_package_identity(&source_root)
                    .map(|identity| identity.plugin_relative_path)
                    .unwrap_or_default(),
            });
    }
}

pub fn collect_portable_plugin_sources() -> Result<Vec<PortablePluginSource>, String> {
    let home_dir = workspace::home_dir()?;
    let managed_root = workspace::managed_workspace_root()?.join(PLUGIN_PACKAGE_DIR);
    let disabled_root = cursor_disabled_plugins_root(&home_dir);
    let mut sources = BTreeMap::new();
    insert_portable_plugin_directories(&mut sources, &managed_root, false);
    insert_portable_plugin_directories(&mut sources, &disabled_root, true);

    if let Ok(plugins) = list_installed_plugins_blocking_with_mode(PluginScanMode::Local) {
        for plugin in plugins {
            let path = Path::new(&plugin.root_path);
            let source_root = managed_plugin_package_root_for_path(path).or_else(|| {
                path.strip_prefix(&disabled_root)
                    .ok()
                    .and_then(|relative| relative.components().next())
                    .map(|component| disabled_root.join(component.as_os_str()))
            });
            let Some(source_root) = source_root else {
                continue;
            };
            let Some(source) = sources.get_mut(&source_root) else {
                continue;
            };
            if plugin.host_tool == "opencode" && plugin.enabled_state == "disabled" {
                source.disabled_host_tools.push("opencode".to_string());
            }
            if source.plugin_relative_path.is_empty() {
                source.plugin_relative_path = plugin.plugin_relative_path.clone();
            }
            source.host_tools.push(plugin.host_tool);
            source.host_tools.extend(plugin.related_host_tools);
        }
    }

    let mut result = sources.into_values().collect::<Vec<_>>();
    for source in &mut result {
        source.host_tools.sort();
        source.host_tools.dedup();
        source.disabled_host_tools.sort();
        source.disabled_host_tools.dedup();
    }
    result.sort_by(|left, right| {
        left.cursor_was_disabled
            .cmp(&right.cursor_was_disabled)
            .then(left.directory_name.cmp(&right.directory_name))
    });
    Ok(result)
}

pub fn align_portable_plugin_targets(
    targets: &[PortablePluginTarget],
) -> Result<Vec<String>, String> {
    let home_dir = workspace::home_dir()?;
    let managed_root = workspace::managed_workspace_root()?.join(PLUGIN_PACKAGE_DIR);
    let disabled_root = cursor_disabled_plugins_root(&home_dir);
    let mut warnings = Vec::new();
    for target in targets {
        let package_root = if target.cursor_was_disabled {
            disabled_root.join(&target.directory_name)
        } else {
            managed_root.join(&target.directory_name)
        };
        if !package_root.is_dir() {
            warnings.push(format!("插件文件不存在，跳过启用: {}", target.package_id));
            continue;
        }
        let plugin_relative_path = PathBuf::from(&target.plugin_relative_path);
        if !plugin_relative_path.as_os_str().is_empty() {
            write_plugin_package_identity(
                &package_root,
                &path_to_string(&package_root),
                &plugin_relative_path,
            )?;
        }
        let probe_root = if plugin_relative_path.as_os_str().is_empty() {
            package_root.clone()
        } else {
            package_root.join(&plugin_relative_path)
        };
        let probe = probe_plugin_root(&probe_root, None);
        let source_root = PathBuf::from(&probe.plugin_root);
        for host_tool in &target.host_tools {
            let result = if target.cursor_was_disabled && host_tool == "cursor" {
                set_cursor_plugin_enabled(&probe.plugin_root, true).map(|_| source_root.clone())
            } else {
                install_plugin_probe_for_host(
                    &home_dir,
                    &source_root,
                    &package_root,
                    &probe,
                    host_tool,
                )
            };
            if let Err(error) = result {
                warnings.push(format!(
                    "{} 未能启用到 {}: {error}",
                    target.package_id, host_tool
                ));
                continue;
            }
            if target
                .disabled_host_tools
                .iter()
                .any(|disabled_host| disabled_host == host_tool)
            {
                if let Err(error) =
                    set_plugin_enabled(host_tool.clone(), path_to_string(&source_root), false)
                {
                    warnings.push(format!(
                        "{} 未能恢复 {} 停用状态: {error}",
                        target.package_id, host_tool
                    ));
                }
            }
        }
    }
    Ok(warnings)
}

fn list_installed_plugins_blocking_with_mode(
    scan_mode: PluginScanMode,
) -> Result<Vec<PluginSummary>, String> {
    let mut plugins = Vec::new();
    plugins.extend(scan_codex_installed_plugins(scan_mode));
    plugins.extend(scan_claude_installed_plugins(scan_mode));
    plugins.extend(scan_cursor_installed_plugins(scan_mode));
    plugins.extend(scan_opencode_installed_plugins(scan_mode));
    dedupe_and_sort_plugins(plugins)
}

fn plugin_list_cache_file() -> Option<PathBuf> {
    workspace_file_path(PLUGIN_LIST_CACHE_FILE_NAME).ok()
}

fn save_plugin_list_cache(plugins: &[PluginSummary]) {
    let Some(cache_file) = plugin_list_cache_file() else {
        return;
    };
    let Some(parent) = cache_file.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(payload) = serde_json::to_string_pretty(plugins) else {
        return;
    };
    let _ = fs::write(cache_file, payload);
}

fn refresh_and_persist_local_plugin_state(
    host_tool: &str,
    root_path: &str,
) -> Result<PluginSummary, String> {
    let plugins = list_installed_plugins_blocking_with_mode(PluginScanMode::Local)?;
    let refreshed_plugin = plugins
        .iter()
        .find(|plugin| plugin_cache_matches_host_and_root(host_tool, root_path, plugin))
        .cloned()
        .ok_or_else(|| "未找到要刷新的插件".to_string())?;
    save_plugin_list_cache(&plugins);
    Ok(refreshed_plugin)
}

#[tauri::command]
pub async fn install_selected_plugin_probes(
    probes: Vec<PluginProbeResult>,
    host_tools: Vec<String>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<PluginSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        emit_plugin_status(&app_handle, "preparing", "正在准备安装...");
        let progress = make_plugin_progress_emitter(&app_handle);
        let result = install_selected_plugin_probes_blocking(probes, host_tools, Some(&progress));
        emit_plugin_status(&app_handle, "finalizing", "正在完成安装...");
        result
    })
    .await
    .map_err(|error| format!("插件安装任务失败: {error}"))?
}

fn install_selected_plugin_probes_blocking(
    probes: Vec<PluginProbeResult>,
    host_tools: Vec<String>,
    on_progress: Option<&CloneProgressCallback>,
) -> Result<Vec<PluginSummary>, String> {
    let home_dir = workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let install_result = (|| {
        let mut installed_roots = Vec::new();

        for probe in probes {
            let selected_host_tools = host_tools
                .iter()
                .filter(|host_tool| plugin_probe_supports_host(&probe, host_tool))
                .cloned()
                .collect::<Vec<_>>();
            if selected_host_tools.is_empty() {
                continue;
            }
            for host_tool in &selected_host_tools {
                ensure_plugin_host_tool_installed(host_tool)?;
            }
            let cursor_selected = selected_host_tools
                .iter()
                .any(|host_tool| host_tool == "cursor");
            let shared_host_tools = selected_host_tools
                .into_iter()
                .filter(|host_tool| host_tool != "cursor")
                .collect::<Vec<_>>();
            let progress = on_progress.cloned();
            let mut install_threads = Vec::new();

            if cursor_selected && !shared_host_tools.is_empty() {
                let home_dir = home_dir.clone();
                let probe = probe.clone();
                let progress = progress.clone();
                let mut combined_host_tools = shared_host_tools.clone();
                combined_host_tools.push("cursor".to_string());
                install_threads.push(std::thread::spawn(move || {
                    install_shared_plugin_probe_for_hosts(
                        &home_dir,
                        &probe,
                        combined_host_tools,
                        progress.as_ref(),
                    )
                }));
            } else if cursor_selected {
                let home_dir = home_dir.clone();
                let probe = probe.clone();
                let progress = progress.clone();
                install_threads.push(std::thread::spawn(move || {
                    install_cursor_plugin_probe_independent(&home_dir, &probe, progress.as_ref())
                        .map(|installed_root| vec![("cursor".to_string(), installed_root)])
                }));
            }

            if !cursor_selected && !shared_host_tools.is_empty() {
                let home_dir = home_dir.clone();
                let probe = probe.clone();
                let progress = progress.clone();
                install_threads.push(std::thread::spawn(move || {
                    install_shared_plugin_probe_for_hosts(
                        &home_dir,
                        &probe,
                        shared_host_tools,
                        progress.as_ref(),
                    )
                }));
            }

            for install_thread in install_threads {
                let installed = install_thread
                    .join()
                    .map_err(|_| "插件安装线程意外中断".to_string())??;
                installed_roots.extend(installed);
            }
        }

        let installed_plugins = list_installed_plugins_blocking_with_mode(PluginScanMode::Local)?;
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

    install_result
}

fn install_shared_plugin_probe_for_hosts(
    home_dir: &Path,
    probe: &PluginProbeResult,
    host_tools: Vec<String>,
    on_progress: Option<&CloneProgressCallback>,
) -> Result<Vec<(String, PathBuf)>, String> {
    let package = ensure_shared_plugin_package(probe, &host_tools, on_progress)?;
    let source_root = canonicalize_existing_dir(&package.plugin_root)?;
    let package_root =
        managed_plugin_package_root_for_path(&source_root).unwrap_or_else(|| source_root.clone());

    let install_threads = host_tools
        .into_iter()
        .map(|host_tool| {
            let home_dir = home_dir.to_path_buf();
            let source_root = source_root.clone();
            let package_root = package_root.clone();
            let probe = probe.clone();
            std::thread::spawn(move || {
                install_plugin_probe_for_host(
                    &home_dir,
                    &source_root,
                    &package_root,
                    &probe,
                    &host_tool,
                )
                .map(|installed_root| (host_tool, installed_root))
            })
        })
        .collect::<Vec<_>>();

    let mut installed_roots = Vec::new();
    for install_thread in install_threads {
        installed_roots.push(
            install_thread
                .join()
                .map_err(|_| "插件安装线程意外中断".to_string())??,
        );
    }
    Ok(installed_roots)
}

#[tauri::command]
pub fn open_plugin_in_editor(root_path: &str, editor_id: &str) -> Result<(), String> {
    let plugin_root = canonicalize_existing_dir(Path::new(root_path))?;
    let target = path_to_string(&plugin_root);
    if editor_id == "intellij" {
        crate::commands::trust_intellij_project_path(&target)?;
        crate::commands::ensure_intellij_git_project_files(&target)?;
    }
    crate::commands::open_path_with_editor(&target, editor_id)
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
        "cursor" => set_cursor_plugin_enabled(&root_path, enabled),
        "opencode" => set_opencode_plugin_enabled(&root_path, enabled),
        _ => Err(format!("不支持的插件宿主: {host_tool}")),
    }
}

#[tauri::command]
pub async fn update_plugin(host_tool: String, root_path: String) -> Result<PluginSummary, String> {
    tauri::async_runtime::spawn_blocking(move || update_plugin_blocking(&host_tool, &root_path))
        .await
        .map_err(|error| format!("插件更新任务失败: {error}"))?
}

fn update_plugin_blocking(host_tool: &str, root_path: &str) -> Result<PluginSummary, String> {
    let target_root = canonicalize_existing_dir(Path::new(root_path))?;
    ensure_plugin_manifest_for_host(host_tool, &target_root)?;
    let plugin = find_plugin_after_enabled_change(host_tool, &target_root)?;
    match plugin.update_strategy.as_str() {
        "git" => {
            let update_root = if host_tool == "cursor" && find_git_root(&target_root).is_none() {
                managed_plugin_root_for_cursor_plugin_path(&target_root)
                    .unwrap_or_else(|| target_root.clone())
            } else if host_tool == "codex" && find_git_root(&target_root).is_none() {
                managed_plugin_package_root_from_source_metadata(&target_root)
                    .unwrap_or_else(|| target_root.clone())
            } else {
                target_root.clone()
            };
            update_plugin_repo(&update_root)?;
            if host_tool == "cursor" && update_root != target_root {
                sync_cursor_local_git_copy(&update_root, &target_root)?;
            }
            if host_tool == "codex" && plugin.source_label == "skilldock" {
                reconcile_skilldock_codex_cache_after_update(&plugin, &target_root, &update_root)?;
            }
            if host_tool == "opencode" {
                let home_dir =
                    workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
                if plugin.enabled_state == "disabled" {
                    ensure_opencode_links_disabled(&home_dir, &target_root)?;
                } else {
                    ensure_opencode_links_enabled(&home_dir, &target_root)?;
                }
            }
            find_plugin_after_enabled_change(host_tool, &target_root)
        }
        "hash" => update_hash_plugin(host_tool, &target_root),
        _ => Err("该插件当前不支持更新".to_string()),
    }
}

#[tauri::command]
pub fn delete_plugin(host_tool: String, root_path: String) -> Result<(), String> {
    let requested_root = Path::new(&root_path);
    if canonicalize_existing_dir(requested_root).is_err() {
        if host_tool != "codex" {
            if let Some(result) = delete_broken_managed_plugin(requested_root) {
                return result;
            }
        }
        if host_tool != "codex"
            && fs::symlink_metadata(requested_root).is_err()
            && is_host_plugin_storage_path(&host_tool, requested_root)
        {
            return Ok(());
        }
    }

    match host_tool.as_str() {
        "codex" => delete_codex_plugin(&root_path),
        "claude-code" => delete_claude_plugin(&root_path),
        "cursor" => delete_cursor_plugin(&root_path),
        "opencode" => delete_opencode_plugin(&root_path),
        _ => Err(format!("不支持的插件宿主: {host_tool}")),
    }
}

fn is_host_plugin_storage_path(host_tool: &str, path: &Path) -> bool {
    let Some(home_dir) = workspace::home_dir_option() else {
        return false;
    };
    let host_roots = match host_tool {
        "claude-code" => vec![home_dir.join(".claude/plugins")],
        "cursor" => vec![
            home_dir.join(".cursor/plugins/local"),
            cursor_disabled_plugins_root(&home_dir),
        ],
        "opencode" => vec![
            opencode_user_plugins_root(&home_dir),
            opencode_disabled_plugins_root(&home_dir),
        ],
        _ => Vec::new(),
    };
    let normalized_path = normalize_lexical_path(path);
    host_roots
        .into_iter()
        .any(|root| normalized_path.starts_with(normalize_lexical_path(&root)))
}

fn delete_broken_managed_plugin(requested_root: &Path) -> Option<Result<(), String>> {
    let package_root = managed_plugin_package_root_for_broken_request(requested_root)?;
    Some(clean_up_broken_managed_plugin(&package_root))
}

fn managed_plugin_package_root_for_broken_request(path: &Path) -> Option<PathBuf> {
    managed_plugin_package_root_for_requested_path(path).or_else(|| {
        let link_target = fs::read_link(path).ok()?;
        let resolved_target = if link_target.is_absolute() {
            link_target
        } else {
            path.parent()?.join(link_target)
        };
        managed_plugin_package_root_for_requested_path(&normalize_lexical_path(&resolved_target))
    })
}

fn clean_up_broken_managed_plugin(package_root: &Path) -> Result<(), String> {
    let home_dir = workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
    remove_broken_claude_plugin_entries(&home_dir, package_root)?;

    let mut links_to_remove = BTreeMap::<String, PathBuf>::new();
    for host_root in [
        home_dir.join(".claude/plugins"),
        home_dir.join(".cursor/plugins/local"),
        cursor_disabled_plugins_root(&home_dir),
        home_dir.join(".cursor/agents"),
        home_dir.join(".cursor/commands"),
        home_dir.join(".cursor/rules"),
        home_dir.join(".cursor/skills"),
        opencode_user_plugins_root(&home_dir),
    ] {
        collect_broken_managed_plugin_links(&host_root, package_root, 0, &mut links_to_remove);
    }
    remove_plugin_roots(links_to_remove.into_values(), "损坏的 SkillDock")?;

    if let Ok(disabled_marker) = opencode_disabled_marker(&home_dir, package_root) {
        remove_plugin_roots([disabled_marker], "OpenCode")?;
    }
    remove_plugin_roots([package_root.to_path_buf()], "SkillDock")
}

fn remove_broken_claude_plugin_entries(home_dir: &Path, package_root: &Path) -> Result<(), String> {
    let installed_state_path = home_dir.join(".claude/plugins/installed_plugins.json");
    if !installed_state_path.is_file() {
        return Ok(());
    }

    let mut installed_state = read_json_object_or_empty(&installed_state_path)?;
    let plugins = installed_state
        .as_object_mut()
        .and_then(|object| object.get_mut("plugins"))
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| "Claude installed_plugins.json plugins 不是对象".to_string())?;
    let mut removed_plugin_keys = Vec::new();
    let mut state_changed = false;
    for (plugin_key, entries_value) in plugins.iter_mut() {
        let Some(entries) = entries_value.as_array_mut() else {
            continue;
        };
        let previous_len = entries.len();
        entries.retain(|entry| {
            entry
                .get("installPath")
                .and_then(serde_json::Value::as_str)
                .map(|install_path| {
                    !path_resolves_into_broken_package(Path::new(install_path), package_root)
                })
                .unwrap_or(true)
        });
        let entries_changed = entries.len() != previous_len;
        state_changed |= entries_changed;
        if entries_changed && entries.is_empty() {
            removed_plugin_keys.push(plugin_key.clone());
        }
    }
    for plugin_key in &removed_plugin_keys {
        plugins.remove(plugin_key);
    }
    if state_changed {
        write_json_config(
            &installed_state_path,
            &installed_state,
            "Claude installed_plugins.json",
        )?;
    }

    let settings_path = home_dir.join(".claude/settings.json");
    for plugin_key in removed_plugin_keys {
        remove_claude_enabled_plugin_entry(&settings_path, &plugin_key)?;
    }
    Ok(())
}

fn collect_broken_managed_plugin_links(
    root: &Path,
    package_root: &Path,
    depth: usize,
    links: &mut BTreeMap<String, PathBuf>,
) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            if path_resolves_into_broken_package(&path, package_root) {
                links.insert(path_to_string(&path), path);
            }
        } else if metadata.is_dir() {
            collect_broken_managed_plugin_links(&path, package_root, depth + 1, links);
        }
    }
}

fn path_resolves_into_broken_package(path: &Path, package_root: &Path) -> bool {
    path_resolves_into_broken_package_at_depth(path, package_root, 0)
}

fn path_resolves_into_broken_package_at_depth(
    path: &Path,
    package_root: &Path,
    depth: usize,
) -> bool {
    if depth > 16 {
        return false;
    }
    let normalized_path = normalize_lexical_path(path);
    if normalized_path.starts_with(package_root) {
        return true;
    }

    let mut candidate = Some(normalized_path.as_path());
    while let Some(prefix) = candidate {
        if let Ok(link_target) = fs::read_link(prefix) {
            let remaining_path = normalized_path
                .strip_prefix(prefix)
                .unwrap_or(Path::new(""));
            let target_parent = prefix.parent().unwrap_or(Path::new(""));
            let mut resolved_path = if link_target.is_absolute() {
                link_target
            } else {
                target_parent.join(link_target)
            };
            resolved_path.push(remaining_path);
            return path_resolves_into_broken_package_at_depth(
                &resolved_path,
                package_root,
                depth + 1,
            );
        }
        candidate = prefix.parent();
    }
    false
}

fn normalize_lexical_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    normalized
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
    Ok(build_plugin_component_preview(
        &root,
        &component_id,
        asset_type,
        &preview_path,
        content,
    ))
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
    Ok(build_plugin_component_preview(
        &root,
        &component_id,
        asset_type,
        &preview_path,
        content,
    ))
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

    Ok(Some(build_virtual_plugin_component_preview(
        &format!("{config_relative_path}/{server_name}"),
        &server_name,
        asset_type,
        preview_content,
    )))
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

    Ok(Some(build_virtual_plugin_component_preview(
        &format!("{config_relative_path}/{server_name}"),
        &server_name,
        asset_type,
        preview_content,
    )))
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

        let source_metadata =
            read_skilldock_plugin_source_metadata_with_package_fallback(&plugin_root);
        let source_type =
            resolve_plugin_source_type(&plugin_root, source_metadata.as_ref(), "marketplace");
        let source_url = read_plugin_manifest(&manifest_path)
            .ok()
            .map(|manifest| source_url_from_manifest(&manifest))
            .unwrap_or_default();
        let display_root =
            codex_plugin_display_root(&home_dir, marketplace_name, plugin_name, &plugin_root);

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

        if let Some(summary) = build_installed_plugin_summary(
            InstalledPluginDescriptor {
                host_tool: "codex".to_string(),
                root: plugin_root.clone(),
                display_root,
                manifest_path,
                repo_root_override: None,
                plugin_relative_path_override: None,
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
            },
            scan_mode,
        ) {
            installed_roots.insert(summary.root_path.clone());
            if let Some(cache_plugin_root) =
                find_codex_cached_plugin_root(&cache_root, marketplace_name, plugin_name)
            {
                let cache_plugin_root =
                    canonicalize_existing_dir(&cache_plugin_root).unwrap_or(cache_plugin_root);
                installed_roots.insert(path_to_string(&cache_plugin_root));
            }
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

fn codex_plugin_display_root(
    home_dir: &Path,
    marketplace_name: &str,
    plugin_name: &str,
    plugin_root: &Path,
) -> PathBuf {
    if marketplace_name == "skilldock" {
        let cache_plugin_root = home_dir
            .join(".codex/plugins/cache")
            .join(marketplace_name)
            .join(plugin_name);
        if fs::symlink_metadata(&cache_plugin_root).is_ok() {
            return cache_plugin_root;
        }
    }
    plugin_root.to_path_buf()
}

fn codex_cached_plugin_display_root(
    home_dir: &Path,
    marketplace_name: &str,
    plugin_root: &Path,
) -> PathBuf {
    if marketplace_name != "skilldock" {
        return plugin_root.to_path_buf();
    }

    let cache_marketplace_root = home_dir.join(".codex/plugins/cache").join(marketplace_name);
    let normalized_cache_marketplace_root =
        canonicalize_existing_dir(&cache_marketplace_root).unwrap_or(cache_marketplace_root);
    let normalized_plugin_root =
        canonicalize_existing_dir(plugin_root).unwrap_or_else(|_| plugin_root.to_path_buf());
    let Ok(relative_path) = normalized_plugin_root.strip_prefix(&normalized_cache_marketplace_root)
    else {
        return plugin_root.to_path_buf();
    };
    let Some(first_component) = relative_path.components().next() else {
        return plugin_root.to_path_buf();
    };
    let display_root = normalized_cache_marketplace_root.join(first_component.as_os_str());
    if fs::symlink_metadata(&display_root).is_ok() {
        display_root
    } else {
        plugin_root.to_path_buf()
    }
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
        if install_state == "detected" {
            continue;
        }
        let source_metadata =
            read_skilldock_plugin_source_metadata_with_package_fallback(&canonical_root);
        let source_type =
            resolve_plugin_source_type(&canonical_root, source_metadata.as_ref(), "marketplace");
        let source_url = source_metadata
            .as_ref()
            .and_then(|metadata| non_empty_trimmed_string(&metadata.source_url))
            .unwrap_or_else(|| {
                read_plugin_manifest(&manifest_path)
                    .ok()
                    .map(|manifest| source_url_from_manifest(&manifest))
                    .unwrap_or_default()
            });
        let display_root =
            codex_cached_plugin_display_root(home_dir, &source_label, &canonical_root);

        if let Some(summary) = build_installed_plugin_summary(
            InstalledPluginDescriptor {
                host_tool: "codex".to_string(),
                root: canonical_root,
                display_root,
                manifest_path,
                repo_root_override: None,
                plugin_relative_path_override: None,
                source_type,
                source_label,
                source_url,
                source_ref: source_metadata
                    .as_ref()
                    .and_then(|metadata| non_empty_trimmed_string(&metadata.source_ref))
                    .unwrap_or_default(),
                source_revision: source_metadata
                    .as_ref()
                    .and_then(|metadata| non_empty_trimmed_string(&metadata.source_revision))
                    .unwrap_or_default(),
                current_version: String::new(),
                current_commit: String::new(),
                installed_at: String::new(),
                updated_at: String::new(),
                install_state,
                install_source: if source_metadata.is_some() {
                    "skilldock".to_string()
                } else {
                    "host".to_string()
                },
                scopes,
            },
            scan_mode,
        ) {
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
                    build_installed_plugin_summary(
                        InstalledPluginDescriptor {
                            host_tool: "claude-code".to_string(),
                            root: plugin_root.clone(),
                            display_root: PathBuf::from(&install_entry.install_path),
                            manifest_path,
                            repo_root_override: None,
                            plugin_relative_path_override: None,
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
                        },
                        scan_mode,
                    )
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
        manifest_name: plugin_name.to_string(),
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
        local_modified_source: String::new(),
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

        if let Some(summary) = build_installed_plugin_summary(
            InstalledPluginDescriptor {
                host_tool: "claude-code".to_string(),
                root: plugin_root.clone(),
                display_root: plugin_root,
                manifest_path,
                repo_root_override: None,
                plugin_relative_path_override: None,
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
            },
            scan_mode,
        ) {
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

    let mut enabled_plugin_roots = Vec::new();
    collect_cursor_plugin_roots(
        &home_dir.join(".cursor/plugins/local"),
        0,
        &mut enabled_plugin_roots,
    );
    let mut disabled_plugin_roots = Vec::new();
    collect_cursor_plugin_roots(
        &cursor_disabled_plugins_root(&home_dir),
        0,
        &mut disabled_plugin_roots,
    );
    let plugin_roots = enabled_plugin_roots
        .into_iter()
        .map(|root| (root, "enabled"))
        .chain(
            disabled_plugin_roots
                .into_iter()
                .map(|root| (root, "disabled")),
        );

    let mut installed = Vec::new();
    let mut seen_roots = BTreeSet::new();
    for (plugin_root, enabled_state) in plugin_roots {
        let Ok(canonical_root) = canonicalize_existing_dir(&plugin_root) else {
            continue;
        };
        let root_key = path_to_string(&canonical_root);
        if !seen_roots.insert(root_key) {
            continue;
        }

        let manifest_path = canonical_root.join(CURSOR_PLUGIN_MANIFEST);
        let cursor_git_root = find_git_root(&canonical_root)
            .filter(|root| is_under_cursor_plugin_storage(&home_dir, root))
            .filter(|root| !is_synthetic_cursor_git_repo(root));
        let local_git_plugin_relative_path = cursor_git_root.as_ref().and_then(|repo_root| {
            read_plugin_package_identity(&canonical_root)
                .or_else(|| read_plugin_package_identity(repo_root))
                .map(|identity| PathBuf::from(identity.plugin_relative_path))
        });
        let managed_plugin_root = if cursor_git_root.is_some() {
            None
        } else {
            managed_plugin_root_for_cursor_plugin_path(&canonical_root).filter(|path| path.is_dir())
        };
        let managed_plugin_relative_path = managed_plugin_root.as_ref().and_then(|root| {
            read_plugin_package_identity(&canonical_root)
                .or_else(|| read_plugin_package_identity(root))
                .map(|identity| PathBuf::from(identity.plugin_relative_path))
                .or_else(|| {
                    managed_plugin_package_root_for_path(root)
                        .and_then(|package_root| root.strip_prefix(package_root).ok())
                        .map(Path::to_path_buf)
                })
        });
        let source_metadata =
            read_skilldock_plugin_source_metadata(&canonical_root).or_else(|| {
                managed_plugin_root
                    .as_ref()
                    .and_then(|root| read_skilldock_plugin_source_metadata(root))
            });
        let source_type = resolve_plugin_source_type(
            &canonical_root,
            source_metadata.as_ref(),
            if is_under_cursor_plugin_storage(&home_dir, &canonical_root) {
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

        if let Some(summary) = build_installed_plugin_summary(
            InstalledPluginDescriptor {
                host_tool: "cursor".to_string(),
                root: canonical_root.clone(),
                display_root: plugin_root,
                manifest_path: manifest_path.clone(),
                repo_root_override: managed_plugin_root
                    .as_ref()
                    .and_then(|root| managed_plugin_package_root_for_path(root)),
                plugin_relative_path_override: local_git_plugin_relative_path
                    .or(managed_plugin_relative_path),
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
                    enabled_state,
                    &manifest_path,
                )],
            },
            scan_mode,
        ) {
            installed.push(summary);
        }
    }

    installed
}

fn opencode_managed_plugin_root_for_link(home_dir: &Path, link_path: &Path) -> Option<PathBuf> {
    let source_path = opencode_link_source(link_path)?;
    let plugin_root = opencode_plugin_root_from_entry_path(&source_path)?;
    let canonical_plugin_root = canonicalize_existing_dir(&plugin_root).ok()?;
    managed_plugin_package_root_for_path(&canonical_plugin_root)?;
    let expected_links = opencode_expected_links(home_dir, &canonical_plugin_root).ok()?;
    expected_links
        .iter()
        .any(|(source, target)| target == link_path && opencode_link_points_to(link_path, source))
        .then_some(canonical_plugin_root)
}

fn scan_opencode_installed_plugins(scan_mode: PluginScanMode) -> Vec<PluginSummary> {
    let Some(home_dir) = workspace::home_dir_option() else {
        return Vec::new();
    };
    let mut plugin_states = BTreeMap::<PathBuf, &'static str>::new();
    if let Ok(entries) = fs::read_dir(opencode_user_plugins_root(&home_dir)) {
        for entry in entries.flatten() {
            let link_path = entry.path();
            let is_symlink = fs::symlink_metadata(&link_path)
                .map(|metadata| metadata.file_type().is_symlink())
                .unwrap_or(false);
            if !is_symlink {
                continue;
            }
            if let Some(plugin_root) = opencode_managed_plugin_root_for_link(&home_dir, &link_path)
            {
                plugin_states.insert(plugin_root, "enabled");
            }
        }
    }

    let managed_root = workspace::managed_workspace_root()
        .ok()
        .map(|root| root.join(PLUGIN_PACKAGE_DIR));
    if let (Some(managed_root), Ok(entries)) = (
        managed_root,
        fs::read_dir(opencode_disabled_plugins_root(&home_dir)),
    ) {
        for entry in entries.flatten() {
            let marker = entry.path();
            if !marker.is_dir() {
                continue;
            }
            let package_root = managed_root.join(entry.file_name());
            if !package_root.is_dir() {
                continue;
            }
            let plugin_root = managed_plugin_root_from_package_root(&package_root);
            if first_opencode_plugin_entry(&plugin_root).is_some() {
                plugin_states.entry(plugin_root).or_insert("disabled");
            }
        }
    }

    plugin_states
        .into_iter()
        .filter_map(|(plugin_root, enabled_state)| {
            build_opencode_plugin_summary(&home_dir, &plugin_root, enabled_state, scan_mode)
        })
        .collect()
}

fn set_opencode_plugin_enabled(root_path: &str, enabled: bool) -> Result<PluginSummary, String> {
    let home_dir = workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let plugin_root = canonicalize_existing_dir(Path::new(root_path))?;
    ensure_plugin_manifest_for_host("opencode", &plugin_root)?;
    if enabled {
        ensure_opencode_links_enabled(&home_dir, &plugin_root)?;
    } else {
        ensure_opencode_links_disabled(&home_dir, &plugin_root)?;
    }
    find_plugin_after_enabled_change("opencode", &plugin_root)
}

fn delete_opencode_plugin(root_path: &str) -> Result<(), String> {
    let home_dir = workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let plugin_root = canonicalize_existing_dir(Path::new(root_path))?;
    ensure_plugin_manifest_for_host("opencode", &plugin_root)?;
    let package_root = managed_plugin_package_root_for_path(&plugin_root)
        .ok_or_else(|| "OpenCode 插件源必须位于 SkillDock 托管目录".to_string())?;
    remove_opencode_installation(&home_dir, &plugin_root)?;
    if !managed_package_has_other_host_installations(&package_root, "opencode") {
        remove_path(&package_root)?;
    }
    Ok(())
}

fn set_cursor_plugin_enabled(root_path: &str, enabled: bool) -> Result<PluginSummary, String> {
    let home_dir = workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let home_dir = canonicalize_existing_dir(&home_dir).unwrap_or(home_dir);
    let target_root = canonicalize_existing_dir(Path::new(root_path))?;
    ensure_plugin_manifest_for_host("cursor", &target_root)?;

    let active_install_root = cursor_local_install_root_for_path(&home_dir, &target_root);
    let disabled_install_root = cursor_disabled_install_root_for_path(&home_dir, &target_root);
    if (enabled && active_install_root.is_some()) || (!enabled && disabled_install_root.is_some()) {
        return find_cursor_plugin_summary(&target_root);
    }

    let source_install_root = if enabled {
        disabled_install_root
    } else {
        active_install_root
    }
    .ok_or_else(|| "Cursor 插件不在 SkillDock 可管理的本地插件目录中".to_string())?;
    ensure_single_cursor_plugin_install(&source_install_root)?;

    let plugin_relative_path = target_root
        .strip_prefix(&source_install_root)
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let install_name = source_install_root
        .file_name()
        .ok_or_else(|| "Cursor 插件安装目录无效".to_string())?;
    let destination_parent = if enabled {
        home_dir.join(".cursor/plugins/local")
    } else {
        cursor_disabled_plugins_root(&home_dir)
    };
    let destination_install_root = destination_parent.join(install_name);
    if destination_install_root.exists() || fs::symlink_metadata(&destination_install_root).is_ok()
    {
        return Err(format!(
            "Cursor 插件目标目录已存在，无法{}: {}",
            if enabled { "启用" } else { "停用" },
            destination_install_root.display()
        ));
    }

    fs::create_dir_all(&destination_parent).map_err(|error| {
        format!(
            "创建 Cursor 插件状态目录失败（{}）: {error}",
            destination_parent.display()
        )
    })?;
    fs::rename(&source_install_root, &destination_install_root).map_err(|error| {
        format!(
            "移动 Cursor 插件目录失败（{} -> {}）: {error}",
            source_install_root.display(),
            destination_install_root.display()
        )
    })?;

    let destination_plugin_root = destination_install_root.join(plugin_relative_path);
    let updated_plugin = canonicalize_existing_dir(&destination_plugin_root)
        .and_then(|plugin_root| find_cursor_plugin_summary(&plugin_root));
    match updated_plugin {
        Ok(plugin) => Ok(plugin),
        Err(error) => {
            let rollback_result = fs::rename(&destination_install_root, &source_install_root);
            match rollback_result {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(format!(
                    "{error}；回滚 Cursor 插件目录失败（{} -> {}）: {rollback_error}",
                    destination_install_root.display(),
                    source_install_root.display()
                )),
            }
        }
    }
}

fn find_cursor_plugin_summary(plugin_root: &Path) -> Result<PluginSummary, String> {
    let root_path = path_to_string(plugin_root);
    list_installed_plugins_blocking_with_mode(PluginScanMode::Local)?
        .into_iter()
        .find(|plugin| plugin.host_tool == "cursor" && plugin.root_path == root_path)
        .ok_or_else(|| "切换后未能重新识别 Cursor 插件".to_string())
}

fn ensure_single_cursor_plugin_install(install_root: &Path) -> Result<(), String> {
    let mut plugin_roots = Vec::new();
    collect_cursor_plugin_roots(install_root, 0, &mut plugin_roots);
    if plugin_roots.len() > 1 {
        return Err("Cursor 插件安装目录包含多个插件，暂不支持单独切换".to_string());
    }
    Ok(())
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
    build_codex_plugin_summary_after_enabled_change(
        &home_dir,
        &config,
        &plugin_key,
        &target_root,
        enabled,
    )
}

fn delete_codex_plugin(root_path: &str) -> Result<(), String> {
    let home_dir = workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let config_path = home_dir.join(".codex/config.toml");
    let requested_root = PathBuf::from(root_path);
    let target_root = canonicalize_existing_dir(Path::new(root_path))?;
    ensure_plugin_manifest_for_host("codex", &target_root)?;
    let managed_package_root = managed_plugin_package_root_for_requested_path(&requested_root)
        .or_else(|| managed_plugin_package_root_for_path(&target_root))
        .or_else(|| managed_plugin_package_root_from_identity(&target_root))
        .or_else(|| managed_plugin_package_root_from_source_metadata(&target_root));
    let should_remove_managed_package = managed_package_root.as_ref().is_some_and(|package_root| {
        !managed_package_has_other_host_installations(package_root, "codex")
    });
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
    let requested_root_is_managed_package_path = managed_package_root
        .as_ref()
        .is_some_and(|package_root| requested_root.strip_prefix(package_root).is_ok());
    if should_delete_codex_physical_root(&home_dir, &target_root)
        && (!requested_root_is_managed_package_path || should_remove_managed_package)
    {
        roots_to_remove.insert(path_to_string(&requested_root), requested_root.clone());
    }
    if should_remove_managed_package {
        if let Some(ref package_root) = managed_package_root {
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
                if marketplace_name == "skilldock" {
                    if let Some(marketplace_config) = config.marketplaces.get(&marketplace_name) {
                        if let Some(marketplace_plugin_root) = resolve_configured_codex_plugin_root(
                            &cache_root,
                            &marketplace_name,
                            marketplace_config,
                            &plugin_name,
                        ) {
                            roots_to_remove.insert(
                                path_to_string(&marketplace_plugin_root),
                                marketplace_plugin_root,
                            );
                        }
                    }
                }
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

fn managed_plugin_package_root_for_requested_path(path: &Path) -> Option<PathBuf> {
    let managed_plugins_root = workspace::managed_workspace_root()
        .ok()?
        .join(PLUGIN_PACKAGE_DIR);
    let normalized_path = normalize_lexical_path(path);
    let normalized_managed_root = normalize_lexical_path(&managed_plugins_root);
    if let Ok(relative_path) = normalized_path.strip_prefix(&normalized_managed_root) {
        let package_name = relative_path.components().next()?.as_os_str();
        return Some(normalized_managed_root.join(package_name));
    }
    let canonical_managed_root = canonicalize_existing_dir(&managed_plugins_root).ok()?;
    let relative_path = path.strip_prefix(&canonical_managed_root).ok()?;
    let package_name = relative_path.components().next()?.as_os_str();
    Some(canonical_managed_root.join(package_name))
}

fn managed_plugin_package_root_from_identity(path: &Path) -> Option<PathBuf> {
    let identity = read_plugin_package_identity(path)?;
    let package_parent = workspace::managed_workspace_root()
        .ok()?
        .join(PLUGIN_PACKAGE_DIR);
    let entries = fs::read_dir(&package_parent).ok()?;
    for entry in entries.flatten() {
        let candidate_root = entry.path();
        if read_plugin_package_identity(&candidate_root).as_ref() == Some(&identity) {
            return Some(candidate_root);
        }
    }
    None
}

fn managed_plugin_package_root_from_source_metadata(path: &Path) -> Option<PathBuf> {
    let metadata = read_skilldock_plugin_source_metadata(path)?;
    let normalized_source = normalize_plugin_package_source(&metadata.source_url);
    let package_parent = workspace::managed_workspace_root()
        .ok()?
        .join(PLUGIN_PACKAGE_DIR);
    let entries = fs::read_dir(&package_parent).ok()?;

    for entry in entries.flatten() {
        let candidate_root = entry.path();
        let Some(identity) = read_plugin_package_identity(&candidate_root) else {
            continue;
        };
        if normalize_plugin_package_source(&identity.source) == normalized_source {
            return Some(candidate_root);
        }
    }
    None
}

fn managed_plugin_package_root_from_cursor_manifest(path: &Path) -> Option<PathBuf> {
    let manifest = read_plugin_manifest(&path.join(CURSOR_PLUGIN_MANIFEST)).ok()?;
    let normalized_source = normalize_plugin_package_source(&source_url_from_manifest(&manifest));
    let package_parent = workspace::managed_workspace_root()
        .ok()?
        .join(PLUGIN_PACKAGE_DIR);
    let entries = fs::read_dir(&package_parent).ok()?;
    let manifest_name = manifest.name.trim().to_string();
    let display_name = plugin_display_name(&manifest, path);

    for entry in entries.flatten() {
        let candidate_root = entry.path();
        let identity = read_plugin_package_identity(&candidate_root);
        if !normalized_source.is_empty()
            && identity.as_ref().is_some_and(|identity| {
                normalize_plugin_package_source(&identity.source) == normalized_source
            })
        {
            return Some(candidate_root);
        }

        if contains_plugin_manifest(&candidate_root)
            && plugin_package_contains_cursor_plugin(
                &candidate_root,
                &manifest_name,
                &display_name,
                &normalized_source,
            )
        {
            return Some(candidate_root);
        }
    }

    None
}

fn managed_plugin_root_for_cursor_plugin_path(path: &Path) -> Option<PathBuf> {
    let package_root = managed_plugin_package_root_for_requested_path(path)
        .or_else(|| managed_plugin_package_root_for_path(path))
        .or_else(|| managed_plugin_package_root_from_identity(path))
        .or_else(|| managed_plugin_package_root_from_source_metadata(path))
        .or_else(|| managed_plugin_package_root_from_cursor_manifest(path))?;
    let identity = read_plugin_package_identity(path)
        .or_else(|| read_plugin_package_identity(&package_root))
        .unwrap_or_else(|| {
            managed_plugin_package_identity(&path_to_string(&package_root), Path::new(""))
        });
    let relative_path = PathBuf::from(identity.plugin_relative_path);
    if relative_path.as_os_str().is_empty() {
        Some(package_root)
    } else {
        Some(package_root.join(relative_path))
    }
}

fn plugin_package_contains_cursor_plugin(
    root: &Path,
    manifest_name: &str,
    display_name: &str,
    normalized_source: &str,
) -> bool {
    let manifest_path = root.join(CURSOR_PLUGIN_MANIFEST);
    if manifest_path.is_file() {
        if let Ok(candidate_manifest) = read_plugin_manifest(&manifest_path) {
            if plugin_name_matches(manifest_name, &candidate_manifest.name)
                || plugin_name_matches(
                    display_name,
                    &plugin_display_name(&candidate_manifest, root),
                )
            {
                return true;
            }

            if !normalized_source.is_empty()
                && normalize_plugin_package_source(&source_url_from_manifest(&candidate_manifest))
                    == normalized_source
            {
                return true;
            }
        }
    }

    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };

    entries.flatten().any(|entry| {
        let path = entry.path();
        path.is_dir()
            && plugin_package_contains_cursor_plugin(
                &path,
                manifest_name,
                display_name,
                normalized_source,
            )
    })
}

fn opencode_has_plugin_from_package(managed_package_root: &Path) -> bool {
    scan_opencode_installed_plugins(PluginScanMode::Local)
        .into_iter()
        .any(|plugin| {
            managed_plugin_package_root_for_path(Path::new(&plugin.root_path)).is_some_and(
                |package_root| paths_refer_to_same_dir(&package_root, managed_package_root),
            )
        })
}

fn managed_package_has_other_host_installations(
    managed_package_root: &Path,
    deleting_host_tool: &str,
) -> bool {
    let Some(home_dir) = workspace::home_dir_option() else {
        return false;
    };

    let home_dir = canonicalize_existing_dir(&home_dir).unwrap_or(home_dir);
    let host_roots = [
        ("cursor", home_dir.join(".cursor/plugins/local")),
        ("cursor", cursor_disabled_plugins_root(&home_dir)),
        ("claude-code", home_dir.join(".claude/plugins")),
        ("codex", home_dir.join(".codex/plugins/cache")),
        ("codex", home_dir.join(".codex/marketplaces")),
    ];

    host_roots.iter().any(|(host_tool, host_root)| {
        if *host_tool == deleting_host_tool || !host_root.exists() {
            return false;
        }

        path_contains_plugin_from_package(host_root, managed_package_root)
    }) || (deleting_host_tool != "opencode"
        && opencode_has_plugin_from_package(managed_package_root))
}

fn path_contains_plugin_from_package(root: &Path, managed_package_root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };

    for entry in entries.flatten() {
        let candidate_path = entry.path();
        if !candidate_path.is_dir() {
            continue;
        }

        if managed_plugin_package_root_for_path(&candidate_path)
            .or_else(|| managed_plugin_package_root_from_identity(&candidate_path))
            .or_else(|| managed_plugin_package_root_from_source_metadata(&candidate_path))
            .is_some_and(|package_root| {
                paths_refer_to_same_dir(&package_root, managed_package_root)
            })
        {
            return true;
        }

        if path_contains_plugin_from_package(&candidate_path, managed_package_root) {
            return true;
        }
    }

    false
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
        None,
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

    build_claude_plugin_summary_after_enabled_change(
        &home_dir,
        &installed_state,
        &settings_path,
        &target_root,
        enabled,
    )
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
    let managed_package_root = managed_plugin_package_root_for_requested_path(&requested_root)
        .or_else(|| managed_plugin_package_root_for_path(&target_root))
        .or_else(|| managed_plugin_package_root_from_identity(&target_root))
        .or_else(|| managed_plugin_package_root_from_source_metadata(&target_root));
    let should_remove_managed_package = managed_package_root.as_ref().is_some_and(|package_root| {
        !managed_package_has_other_host_installations(package_root, "claude-code")
    });
    let mut roots_to_remove = BTreeMap::<String, PathBuf>::new();
    let requested_root_is_managed_package_path =
        managed_package_root.as_ref().is_some_and(|package_root| {
            requested_root.strip_prefix(package_root).is_ok()
                || target_root.strip_prefix(package_root).is_ok()
        });
    if !requested_root_is_managed_package_path || requested_root != target_root {
        roots_to_remove.insert(path_to_string(&requested_root), requested_root.clone());
    }
    if should_remove_managed_package {
        if let Some(ref package_root) = managed_package_root {
            insert_managed_plugin_package_roots_to_remove(&mut roots_to_remove, package_root);
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
    let managed_package_root = managed_plugin_package_root_for_requested_path(&requested_root)
        .or_else(|| managed_plugin_package_root_for_path(&target_root))
        .or_else(|| managed_plugin_package_root_from_identity(&target_root))
        .or_else(|| managed_plugin_package_root_from_source_metadata(&target_root))
        .or_else(|| managed_plugin_package_root_from_cursor_manifest(&target_root));
    let should_remove_managed_package = managed_package_root.as_ref().is_some_and(|package_root| {
        !managed_package_has_other_host_installations(package_root, "cursor")
    });
    let mut roots_to_remove = BTreeMap::<String, PathBuf>::new();
    roots_to_remove.insert(path_to_string(&requested_root), requested_root.clone());
    if requested_root != target_root {
        roots_to_remove.insert(path_to_string(&target_root), target_root.clone());
    }
    if let Some(home_dir) = workspace::home_dir_option() {
        if let Some(local_install_root) =
            cursor_local_install_root_for_path(&home_dir, &target_root)
        {
            roots_to_remove.insert(path_to_string(&local_install_root), local_install_root);
        }
        if let Some(disabled_install_root) =
            cursor_disabled_install_root_for_path(&home_dir, &target_root)
        {
            roots_to_remove.insert(
                path_to_string(&disabled_install_root),
                disabled_install_root,
            );
        }
    }
    if should_remove_managed_package {
        if let Some(ref package_root) = managed_package_root {
            insert_managed_plugin_package_roots_to_remove(&mut roots_to_remove, package_root);
        }
    }
    if let Some(home_dir) = workspace::home_dir_option() {
        for root in collect_cursor_plugin_roots_for_target(
            &home_dir,
            &target_root,
            managed_package_root.as_deref(),
        ) {
            roots_to_remove.insert(path_to_string(&root), root);
        }
    }
    remove_plugin_roots(roots_to_remove.into_values(), "Cursor")
}

fn cursor_local_install_root_for_path(home_dir: &Path, path: &Path) -> Option<PathBuf> {
    let cursor_root = home_dir.join(".cursor/plugins/local");
    cursor_install_root_for_path(&cursor_root, path)
        .or_else(|| cursor_install_root_for_target(&cursor_root, path))
}

fn cursor_disabled_install_root_for_path(home_dir: &Path, path: &Path) -> Option<PathBuf> {
    let cursor_root = cursor_disabled_plugins_root(home_dir);
    cursor_install_root_for_path(&cursor_root, path)
        .or_else(|| cursor_install_root_for_target(&cursor_root, path))
}

fn cursor_install_root_for_path(cursor_root: &Path, path: &Path) -> Option<PathBuf> {
    let relative_path = path.strip_prefix(&cursor_root).ok()?;
    let install_name = relative_path.components().next()?.as_os_str();
    Some(cursor_root.join(install_name))
}

fn cursor_install_root_for_target(cursor_root: &Path, target_root: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(cursor_root).ok()?;
    for entry in entries.flatten() {
        let install_root = entry.path();
        let Ok(canonical_install_root) = canonicalize_existing_dir(&install_root) else {
            continue;
        };
        if target_root.strip_prefix(&canonical_install_root).is_ok() {
            return Some(install_root);
        }
    }
    None
}

fn collect_cursor_plugin_roots_for_target(
    home_dir: &Path,
    target_root: &Path,
    managed_package_root: Option<&Path>,
) -> Vec<PathBuf> {
    let cursor_root = home_dir.join(".cursor/plugins/local");
    let mut roots = Vec::new();
    let Ok(entries) = fs::read_dir(cursor_root) else {
        return roots;
    };
    for entry in entries.flatten() {
        let candidate_root = entry.path();
        if cursor_plugin_matches_target(&candidate_root, target_root, managed_package_root) {
            roots.push(candidate_root);
        }
    }
    roots
}

fn cursor_plugin_matches_target(
    candidate_root: &Path,
    target_root: &Path,
    managed_package_root: Option<&Path>,
) -> bool {
    if paths_refer_to_same_dir(candidate_root, target_root) {
        return true;
    }

    if managed_package_root.is_some_and(|package_root| {
        managed_plugin_package_root_for_path(candidate_root)
            .or_else(|| managed_plugin_package_root_from_identity(candidate_root))
            .or_else(|| managed_plugin_package_root_from_source_metadata(candidate_root))
            .is_some_and(|candidate_package_root| {
                paths_refer_to_same_dir(&candidate_package_root, package_root)
            })
    }) {
        return true;
    }

    let candidate_identity = read_plugin_package_identity(candidate_root);
    let target_identity = read_plugin_package_identity(target_root);
    if candidate_identity.is_some() && candidate_identity == target_identity {
        return true;
    }

    let candidate_metadata = read_skilldock_plugin_source_metadata(candidate_root);
    let target_metadata = read_skilldock_plugin_source_metadata(target_root);
    if let (Some(candidate_metadata), Some(target_metadata)) =
        (&candidate_metadata, &target_metadata)
    {
        let candidate_source = normalize_plugin_package_source(&candidate_metadata.source_url);
        let target_source = normalize_plugin_package_source(&target_metadata.source_url);
        if !candidate_source.is_empty() && candidate_source == target_source {
            return true;
        }
    }

    let candidate_manifest_path = candidate_root.join(CURSOR_PLUGIN_MANIFEST);
    let target_manifest_path = target_root.join(CURSOR_PLUGIN_MANIFEST);
    let candidate_manifest = read_plugin_manifest(&candidate_manifest_path).ok();
    let target_manifest = read_plugin_manifest(&target_manifest_path).ok();
    match (candidate_manifest, target_manifest) {
        (Some(candidate_manifest), Some(target_manifest)) => {
            plugin_name_matches(&candidate_manifest.name, &target_manifest.name)
                || plugin_name_matches(
                    &plugin_display_name(&candidate_manifest, candidate_root),
                    &plugin_display_name(&target_manifest, target_root),
                )
        }
        _ => false,
    }
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

fn build_codex_plugin_summary_after_enabled_change(
    home_dir: &Path,
    config: &CodexConfigFile,
    plugin_key: &str,
    target_root: &Path,
    enabled: bool,
) -> Result<PluginSummary, String> {
    let cache_root = home_dir.join(".codex/plugins/cache");
    let (plugin_name, marketplace_name) = split_enabled_plugin_key(plugin_key)
        .ok_or_else(|| format!("无法解析 Codex 插件键: {plugin_key}"))?;
    let marketplace_config = config
        .marketplaces
        .get(marketplace_name)
        .ok_or_else(|| format!("未找到 Codex marketplace 配置: {marketplace_name}"))?;
    let plugin_root = resolve_configured_codex_plugin_root(
        &cache_root,
        marketplace_name,
        marketplace_config,
        plugin_name,
    )
    .unwrap_or_else(|| target_root.to_path_buf());
    let manifest_path = plugin_root.join(CODEX_PLUGIN_MANIFEST);
    if !manifest_path.is_file() {
        return Err("插件启用状态已写入，但未找到对应的 Codex 插件清单".to_string());
    }

    let source_metadata = read_skilldock_plugin_source_metadata(&plugin_root);
    let source_type =
        resolve_plugin_source_type(&plugin_root, source_metadata.as_ref(), "marketplace");
    let source_url = read_plugin_manifest(&manifest_path)
        .ok()
        .map(|manifest| source_url_from_manifest(&manifest))
        .unwrap_or_default();
    let display_root =
        codex_plugin_display_root(home_dir, marketplace_name, plugin_name, &plugin_root);
    let enabled_state = if enabled { "enabled" } else { "disabled" };
    let scopes = vec![build_plugin_scope_summary(
        "user",
        "用户级",
        enabled_state,
        &home_dir.join(".codex/config.toml"),
    )];

    build_installed_plugin_summary(
        InstalledPluginDescriptor {
            host_tool: "codex".to_string(),
            root: plugin_root.clone(),
            display_root,
            manifest_path,
            repo_root_override: None,
            plugin_relative_path_override: None,
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
        },
        PluginScanMode::Local,
    )
    .ok_or_else(|| "插件启用状态已写入，但重建 Codex 插件摘要失败".to_string())
}

fn build_claude_plugin_summary_after_enabled_change(
    home_dir: &Path,
    installed_state: &ClaudeInstalledPluginsFile,
    settings_path: &Path,
    target_root: &Path,
    enabled: bool,
) -> Result<PluginSummary, String> {
    for (plugin_key, install_entries) in &installed_state.plugins {
        for install_entry in install_entries {
            if install_entry.install_path.trim().is_empty() {
                continue;
            }
            let Ok(plugin_root) = canonicalize_existing_dir(Path::new(&install_entry.install_path))
            else {
                continue;
            };
            if !paths_refer_to_same_dir(&plugin_root, target_root) {
                continue;
            }

            let manifest_path = plugin_root.join(CLAUDE_PLUGIN_MANIFEST);
            let enabled_state = if enabled { "enabled" } else { "disabled" };
            let scopes = vec![build_plugin_scope_summary(
                "user",
                "用户级",
                enabled_state,
                settings_path,
            )];
            let source_metadata = read_skilldock_plugin_source_metadata(&plugin_root);
            let source_type =
                resolve_plugin_source_type(&plugin_root, source_metadata.as_ref(), "marketplace");
            let source_label = plugin_key
                .rsplit_once('@')
                .map(|(_, marketplace_name)| marketplace_name.to_string())
                .unwrap_or_default();

            let summary = if manifest_path.is_file() {
                let source_url = read_plugin_manifest(&manifest_path)
                    .ok()
                    .map(|manifest| source_url_from_manifest(&manifest))
                    .unwrap_or_default();
                build_installed_plugin_summary(
                    InstalledPluginDescriptor {
                        host_tool: "claude-code".to_string(),
                        root: plugin_root.clone(),
                        display_root: PathBuf::from(&install_entry.install_path),
                        manifest_path,
                        repo_root_override: None,
                        plugin_relative_path_override: None,
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
                        current_version: install_entry.version.clone(),
                        current_commit: install_entry.git_commit_sha.clone(),
                        installed_at: install_entry.installed_at.clone(),
                        updated_at: install_entry.last_updated.clone(),
                        install_state: "installed".to_string(),
                        install_source: if source_metadata.is_some() {
                            "skilldock".to_string()
                        } else {
                            "host".to_string()
                        },
                        scopes,
                    },
                    PluginScanMode::Local,
                )
            } else {
                build_claude_marketplace_entry_summary(
                    home_dir,
                    &plugin_root,
                    plugin_key,
                    ClaudeInstalledPluginEntry {
                        install_path: install_entry.install_path.clone(),
                        version: install_entry.version.clone(),
                        installed_at: install_entry.installed_at.clone(),
                        last_updated: install_entry.last_updated.clone(),
                        git_commit_sha: install_entry.git_commit_sha.clone(),
                    },
                    scopes,
                )
            };

            return summary
                .ok_or_else(|| "插件启用状态已写入，但重建 Claude 插件摘要失败".to_string());
        }
    }

    Err("插件启用状态已写入，但未找到对应的 Claude 插件安装记录".to_string())
}

fn ensure_plugin_manifest_for_host(host_tool: &str, plugin_root: &Path) -> Result<(), String> {
    let manifest_path = plugin_manifest_path_for_host(host_tool, plugin_root)?;
    if manifest_path.is_file() {
        return Ok(());
    }

    Err(format!(
        "目录不是有效的 {host_tool} 插件目录: {}",
        workspace::display_path_value(&plugin_root.to_string_lossy())
    ))
}

fn plugin_manifest_path_for_host(host_tool: &str, plugin_root: &Path) -> Result<PathBuf, String> {
    match host_tool {
        "codex" => Ok(plugin_root.join(CODEX_PLUGIN_MANIFEST)),
        "claude-code" => Ok(plugin_root.join(CLAUDE_PLUGIN_MANIFEST)),
        "cursor" => Ok(plugin_root.join(CURSOR_PLUGIN_MANIFEST)),
        "opencode" => first_opencode_plugin_entry(plugin_root)
            .ok_or_else(|| format!("目录缺少 OpenCode 插件入口: {}", plugin_root.display())),
        _ => Err(format!("不支持的插件宿主: {host_tool}")),
    }
}

fn update_hash_plugin(host_tool: &str, target_root: &Path) -> Result<PluginSummary, String> {
    let plugin = find_plugin_after_enabled_change(host_tool, target_root)?;
    if plugin.update_strategy != "hash" {
        return Err("该插件当前不支持 hash 更新".to_string());
    }

    let update_root = if host_tool == "cursor" {
        managed_plugin_root_for_cursor_plugin_path(target_root)
            .unwrap_or_else(|| target_root.to_path_buf())
    } else {
        target_root.to_path_buf()
    };
    let updated = update_hash_plugin_root(host_tool, target_root, &plugin, &update_root)?;
    if host_tool == "cursor" && update_root != target_root {
        sync_cursor_local_git_copy(&update_root, target_root)?;
    }
    Ok(updated)
}

fn update_hash_plugin_root(
    host_tool: &str,
    target_root: &Path,
    plugin: &PluginSummary,
    update_root: &Path,
) -> Result<PluginSummary, String> {
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
    let (clone_url, source_ref, sparse_paths) = plugin_remote_clone_parts(
        &plugin.source_url,
        &plugin.source_ref,
        &plugin_relative_path,
    )?;
    let parent_dir = update_root
        .parent()
        .ok_or_else(|| "无法确定插件目录父路径".to_string())?;
    let temp_target = parent_dir.join(format!(
        ".skilldock-update-{}",
        short_stable_hash(&path_to_string(update_root))
    ));
    if temp_target.exists() || fs::symlink_metadata(&temp_target).is_ok() {
        remove_path(&temp_target)?;
    }
    with_temporary_discovery_repo_resolved(
        &clone_url,
        source_ref.as_deref(),
        &repo_key,
        &sparse_paths,
        None,
        |repo_root| {
            let remote_plugin_root = if plugin_relative_path.is_empty() {
                repo_root.to_path_buf()
            } else {
                repo_root.join(&plugin_relative_path)
            };
            if !remote_plugin_root.is_dir() {
                return Err(format!(
                    "远端插件目录不存在: {}",
                    remote_plugin_root.display()
                ));
            }

            let has_remote_plugin = match host_tool {
                "codex" => remote_plugin_root.join(CODEX_PLUGIN_MANIFEST).is_file(),
                "claude-code" => remote_plugin_root.join(CLAUDE_PLUGIN_MANIFEST).is_file(),
                "cursor" => remote_plugin_root.join(CURSOR_PLUGIN_MANIFEST).is_file(),
                "opencode" => first_opencode_plugin_entry(&remote_plugin_root).is_some(),
                _ => return Err(format!("不支持的插件宿主: {host_tool}")),
            };
            if !has_remote_plugin {
                return Err("远端插件目录缺少宿主 manifest，无法更新".to_string());
            }

            copy_dir_all(&remote_plugin_root, &temp_target, true)
        },
    )?;
    if update_root.exists() || fs::symlink_metadata(update_root).is_ok() {
        remove_path(update_root)?;
    }
    fs::rename(&temp_target, update_root).map_err(|error| {
        format!(
            "替换插件目录失败（{} -> {}）: {error}",
            temp_target.display(),
            update_root.display()
        )
    })?;

    let new_baseline_hash = compute_plugin_dir_hash(update_root)?;
    write_plugin_update_metadata(
        update_root,
        &SkillDockPluginUpdateMetadata {
            baseline_hash: new_baseline_hash,
        },
    )?;
    if host_tool == "opencode" {
        let home_dir =
            workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
        if plugin.enabled_state == "disabled" {
            ensure_opencode_links_disabled(&home_dir, target_root)?;
        } else {
            ensure_opencode_links_enabled(&home_dir, target_root)?;
        }
    }
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

    run_git_at(&repo_root, &["fetch", "origin", "--quiet", "--no-tags"])?;
    let remote_branch = format!("{REMOTE_BRANCH_PREFIX}{branch}");
    run_git_at(&repo_root, &["merge", "--ff-only", &remote_branch])?;
    Ok(())
}

fn install_plugin_probe_for_host(
    home_dir: &Path,
    source_root: &Path,
    package_root: &Path,
    probe: &PluginProbeResult,
    host_tool: &str,
) -> Result<PathBuf, String> {
    let install_root = resolve_install_root_for_host(source_root, package_root, probe, host_tool)?;
    match host_tool {
        "codex" => install_codex_plugin_probe(home_dir, &install_root, probe),
        "claude-code" => install_claude_plugin_probe(home_dir, &install_root, probe),
        "cursor" => install_cursor_plugin_probe(home_dir, &install_root, package_root, probe),
        "opencode" => install_opencode_plugin_probe(home_dir, &install_root, package_root, probe),
        _ => Err(format!("不支持的插件宿主: {host_tool}")),
    }
}

fn ensure_shared_plugin_package(
    probe: &PluginProbeResult,
    host_tools: &[String],
    on_progress: Option<&CloneProgressCallback>,
) -> Result<SharedPluginPackage, String> {
    let source_root = canonicalize_existing_dir(Path::new(&probe.plugin_root))
        .ok()
        .map(|root| resolve_effective_probe_plugin_root(probe, &root));
    let plugin_relative_path = plugin_relative_path_for_probe(
        probe,
        non_empty_trimmed_string(&probe.git_root)
            .as_deref()
            .map(Path::new),
        source_root
            .as_deref()
            .unwrap_or_else(|| Path::new(&probe.plugin_root)),
    );
    let preferred_package_name = source_root
        .as_deref()
        .and_then(|root| plugin_preferred_package_name(probe, root));

    if source_root.is_none() {
        if let Some(source_url) = non_empty_trimmed_string(&probe.source_url) {
            let source_spec = parse_market_source_url(&source_url)?;
            let package_id = resolve_shared_plugin_package_id(
                &source_spec.clone_url,
                &plugin_relative_path,
                preferred_package_name.as_deref(),
            )?;
            let repo_root = shared_plugin_package_repo_root(&package_id)?;
            let plugin_root = if plugin_relative_path.as_os_str().is_empty() {
                repo_root.clone()
            } else {
                repo_root.join(&plugin_relative_path)
            };
            ensure_shared_plugin_repo(
                &source_spec.clone_url,
                non_empty_trimmed_string(&probe.source_ref)
                    .as_deref()
                    .or(source_spec.branch.as_deref()),
                &repo_root,
                &plugin_relative_path,
                false,
                on_progress,
            )?;
            ensure_host_manifests_for_hosts(&plugin_root, probe, host_tools)?;
            return Ok(SharedPluginPackage { plugin_root });
        }
        return Err(format!(
            "插件目录不存在: {}",
            Path::new(&probe.plugin_root).display()
        ));
    }

    let source_root = source_root.expect("checked source root exists");
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
        let package_id = resolve_shared_plugin_package_id(
            identity_source,
            &plugin_relative_path,
            preferred_package_name.as_deref(),
        )?;
        let repo_root = shared_plugin_package_repo_root(&package_id)?;
        if is_managed_plugin_discovery_repo(git_root) {
            let source_spec = source_spec
                .as_ref()
                .ok_or_else(|| format!("无法解析插件缓存的远端来源: {identity_source}"))?;
            let source_ref =
                non_empty_trimmed_string(&probe.source_ref).or_else(|| source_spec.branch.clone());
            ensure_shared_plugin_repo(
                &source_spec.clone_url,
                source_ref.as_deref(),
                &repo_root,
                &plugin_relative_path,
                false,
                on_progress,
            )?;
        } else {
            ensure_shared_plugin_repo_from_existing(
                git_root,
                &repo_root,
                identity_source,
                &plugin_relative_path,
            )?;
        }
        cleanup_duplicate_plugin_package_roots(&repo_root, identity_source, &plugin_relative_path)?;
        let plugin_root = if plugin_relative_path.as_os_str().is_empty() {
            repo_root
        } else {
            repo_root.join(&plugin_relative_path)
        };
        ensure_host_manifests_for_hosts(&plugin_root, probe, host_tools)?;
        return Ok(SharedPluginPackage { plugin_root });
    }

    if let Some(source_url) = non_empty_trimmed_string(&probe.source_url) {
        if source_url.starts_with("http://")
            || source_url.starts_with("https://")
            || source_url.contains('@')
        {
            let source_spec = parse_market_source_url(&source_url)?;
            let package_id = resolve_shared_plugin_package_id(
                &source_spec.clone_url,
                &plugin_relative_path,
                preferred_package_name.as_deref(),
            )?;
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
                ensure_host_manifests_for_hosts(&plugin_root, probe, host_tools)?;
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
                false,
                on_progress,
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
            ensure_host_manifests_for_hosts(&plugin_root, probe, host_tools)?;
            return Ok(SharedPluginPackage { plugin_root });
        }
    }

    let package_id = resolve_shared_plugin_package_id(
        &path_to_string(&source_root),
        Path::new(""),
        preferred_package_name.as_deref(),
    )?;
    let repo_root = shared_plugin_package_repo_root(&package_id)?;
    copy_plugin_dir(&source_root, &repo_root)?;
    write_plugin_package_identity(&repo_root, &path_to_string(&source_root), Path::new(""))?;
    ensure_host_manifests_for_hosts(&repo_root, probe, host_tools)?;
    cleanup_duplicate_plugin_package_roots(
        &repo_root,
        &path_to_string(&source_root),
        Path::new(""),
    )?;
    Ok(SharedPluginPackage {
        plugin_root: repo_root,
    })
}

fn resolve_install_root_for_host(
    source_root: &Path,
    package_root: &Path,
    probe: &PluginProbeResult,
    host_tool: &str,
) -> Result<PathBuf, String> {
    if ensure_plugin_manifest_for_host(host_tool, source_root).is_ok() {
        return Ok(source_root.to_path_buf());
    }

    let effective_root = resolve_effective_probe_plugin_root(probe, source_root);
    if ensure_plugin_manifest_for_host(host_tool, &effective_root).is_ok() {
        return Ok(effective_root);
    }

    if let Some(candidate_root) =
        nearest_manifest_root_for_host(source_root, package_root, host_tool)
    {
        return Ok(candidate_root);
    }

    ensure_plugin_manifest_for_host(host_tool, source_root)?;
    Ok(source_root.to_path_buf())
}

fn resolve_effective_probe_plugin_root(probe: &PluginProbeResult, source_root: &Path) -> PathBuf {
    if contains_plugin_manifest(source_root) {
        return source_root.to_path_buf();
    }

    if let Some(manifest_root) = plugin_root_from_probe_manifest_path(probe) {
        if manifest_root.strip_prefix(source_root).is_ok()
            || source_root.strip_prefix(&manifest_root).is_ok()
        {
            return manifest_root;
        }
    }

    nearest_manifest_root_for_host(
        source_root,
        find_git_root(source_root).as_deref().unwrap_or(source_root),
        &probe.tool,
    )
    .unwrap_or_else(|| source_root.to_path_buf())
}

fn plugin_root_from_probe_manifest_path(probe: &PluginProbeResult) -> Option<PathBuf> {
    plugin_root_from_manifest_path(Path::new(&probe.manifest_path))
}

fn plugin_root_from_manifest_path(manifest_path: &Path) -> Option<PathBuf> {
    let canonical_manifest_path = fs::canonicalize(manifest_path).ok()?;
    if is_opencode_plugin_entry(&canonical_manifest_path) {
        let plugins_dir = canonical_manifest_path.parent()?;
        if plugins_dir.file_name().and_then(|value| value.to_str()) == Some("plugins")
            && plugins_dir
                .parent()
                .and_then(|path| path.file_name())
                .and_then(|value| value.to_str())
                == Some(".opencode")
        {
            return plugins_dir.parent()?.parent().map(Path::to_path_buf);
        }
    }
    if canonical_manifest_path
        .file_name()
        .and_then(|value| value.to_str())
        != Some("plugin.json")
    {
        return None;
    }

    let marker_dir = canonical_manifest_path.parent()?;
    let marker_name = marker_dir.file_name().and_then(|value| value.to_str())?;
    if !matches!(
        marker_name,
        ".claude-plugin" | ".cursor-plugin" | ".codex-plugin"
    ) {
        return None;
    }

    marker_dir.parent().map(Path::to_path_buf)
}

fn nearest_manifest_root_for_host(
    source_root: &Path,
    boundary_root: &Path,
    host_tool: &str,
) -> Option<PathBuf> {
    let boundary_root = canonicalize_existing_dir(boundary_root).ok()?;
    let mut current = canonicalize_existing_dir(source_root).ok()?;
    loop {
        if ensure_plugin_manifest_for_host(host_tool, &current).is_ok() {
            return Some(current);
        }
        if paths_refer_to_same_dir(&current, &boundary_root) {
            break;
        }
        current = current.parent()?.to_path_buf();
    }
    None
}

fn ensure_host_manifests_for_hosts(
    plugin_root: &Path,
    probe: &PluginProbeResult,
    host_tools: &[String],
) -> Result<(), String> {
    for host_tool in host_tools {
        if host_tool == "opencode" {
            ensure_plugin_manifest_for_host(host_tool, plugin_root)?;
            continue;
        }
        repair_host_manifest_copied_from_generic_manifest(plugin_root, host_tool)?;
        materialize_missing_host_manifest(plugin_root, host_tool, probe)?;
    }

    Ok(())
}

fn repair_host_manifest_copied_from_generic_manifest(
    plugin_root: &Path,
    host_tool: &str,
) -> Result<(), String> {
    let generic_manifest_path = plugin_root.join("plugin.json");
    if !generic_manifest_path.is_file()
        || !json_manifest_schema_contains(&generic_manifest_path, "antigravity.google")
    {
        return Ok(());
    }

    let host_manifest_path = plugin_manifest_path_for_host(host_tool, plugin_root)?;
    if !host_manifest_path.is_file()
        || !json_files_have_same_value(&host_manifest_path, &generic_manifest_path)?
    {
        return Ok(());
    }

    let Some(repo_root) = find_git_root(plugin_root) else {
        return Ok(());
    };
    let Ok(relative_manifest_path) = host_manifest_path.strip_prefix(&repo_root) else {
        return Ok(());
    };
    let relative_manifest_path = normalize_relative_path(relative_manifest_path);
    if relative_manifest_path.is_empty() {
        return Ok(());
    }

    let head_spec = format!("HEAD:{relative_manifest_path}");
    let head_content = match run_git_at(&repo_root, &["show", &head_spec]) {
        Ok(content) => content,
        Err(_) => return Ok(()),
    };
    if head_content.trim().is_empty()
        || json_content_has_same_value_as_file(&head_content, &generic_manifest_path)?
    {
        return Ok(());
    }

    run_git_at(&repo_root, &["checkout", "--", &relative_manifest_path])?;
    Ok(())
}

fn materialize_missing_host_manifest(
    plugin_root: &Path,
    host_tool: &str,
    probe: &PluginProbeResult,
) -> Result<(), String> {
    if ensure_plugin_manifest_for_host(host_tool, plugin_root).is_ok() {
        return Ok(());
    }

    let source_manifest_path = manifest_template_path_for_probe(plugin_root, probe);
    if !source_manifest_path.is_file() {
        return Ok(());
    }

    let manifest = read_plugin_manifest(&source_manifest_path)?;
    if manifest.name.trim().is_empty() {
        return Ok(());
    }

    let target_manifest_path = plugin_manifest_path_for_host(host_tool, plugin_root)?;
    let Some(parent) = target_manifest_path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "创建 {host_tool} 插件 manifest 目录失败（{}）: {error}",
            parent.display()
        )
    })?;

    let content = fs::read_to_string(&source_manifest_path).map_err(|error| {
        format!(
            "读取插件 manifest 模板失败（{}）: {error}",
            source_manifest_path.display()
        )
    })?;
    fs::write(&target_manifest_path, content).map_err(|error| {
        format!(
            "写入 {host_tool} 插件 manifest 失败（{}）: {error}",
            target_manifest_path.display()
        )
    })?;
    Ok(())
}

fn manifest_template_path_for_probe(plugin_root: &Path, probe: &PluginProbeResult) -> PathBuf {
    let probe_manifest_path = Path::new(&probe.manifest_path);
    if probe_manifest_path.is_file() {
        if plugin_root_from_manifest_path(probe_manifest_path)
            .is_some_and(|manifest_root| paths_refer_to_same_dir(&manifest_root, plugin_root))
        {
            return probe_manifest_path.to_path_buf();
        }
        if probe_manifest_path
            .file_name()
            .and_then(|value| value.to_str())
            == Some("plugin.json")
            && probe_manifest_path
                .parent()
                .is_some_and(|manifest_root| paths_refer_to_same_dir(manifest_root, plugin_root))
            && !json_manifest_schema_contains(probe_manifest_path, "antigravity.google")
        {
            return probe_manifest_path.to_path_buf();
        }
    }

    for candidate in manifest_template_candidates_for_probe(plugin_root, probe) {
        if candidate.is_file() {
            return candidate;
        }
    }

    let generic_manifest_path = plugin_root.join("plugin.json");
    if generic_manifest_path.is_file()
        && !json_manifest_schema_contains(&generic_manifest_path, "antigravity.google")
    {
        return generic_manifest_path;
    }
    PathBuf::new()
}

fn json_manifest_schema_contains(path: &Path, needle: &str) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<JsonValue>(&content) else {
        return false;
    };
    value
        .get("$schema")
        .and_then(JsonValue::as_str)
        .is_some_and(|schema| schema.contains(needle))
}

fn json_files_have_same_value(left: &Path, right: &Path) -> Result<bool, String> {
    let left_content = fs::read_to_string(left)
        .map_err(|error| format!("读取 JSON 文件失败（{}）: {error}", left.display()))?;
    json_content_has_same_value_as_file(&left_content, right)
}

fn json_content_has_same_value_as_file(content: &str, path: &Path) -> Result<bool, String> {
    let Ok(left_value) = serde_json::from_str::<JsonValue>(content) else {
        return Ok(false);
    };
    let right_content = fs::read_to_string(path)
        .map_err(|error| format!("读取 JSON 文件失败（{}）: {error}", path.display()))?;
    let Ok(right_value) = serde_json::from_str::<JsonValue>(&right_content) else {
        return Ok(false);
    };
    Ok(left_value == right_value)
}

fn manifest_template_candidates_for_probe(
    plugin_root: &Path,
    probe: &PluginProbeResult,
) -> Vec<PathBuf> {
    let mut manifest_paths = Vec::new();

    if let Ok(path) = plugin_manifest_path_for_host(&probe.tool, plugin_root) {
        manifest_paths.push(path);
    }

    for host_tool in &probe.compatible_host_tools {
        if host_tool == &probe.tool {
            continue;
        }
        if let Ok(path) = plugin_manifest_path_for_host(host_tool, plugin_root) {
            manifest_paths.push(path);
        }
    }

    for relative_path in [
        CODEX_PLUGIN_MANIFEST,
        CLAUDE_PLUGIN_MANIFEST,
        CURSOR_PLUGIN_MANIFEST,
    ] {
        manifest_paths.push(plugin_root.join(relative_path));
    }

    manifest_paths
}

fn plugin_relative_path_for_probe(
    probe: &PluginProbeResult,
    git_root: Option<&Path>,
    plugin_root: &Path,
) -> PathBuf {
    if let Some(relative_path) = non_empty_trimmed_string(&probe.plugin_relative_path) {
        let relative_path = PathBuf::from(relative_path);
        if git_root
            .map(|root| paths_refer_to_same_dir(&root.join(&relative_path), plugin_root))
            .unwrap_or(false)
        {
            return relative_path;
        }
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

fn is_managed_plugin_discovery_repo(path: &Path) -> bool {
    workspace::managed_workspace_root_option()
        .map(|root| root.join(workspace::REPOSITORIES_DIR_NAME))
        .and_then(|root| canonicalize_existing_dir(&root).ok())
        .is_some_and(|root| path.starts_with(root))
}

fn resolve_shared_plugin_package_id(
    source: &str,
    plugin_relative_path: &Path,
    preferred_name: Option<&str>,
) -> Result<String, String> {
    let identity = managed_plugin_package_identity(source, plugin_relative_path);
    let candidates =
        shared_plugin_package_id_candidates(source, plugin_relative_path, preferred_name);
    for candidate in candidates {
        let candidate_root = shared_plugin_package_repo_root(&candidate)?;
        if !candidate_root.exists() {
            return Ok(candidate);
        }
        if read_plugin_package_identity(&candidate_root).as_ref() == Some(&identity) {
            return Ok(candidate);
        }
        if legacy_git_package_matches_identity(&candidate_root, &identity) {
            write_plugin_package_identity(&candidate_root, source, plugin_relative_path)?;
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

fn legacy_git_package_matches_identity(
    candidate_root: &Path,
    identity: &ManagedPluginPackageIdentity,
) -> bool {
    if read_plugin_package_identity(candidate_root).is_some()
        || !candidate_root.join(".git").exists()
    {
        return false;
    }

    let Ok(remote_url) = run_git_at(candidate_root, &["remote", "get-url", "origin"]) else {
        return false;
    };
    if normalize_plugin_package_source(&remote_url) != identity.source {
        return false;
    }

    let relative_path = Path::new(&identity.plugin_relative_path);
    relative_path.as_os_str().is_empty() || candidate_root.join(relative_path).exists()
}

fn shared_plugin_package_id_candidates(
    source: &str,
    plugin_relative_path: &Path,
    preferred_name: Option<&str>,
) -> Vec<String> {
    let base_name = plugin_base_package_name(source, plugin_relative_path);
    let repo_parts = plugin_repo_name_parts(source);
    let mut candidates = Vec::new();
    if let Some(preferred_name) = preferred_name
        .map(sanitize_storage_name)
        .filter(|value| !value.is_empty())
    {
        push_unique_plugin_package_candidate(&mut candidates, preferred_name);
    }
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

fn plugin_preferred_package_name(probe: &PluginProbeResult, plugin_root: &Path) -> Option<String> {
    if probe.tool == "opencode" {
        return Some(opencode_plugin_manifest(plugin_root).name)
            .filter(|name| !name.trim().is_empty());
    }
    let manifest_path = match probe.tool.as_str() {
        "cursor" => plugin_root.join(CURSOR_PLUGIN_MANIFEST),
        "claude-code" => plugin_root.join(CLAUDE_PLUGIN_MANIFEST),
        "codex" => plugin_root.join(CODEX_PLUGIN_MANIFEST),
        _ => return None,
    };
    let manifest = read_plugin_manifest(&manifest_path).ok()?;
    let install_name = plugin_install_name(&manifest, plugin_root);
    (!install_name.is_empty()).then_some(install_name)
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
    let effective_path = canonicalize_existing_dir(path).unwrap_or_else(|_| path.to_path_buf());
    if let Some(git_root) = find_git_root(&effective_path) {
        if let Some(metadata_dir) = git_skilldock_metadata_dir(&git_root) {
            let relative_path = effective_path
                .strip_prefix(&git_root)
                .unwrap_or(Path::new(""));
            if relative_path.as_os_str().is_empty() {
                return metadata_dir.join(SKILLDOCK_PACKAGE_IDENTITY_METADATA_FILE);
            }
            return metadata_dir.join("package-identity").join(
                metadata_file_name_for_relative_path(relative_path, PLUGIN_PACKAGE_IDENTITY_FILE),
            );
        }
    }
    legacy_plugin_package_identity_path(path)
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
        || first_opencode_plugin_entry(path).is_some()
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
            continue;
        }
        if legacy_git_package_matches_identity(&candidate_root, &active_identity) {
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
    apply_instead_of: bool,
    on_progress: Option<&CloneProgressCallback>,
) -> Result<(), String> {
    if repo_root.join(".git").is_dir() {
        // 已有缓存必须先同步远端；同步失败时停止安装，不能把旧缓存当作最新版。
        if let Some(cb) = on_progress {
            cb("正在更新插件缓存...");
        }
        let mut fetch_args = vec!["fetch", "origin", "--no-tags", "--quiet"];
        let branch_arg;
        if let Some(r) = git_ref.and_then(non_empty_trimmed_string) {
            branch_arg = r.to_string();
            fetch_args.push(&branch_arg);
        }
        run_git_at(repo_root, &fetch_args).map_err(|error| {
            format!(
                "更新插件缓存失败，已停止安装以避免使用旧版本（{}）: {error}",
                repo_root.display()
            )
        })?;
        run_git_at(repo_root, &["reset", "--hard", "FETCH_HEAD"])?;
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

    let resolved_url = if apply_instead_of {
        resolve_git_clone_url_with_instead_of(clone_url)
    } else {
        clone_url.trim().to_string()
    };

    let mut command = git_command();
    configure_git_network_command(&mut command);
    command
        .arg("clone")
        .arg("--filter=blob:none")
        .arg("--no-tags")
        .arg("--sparse");
    if on_progress.is_some() {
        command.arg("--progress");
    }
    if let Some(branch) = git_ref.and_then(non_empty_trimmed_string) {
        command.arg("--branch").arg(branch);
    }
    command
        .arg(&resolved_url)
        .arg(repo_root.to_string_lossy().as_ref());
    run_git_clone_with_progress(&mut command, on_progress, "git clone (plugin)")?;

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
        run_git_at(target_repo_root, &["reset", "--hard", "HEAD"])?;
        ensure_managed_plugin_repo_git_excludes(target_repo_root)?;
        configure_plugin_sparse_checkout(target_repo_root, plugin_relative_path)?;
        return Ok(());
    }
    if target_repo_root.join(".git").is_dir() {
        write_plugin_package_identity(target_repo_root, source, plugin_relative_path)?;
        run_git_at(target_repo_root, &["reset", "--hard", "HEAD"])?;
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
    copy_dir_all(source_repo_root, target_repo_root, false)?;
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
    for pattern in [".idea/", ".vscode/", ".DS_Store"] {
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
        let sparse_enabled = run_git_at(repo_root, &["config", "--bool", "core.sparseCheckout"])
            .map(|value| value == "true")
            .unwrap_or(false);
        if sparse_enabled {
            run_git_at(repo_root, &["sparse-checkout", "disable"])?;
            run_git_at(repo_root, &["checkout", "--quiet"])?;
        }
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

fn is_opencode_plugin_entry(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
        && path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "js" | "ts"))
}

fn opencode_plugin_entries(plugin_root: &Path) -> Vec<PathBuf> {
    let entry_root = plugin_root.join(OPENCODE_PLUGIN_DIR);
    let Ok(entries) = fs::read_dir(entry_root) else {
        return Vec::new();
    };
    let mut entrypoints = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_opencode_plugin_entry(path))
        .collect::<Vec<_>>();
    entrypoints.sort();
    entrypoints
}

fn first_opencode_plugin_entry(plugin_root: &Path) -> Option<PathBuf> {
    opencode_plugin_entries(plugin_root).into_iter().next()
}

fn opencode_plugin_manifest(plugin_root: &Path) -> PluginManifest {
    let fallback_name = plugin_root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("opencode-plugin")
        .to_string();
    let Ok(content) = fs::read_to_string(plugin_root.join("package.json")) else {
        return PluginManifest {
            name: fallback_name,
            ..PluginManifest::default()
        };
    };
    let Ok(package) = serde_json::from_str::<JsonValue>(&content) else {
        return PluginManifest {
            name: fallback_name,
            ..PluginManifest::default()
        };
    };
    let string_field = |field: &str| {
        package
            .get(field)
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let repository = package
        .get("repository")
        .and_then(|value| {
            value.as_str().or_else(|| {
                value
                    .as_object()
                    .and_then(|object| object.get("url"))
                    .and_then(JsonValue::as_str)
            })
        })
        .unwrap_or_default()
        .trim()
        .to_string();
    let name = string_field("name");
    PluginManifest {
        name: if name.is_empty() { fallback_name } else { name },
        version: string_field("version"),
        description: string_field("description"),
        homepage: string_field("homepage"),
        repository,
        ..PluginManifest::default()
    }
}

fn opencode_user_plugins_root(home_dir: &Path) -> PathBuf {
    home_dir.join(OPENCODE_USER_PLUGIN_DIR)
}

fn opencode_disabled_plugins_root(home_dir: &Path) -> PathBuf {
    home_dir.join(OPENCODE_DISABLED_PLUGIN_DIR)
}

fn managed_plugin_root_from_package_root(package_root: &Path) -> PathBuf {
    let relative_path = read_plugin_package_identity(package_root)
        .map(|identity| PathBuf::from(identity.plugin_relative_path))
        .unwrap_or_default();
    if relative_path.as_os_str().is_empty() {
        package_root.to_path_buf()
    } else {
        package_root.join(relative_path)
    }
}

fn opencode_package_id(package_root: &Path) -> Result<String, String> {
    package_root
        .file_name()
        .and_then(|value| value.to_str())
        .and_then(non_empty_trimmed_string)
        .ok_or_else(|| format!("无法确定 OpenCode 插件包名: {}", package_root.display()))
}

fn opencode_disabled_marker(home_dir: &Path, package_root: &Path) -> Result<PathBuf, String> {
    Ok(opencode_disabled_plugins_root(home_dir).join(opencode_package_id(package_root)?))
}

fn opencode_link_name(
    package_root: &Path,
    plugin_root: &Path,
    entrypoint: &Path,
) -> Result<String, String> {
    let package_id = opencode_package_id(package_root)?;
    let plugin_relative_path = plugin_root
        .strip_prefix(package_root)
        .unwrap_or(Path::new(""));
    let scope_hash = short_stable_hash(&normalize_relative_path(plugin_relative_path));
    let stem = entrypoint
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_storage_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "plugin".to_string());
    let extension = entrypoint
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("ts")
        .to_ascii_lowercase();
    let entry_hash = short_stable_hash(
        entrypoint
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default(),
    );
    Ok(format!(
        "{package_id}-{scope_hash}-{stem}-{entry_hash}.{extension}"
    ))
}

fn opencode_expected_links(
    home_dir: &Path,
    plugin_root: &Path,
) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let package_root = managed_plugin_package_root_for_path(plugin_root).ok_or_else(|| {
        format!(
            "OpenCode 插件源不在 SkillDock 托管目录中: {}",
            plugin_root.display()
        )
    })?;
    let canonical_package_root = canonicalize_existing_dir(&package_root)?;
    let entrypoints = opencode_plugin_entries(plugin_root);
    if entrypoints.is_empty() {
        return Err(format!(
            "目录缺少 OpenCode 插件入口: {}",
            plugin_root.join(OPENCODE_PLUGIN_DIR).display()
        ));
    }
    let target_root = opencode_user_plugins_root(home_dir);
    entrypoints
        .into_iter()
        .map(|source| {
            let canonical_source = fs::canonicalize(&source).map_err(|error| {
                format!(
                    "解析 OpenCode 插件入口失败（{}）: {error}",
                    source.display()
                )
            })?;
            if !canonical_source.starts_with(&canonical_package_root) {
                return Err(format!(
                    "OpenCode 插件入口必须位于 SkillDock 托管包内: {}",
                    source.display()
                ));
            }
            let link_name = opencode_link_name(&package_root, plugin_root, &source)?;
            Ok((source, target_root.join(link_name)))
        })
        .collect()
}

fn opencode_link_source(link_path: &Path) -> Option<PathBuf> {
    let target = fs::read_link(link_path).ok()?;
    if target.is_absolute() {
        return Some(target);
    }
    link_path.parent().map(|parent| parent.join(target))
}

fn opencode_link_points_to(link_path: &Path, source_path: &Path) -> bool {
    let Some(link_source) = opencode_link_source(link_path) else {
        return false;
    };
    match (fs::canonicalize(link_source), fs::canonicalize(source_path)) {
        (Ok(link_source), Ok(source_path)) => link_source == source_path,
        _ => false,
    }
}

fn opencode_plugin_root_from_entry_path(entrypoint: &Path) -> Option<PathBuf> {
    let plugins_dir = entrypoint.parent()?;
    if plugins_dir.file_name().and_then(|value| value.to_str()) != Some("plugins") {
        return None;
    }
    let marker_dir = plugins_dir.parent()?;
    if marker_dir.file_name().and_then(|value| value.to_str()) != Some(".opencode") {
        return None;
    }
    marker_dir.parent().map(Path::to_path_buf)
}

fn opencode_link_belongs_to_plugin(link_path: &Path, plugin_root: &Path) -> Result<bool, String> {
    let link_source = opencode_link_source(link_path)
        .ok_or_else(|| format!("读取 OpenCode 插件软连接失败（{}）", link_path.display()))?;
    let Some(link_plugin_root) = opencode_plugin_root_from_entry_path(&link_source) else {
        return Ok(false);
    };
    if !paths_refer_to_same_dir(&link_plugin_root, plugin_root)
        && !(link_plugin_root == plugin_root && link_source.starts_with(plugin_root))
    {
        return Ok(false);
    }
    let package_root = managed_plugin_package_root_for_path(plugin_root)
        .ok_or_else(|| "OpenCode 插件源必须位于 SkillDock 托管目录".to_string())?;
    let expected_name = opencode_link_name(&package_root, plugin_root, &link_source)?;
    Ok(link_path.file_name().and_then(|value| value.to_str()) == Some(expected_name.as_str()))
}

fn collect_opencode_links_for_plugin(
    home_dir: &Path,
    plugin_root: &Path,
) -> Result<Vec<PathBuf>, String> {
    let active_root = opencode_user_plugins_root(home_dir);
    let entries = match fs::read_dir(&active_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "读取 OpenCode 插件目录失败（{}）: {error}",
                active_root.display()
            ))
        }
    };
    let mut links = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "读取 OpenCode 插件目录项失败（{}）: {error}",
                active_root.display()
            )
        })?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!("读取 OpenCode 插件路径失败（{}）: {error}", path.display())
        })?;
        if metadata.file_type().is_symlink() && opencode_link_belongs_to_plugin(&path, plugin_root)?
        {
            links.push(path);
        }
    }
    Ok(links)
}

fn resolve_opencode_link_sources(
    link_paths: Vec<PathBuf>,
) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    link_paths
        .into_iter()
        .map(|link_path| {
            let source_path = opencode_link_source(&link_path).ok_or_else(|| {
                format!("读取 OpenCode 插件软连接失败（{}）", link_path.display())
            })?;
            Ok((source_path, link_path))
        })
        .collect()
}

fn rollback_opencode_link_changes(
    created_links: &[PathBuf],
    removed_links: &[(PathBuf, PathBuf)],
) -> Vec<String> {
    let mut errors = Vec::new();
    for created_link in created_links.iter().rev() {
        if let Err(error) = fs::remove_file(created_link) {
            if error.kind() != std::io::ErrorKind::NotFound {
                errors.push(format!("删除 {} 失败: {error}", created_link.display()));
            }
        }
    }
    for (source_path, link_path) in removed_links.iter().rev() {
        if fs::symlink_metadata(link_path).is_ok() {
            continue;
        }
        if let Err(error) = create_opencode_symlink(source_path, link_path) {
            errors.push(error);
        }
    }
    errors
}

fn opencode_transaction_error(error: String, rollback_errors: Vec<String>) -> String {
    if rollback_errors.is_empty() {
        error
    } else {
        format!("{error}；回滚失败: {}", rollback_errors.join("；"))
    }
}

fn create_opencode_symlink(source_path: &Path, link_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source_path, link_path).map_err(|error| {
            format!(
                "创建 OpenCode 插件软连接失败（{} -> {}）: {error}",
                link_path.display(),
                source_path.display()
            )
        })
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(source_path, link_path).map_err(|error| {
            format!(
                "创建 OpenCode 插件软连接失败（{} -> {}）: {error}",
                link_path.display(),
                source_path.display()
            )
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (source_path, link_path);
        Err("当前系统不支持 OpenCode 插件软连接".to_string())
    }
}

fn ensure_opencode_links_enabled(home_dir: &Path, plugin_root: &Path) -> Result<(), String> {
    let plugin_root = canonicalize_existing_dir(plugin_root)?;
    let package_root = managed_plugin_package_root_for_path(&plugin_root)
        .ok_or_else(|| "OpenCode 插件源必须位于 SkillDock 托管目录".to_string())?;
    let expected_links = opencode_expected_links(home_dir, &plugin_root)?;
    for (source_path, link_path) in &expected_links {
        if fs::symlink_metadata(link_path).is_err() {
            continue;
        }
        if !opencode_link_points_to(link_path, source_path) {
            return Err(format!(
                "OpenCode 插件目标已存在且不属于当前 SkillDock 插件: {}",
                link_path.display()
            ));
        }
    }
    let target_root = opencode_user_plugins_root(home_dir);
    fs::create_dir_all(&target_root).map_err(|error| {
        format!(
            "创建 OpenCode 插件目录失败（{}）: {error}",
            target_root.display()
        )
    })?;

    let existing_links =
        resolve_opencode_link_sources(collect_opencode_links_for_plugin(home_dir, &plugin_root)?)?;
    let mut created_links = Vec::new();
    for (source_path, link_path) in &expected_links {
        if fs::symlink_metadata(link_path).is_ok() {
            continue;
        }
        if let Err(error) = create_opencode_symlink(source_path, link_path) {
            let rollback_errors = rollback_opencode_link_changes(&created_links, &[]);
            return Err(opencode_transaction_error(error, rollback_errors));
        }
        created_links.push(link_path.clone());
    }

    let expected_paths = expected_links
        .iter()
        .map(|(_, link_path)| link_path.clone())
        .collect::<BTreeSet<_>>();
    let mut removed_links = Vec::new();
    for (source_path, stale_link) in existing_links {
        if expected_paths.contains(&stale_link) {
            continue;
        }
        if let Err(error) = fs::remove_file(&stale_link) {
            let rollback_errors = rollback_opencode_link_changes(&created_links, &removed_links);
            return Err(opencode_transaction_error(
                format!(
                    "清理失效 OpenCode 插件软连接失败（{}）: {error}",
                    stale_link.display()
                ),
                rollback_errors,
            ));
        }
        removed_links.push((source_path, stale_link));
    }

    let disabled_marker = opencode_disabled_marker(home_dir, &package_root)?;
    if disabled_marker.exists() {
        if let Err(error) = fs::remove_dir_all(&disabled_marker) {
            let rollback_errors = rollback_opencode_link_changes(&created_links, &removed_links);
            return Err(opencode_transaction_error(
                format!(
                    "清理 OpenCode 插件停用标记失败（{}）: {error}",
                    disabled_marker.display()
                ),
                rollback_errors,
            ));
        }
    }
    Ok(())
}

fn ensure_opencode_links_disabled(home_dir: &Path, plugin_root: &Path) -> Result<(), String> {
    let plugin_root = canonicalize_existing_dir(plugin_root)?;
    let package_root = managed_plugin_package_root_for_path(&plugin_root)
        .ok_or_else(|| "OpenCode 插件源必须位于 SkillDock 托管目录".to_string())?;
    let links =
        resolve_opencode_link_sources(collect_opencode_links_for_plugin(home_dir, &plugin_root)?)?;
    let disabled_marker = opencode_disabled_marker(home_dir, &package_root)?;
    let marker_existed = disabled_marker.exists();
    fs::create_dir_all(&disabled_marker).map_err(|error| {
        format!(
            "创建 OpenCode 插件停用标记失败（{}）: {error}",
            disabled_marker.display()
        )
    })?;

    let mut removed_links = Vec::<(PathBuf, PathBuf)>::new();
    for (source_path, link_path) in links {
        if let Err(error) = fs::remove_file(&link_path) {
            let mut rollback_errors = rollback_opencode_link_changes(&[], &removed_links);
            if !marker_existed {
                if let Err(marker_error) = fs::remove_dir_all(&disabled_marker) {
                    rollback_errors.push(format!(
                        "删除停用标记 {} 失败: {marker_error}",
                        disabled_marker.display()
                    ));
                }
            }
            return Err(opencode_transaction_error(
                format!("停用 OpenCode 插件失败（{}）: {error}", link_path.display()),
                rollback_errors,
            ));
        }
        removed_links.push((source_path, link_path));
    }
    Ok(())
}

fn remove_opencode_installation(home_dir: &Path, plugin_root: &Path) -> Result<(), String> {
    let package_root = managed_plugin_package_root_for_path(plugin_root)
        .ok_or_else(|| "OpenCode 插件源必须位于 SkillDock 托管目录".to_string())?;
    let links =
        resolve_opencode_link_sources(collect_opencode_links_for_plugin(home_dir, plugin_root)?)?;
    let mut removed_links = Vec::new();
    for (source_path, link_path) in links {
        if let Err(error) = fs::remove_file(&link_path) {
            let rollback_errors = rollback_opencode_link_changes(&[], &removed_links);
            return Err(opencode_transaction_error(
                format!(
                    "删除 OpenCode 插件软连接失败（{}）: {error}",
                    link_path.display()
                ),
                rollback_errors,
            ));
        }
        removed_links.push((source_path, link_path));
    }
    let marker = opencode_disabled_marker(home_dir, &package_root)?;
    if marker.exists() {
        if let Err(error) = fs::remove_dir_all(&marker) {
            let rollback_errors = rollback_opencode_link_changes(&[], &removed_links);
            return Err(opencode_transaction_error(
                format!(
                    "删除 OpenCode 插件停用标记失败（{}）: {error}",
                    marker.display()
                ),
                rollback_errors,
            ));
        }
    }
    Ok(())
}

fn link_or_copy_plugin_dir(source_root: &Path, target_root: &Path) -> Result<(), String> {
    if try_link_plugin_dir(source_root, target_root)? {
        return Ok(());
    }
    copy_dir_all(source_root, target_root, false)
}

fn try_link_plugin_dir(source_root: &Path, target_root: &Path) -> Result<bool, String> {
    if paths_refer_to_same_dir(source_root, target_root) {
        return Ok(true);
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
        if std::os::unix::fs::symlink(source_root, target_root).is_ok() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn link_cursor_plugin_dir_contents(source_root: &Path, target_root: &Path) -> Result<bool, String> {
    #[cfg(unix)]
    {
        if paths_refer_to_same_dir(source_root, target_root) {
            return Ok(true);
        }
        if target_root.exists() || fs::symlink_metadata(target_root).is_ok() {
            remove_path(target_root)?;
        }
        fs::create_dir_all(target_root).map_err(|error| {
            format!(
                "创建 Cursor 插件安装目录失败（{}）: {error}",
                target_root.display()
            )
        })?;
        let entries = fs::read_dir(source_root).map_err(|error| {
            format!(
                "读取 Cursor 插件源目录失败（{}）: {error}",
                source_root.display()
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!(
                    "读取 Cursor 插件源目录条目失败（{}）: {error}",
                    source_root.display()
                )
            })?;
            let file_name = entry.file_name();
            if file_name == ".git" || file_name == ".idea" {
                continue;
            }
            let source_path = entry.path();
            let target_path = target_root.join(&file_name);
            if let Err(error) = std::os::unix::fs::symlink(&source_path, &target_path) {
                let _ = fs::remove_dir_all(target_root);
                return Err(format!(
                    "创建 Cursor 插件内容软连接失败（{} -> {}）: {error}",
                    target_path.display(),
                    source_path.display()
                ));
            }
        }
        return Ok(true);
    }
    #[allow(unreachable_code)]
    Ok(false)
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
    let mut command = git_command();
    configure_git_network_command(&mut command);
    let output = command
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
            app_names: CODEX_APP_NAMES,
            executable_names: &["codex"],
        }),
        "cursor" => Some(PluginHostDetectionSpec {
            label: "Cursor",
            app_names: &["Cursor"],
            executable_names: &["cursor"],
        }),
        "opencode" => Some(PluginHostDetectionSpec {
            label: "OpenCode",
            app_names: &["OpenCode"],
            executable_names: &["opencode"],
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
    let mut search_dirs = env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .unwrap_or_default();
    #[cfg(unix)]
    search_dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ]);

    resolve_command_path(executable_name, &search_dirs)
}

fn find_plugin_host_app_bundle(app_name_candidates: &[&str]) -> Option<PathBuf> {
    let mut app_dirs = vec![PathBuf::from("/Applications")];
    if let Some(home_dir) = workspace::home_dir_option() {
        app_dirs.push(home_dir.join("Applications"));
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
    probe: &PluginProbeResult,
) -> Result<PathBuf, String> {
    const SKILLDOCK_MARKETPLACE_NAME: &str = "skilldock";
    let manifest = read_plugin_manifest(&source_root.join(CODEX_PLUGIN_MANIFEST))?;
    let plugin_name = plugin_install_name(&manifest, source_root);
    let marketplace_root = ensure_skilldock_codex_marketplace(home_dir, source_root, &plugin_name)?;
    let marketplace_plugin_root = marketplace_root.join("plugins").join(&plugin_name);
    write_skilldock_plugin_source_metadata(&marketplace_plugin_root, probe)?;
    let cache_plugin_root = ensure_skilldock_codex_cache_link(
        home_dir,
        source_root,
        SKILLDOCK_MARKETPLACE_NAME,
        &plugin_name,
    )?;
    write_skilldock_plugin_source_metadata(&cache_plugin_root, probe)?;
    write_codex_plugin_install_config(
        home_dir,
        SKILLDOCK_MARKETPLACE_NAME,
        &plugin_name,
        &marketplace_root,
    )?;
    Ok(marketplace_plugin_root)
}

fn install_opencode_plugin_probe(
    home_dir: &Path,
    source_root: &Path,
    package_root: &Path,
    probe: &PluginProbeResult,
) -> Result<PathBuf, String> {
    if managed_plugin_package_root_for_path(source_root)
        .is_none_or(|managed_root| !paths_refer_to_same_dir(&managed_root, package_root))
    {
        return Err("OpenCode 插件源必须来自当前 SkillDock 托管包".to_string());
    }
    ensure_opencode_links_enabled(home_dir, source_root)?;
    write_skilldock_plugin_source_metadata(source_root, probe)?;
    Ok(source_root.to_path_buf())
}

fn ensure_skilldock_codex_cache_link(
    home_dir: &Path,
    source_root: &Path,
    marketplace_name: &str,
    plugin_name: &str,
) -> Result<PathBuf, String> {
    let plugin_cache_root = home_dir
        .join(".codex/plugins/cache")
        .join(marketplace_name)
        .join(plugin_name);
    remove_legacy_codex_plugin_cache_root(&plugin_cache_root, source_root)?;
    prune_codex_plugin_cache_versions(&plugin_cache_root, CODEX_SKILLDOCK_CACHE_VERSION)?;
    let target_root = plugin_cache_root.join(CODEX_SKILLDOCK_CACHE_VERSION);
    mirror_codex_plugin_cache_dir(source_root, &target_root)?;
    Ok(target_root)
}

fn reconcile_skilldock_codex_cache_after_update(
    plugin: &PluginSummary,
    target_root: &Path,
    update_root: &Path,
) -> Result<(), String> {
    let home_dir = workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let source_root = resolve_updated_codex_plugin_source_root(plugin, target_root, update_root)
        .ok_or_else(|| format!("更新后未找到 Codex 插件目录: {}", plugin.name))?;
    ensure_skilldock_codex_cache_link(&home_dir, &source_root, "skilldock", &plugin.manifest_name)?;
    Ok(())
}

fn resolve_updated_codex_plugin_source_root(
    plugin: &PluginSummary,
    target_root: &Path,
    update_root: &Path,
) -> Option<PathBuf> {
    if target_root.join(CODEX_PLUGIN_MANIFEST).is_file() && find_git_root(target_root).is_some() {
        return Some(target_root.to_path_buf());
    }
    if update_root.join(CODEX_PLUGIN_MANIFEST).is_file() {
        return Some(update_root.to_path_buf());
    }

    let mut candidates = Vec::new();
    collect_codex_plugin_roots(update_root, 0, &mut candidates);
    candidates
        .into_iter()
        .filter(|root| cached_codex_plugin_matches(root, &plugin.manifest_name))
        .max_by_key(|root| file_modified_timestamp(&root.join(CODEX_PLUGIN_MANIFEST)))
}

fn remove_legacy_codex_plugin_cache_root(
    plugin_cache_root: &Path,
    source_root: &Path,
) -> Result<(), String> {
    if fs::symlink_metadata(plugin_cache_root).is_err() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(plugin_cache_root).map_err(|error| {
        format!(
            "读取 Codex 插件缓存失败（{}）: {error}",
            plugin_cache_root.display()
        )
    })?;
    if metadata.file_type().is_symlink()
        || metadata.is_file()
        || paths_refer_to_same_dir(plugin_cache_root, source_root)
        || plugin_cache_root.join(CODEX_PLUGIN_MANIFEST).is_file()
    {
        remove_path(plugin_cache_root)?;
    }
    Ok(())
}

fn prune_codex_plugin_cache_versions(
    plugin_cache_root: &Path,
    keep_version: &str,
) -> Result<(), String> {
    if !plugin_cache_root.is_dir() {
        return Ok(());
    }
    let entries = fs::read_dir(plugin_cache_root).map_err(|error| {
        format!(
            "读取 Codex 插件缓存目录失败（{}）: {error}",
            plugin_cache_root.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "读取 Codex 插件缓存条目失败（{}）: {error}",
                plugin_cache_root.display()
            )
        })?;
        if entry.file_name().to_string_lossy() != keep_version {
            remove_path(&entry.path())?;
        }
    }
    Ok(())
}

fn mirror_codex_plugin_cache_dir(source_root: &Path, target_root: &Path) -> Result<(), String> {
    if paths_refer_to_same_dir(source_root, target_root) {
        return Ok(());
    }
    let source_metadata = read_skilldock_plugin_source_metadata(target_root)
        .or_else(|| read_skilldock_plugin_source_metadata(source_root))
        .or_else(|| plugin_source_metadata_from_package_identity(source_root));
    if target_root.exists() || fs::symlink_metadata(target_root).is_ok() {
        remove_path(target_root)?;
    }
    if let Some(parent) = target_root.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "创建 Codex 插件缓存目录失败（{}）: {error}",
                parent.display()
            )
        })?;
    }

    #[cfg(unix)]
    {
        if let Err(error) = symlink_plugin_dir_entries(source_root, target_root) {
            let _ = remove_path(target_root);
            copy_dir_all(source_root, target_root, false).map_err(|copy_error| {
                format!(
                    "创建 Codex 插件缓存镜像失败（{} -> {}）: {error}; 复制回退也失败: {copy_error}",
                    source_root.display(),
                    target_root.display()
                )
            })?;
        }
        if let Some(metadata) = source_metadata.as_ref() {
            write_skilldock_plugin_source_metadata_value(target_root, metadata)?;
        }
        return Ok(());
    }

    #[cfg(not(unix))]
    {
        copy_dir_all(source_root, target_root, false)?;
        if let Some(metadata) = source_metadata.as_ref() {
            write_skilldock_plugin_source_metadata_value(target_root, metadata)?;
        }
        Ok(())
    }
}

#[cfg(unix)]
fn symlink_plugin_dir_entries(source_root: &Path, target_root: &Path) -> Result<(), String> {
    fs::create_dir_all(target_root).map_err(|error| {
        format!(
            "创建 Codex 插件缓存镜像目录失败（{}）: {error}",
            target_root.display()
        )
    })?;
    let entries = fs::read_dir(source_root).map_err(|error| {
        format!(
            "读取 Codex 插件源目录失败（{}）: {error}",
            source_root.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "读取 Codex 插件源目录条目失败（{}）: {error}",
                source_root.display()
            )
        })?;
        let source_path = entry.path();
        let target_path = target_root.join(entry.file_name());
        let entry_name = entry.file_name();
        let entry_name = entry_name.to_string_lossy();
        if entry_name == ".git" || entry_name == ".skilldock" {
            continue;
        }
        std::os::unix::fs::symlink(&source_path, &target_path).map_err(|error| {
            format!(
                "创建 Codex 插件缓存镜像链接失败（{} -> {}）: {error}",
                target_path.display(),
                source_path.display()
            )
        })?;
    }
    Ok(())
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
    package_root: &Path,
    probe: &PluginProbeResult,
) -> Result<PathBuf, String> {
    let manifest = read_plugin_manifest(&source_root.join(CURSOR_PLUGIN_MANIFEST))?;
    let plugin_name = plugin_install_name(&manifest, source_root);
    ensure_cursor_plugin_not_disabled(home_dir, &plugin_name)?;
    let target_repo_root = home_dir.join(".cursor/plugins/local").join(&plugin_name);
    let plugin_relative_path = cursor_plugin_relative_path(package_root, source_root, probe);

    if link_cursor_plugin_dir_contents(source_root, &target_repo_root)? {
        write_cursor_plugin_metadata(source_root, package_root, probe, &plugin_relative_path)?;
        return Ok(target_repo_root);
    }

    if cursor_plugin_should_use_git_clone(package_root, source_root, probe) {
        let target_root = ensure_cursor_local_git_clone(
            source_root,
            package_root,
            probe,
            &target_repo_root,
            &plugin_relative_path,
        )?;
        write_cursor_plugin_metadata(&target_root, package_root, probe, &plugin_relative_path)?;
        return Ok(target_root);
    }

    copy_cursor_plugin_dir(source_root, &target_repo_root)?;
    write_cursor_plugin_metadata(
        &target_repo_root,
        package_root,
        probe,
        &plugin_relative_path,
    )?;
    Ok(target_repo_root)
}

fn ensure_cursor_plugin_not_disabled(home_dir: &Path, plugin_name: &str) -> Result<(), String> {
    let disabled_root = cursor_disabled_plugins_root(home_dir).join(plugin_name);
    if disabled_root.exists() || fs::symlink_metadata(&disabled_root).is_ok() {
        return Err(format!(
            "Cursor 插件 {plugin_name} 已停用，请先重新启用后再安装"
        ));
    }
    Ok(())
}

fn install_cursor_plugin_probe_independent(
    home_dir: &Path,
    probe: &PluginProbeResult,
    on_progress: Option<&CloneProgressCallback>,
) -> Result<PathBuf, String> {
    if let Ok(installed_root) =
        install_cursor_plugin_probe_from_existing_git_source(home_dir, probe, on_progress)
    {
        return Ok(installed_root);
    }

    if let Ok((clone_url, source_ref, plugin_relative_path)) = cursor_remote_clone_spec(probe) {
        if let Ok(installed_root) = install_cursor_plugin_probe_from_remote(
            home_dir,
            probe,
            &clone_url,
            source_ref.as_deref(),
            &plugin_relative_path,
            on_progress,
        ) {
            return Ok(installed_root);
        }
    }

    let host_tools = vec!["cursor".to_string()];
    let package = ensure_shared_plugin_package(probe, &host_tools, on_progress)?;
    let source_root = canonicalize_existing_dir(&package.plugin_root)?;
    let package_root =
        managed_plugin_package_root_for_path(&source_root).unwrap_or_else(|| source_root.clone());
    install_cursor_plugin_probe(home_dir, &source_root, &package_root, probe)
}

fn install_cursor_plugin_probe_from_existing_git_source(
    home_dir: &Path,
    probe: &PluginProbeResult,
    on_progress: Option<&CloneProgressCallback>,
) -> Result<PathBuf, String> {
    let source_root = canonicalize_existing_dir(Path::new(&probe.plugin_root))
        .ok()
        .map(|root| resolve_effective_probe_plugin_root(probe, &root))
        .ok_or_else(|| "插件本地源目录不存在".to_string())?;
    let source_git_root = non_empty_trimmed_string(&probe.git_root)
        .and_then(|value| canonicalize_existing_dir(Path::new(&value)).ok())
        .filter(|path| path.join(".git").is_dir())
        .or_else(|| find_git_root(&source_root))
        .ok_or_else(|| "插件本地源目录不是 Git 仓库".to_string())?;
    if !source_git_root.join(".git").is_dir() {
        return Err("插件本地源目录不是 Git 仓库".to_string());
    }
    let repo_cache_root = workspace::managed_workspace_root_option()
        .map(|root| root.join(workspace::REPOSITORIES_DIR_NAME))
        .and_then(|root| canonicalize_existing_dir(&root).ok())
        .ok_or_else(|| "插件本地源不是 SkillDock repositories".to_string())?;
    if source_git_root.strip_prefix(&repo_cache_root).is_err() {
        return Err("插件本地源不是 SkillDock repositories".to_string());
    }

    let host_tools = vec!["cursor".to_string()];
    let package = ensure_shared_plugin_package(probe, &host_tools, on_progress)?;
    let source_root = canonicalize_existing_dir(&package.plugin_root)?;
    let package_root =
        managed_plugin_package_root_for_path(&source_root).unwrap_or_else(|| source_root.clone());
    install_cursor_plugin_probe(home_dir, &source_root, &package_root, probe)
}

fn install_cursor_plugin_probe_from_remote(
    home_dir: &Path,
    probe: &PluginProbeResult,
    clone_url: &str,
    source_ref: Option<&str>,
    plugin_relative_path: &Path,
    on_progress: Option<&CloneProgressCallback>,
) -> Result<PathBuf, String> {
    let mut shared_probe = probe.clone();
    shared_probe.plugin_root.clear();
    shared_probe.repo_root.clear();
    shared_probe.git_root.clear();
    shared_probe.source_url = clone_url.to_string();
    shared_probe.source_ref = source_ref.unwrap_or_default().to_string();
    shared_probe.plugin_relative_path = normalize_relative_path(plugin_relative_path);

    let host_tools = vec!["cursor".to_string()];
    let package = ensure_shared_plugin_package(&shared_probe, &host_tools, on_progress)?;
    let source_root = canonicalize_existing_dir(&package.plugin_root)?;
    let package_root =
        managed_plugin_package_root_for_path(&source_root).unwrap_or_else(|| source_root.clone());
    install_cursor_plugin_probe(home_dir, &source_root, &package_root, &shared_probe)
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
    let resolved_source_type =
        if probe.source_type.trim() == "git" || !probe.git_root.trim().is_empty() {
            "git".to_string()
        } else if !probe.source_url.trim().is_empty() && find_git_root(plugin_root).is_none() {
            "marketplace".to_string()
        } else {
            probe.source_type.trim().to_string()
        };
    let metadata = SkillDockPluginSourceMetadata {
        source_url: probe.source_url.trim().to_string(),
        source_type: resolved_source_type,
        source_ref: probe.source_ref.trim().to_string(),
        source_revision: probe_source_revision(probe),
    };
    if metadata.source_url.is_empty()
        && metadata.source_type.is_empty()
        && metadata.source_revision.is_empty()
    {
        return Ok(());
    }
    write_skilldock_plugin_source_metadata_value(plugin_root, &metadata)
}

fn write_skilldock_plugin_source_metadata_value(
    plugin_root: &Path,
    metadata: &SkillDockPluginSourceMetadata,
) -> Result<(), String> {
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

fn read_skilldock_plugin_source_metadata_with_package_fallback(
    plugin_root: &Path,
) -> Option<SkillDockPluginSourceMetadata> {
    read_skilldock_plugin_source_metadata(plugin_root)
        .or_else(|| plugin_source_metadata_from_package_identity(plugin_root))
}

fn plugin_source_metadata_from_package_identity(
    plugin_root: &Path,
) -> Option<SkillDockPluginSourceMetadata> {
    let effective_plugin_root =
        canonicalize_existing_dir(plugin_root).unwrap_or_else(|_| plugin_root.to_path_buf());
    let identity = read_plugin_package_identity(&effective_plugin_root).or_else(|| {
        find_git_root(&effective_plugin_root)
            .and_then(|git_root| read_plugin_package_identity(&git_root))
    })?;
    let source_url = non_empty_trimmed_string(&identity.source)?;
    let source_type = if find_git_root(&effective_plugin_root).is_some() {
        "git"
    } else {
        "marketplace"
    };
    Some(SkillDockPluginSourceMetadata {
        source_url,
        source_type: source_type.to_string(),
        source_ref: String::new(),
        source_revision: current_git_commit(&effective_plugin_root).unwrap_or_default(),
    })
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
    let install_name = if !manifest.name.trim().is_empty() {
        manifest.name.trim().to_string()
    } else {
        plugin_display_name(manifest, root)
    };
    let slug = slugify(&install_name);
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
    let output = git_command()
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

fn cursor_plugin_relative_path(
    package_root: &Path,
    source_root: &Path,
    probe: &PluginProbeResult,
) -> PathBuf {
    source_root
        .strip_prefix(package_root)
        .map(Path::to_path_buf)
        .ok()
        .filter(|path| {
            path.as_os_str().is_empty() || source_root.join(CURSOR_PLUGIN_MANIFEST).is_file()
        })
        .or_else(|| {
            read_plugin_package_identity(package_root)
                .map(|identity| PathBuf::from(identity.plugin_relative_path))
        })
        .unwrap_or_else(|| {
            plugin_relative_path_for_probe(
                probe,
                find_git_root(source_root).as_deref(),
                source_root,
            )
        })
}

fn cursor_plugin_should_use_git_clone(
    package_root: &Path,
    source_root: &Path,
    probe: &PluginProbeResult,
) -> bool {
    if !probe.source_type.trim().eq_ignore_ascii_case("git")
        && probe.git_root.trim().is_empty()
        && !probe.is_git_repo
    {
        return false;
    }

    package_root.join(".git").exists() || find_git_root(source_root).is_some()
}

fn cursor_remote_clone_spec(
    probe: &PluginProbeResult,
) -> Result<(String, Option<String>, PathBuf), String> {
    let plugin_relative_path = non_empty_trimmed_string(&probe.plugin_relative_path)
        .map(PathBuf::from)
        .or_else(|| {
            parse_market_source_url(&probe.source_url)
                .ok()
                .and_then(|spec| spec.relative_path)
        })
        .unwrap_or_default();
    let source_ref = non_empty_trimmed_string(&probe.source_ref).or_else(|| {
        parse_market_source_url(&probe.source_url)
            .ok()
            .and_then(|spec| spec.branch)
    });
    let clone_url = cursor_remote_clone_url(probe)
        .ok_or_else(|| "Cursor 插件缺少可独立克隆的 Git 来源，回退到本地目录安装".to_string())?;
    Ok((clone_url, source_ref, plugin_relative_path))
}

fn cursor_remote_clone_url(probe: &PluginProbeResult) -> Option<String> {
    remote_clone_url_from_source(&probe.source_url)
        .or_else(|| local_git_clone_url_from_source(&probe.source_url))
        .or_else(|| {
            non_empty_trimmed_string(&probe.git_root)
                .and_then(|git_root| cursor_git_remote_or_local_path(Path::new(&git_root)))
        })
        .or_else(|| {
            find_git_root(Path::new(&probe.plugin_root))
                .and_then(|git_root| cursor_git_remote_or_local_path(&git_root))
        })
}

fn cursor_git_remote_or_local_path(git_root: &Path) -> Option<String> {
    run_git_at(git_root, &["remote", "get-url", "origin"])
        .ok()
        .and_then(|url| non_empty_trimmed_string(&url))
        .or_else(|| Some(path_to_string(git_root)))
}

fn local_git_clone_url_from_source(source: &str) -> Option<String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if path.join(".git").is_dir() || path.is_dir() {
        return Some(path_to_string(path));
    }
    None
}

fn ensure_cursor_local_git_clone(
    source_root: &Path,
    package_root: &Path,
    probe: &PluginProbeResult,
    target_repo_root: &Path,
    plugin_relative_path: &Path,
) -> Result<PathBuf, String> {
    let source_repo_root = if package_root.join(".git").exists() {
        package_root.to_path_buf()
    } else {
        find_git_root(source_root).ok_or_else(|| {
            format!(
                "Cursor 插件来源不是 Git 仓库，无法创建独立 Git 安装: {}",
                source_root.display()
            )
        })?
    };

    if paths_refer_to_same_dir(&source_repo_root, target_repo_root) {
        ensure_cursor_plugin_root_overlay(target_repo_root, plugin_relative_path)?;
        return canonicalize_existing_dir(target_repo_root);
    }
    if target_repo_root.exists() || fs::symlink_metadata(target_repo_root).is_ok() {
        remove_path(target_repo_root)?;
    }
    if let Some(parent) = target_repo_root.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("创建 Cursor 插件目录失败（{}）: {error}", parent.display())
        })?;
    }

    let mut clone_args = vec!["clone".to_string(), "--no-hardlinks".to_string()];
    if !plugin_relative_path.as_os_str().is_empty() {
        clone_args.push("--sparse".to_string());
        clone_args.push("--filter=blob:none".to_string());
    }
    clone_args.push(source_repo_root.to_string_lossy().to_string());
    clone_args.push(target_repo_root.to_string_lossy().to_string());
    run_git_dynamic_at(Path::new("."), &clone_args)?;

    ensure_managed_plugin_repo_git_excludes(target_repo_root)?;
    configure_plugin_sparse_checkout(target_repo_root, plugin_relative_path)?;
    ensure_cursor_plugin_root_overlay(target_repo_root, plugin_relative_path)?;
    if let Some(origin_url) = cursor_clone_origin_url(probe, package_root) {
        run_git_at(
            target_repo_root,
            &["remote", "set-url", "origin", &origin_url],
        )?;
    }

    if !target_repo_root.join(CURSOR_PLUGIN_MANIFEST).is_file() {
        return Err(format!(
            "Cursor 本地 Git 仓库缺少插件 manifest: {}",
            target_repo_root.join(CURSOR_PLUGIN_MANIFEST).display()
        ));
    }
    canonicalize_existing_dir(target_repo_root)
}

fn cursor_plugin_root_from_repo(
    repo_root: &Path,
    plugin_relative_path: &Path,
) -> Result<PathBuf, String> {
    let root = if plugin_relative_path.as_os_str().is_empty() {
        repo_root.to_path_buf()
    } else {
        repo_root.join(plugin_relative_path)
    };
    canonicalize_existing_dir(&root)
}

fn ensure_cursor_plugin_root_overlay(
    repo_root: &Path,
    plugin_relative_path: &Path,
) -> Result<(), String> {
    if plugin_relative_path.as_os_str().is_empty() {
        return Ok(());
    }

    let plugin_root = cursor_plugin_root_from_repo(repo_root, plugin_relative_path)?;
    if !plugin_root.join(CURSOR_PLUGIN_MANIFEST).is_file() {
        return Err(format!(
            "Cursor 本地 Git 仓库缺少插件 manifest: {}",
            plugin_root.join(CURSOR_PLUGIN_MANIFEST).display()
        ));
    }

    let mut exclude_patterns = Vec::new();
    let entries = fs::read_dir(&plugin_root).map_err(|error| {
        format!(
            "读取 Cursor 插件目录失败（{}）: {error}",
            plugin_root.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "读取 Cursor 插件目录条目失败（{}）: {error}",
                plugin_root.display()
            )
        })?;
        let file_name = entry.file_name();
        if file_name == ".git" {
            continue;
        }
        let source_path = entry.path();
        let target_path = repo_root.join(&file_name);
        let link_target = plugin_relative_path.join(&file_name);
        ensure_cursor_overlay_symlink(&source_path, &target_path, &link_target)?;
        exclude_patterns.push(format!("/{}", file_name.to_string_lossy()));
    }

    ensure_cursor_overlay_git_excludes(repo_root, &exclude_patterns)
}

fn ensure_cursor_overlay_symlink(
    source_path: &Path,
    target_path: &Path,
    link_target: &Path,
) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(target_path) {
        if metadata.file_type().is_symlink() {
            let existing_target = fs::read_link(target_path).map_err(|error| {
                format!(
                    "读取 Cursor 插件 overlay 符号链接失败（{}）: {error}",
                    target_path.display()
                )
            })?;
            if existing_target == link_target {
                return Ok(());
            }
            remove_path(target_path)?;
        } else if paths_refer_to_same_dir(source_path, target_path) {
            return Ok(());
        } else {
            return Err(format!(
                "Cursor 插件 overlay 与仓库根目录已有路径冲突: {}",
                target_path.display()
            ));
        }
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(link_target, target_path).map_err(|error| {
            format!(
                "创建 Cursor 插件 overlay 符号链接失败（{} -> {}）: {error}",
                target_path.display(),
                link_target.display()
            )
        })?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(format!(
        "当前平台不支持创建 Cursor 插件 overlay 符号链接（{}）",
        target_path.display()
    ))
}

fn ensure_cursor_overlay_git_excludes(repo_root: &Path, patterns: &[String]) -> Result<(), String> {
    if patterns.is_empty() {
        return Ok(());
    }
    let exclude_path = repo_root.join(".git/info/exclude");
    let Some(parent) = exclude_path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "创建 Cursor 插件 Git exclude 目录失败（{}）: {error}",
            parent.display()
        )
    })?;

    let existing_content = fs::read_to_string(&exclude_path).unwrap_or_default();
    let mut lines = existing_content
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    for pattern in patterns {
        if !lines.iter().any(|line| line.trim() == pattern) {
            lines.push(pattern.clone());
        }
    }
    let next_content = format!("{}\n", lines.join("\n"));
    if next_content != existing_content {
        fs::write(&exclude_path, next_content).map_err(|error| {
            format!(
                "写入 Cursor 插件 Git exclude 失败（{}）: {error}",
                exclude_path.display()
            )
        })?;
    }
    Ok(())
}

fn cursor_clone_origin_url(probe: &PluginProbeResult, package_root: &Path) -> Option<String> {
    run_git_at(package_root, &["remote", "get-url", "origin"])
        .ok()
        .and_then(|url| non_empty_trimmed_string(&url))
        .or_else(|| remote_clone_url_from_source(&probe.source_url))
        .or_else(|| {
            read_plugin_package_identity(package_root)
                .and_then(|identity| remote_clone_url_from_source(&identity.source))
        })
}

fn remote_clone_url_from_source(source: &str) -> Option<String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !(trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("ssh://")
        || trimmed.starts_with("git@")
        || trimmed.starts_with("file://"))
    {
        return None;
    }
    parse_market_source_url(trimmed)
        .ok()
        .map(|spec| spec.clone_url)
        .or_else(|| normalize_cursor_local_git_remote_url(trimmed))
}

fn write_cursor_plugin_metadata(
    plugin_root: &Path,
    package_root: &Path,
    probe: &PluginProbeResult,
    plugin_relative_path: &Path,
) -> Result<(), String> {
    write_skilldock_plugin_source_metadata(plugin_root, probe)?;
    let source = read_plugin_package_identity(package_root)
        .map(|identity| identity.source)
        .or_else(|| remote_clone_url_from_source(&probe.source_url))
        .unwrap_or_else(|| probe.source_url.trim().to_string());
    if !source.trim().is_empty() {
        write_plugin_package_identity(plugin_root, &source, plugin_relative_path)?;
        if let Some(repo_root) = find_git_root(plugin_root) {
            write_plugin_package_identity(&repo_root, &source, plugin_relative_path)?;
        }
    }
    Ok(())
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
    copy_dir_all(source_root, target_root, false)
}

fn copy_cursor_plugin_dir(source_root: &Path, target_root: &Path) -> Result<(), String> {
    if paths_refer_to_same_dir(source_root, target_root) {
        return Ok(());
    }
    if target_root.exists() {
        fs::remove_dir_all(target_root).map_err(|error| {
            format!("清理插件安装目录失败（{}）: {error}", target_root.display())
        })?;
    }
    copy_dir_all(source_root, target_root, true)
}

fn copy_dir_all(source: &Path, target: &Path, skip_git_dir: bool) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|error| format!("创建插件安装目录失败（{}）: {error}", target.display()))?;
    let entries = fs::read_dir(source)
        .map_err(|error| format!("读取插件目录失败（{}）: {error}", source.display()))?;
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("读取插件目录条目失败（{}）: {error}", source.display()))?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        let source_path = entry.path();
        let target_path = target.join(&file_name);
        if skip_git_dir && file_name == ".git" {
            continue;
        }
        if file_name == ".idea" {
            continue;
        }
        let metadata = fs::symlink_metadata(&source_path).map_err(|error| {
            format!(
                "读取插件目录条目元数据失败（{}）: {error}",
                source_path.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            copy_plugin_symlink(&source_path, &target_path)?;
        } else if metadata.is_dir() {
            copy_dir_all(&source_path, &target_path, skip_git_dir)?;
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

fn copy_plugin_symlink(source_path: &Path, target_path: &Path) -> Result<(), String> {
    if target_path.exists() || fs::symlink_metadata(target_path).is_ok() {
        remove_path(target_path)?;
    }
    #[cfg(unix)]
    {
        let link_target = fs::read_link(source_path).map_err(|error| {
            format!("读取插件符号链接失败（{}）: {error}", source_path.display())
        })?;
        std::os::unix::fs::symlink(&link_target, target_path).map_err(|error| {
            format!(
                "创建插件符号链接失败（{} -> {}）: {error}",
                target_path.display(),
                link_target.display()
            )
        })?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(format!(
        "当前平台不支持复制插件符号链接（{}）",
        source_path.display()
    ))
}

fn cursor_synthetic_git_marker_path(plugin_root: &Path) -> PathBuf {
    plugin_root.join(".skilldock/cursor-local-git")
}

fn is_synthetic_cursor_git_repo(plugin_root: &Path) -> bool {
    cursor_synthetic_git_marker_path(plugin_root).is_file()
}

fn normalize_cursor_local_git_remote_url(source_url: &str) -> Option<String> {
    let trimmed = source_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.starts_with("git@") || trimmed.starts_with("ssh://") {
        return Some(trimmed.to_string());
    }

    let parsed = url::Url::parse(trimmed).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }

    let host = parsed.host_str()?;
    let host_with_port = parsed
        .port()
        .map(|port| format!("{host}:{port}"))
        .unwrap_or_else(|| host.to_string());
    let segments = parsed
        .path_segments()
        .map(|items| items.filter(|item| !item.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    let repo_segments = plugin_remote_repo_segments(host, &segments)?;

    Some(format!(
        "{}://{}/{}.git",
        parsed.scheme(),
        host_with_port,
        repo_segments.join("/")
    ))
}

fn plugin_remote_repo_segments<'a>(host: &str, segments: &'a [&'a str]) -> Option<Vec<&'a str>> {
    if segments.len() < 2 {
        return None;
    }

    if let Some(marker_index) = segments
        .iter()
        .position(|segment| matches!(*segment, "tree" | "blob" | "-"))
    {
        if marker_index >= 2 {
            return Some(segments[..marker_index].to_vec());
        }
    }

    if host.ends_with("github.com") || host.ends_with("gitee.com") {
        return Some(vec![segments[0], segments[1].trim_end_matches(".git")]);
    }

    Some(
        segments
            .iter()
            .map(|segment| segment.trim_end_matches(".git"))
            .collect(),
    )
}

fn sync_cursor_local_git_copy(source_root: &Path, target_root: &Path) -> Result<(), String> {
    if link_cursor_plugin_dir_contents(source_root, target_root)? {
        return Ok(());
    }
    copy_cursor_plugin_dir(source_root, target_root)
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
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == ".git")
        {
            continue;
        }
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

fn cursor_disabled_plugins_root(home_dir: &Path) -> PathBuf {
    home_dir.join(CURSOR_DISABLED_PLUGIN_DIR)
}

fn is_under_cursor_disabled_plugins(home_dir: &Path, plugin_root: &Path) -> bool {
    plugin_root
        .strip_prefix(cursor_disabled_plugins_root(home_dir))
        .is_ok()
}

fn is_under_cursor_plugin_storage(home_dir: &Path, plugin_root: &Path) -> bool {
    is_under_cursor_local_plugins(home_dir, plugin_root)
        || is_under_cursor_disabled_plugins(home_dir, plugin_root)
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
    let local_label = plugin_root
        .strip_prefix(local_root)
        .ok()
        .and_then(|relative_path| relative_path.components().next())
        .and_then(|component| component.as_os_str().to_str())
        .unwrap_or_default()
        .to_string();
    if !local_label.is_empty() {
        return local_label;
    }

    plugin_root
        .strip_prefix(cursor_disabled_plugins_root(home_dir))
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
        "opencode" => 3,
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
    let normalized = value.trim().trim_end_matches('/').to_ascii_lowercase();

    if let Some((repo_url, branch_path)) = normalized.rsplit_once("/-/tree/") {
        if !repo_url.is_empty() && !branch_path.contains('/') {
            return repo_url.trim_end_matches(".git").to_string();
        }
    }
    if let Some((repo_url, branch_path)) = normalized.rsplit_once("/tree/") {
        if !repo_url.is_empty() && !branch_path.contains('/') {
            return repo_url.trim_end_matches(".git").to_string();
        }
    }

    normalized.trim_end_matches(".git").to_string()
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
    let (clone_url, source_ref, sparse_paths) =
        plugin_remote_clone_parts(source_url, source_ref, plugin_relative_path)?;
    with_temporary_discovery_repo_resolved(
        &clone_url,
        source_ref.as_deref(),
        &repo_key,
        &sparse_paths,
        None,
        |repo_root| {
            let target_root = if plugin_relative_path.trim().is_empty() {
                repo_root.to_path_buf()
            } else {
                repo_root.join(plugin_relative_path)
            };
            if !target_root.is_dir() {
                return Err(format!(
                    "远端插件目录不存在: {}",
                    target_root.to_string_lossy()
                ));
            }
            compute_plugin_dir_hash(&target_root)
        },
    )
}

fn build_installed_plugin_summary(
    descriptor: InstalledPluginDescriptor,
    scan_mode: PluginScanMode,
) -> Option<PluginSummary> {
    let manifest = read_plugin_manifest(&descriptor.manifest_path).ok()?;
    build_installed_plugin_summary_with_manifest(descriptor, scan_mode, manifest)
}

fn build_opencode_plugin_summary(
    home_dir: &Path,
    plugin_root: &Path,
    enabled_state: &str,
    scan_mode: PluginScanMode,
) -> Option<PluginSummary> {
    let manifest_path = first_opencode_plugin_entry(plugin_root)?;
    let manifest = opencode_plugin_manifest(plugin_root);
    let source_metadata = read_skilldock_plugin_source_metadata(plugin_root);
    let source_url = source_metadata
        .as_ref()
        .and_then(|metadata| non_empty_trimmed_string(&metadata.source_url))
        .unwrap_or_else(|| source_url_from_manifest(&manifest));
    let descriptor = InstalledPluginDescriptor {
        host_tool: "opencode".to_string(),
        root: plugin_root.to_path_buf(),
        display_root: opencode_user_plugins_root(home_dir),
        manifest_path,
        repo_root_override: None,
        plugin_relative_path_override: None,
        source_type: resolve_plugin_source_type(plugin_root, source_metadata.as_ref(), "local"),
        source_label: "skilldock".to_string(),
        source_url,
        source_ref: source_metadata
            .as_ref()
            .map(|metadata| metadata.source_ref.clone())
            .unwrap_or_default(),
        source_revision: source_metadata
            .as_ref()
            .map(|metadata| metadata.source_revision.clone())
            .unwrap_or_default(),
        current_version: String::new(),
        current_commit: String::new(),
        installed_at: String::new(),
        updated_at: String::new(),
        install_state: "installed".to_string(),
        install_source: "skilldock".to_string(),
        scopes: vec![build_plugin_scope_summary(
            "user",
            "用户级",
            enabled_state,
            &opencode_user_plugins_root(home_dir),
        )],
    };
    build_installed_plugin_summary_with_manifest(descriptor, scan_mode, manifest)
}

fn build_installed_plugin_summary_with_manifest(
    descriptor: InstalledPluginDescriptor,
    scan_mode: PluginScanMode,
    manifest: PluginManifest,
) -> Option<PluginSummary> {
    let root = canonicalize_existing_dir(&descriptor.root).ok()?;
    let display_root = descriptor.display_root;
    let git_root = descriptor
        .repo_root_override
        .as_ref()
        .and_then(|path| canonicalize_existing_dir(path).ok())
        .or_else(|| find_git_root(&root));
    let plugin_relative_path = descriptor
        .plugin_relative_path_override
        .clone()
        .or_else(|| {
            git_root
                .as_ref()
                .and_then(|repo_root| root.strip_prefix(repo_root).ok())
                .map(Path::to_path_buf)
        })
        .unwrap_or_default();
    let git_state = git_root
        .as_ref()
        .map(|repo_root| plugin_git_state(repo_root, &plugin_relative_path))
        .unwrap_or_default();
    let plugin_id = build_plugin_id(&descriptor.host_tool, &manifest, &root);
    let components = collect_asset_components(&root, &plugin_id);
    let modified_at = plugin_modified_timestamp(&root, &descriptor.manifest_path, scan_mode);
    let last_scanned_at = current_timestamp_millis();
    let raw_source_url = if descriptor.source_url.trim().is_empty() {
        source_url_from_manifest(&manifest)
    } else {
        descriptor.source_url.clone()
    };
    let source_url = display_source_url(&raw_source_url);
    let update_mode = if git_root.is_some()
        || descriptor.source_type == "marketplace"
        || !source_url.trim().is_empty()
    {
        "auto"
    } else {
        "unsupported"
    };
    let git_update_root = if descriptor.source_type == "git" {
        git_root.as_deref()
    } else {
        None
    };
    let update_strategy =
        resolve_plugin_update_strategy(git_update_root, &source_url, &plugin_relative_path);
    let base_summary = PluginSummary {
        id: plugin_id,
        package_id: plugin_package_id(&source_url, git_root.as_deref(), &plugin_relative_path),
        manifest_name: manifest.name.trim().to_string(),
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
        local_modified_source: String::new(),
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
        return shared_plugin_package_id_candidates(source_url, plugin_relative_path, None)
            .into_iter()
            .next()
            .unwrap_or_default();
    }
    git_root
        .map(path_to_string)
        .and_then(|path| {
            shared_plugin_package_id_candidates(&path, plugin_relative_path, None)
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
        let mut command = git_command();
        configure_git_network_command(&mut command);
        let result = command
            .args(["-C", &repo_key, "fetch", "origin", "--quiet", "--no-tags"])
            .output();
        let _ = tx.send(result);
    });
    let _ = rx.recv_timeout(Duration::from_secs(5));
}

fn load_plugin_update_cache() -> PluginUpdateCache {
    let Some((_, contents)) = workspace_file_candidates(PLUGIN_UPDATE_CACHE_FILE_NAME)
        .into_iter()
        .find_map(|path| {
            fs::read_to_string(&path)
                .ok()
                .map(|contents| (path, contents))
        })
    else {
        return PluginUpdateCache::default();
    };
    let mut cache = serde_json::from_str(&contents).unwrap_or_default();
    if prune_stale_plugin_update_cache(&mut cache) {
        let _ = save_plugin_update_cache(&cache);
    }
    cache
}

fn prune_stale_plugin_update_cache(cache: &mut PluginUpdateCache) -> bool {
    let original_git_len = cache.git_entries.len();
    let original_pending_len = cache.git_pending_entries.len();
    let original_hash_len = cache.hash_entries.len();

    cache
        .git_entries
        .retain(|entry| plugin_cache_root_exists(&entry.root_path));
    cache
        .git_pending_entries
        .retain(|entry| plugin_cache_root_exists(&entry.root_path));
    cache
        .hash_entries
        .retain(|entry| plugin_cache_root_exists(&entry.root_path));
    let git_entries = cache.git_entries.clone();
    cache
        .git_pending_entries
        .retain(|entry| plugin_pending_push_cache_entry_is_current(entry, &git_entries));

    cache.git_entries.len() != original_git_len
        || cache.git_pending_entries.len() != original_pending_len
        || cache.hash_entries.len() != original_hash_len
}

fn plugin_cache_root_exists(root_path: &str) -> bool {
    let trimmed = root_path.trim();
    !trimmed.is_empty() && Path::new(trimmed).exists()
}

fn save_plugin_update_cache(cache: &PluginUpdateCache) -> Result<(), String> {
    let cache_file = plugin_update_cache_file().ok_or_else(|| "无法定位用户目录".to_string())?;
    let parent_dir = cache_file
        .parent()
        .ok_or_else(|| "插件更新缓存目录无效".to_string())?;
    fs::create_dir_all(parent_dir).map_err(|error| format!("创建插件更新缓存目录失败: {error}"))?;
    let payload = serde_json::to_string_pretty(cache)
        .map_err(|error| format!("序列化插件更新缓存失败: {error}"))?;
    fs::write(cache_file, payload).map_err(|error| format!("写入插件更新缓存失败: {error}"))?;
    remove_legacy_workspace_file(PLUGIN_UPDATE_CACHE_FILE_NAME);
    Ok(())
}

fn plugin_root_cache_key(plugin: &PluginSummary) -> String {
    plugin.root_path.clone()
}

fn plugin_cache_matches_host_and_root(
    host_tool: &str,
    root_path: &str,
    plugin: &PluginSummary,
) -> bool {
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
    let git_entries = cache.git_entries;
    cache.git_pending_entries.into_iter().find(|entry| {
        entry.host_tool == plugin.host_tool
            && entry.root_path == plugin_root_cache_key(plugin)
            && entry.branch == branch
            && entry.head == head
            && entry.working_tree_signature == working_tree_signature
            && plugin_pending_push_cache_entry_is_current(entry, &git_entries)
    })
}

fn cached_hash_entry(plugin: &PluginSummary) -> Option<PluginHashCacheEntry> {
    let _guard = lock_plugin_update_cache();
    let cache = load_plugin_update_cache();
    cache.hash_entries.into_iter().find(|entry| {
        entry.host_tool == plugin.host_tool && entry.root_path == plugin_root_cache_key(plugin)
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

fn clear_plugin_pending_push_cache_entry(plugin: &PluginSummary) {
    let _guard = lock_plugin_update_cache();
    let mut cache = load_plugin_update_cache();
    let root_key = plugin_root_cache_key(plugin);
    cache
        .git_pending_entries
        .retain(|entry| !(entry.host_tool == plugin.host_tool && entry.root_path == root_key));
    let _ = save_plugin_update_cache(&cache);
}

fn plugin_pending_push_cache_entry_is_current(
    entry: &PluginPendingPushCacheEntry,
    git_entries: &[PluginGitCacheEntry],
) -> bool {
    if !entry.working_tree_signature.trim().is_empty() {
        return true;
    }
    if entry.ahead == 0 {
        return false;
    }
    !git_entries.iter().any(|git_entry| {
        git_entry.host_tool == entry.host_tool
            && git_entry.root_path == entry.root_path
            && git_entry.branch == entry.branch
            && git_entry.head == entry.head
            && git_entry.ahead == 0
    })
}

fn cached_plugin_local_collab_status(entry: &PluginPendingPushCacheEntry) -> &'static str {
    if entry.working_tree_signature.trim().is_empty() {
        PLUGIN_STATUS_PENDING_PUSH
    } else {
        PLUGIN_STATUS_PENDING_COMMIT
    }
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
    cache
        .git_entries
        .retain(|entry| !(entry.host_tool == plugin.host_tool && entry.root_path == root_key));
    cache
        .git_pending_entries
        .retain(|entry| !(entry.host_tool == plugin.host_tool && entry.root_path == root_key));
    cache
        .hash_entries
        .retain(|entry| !(entry.host_tool == plugin.host_tool && entry.root_path == root_key));
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

    let remote_counts = local_branch_divergence_counts(repo_root, &branch, &scoped_path);
    let (collab_status, status_text, update_available) =
        derive_plugin_collab_status(working_tree_dirty, remote_counts);
    let latest_local_commit_metadata =
        latest_plugin_commit_metadata_for_ref(repo_root, None, &scoped_path).unwrap_or_default();
    let latest_remote_commit_metadata = if !branch.is_empty() && branch != "HEAD" {
        resolve_remote_branch(repo_root, &branch).and_then(|remote_branch| {
            latest_plugin_commit_metadata_for_ref(
                repo_root,
                Some(remote_branch.as_str()),
                &scoped_path,
            )
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
        .committer
        .clone()
        .or_else(|| latest_local_commit_metadata.committer.clone())
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
        if let Some(entry) =
            cached_pending_push_entry(&plugin, &branch, &head, &working_tree_signature)
        {
            let mut enriched = plugin.clone();
            enriched.current_branch = branch;
            enriched.current_commit = commit;
            enriched.collab_status = cached_plugin_local_collab_status(&entry).to_string();
            enriched.status_text = if enriched.collab_status == PLUGIN_STATUS_PENDING_COMMIT {
                "本地存在未提交修改，已使用上次检测结果。".to_string()
            } else {
                "本地存在待推送提交，已使用上次检测结果。".to_string()
            };
            enriched.local_updated_at = local_updated_at;
            enriched.last_scanned_at = "已缓存".to_string();
            return enriched;
        }

        if let Some(entry) = cached_git_update_entry(&plugin, &branch, &head) {
            let mut enriched = plugin.clone();
            enriched.current_branch = branch;
            enriched.current_commit = commit;
            enriched.collab_status = if entry.behind > 0 && (entry.ahead > 0 || working_tree_dirty)
            {
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
    let remote_counts = local_branch_divergence_counts(repo_root, &git_state.branch, &scoped_path);

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
        } else {
            clear_plugin_pending_push_cache_entry(&plugin);
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
    committer: Option<String>,
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
    args.push("--pretty=format:%cd%x00%cn".to_string());
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
    let committer = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    Some(PluginCommitMetadata {
        updated_at,
        committer,
    })
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
        commit_updated_at
            .or_else(|| latest_plugin_local_content_modified_at(repo_root, scoped_path))
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

fn plugin_modified_timestamp(
    root: &Path,
    manifest_path: &Path,
    scan_mode: PluginScanMode,
) -> String {
    let modified = if scan_mode == PluginScanMode::Refresh {
        latest_modified_in_directory(root)
    } else {
        None
    };

    modified
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().to_string())
        .or_else(|| file_modified_timestamp(manifest_path))
        .unwrap_or_default()
}

fn derive_plugin_collab_status(
    working_tree_dirty: bool,
    remote_counts: Option<(usize, usize)>,
) -> (&'static str, String, bool) {
    if working_tree_dirty {
        return (
            PLUGIN_STATUS_PENDING_COMMIT,
            "本地存在未提交修改，请先提交后再推送。".to_string(),
            false,
        );
    }

    let Some((behind, ahead)) = remote_counts else {
        return (PLUGIN_STATUS_CLEAN, "插件目录已是最新。".to_string(), false);
    };

    if behind > 0 && ahead > 0 {
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
    if ahead > 0 {
        return (
            PLUGIN_STATUS_PENDING_PUSH,
            "本地存在待推送提交。".to_string(),
            false,
        );
    }

    (PLUGIN_STATUS_CLEAN, "插件目录已是最新。".to_string(), false)
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
    on_progress: Option<&CloneProgressCallback>,
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

    // 先尝试 GitHub API 快速路径
    let early_source_url = plugin_probe_source_url(&source_spec);
    if let Ok(Some(mut probes)) = detect_remote_github_plugin_candidates(
        &early_source_url,
        &source_spec,
        hint_host_tool.clone(),
    ) {
        if let Some(probe) = probes.pop() {
            return Ok(probe);
        }
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

    if let Some(probe) = probe_cached_plugin_source(
        &source_spec,
        &repo_key,
        hint_host_tool.clone(),
        |root, hint| Ok(probe_plugin_root(root, hint)),
    ) {
        return Ok(probe);
    }

    with_remote_plugin_discovery_repo(
        &source_spec,
        &sparse_paths,
        on_progress,
        |repo_root, spec| {
            let resolved_source_url = plugin_probe_source_url(spec);
            let probe_root = spec
                .relative_path
                .as_ref()
                .map(|path| repo_root.join(path))
                .unwrap_or_else(|| repo_root.to_path_buf());
            canonicalize_existing_dir(&probe_root).map(|root| {
                annotate_plugin_probe_source(
                    probe_plugin_root(&root, hint_host_tool.clone()),
                    &resolved_source_url,
                    repo_root,
                )
            })
        },
    )
}

fn probe_plugin_source_candidates_blocking(
    source: &str,
    git_ref: Option<&str>,
    sparse_path: Option<&str>,
    hint_host_tool: Option<String>,
    on_progress: Option<&CloneProgressCallback>,
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

    // 先尝试 GitHub API 快速路径（无需 git ls-remote，纯 HTTP API）
    let early_source_url = plugin_probe_source_url(&source_spec);
    if let Ok(Some(probes)) = detect_remote_github_plugin_candidates(
        &early_source_url,
        &source_spec,
        hint_host_tool.clone(),
    ) {
        return Ok(probes);
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

    if let Some(probes) = probe_cached_plugin_source(
        &source_spec,
        &repo_key,
        hint_host_tool.clone(),
        |root, hint| Ok(probe_plugin_candidates(root, hint)),
    ) {
        return Ok(probes);
    }

    // GitHub API 和本地发现缓存均未命中时再做实际 clone；HTTP 失败后再尝试 SSH。
    with_remote_plugin_discovery_repo(
        &source_spec,
        &sparse_paths,
        on_progress,
        |repo_root, spec| {
            let resolved_source_url = plugin_probe_source_url(spec);
            let probe_root = spec
                .relative_path
                .as_ref()
                .map(|path| repo_root.join(path))
                .unwrap_or_else(|| repo_root.to_path_buf());
            canonicalize_existing_dir(&probe_root).map(|root| {
                probe_plugin_candidates(&root, hint_host_tool.clone())
                    .into_iter()
                    .map(|probe| {
                        annotate_plugin_probe_source(probe, &resolved_source_url, repo_root)
                    })
                    .collect()
            })
        },
    )
}

fn with_remote_plugin_discovery_repo<T, F>(
    source_spec: &crate::library::MarketSourceSpec,
    sparse_paths: &[String],
    on_progress: Option<&CloneProgressCallback>,
    mut callback: F,
) -> Result<T, String>
where
    F: FnMut(&Path, &crate::library::MarketSourceSpec) -> Result<T, String>,
{
    let repository_url = repository_url_from_clone_url(&source_spec.clone_url);
    let candidates = remote_clone_candidates(&source_spec.clone_url, &repository_url);
    if candidates.is_empty() {
        return Err("仓库地址解析失败: clone URL 为空".to_string());
    }

    let mut failures = Vec::new();
    for candidate in candidates {
        let candidate_spec = crate::library::MarketSourceSpec {
            clone_url: candidate.url.clone(),
            branch: source_spec.branch.clone(),
            relative_path: source_spec.relative_path.clone(),
            tree_segments: source_spec.tree_segments.clone(),
        };
        let repo_key = plugin_discovery_repo_key(
            &candidate_spec.clone_url,
            candidate_spec.branch.as_deref(),
            candidate_spec.relative_path.as_ref(),
        );
        match with_temporary_discovery_repo_resolved(
            &candidate_spec.clone_url,
            candidate_spec.branch.as_deref(),
            &repo_key,
            sparse_paths,
            on_progress,
            |repo_root| callback(repo_root, &candidate_spec),
        ) {
            Ok(result) => return Ok(result),
            Err(error) => failures.push(format!(
                "{} {}: {}",
                candidate.label,
                candidate.url,
                summarize_git_error(&error)
            )),
        }
    }

    Err(format!(
        "无法克隆远端仓库。已先尝试 HTTP，失败后尝试 SSH，均未成功。\n{}",
        failures.join("\n")
    ))
}

fn probe_cached_plugin_source<T, F>(
    source_spec: &crate::library::MarketSourceSpec,
    repo_key: &str,
    hint_host_tool: Option<String>,
    probe: F,
) -> Option<T>
where
    F: FnOnce(&Path, Option<String>) -> Result<T, String>,
    T: AnnotateCachedPluginProbeSource,
{
    let repo_root = repo_cache_directory(repo_key).ok()?;
    if !repo_root.join(".git").is_dir() {
        return None;
    }

    let probe_root = source_spec
        .relative_path
        .as_ref()
        .map(|path| repo_root.join(path))
        .unwrap_or_else(|| repo_root.clone());
    let canonical_probe_root = canonicalize_existing_dir(&probe_root).ok()?;
    let source_url = plugin_probe_source_url(source_spec);
    let source_ref = source_spec.branch.as_deref().unwrap_or_default();
    probe(&canonical_probe_root, hint_host_tool)
        .ok()
        .map(|result| {
            annotate_cached_plugin_probe_source(result, &source_url, source_ref, &repo_root)
        })
}

trait AnnotateCachedPluginProbeSource {
    fn annotate_cached(self, source_url: &str, source_ref: &str, repo_root: &Path) -> Self;
}

impl AnnotateCachedPluginProbeSource for PluginProbeResult {
    fn annotate_cached(self, source_url: &str, source_ref: &str, repo_root: &Path) -> Self {
        let mut probe = annotate_plugin_probe_source(self, source_url, repo_root);
        probe.source_ref = source_ref.to_string();
        probe
    }
}

impl AnnotateCachedPluginProbeSource for Vec<PluginProbeResult> {
    fn annotate_cached(self, source_url: &str, source_ref: &str, repo_root: &Path) -> Self {
        self.into_iter()
            .map(|probe| {
                let mut probe = annotate_plugin_probe_source(probe, source_url, repo_root);
                probe.source_ref = source_ref.to_string();
                probe
            })
            .collect()
    }
}

fn annotate_cached_plugin_probe_source<T>(
    result: T,
    source_url: &str,
    source_ref: &str,
    repo_root: &Path,
) -> T
where
    T: AnnotateCachedPluginProbeSource,
{
    result.annotate_cached(source_url, source_ref, repo_root)
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

fn plugin_remote_clone_parts(
    source_url: &str,
    source_ref: &str,
    plugin_relative_path: &str,
) -> Result<(String, Option<String>, Vec<String>), String> {
    let mut source_spec = parse_market_source_url(source_url)?;
    if let Some(explicit_ref) = non_empty_trimmed_string(source_ref) {
        source_spec.branch = Some(explicit_ref);
    }
    let sparse_paths = if plugin_relative_path.trim().is_empty() {
        source_spec
            .relative_path
            .as_ref()
            .map(|path| vec![normalize_relative_path(path)])
            .unwrap_or_default()
    } else {
        vec![plugin_relative_path.to_string()]
    };
    Ok((source_spec.clone_url, source_spec.branch, sparse_paths))
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

fn repository_url_from_clone_url(clone_url: &str) -> String {
    let trimmed = clone_url.trim().trim_end_matches(".git");
    if let Ok(parsed) = url::Url::parse(trimmed) {
        if let Some(host) = parsed.host_str() {
            let segments = parsed
                .path_segments()
                .map(|items| items.filter(|item| !item.is_empty()).collect::<Vec<_>>())
                .unwrap_or_default();
            if segments.len() >= 2 {
                return format!(
                    "https://{}/{}/{}",
                    host,
                    segments[0],
                    segments[1].trim_end_matches(".git")
                );
            }
        }
    }

    if let Some((_, rest)) = trimmed.split_once('@') {
        if let Some((host, path)) = rest.split_once(':') {
            let segments = path
                .split('/')
                .filter(|segment| !segment.is_empty())
                .collect::<Vec<_>>();
            if segments.len() >= 2 {
                return format!(
                    "https://{}/{}/{}",
                    host,
                    segments[0],
                    segments[1].trim_end_matches(".git")
                );
            }
        }
    }

    trimmed.to_string()
}

fn plugin_probe_source_url(source_spec: &crate::library::MarketSourceSpec) -> String {
    let clone_url = source_spec.clone_url.trim().trim_end_matches(".git");
    let Some(branch) = source_spec
        .branch
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return clone_url.to_string();
    };
    let mut url = format!("{clone_url}/tree/{branch}");
    if let Some(relative_path) = source_spec.relative_path.as_ref() {
        let normalized = normalize_relative_path(relative_path);
        if !normalized.is_empty() {
            url.push('/');
            url.push_str(&normalized);
        }
    }
    url
}

fn github_owner_repo_from_clone_url(clone_url: &str) -> Option<String> {
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

fn fetch_github_json<T: serde::de::DeserializeOwned>(
    owner_repo: &str,
    path: &str,
    git_ref: Option<&str>,
    timeout_seconds: u64,
) -> Result<T, String> {
    let mut url = format!("https://api.github.com/repos/{owner_repo}/{path}");
    if let Some(branch) = git_ref.filter(|value| !value.trim().is_empty()) {
        url.push_str("?ref=");
        url.push_str(&branch.replace('/', "%2F"));
    }
    let mut command = Command::new("curl");
    configure_hidden_subprocess(&mut command);
    let output = command
        .args([
            "-LsS",
            "--fail",
            "--max-time",
            &timeout_seconds.to_string(),
            "-H",
            "Accept: application/vnd.github.v3+json",
            "-H",
            "User-Agent: skilldock/0.1",
            &url,
        ])
        .output()
        .map_err(|error| format!("执行 GitHub 请求失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "GitHub 请求失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice::<T>(&output.stdout)
        .map_err(|error| format!("解析 GitHub JSON 失败: {error}"))
}

fn fetch_github_contents(
    owner_repo: &str,
    root: &Path,
    git_ref: Option<&str>,
) -> Result<Vec<GitHubContentEntry>, String> {
    let path = if root.as_os_str().is_empty() {
        "contents".to_string()
    } else {
        let encoded_path = root
            .to_string_lossy()
            .split('/')
            .map(percent_encode_path_segment)
            .collect::<Vec<_>>()
            .join("/");
        format!("contents/{encoded_path}")
    };
    fetch_github_json::<Vec<GitHubContentEntry>>(owner_repo, &path, git_ref, 8)
}

fn fetch_github_file_entry(
    owner_repo: &str,
    relative_path: &Path,
    git_ref: Option<&str>,
) -> Result<GitHubContentEntry, String> {
    let encoded_path = relative_path
        .to_string_lossy()
        .split('/')
        .map(percent_encode_path_segment)
        .collect::<Vec<_>>()
        .join("/");
    fetch_github_json::<GitHubContentEntry>(
        owner_repo,
        &format!("contents/{encoded_path}"),
        git_ref,
        8,
    )
}

fn fetch_github_tree(
    owner_repo: &str,
    git_ref: Option<&str>,
) -> Result<GitHubTreeResponse, String> {
    let branch = git_ref
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("HEAD");
    fetch_github_json::<GitHubTreeResponse>(
        owner_repo,
        &format!("git/trees/{}?recursive=1", branch.replace('/', "%2F")),
        None,
        12,
    )
}

fn decode_github_base64(content: &str) -> Result<Vec<u8>, String> {
    let normalized = content.lines().collect::<String>();
    BASE64_STANDARD
        .decode(normalized.as_bytes())
        .map_err(|error| format!("解码 GitHub 文件内容失败: {error}"))
}

fn parse_github_plugin_manifest(
    owner_repo: &str,
    manifest_relative_path: &Path,
    git_ref: Option<&str>,
) -> Result<PluginManifest, String> {
    let entry = fetch_github_file_entry(owner_repo, manifest_relative_path, git_ref)?;
    if entry.entry_type != "file" {
        return Err(format!(
            "GitHub 路径不是文件: {}",
            manifest_relative_path.display()
        ));
    }
    if entry.encoding != "base64" {
        return Err(format!(
            "GitHub 文件编码不支持: {}",
            manifest_relative_path.display()
        ));
    }
    let bytes = decode_github_base64(&entry.content)?;
    serde_json::from_slice::<PluginManifest>(&bytes)
        .map_err(|error| format!("解析远端插件 manifest 失败: {error}"))
}

fn remote_component_summary(
    name: &str,
    relative_path: PathBuf,
    asset_type: &str,
) -> PluginComponentSummary {
    PluginComponentSummary {
        id: normalize_relative_path(&relative_path),
        name: name.to_string(),
        description: component_fallback_description(asset_type).to_string(),
        asset_type: asset_type.to_string(),
        owner_plugin_id: String::new(),
        package_item_id: normalize_relative_path(&relative_path),
    }
}

fn collect_remote_plugin_components(
    owner_repo: &str,
    root: &Path,
    git_ref: Option<&str>,
) -> Result<Vec<PluginComponentSummary>, String> {
    let mut components = Vec::new();
    let tree = fetch_github_tree(owner_repo, git_ref)?;
    let root_prefix = normalize_relative_path(root);
    let with_root = |path: &str| {
        if root_prefix.is_empty() {
            path.to_string()
        } else {
            format!("{root_prefix}/{path}")
        }
    };

    for entry in tree.tree {
        let relative_path = entry.path;
        let trimmed = if root_prefix.is_empty() {
            relative_path.clone()
        } else if let Some(rest) = relative_path.strip_prefix(&format!("{root_prefix}/")) {
            rest.to_string()
        } else {
            continue;
        };
        if trimmed.is_empty() {
            continue;
        }
        let segments = trimmed.split('/').collect::<Vec<_>>();
        match entry.entry_type.as_str() {
            "blob" => {
                if segments.len() == 3 && segments[0] == "skills" && segments[2] == "SKILL.md" {
                    components.push(remote_component_summary(
                        segments[1],
                        PathBuf::from(&relative_path)
                            .parent()
                            .unwrap_or(Path::new(""))
                            .to_path_buf(),
                        "skill",
                    ));
                    continue;
                }
                if segments.len() == 2
                    && matches!(
                        segments[0],
                        "commands" | "bin" | "rules" | "hooks" | "agents" | "subagents"
                    )
                {
                    let asset_type = match segments[0] {
                        "commands" | "bin" => "command",
                        "rules" => "rule",
                        "hooks" => "hook",
                        "agents" | "subagents" => "subagent",
                        _ => continue,
                    };
                    components.push(remote_component_summary(
                        segments[1],
                        PathBuf::from(&relative_path),
                        asset_type,
                    ));
                    continue;
                }
                if relative_path == with_root("mcp.json")
                    || relative_path == with_root(".mcp.json")
                    || relative_path == with_root(".cursor/mcp.json")
                {
                    components.push(remote_component_summary(
                        Path::new(&relative_path)
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("mcp"),
                        PathBuf::from(&relative_path),
                        "mcp",
                    ));
                }
            }
            "tree" => {
                if segments.len() == 2 && matches!(segments[0], "agents" | "subagents") {
                    components.push(remote_component_summary(
                        segments[1],
                        PathBuf::from(&relative_path),
                        "subagent",
                    ));
                }
            }
            _ => {}
        }
    }

    components.sort_by(|left, right| {
        left.asset_type
            .cmp(&right.asset_type)
            .then(left.name.cmp(&right.name))
            .then(left.id.cmp(&right.id))
    });
    components.dedup_by(|left, right| left.id == right.id && left.asset_type == right.asset_type);
    Ok(components)
}

fn remote_plugin_root_for_source(relative_path: Option<&PathBuf>) -> PathBuf {
    relative_path.cloned().unwrap_or_default()
}

fn build_remote_plugin_probe(
    owner_repo: &str,
    source_url: &str,
    git_ref: Option<&str>,
    plugin_root_relative_path: &Path,
    manifest_relative_path: &Path,
    manifest: &PluginManifest,
    compatible_host_tools: Vec<String>,
    selected_host_tool: &str,
    warning: Option<String>,
) -> Result<PluginProbeResult, String> {
    let description = plugin_description(manifest);
    let name = plugin_display_name(manifest, plugin_root_relative_path);
    let warnings = warning.into_iter().collect::<Vec<_>>();
    let plugin_root = plugin_root_relative_path.to_string_lossy().to_string();
    let manifest_path = manifest_relative_path.to_string_lossy().to_string();
    Ok(PluginProbeResult {
        tool: selected_host_tool.to_string(),
        compatible_host_tools,
        kind: "plugin-repo".to_string(),
        manifest_name: manifest.name.trim().to_string(),
        name,
        description,
        plugin_root: plugin_root.clone(),
        repo_root: String::new(),
        plugin_relative_path: normalize_relative_path(plugin_root_relative_path),
        manifest_path,
        marketplace_manifest_path: String::new(),
        components: collect_remote_plugin_components(
            owner_repo,
            plugin_root_relative_path,
            git_ref,
        )?,
        source_type: "git".to_string(),
        source_url: source_url.trim().to_string(),
        source_ref: git_ref.unwrap_or_default().to_string(),
        is_git_repo: true,
        git_root: String::new(),
        confidence: "high".to_string(),
        install_strategy: install_strategy_for_plugin_tool(selected_host_tool).to_string(),
        warnings,
    })
}

fn detect_remote_github_plugin_candidates(
    source_url: &str,
    source_spec: &crate::library::MarketSourceSpec,
    hint_host_tool: Option<String>,
) -> Result<Option<Vec<PluginProbeResult>>, String> {
    let Some(owner_repo) = github_owner_repo_from_clone_url(&source_spec.clone_url) else {
        return Ok(None);
    };

    let plugin_root = remote_plugin_root_for_source(source_spec.relative_path.as_ref());
    let entries = fetch_github_contents(&owner_repo, &plugin_root, source_spec.branch.as_deref())?;
    let entry_names = entries
        .iter()
        .map(|entry| (entry.name.as_str(), entry.entry_type.as_str()))
        .collect::<BTreeMap<_, _>>();
    let manifest_candidates = [
        (
            "claude-code",
            plugin_root.join(CLAUDE_PLUGIN_MANIFEST),
            ".claude-plugin",
        ),
        (
            "cursor",
            plugin_root.join(CURSOR_PLUGIN_MANIFEST),
            ".cursor-plugin",
        ),
        (
            "codex",
            plugin_root.join(CODEX_PLUGIN_MANIFEST),
            ".codex-plugin",
        ),
    ];
    let mut detected = manifest_candidates
        .into_iter()
        .filter(|(_, _, marker_dir)| entry_names.get(marker_dir) == Some(&"dir"))
        .map(|(tool, path, _)| (tool, path))
        .collect::<Vec<_>>();
    if entry_names.get(".opencode") == Some(&"dir") {
        let opencode_root = plugin_root.join(".opencode");
        let opencode_entries =
            fetch_github_contents(&owner_repo, &opencode_root, source_spec.branch.as_deref())?;
        if opencode_entries
            .iter()
            .any(|entry| entry.name == "plugins" && entry.entry_type == "dir")
        {
            let opencode_plugins_root = plugin_root.join(OPENCODE_PLUGIN_DIR);
            let mut opencode_plugin_entries = fetch_github_contents(
                &owner_repo,
                &opencode_plugins_root,
                source_spec.branch.as_deref(),
            )?
            .into_iter()
            .filter(|entry| {
                entry.entry_type == "file"
                    && matches!(
                        Path::new(&entry.name)
                            .extension()
                            .and_then(|value| value.to_str())
                            .map(str::to_ascii_lowercase)
                            .as_deref(),
                        Some("js") | Some("ts")
                    )
            })
            .collect::<Vec<_>>();
            opencode_plugin_entries.sort_by(|left, right| left.name.cmp(&right.name));
            if let Some(entry) = opencode_plugin_entries.first() {
                detected.push(("opencode", opencode_plugins_root.join(&entry.name)));
            }
        }
    }
    if detected.is_empty() {
        return Ok(None);
    }
    let selected_index = hint_host_tool
        .as_deref()
        .and_then(|hint| detected.iter().position(|(tool, _)| *tool == hint))
        .unwrap_or(0);
    let compatible_host_tools = detected
        .iter()
        .map(|(tool, _)| (*tool).to_string())
        .collect::<Vec<_>>();
    let (selected_tool, selected_manifest_path) = &detected[selected_index];
    let selected_manifest = if *selected_tool == "opencode" {
        PluginManifest {
            name: plugin_root
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| owner_repo.rsplit('/').next().unwrap_or("opencode-plugin"))
                .to_string(),
            ..PluginManifest::default()
        }
    } else {
        parse_github_plugin_manifest(
            &owner_repo,
            selected_manifest_path,
            source_spec.branch.as_deref(),
        )?
    };
    let warning = if detected.len() > 1 {
        Some(format!(
            "发现多个官方插件清单，已优先使用 {}",
            selected_tool
        ))
    } else {
        None
    };
    Ok(Some(vec![build_remote_plugin_probe(
        &owner_repo,
        source_url,
        source_spec.branch.as_deref(),
        &plugin_root,
        selected_manifest_path,
        &selected_manifest,
        compatible_host_tools,
        selected_tool,
        warning,
    )?]))
}

fn canonicalize_existing_dir(path: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err(format!(
            "插件目录不存在: {}",
            workspace::display_path_value(&path.to_string_lossy())
        ));
    }
    if !path.is_dir() {
        return Err(format!(
            "插件探测仅支持目录路径: {}",
            workspace::display_path_value(&path.to_string_lossy())
        ));
    }
    fs::canonicalize(path).map_err(|error| {
        format!(
            "解析插件目录失败（{}）: {error}",
            workspace::display_path_value(&path.to_string_lossy())
        )
    })
}

fn detect_plugin_repo(
    root: &Path,
    git_root: Option<&Path>,
    hint_host_tool: Option<&str>,
) -> Option<PluginProbeResult> {
    let mut manifest_candidates = vec![
        ("claude-code", root.join(CLAUDE_PLUGIN_MANIFEST)),
        ("cursor", root.join(CURSOR_PLUGIN_MANIFEST)),
        ("codex", root.join(CODEX_PLUGIN_MANIFEST)),
    ];
    if let Some(entrypoint) = first_opencode_plugin_entry(root) {
        manifest_candidates.push(("opencode", entrypoint));
    }
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
        "opencode" => "opencode-plugin-link",
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
    let manifest_name = args
        .manifest_path
        .and_then(|path| read_plugin_manifest(path).ok())
        .map(|manifest| manifest.name.trim().to_string())
        .unwrap_or_default();
    PluginProbeResult {
        tool: args.tool.to_string(),
        compatible_host_tools: args.compatible_host_tools,
        kind: args.kind.to_string(),
        manifest_name,
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
        source_ref: String::new(),
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

fn build_plugin_component_preview(
    root: &Path,
    component_id: &str,
    asset_type: String,
    preview_path: &Path,
    content: String,
) -> PluginComponentPreview {
    let relative_path = preview_path
        .strip_prefix(root)
        .map(normalize_relative_path)
        .unwrap_or_else(|_| path_to_string(preview_path));
    let (root_name, entries, initial_file_path) =
        plugin_component_file_browser(root, component_id, &asset_type, preview_path)
            .unwrap_or_else(|| single_file_plugin_component_browser(&relative_path));

    PluginComponentPreview {
        path: relative_path.clone(),
        title: component_preview_title(component_id, &relative_path),
        asset_type,
        content,
        root_name,
        entries,
        initial_file_path,
    }
}

fn build_virtual_plugin_component_preview(
    path: &str,
    title: &str,
    asset_type: &str,
    content: String,
) -> PluginComponentPreview {
    let file_name = Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string();
    PluginComponentPreview {
        path: path.to_string(),
        title: title.to_string(),
        asset_type: asset_type.to_string(),
        content,
        root_name: title.to_string(),
        entries: vec![SkillFileEntry {
            path: path.to_string(),
            name: file_name,
            entry_type: "file".to_string(),
            depth: 0,
        }],
        initial_file_path: Some(path.to_string()),
    }
}

fn single_file_plugin_component_browser(
    relative_path: &str,
) -> (String, Vec<SkillFileEntry>, Option<String>) {
    let file_name = Path::new(relative_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(relative_path)
        .to_string();
    (
        file_name.clone(),
        vec![SkillFileEntry {
            path: relative_path.to_string(),
            name: file_name,
            entry_type: "file".to_string(),
            depth: 0,
        }],
        Some(relative_path.to_string()),
    )
}

fn plugin_component_file_browser(
    root: &Path,
    component_id: &str,
    asset_type: &str,
    preview_path: &Path,
) -> Option<(String, Vec<SkillFileEntry>, Option<String>)> {
    let component_root = component_browser_root_path(root, component_id, asset_type, preview_path)?;
    let root_name = component_root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(component_id)
        .to_string();
    let root_relative_path = component_root
        .strip_prefix(root)
        .map(normalize_relative_path)
        .unwrap_or_default();
    let mut entries = vec![SkillFileEntry {
        path: root_relative_path,
        name: root_name.clone(),
        entry_type: "directory".to_string(),
        depth: 0,
    }];
    collect_plugin_component_entries(root, &component_root, 1, &mut entries).ok()?;
    let preview_relative_path = preview_path
        .strip_prefix(root)
        .map(normalize_relative_path)
        .ok();
    let initial_file_path = preview_relative_path
        .filter(|path| {
            entries
                .iter()
                .any(|entry| entry.entry_type == "file" && entry.path == *path)
        })
        .or_else(|| {
            entries
                .iter()
                .find(|entry| entry.entry_type == "file")
                .map(|entry| entry.path.clone())
        });

    Some((root_name, entries, initial_file_path))
}

fn component_browser_root_path(
    root: &Path,
    component_id: &str,
    asset_type: &str,
    preview_path: &Path,
) -> Option<PathBuf> {
    if asset_type == "skill" {
        let mut current = if preview_path.is_file() {
            preview_path.parent()?.to_path_buf()
        } else {
            preview_path.to_path_buf()
        };
        while current.starts_with(root) {
            if current.join("SKILL.md").is_file() {
                return Some(current);
            }
            if !current.pop() {
                break;
            }
        }
    }

    let relative_path = safe_relative_path(component_id).ok()?;
    let candidate = root.join(relative_path);
    if candidate.is_dir() {
        return Some(candidate);
    }
    preview_path.parent().map(Path::to_path_buf)
}

fn is_supported_plugin_component_text_file(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    if file_name == "SKILL.md" {
        return true;
    }

    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some(
            "md" | "txt"
                | "json"
                | "yaml"
                | "yml"
                | "toml"
                | "xml"
                | "js"
                | "ts"
                | "tsx"
                | "jsx"
                | "py"
                | "rs"
        )
    )
}

fn collect_plugin_component_entries(
    root: &Path,
    current_path: &Path,
    depth: usize,
    entries: &mut Vec<SkillFileEntry>,
) -> Result<bool, String> {
    let mut child_paths = fs::read_dir(current_path)
        .map_err(|error| format!("读取插件组件目录失败: {error}"))?
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    child_paths.sort();

    let mut has_visible_child = false;

    for child_path in child_paths {
        let Some(name) = child_path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.starts_with('.') || matches!(name, "node_modules" | "dist" | "target") {
            continue;
        }

        if child_path.is_dir() {
            let directory_index = entries.len();
            let relative_path = child_path
                .strip_prefix(root)
                .map_err(|error| format!("解析插件组件目录路径失败: {error}"))
                .map(normalize_relative_path)?;
            entries.push(SkillFileEntry {
                path: relative_path,
                name: name.to_string(),
                entry_type: "directory".to_string(),
                depth,
            });
            let before_children = entries.len();
            let child_has_visible =
                collect_plugin_component_entries(root, &child_path, depth + 1, entries)?;
            if child_has_visible {
                has_visible_child = true;
            } else {
                entries.truncate(directory_index);
            }
            if child_has_visible || entries.len() > before_children {
                has_visible_child = true;
            }
            continue;
        }

        if !is_supported_plugin_component_text_file(&child_path) {
            continue;
        }

        let relative_path = child_path
            .strip_prefix(root)
            .map_err(|error| format!("解析插件组件文件路径失败: {error}"))
            .map(normalize_relative_path)?;
        entries.push(SkillFileEntry {
            path: relative_path,
            name: name.to_string(),
            entry_type: "file".to_string(),
            depth,
        });
        has_visible_child = true;
    }

    Ok(has_visible_child)
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
        "claude-code" | "cursor" | "codex" | "opencode" => Some(normalized),
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
    let path = resolve_command_in_path(command)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&path).ok()?.permissions().mode();
        if mode & 0o111 == 0 {
            return None;
        }
    }
    Some(workspace::display_path_string(&path))
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
    let now: chrono::DateTime<chrono::Utc> = SystemTime::now().into();
    now.format("%Y-%m-%dT%H:%M:%SZ").to_string()
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
    workspace::display_path_string(path)
}

fn display_source_url(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if trimmed.starts_with(r"\\?\")
        || trimmed.contains(":\\")
        || trimmed.starts_with(r"\\")
        || trimmed.starts_with('/')
    {
        return workspace::display_path_value(trimmed);
    }

    trimmed.to_string()
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
        configure_plugin_sparse_checkout, copy_plugin_dir, current_timestamp_rfc3339,
        dedupe_and_sort_plugins, delete_plugin, ensure_shared_plugin_repo,
        ensure_shared_plugin_repo_from_existing, ensure_skilldock_claude_marketplace,
        ensure_skilldock_codex_cache_link, ensure_skilldock_codex_marketplace,
        get_plugin_component_preview, install_selected_plugin_probes_blocking,
        legacy_plugin_package_identity_path, legacy_skilldock_plugin_source_metadata_path,
        list_cli_tools, list_installed_plugins_blocking as list_installed_plugins,
        paths_refer_to_same_dir, plugin_discovery_repo_key, plugin_git_state,
        plugin_probe_source_url, probe_plugin_repo, probe_plugin_source_candidates_blocking,
        read_plugin_package_identity, read_skilldock_plugin_source_metadata,
        resolve_shared_plugin_package_id, set_plugin_enabled, shared_plugin_package_id_candidates,
        shared_plugin_package_repo_root, write_plugin_package_identity,
        write_skilldock_plugin_source_metadata, PLUGIN_STATUS_PENDING_PUSH,
    };
    use crate::library::parse_market_source_url;
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

    #[test]
    fn current_timestamp_rfc3339_has_utc_suffix() {
        let value = current_timestamp_rfc3339();
        assert!(value.ends_with('Z'));
        assert!(value.contains('T'));
    }

    #[test]
    fn codex_plugin_host_accepts_chatgpt_app_name() {
        let spec = super::plugin_host_detection_spec("codex").expect("resolve Codex host");
        assert_eq!(spec.app_names, &["Codex", "ChatGPT"]);
    }

    #[test]
    fn plugin_host_detection_resolves_platform_command_files_from_path() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("plugin-host-command");
        let bin_dir = temp_dir.join("bin");
        fs::create_dir_all(&bin_dir).expect("create test bin");
        let executable_path = bin_dir.join(if cfg!(windows) {
            "claude.cmd"
        } else {
            "claude"
        });
        fs::write(&executable_path, "probe").expect("write host command");

        let previous_path = env::var_os("PATH");
        let mut search_paths = vec![bin_dir];
        if let Some(path) = &previous_path {
            search_paths.extend(env::split_paths(path));
        }
        env::set_var(
            "PATH",
            env::join_paths(search_paths).expect("build plugin host test PATH"),
        );

        let detected_path = super::find_plugin_host_executable_path("claude");

        match previous_path {
            Some(value) => env::set_var("PATH", value),
            None => env::remove_var("PATH"),
        }

        assert_eq!(detected_path, Some(executable_path));
        fs::remove_dir_all(temp_dir).expect("remove test directory");
    }

    fn run_git_test(current_dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .current_dir(current_dir)
            .args(args)
            .status()
            .expect("git command should run");
        assert!(status.success(), "git {:?} should succeed", args);
    }

    fn run_git_test_output(current_dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .current_dir(current_dir)
            .args(args)
            .output()
            .expect("git command should run");
        assert!(output.status.success(), "git {:?} should succeed", args);
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn commit_test_repo(repo_root: &Path, remote_url: Option<&str>) {
        run_git_test(repo_root, &["init", "-b", "main"]);
        run_git_test(repo_root, &["config", "user.name", "SkillDock Test"]);
        run_git_test(
            repo_root,
            &["config", "user.email", "skilldock-test@example.com"],
        );
        if let Some(remote_url) = remote_url {
            run_git_test(repo_root, &["remote", "add", "origin", remote_url]);
        }
        run_git_test(repo_root, &["add", "."]);
        run_git_test(repo_root, &["commit", "-m", "Initial plugin"]);
    }

    fn write_cli_logging_script(cli_path: &Path, log_path: &Path) {
        fs::write(
            cli_path,
            format!(
                "#!/bin/sh\nprintf '%s\n' \"$@\" >> \"{}\"\n",
                log_path.to_string_lossy()
            ),
        )
        .expect("write cli script");
        let mut permissions = fs::metadata(cli_path)
            .expect("read cli metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(cli_path, permissions).expect("set cli permissions");
    }

    #[test]
    fn prunes_stale_plugin_update_cache_entries() {
        let temp_dir = temp_test_dir("plugin-cache-prune");
        let existing_root = temp_dir.join("existing-plugin");
        let missing_root = temp_dir.join("missing-plugin");
        fs::create_dir_all(&existing_root).expect("create existing plugin root");
        let existing_root = existing_root.to_string_lossy().to_string();
        let missing_root = missing_root.to_string_lossy().to_string();

        let mut cache = super::PluginUpdateCache {
            git_entries: vec![
                super::PluginGitCacheEntry {
                    host_tool: "cursor".to_string(),
                    root_path: existing_root.clone(),
                    branch: "main".to_string(),
                    head: "existing".to_string(),
                    behind: 0,
                    ahead: 0,
                    remote_updated_at: String::new(),
                    last_editor: String::new(),
                },
                super::PluginGitCacheEntry {
                    host_tool: "cursor".to_string(),
                    root_path: missing_root.clone(),
                    branch: "main".to_string(),
                    head: "missing".to_string(),
                    behind: 1,
                    ahead: 1,
                    remote_updated_at: String::new(),
                    last_editor: String::new(),
                },
            ],
            git_pending_entries: vec![super::PluginPendingPushCacheEntry {
                host_tool: "cursor".to_string(),
                root_path: missing_root.clone(),
                branch: "main".to_string(),
                head: "missing".to_string(),
                working_tree_signature: String::new(),
                ahead: 1,
            }],
            hash_entries: vec![super::PluginHashCacheEntry {
                host_tool: "cursor".to_string(),
                root_path: missing_root,
                baseline_hash: "old".to_string(),
                current_hash: "new".to_string(),
                update_available: true,
            }],
        };

        assert!(super::prune_stale_plugin_update_cache(&mut cache));
        assert_eq!(cache.git_entries.len(), 1);
        assert_eq!(cache.git_entries[0].root_path, existing_root);
        assert!(cache.git_pending_entries.is_empty());
        assert!(cache.hash_entries.is_empty());
        assert!(!super::prune_stale_plugin_update_cache(&mut cache));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn prunes_clean_pending_push_plugin_cache_entries() {
        let temp_dir = temp_test_dir("plugin-clean-pending-cache-prune");
        let existing_root = temp_dir.join("existing-plugin");
        fs::create_dir_all(&existing_root).expect("create existing plugin root");
        let existing_root = existing_root.to_string_lossy().to_string();

        let mut cache = super::PluginUpdateCache {
            git_entries: vec![super::PluginGitCacheEntry {
                host_tool: "claude-code".to_string(),
                root_path: existing_root.clone(),
                branch: "main".to_string(),
                head: "clean-head".to_string(),
                behind: 0,
                ahead: 0,
                remote_updated_at: String::new(),
                last_editor: String::new(),
            }],
            git_pending_entries: vec![super::PluginPendingPushCacheEntry {
                host_tool: "claude-code".to_string(),
                root_path: existing_root,
                branch: "main".to_string(),
                head: "clean-head".to_string(),
                working_tree_signature: String::new(),
                ahead: 2,
            }],
            hash_entries: Vec::new(),
        };

        assert!(super::prune_stale_plugin_update_cache(&mut cache));
        assert!(cache.git_pending_entries.is_empty());
        assert!(!super::prune_stale_plugin_update_cache(&mut cache));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn dirty_plugin_worktree_is_pending_commit() {
        let (status, status_text, update_available) =
            super::derive_plugin_collab_status(true, Some((0, 2)));

        assert_eq!(status, super::PLUGIN_STATUS_PENDING_COMMIT);
        assert!(status_text.contains("未提交"));
        assert!(!update_available);
    }

    #[test]
    fn clean_plugin_worktree_with_ahead_commits_is_pending_push() {
        let (status, status_text, update_available) =
            super::derive_plugin_collab_status(false, Some((0, 2)));

        assert_eq!(status, super::PLUGIN_STATUS_PENDING_PUSH);
        assert!(status_text.contains("待推送"));
        assert!(!update_available);
    }

    #[test]
    fn unpublished_plugin_branch_is_pending_push_after_commit() {
        let temp_dir = temp_test_dir("plugin-unpublished-branch");
        let remote_repo = temp_dir.join("remote.git");
        let repo_root = temp_dir.join("repo");
        let plugin_root = repo_root.join("example-plugin");

        super::run_git_at(
            Path::new("."),
            &["init", "--bare", remote_repo.to_string_lossy().as_ref()],
        )
        .expect("init bare remote");
        super::run_git_at(&remote_repo, &["symbolic-ref", "HEAD", "refs/heads/main"])
            .expect("point remote HEAD at main");
        fs::create_dir_all(&plugin_root).expect("create plugin directory");
        fs::write(plugin_root.join("SKILL.md"), "# initial").expect("write plugin file");
        commit_test_repo(&repo_root, Some(remote_repo.to_string_lossy().as_ref()));
        run_git_test(&repo_root, &["push", "-u", "origin", "main"]);

        run_git_test(&repo_root, &["checkout", "-b", "feature/local-change"]);
        fs::write(plugin_root.join("SKILL.md"), "# changed").expect("update plugin file");
        run_git_test(&repo_root, &["add", "."]);
        run_git_test(&repo_root, &["commit", "-m", "Update plugin"]);

        assert_eq!(
            crate::git_divergence::local_branch_divergence_counts(
                &repo_root,
                "feature/local-change",
                "example-plugin",
            ),
            Some((0, 1))
        );

        run_git_test(
            &repo_root,
            &["push", "-u", "origin", "feature/local-change"],
        );
        assert_eq!(
            crate::git_divergence::local_branch_divergence_counts(
                &repo_root,
                "feature/local-change",
                "example-plugin",
            ),
            Some((0, 0))
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn cached_dirty_plugin_state_is_pending_commit() {
        let entry = super::PluginPendingPushCacheEntry {
            host_tool: "cursor".to_string(),
            root_path: "/tmp/plugin".to_string(),
            branch: "main".to_string(),
            head: "head".to_string(),
            working_tree_signature: " M SKILL.md".to_string(),
            ahead: 0,
        };

        assert_eq!(
            super::cached_plugin_local_collab_status(&entry),
            super::PLUGIN_STATUS_PENDING_COMMIT
        );
    }

    #[test]
    fn shared_plugin_package_id_prefers_plugin_name_without_hash() {
        let package_id = shared_plugin_package_id_candidates(
            "https://github.com/everyinc/compound-engineering-plugin.git",
            Path::new("plugins/coding-tutor"),
            None,
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
            resolve_shared_plugin_package_id(source, Path::new("plugins/coding-tutor"), None)
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
    fn cleanup_duplicate_plugin_package_roots_removes_legacy_git_duplicate_without_identity() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("plugin-package-legacy-git-duplicate-cleanup");
        let home_dir = temp_dir.join("home");
        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);
        let source = "https://github.com/everyinc/compound-engineering-plugin.git";
        let active_root = home_dir.join(".skilldock/plugins/compound-engineering-plugin");
        let duplicate_root = home_dir
            .join(".skilldock/plugins/compound-engineering-plugin-compound-engineering-plugin");

        fs::create_dir_all(active_root.join(".codex-plugin")).expect("create active manifest dir");
        fs::write(
            active_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"compound-engineering","version":"1.0.0"}"#,
        )
        .expect("write active manifest");
        commit_test_repo(&active_root, Some(source));
        write_plugin_package_identity(&active_root, source, Path::new(""))
            .expect("write active identity");

        fs::create_dir_all(duplicate_root.join(".codex-plugin"))
            .expect("create duplicate manifest dir");
        fs::write(
            duplicate_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"compound-engineering","version":"1.0.0"}"#,
        )
        .expect("write duplicate manifest");
        commit_test_repo(&duplicate_root, Some(source));

        cleanup_duplicate_plugin_package_roots(&active_root, source, Path::new(""))
            .expect("cleanup legacy duplicate");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(active_root.exists());
        assert!(!duplicate_root.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn resolves_legacy_git_package_without_identity_by_remote() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("plugin-package-legacy-git-identity");
        let home_dir = temp_dir.join("home");
        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);
        let source = "https://github.com/everyinc/compound-engineering-plugin.git";
        let legacy_root = home_dir.join(".skilldock/plugins/compound-engineering-plugin");
        fs::create_dir_all(legacy_root.join(".codex-plugin")).expect("create codex manifest dir");
        fs::write(
            legacy_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"compound-engineering","version":"1.0.0"}"#,
        )
        .expect("write codex manifest");
        commit_test_repo(&legacy_root, Some(source));

        let package_id =
            resolve_shared_plugin_package_id(source, Path::new(""), None).expect("resolve id");
        let identity = read_plugin_package_identity(&legacy_root).expect("read package identity");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(package_id, "compound-engineering-plugin");
        assert_eq!(
            identity.source,
            "https://github.com/everyinc/compound-engineering-plugin"
        );
        assert_eq!(identity.plugin_relative_path, "");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn root_plugin_sparse_checkout_is_disabled_when_reused() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("root-plugin-sparse-disable");
        let repo_root = temp_dir.join("repo");
        fs::create_dir_all(repo_root.join(".codex-plugin")).expect("create codex manifest dir");
        fs::write(
            repo_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"compound-engineering","version":"1.0.0"}"#,
        )
        .expect("write codex manifest");
        fs::write(
            repo_root.join("plugin.json"),
            r#"{"name":"compound-engineering"}"#,
        )
        .expect("write generic manifest");
        commit_test_repo(&repo_root, None);
        run_git_test(&repo_root, &["sparse-checkout", "init", "--no-cone"]);
        run_git_test(
            &repo_root,
            &["sparse-checkout", "set", "--no-cone", "/*", "!/*/"],
        );
        run_git_test(&repo_root, &["checkout", "--quiet"]);
        assert!(!repo_root.join(".codex-plugin/plugin.json").exists());

        configure_plugin_sparse_checkout(&repo_root, Path::new(""))
            .expect("disable sparse checkout for root plugin");

        assert!(repo_root.join(".codex-plugin/plugin.json").is_file());
        assert_ne!(
            run_git_test_output(&repo_root, &["config", "--bool", "core.sparseCheckout"]),
            "true"
        );

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
            resolve_shared_plugin_package_id(source, Path::new("plugins/coding-tutor"), None)
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
            resolve_shared_plugin_package_id(source, Path::new("plugins/coding-tutor"), None)
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
    fn shared_plugin_package_id_prefers_manifest_name_over_repo_tail() {
        let package_id = shared_plugin_package_id_candidates(
            "https://github.com/cloudflare/skills",
            Path::new(""),
            Some("cloudflare"),
        )
        .into_iter()
        .next()
        .expect("package id candidate");

        assert_eq!(package_id, "cloudflare");
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
    fn plugin_git_state_uses_real_git_committer_for_last_editor() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("plugin-last-editor-committer");
        let repo_root = temp_dir.join("repo");
        let plugin_dir = repo_root.join("plugins/coding-tutor");
        fs::create_dir_all(&plugin_dir).expect("create plugin dir");
        fs::write(plugin_dir.join("plugin.json"), r#"{"name":"coding-tutor"}"#)
            .expect("write plugin manifest");
        run_git_test(
            &temp_dir,
            &["init", "--quiet", repo_root.to_str().expect("repo path")],
        );
        run_git_test(&repo_root, &["checkout", "-b", "main"]);
        run_git_test(&repo_root, &["config", "user.name", "Real Committer"]);
        run_git_test(
            &repo_root,
            &["config", "user.email", "committer@example.com"],
        );
        run_git_test(&repo_root, &["add", "."]);
        run_git_test(
            &repo_root,
            &[
                "commit",
                "--author",
                "Original Author <author@example.com>",
                "-m",
                "add plugin",
            ],
        );

        let state = plugin_git_state(&repo_root, Path::new("plugins/coding-tutor"));

        assert_eq!(state.last_editor, "Real Committer");

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
        assert!(git_exclude.contains(".vscode/"));
        assert!(git_exclude.contains(".DS_Store"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn shared_plugin_repo_rejects_stale_cache_when_fetch_fails() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("plugin-cache-fetch-fallback");
        let repo_root = temp_dir.join("repo");
        let plugin_root = repo_root.join("example-plugin");
        fs::create_dir_all(plugin_root.join(".opencode/plugins"))
            .expect("create OpenCode plugin dir");
        fs::write(
            plugin_root.join(".opencode/plugins/example-plugin.js"),
            "export const AgenticEngineering = async () => ({})",
        )
        .expect("write OpenCode plugin entry");
        commit_test_repo(&repo_root, None);
        run_git_test(
            &repo_root,
            &[
                "remote",
                "add",
                "origin",
                temp_dir.join("missing-remote.git").to_str().unwrap(),
            ],
        );
        configure_plugin_sparse_checkout(&repo_root, Path::new("example-plugin"))
            .expect("configure sparse checkout");
        fs::remove_dir_all(&plugin_root).expect("simulate missing managed worktree");

        let error = ensure_shared_plugin_repo(
            "unused-while-cache-exists",
            None,
            &repo_root,
            Path::new("example-plugin"),
            false,
            None,
        )
        .expect_err("stale cache must not be reused when fetch fails");

        assert!(error.contains("已停止安装以避免使用旧版本"));
        assert!(!plugin_root.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn shared_plugin_repo_from_existing_restores_reused_managed_worktree() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("plugin-existing-cache-restore");
        let source_repo_root = temp_dir.join("source-repo");
        let target_repo_root = temp_dir.join("managed-repo");
        let plugin_relative_path = Path::new("example-plugin");
        let target_plugin_root = target_repo_root.join(plugin_relative_path);

        fs::create_dir_all(
            source_repo_root
                .join(plugin_relative_path)
                .join(".cursor-plugin"),
        )
        .expect("create source plugin dir");
        fs::write(
            source_repo_root
                .join(plugin_relative_path)
                .join(".cursor-plugin/plugin.json"),
            r#"{"name":"example-plugin"}"#,
        )
        .expect("write source plugin manifest");
        commit_test_repo(&source_repo_root, None);

        fs::create_dir_all(target_plugin_root.join(".opencode/plugins"))
            .expect("create managed OpenCode plugin dir");
        fs::write(
            target_plugin_root.join(".opencode/plugins/example-plugin.js"),
            "export const AgenticEngineering = async () => ({})",
        )
        .expect("write managed OpenCode plugin entry");
        commit_test_repo(&target_repo_root, None);
        configure_plugin_sparse_checkout(&target_repo_root, plugin_relative_path)
            .expect("configure managed sparse checkout");
        fs::remove_dir_all(&target_plugin_root).expect("simulate missing managed worktree");

        ensure_shared_plugin_repo_from_existing(
            &source_repo_root,
            &target_repo_root,
            "https://example.com/example-plugin.git",
            plugin_relative_path,
        )
        .expect("restore reused managed repo from local HEAD");

        assert!(target_plugin_root
            .join(".opencode/plugins/example-plugin.js")
            .is_file());
        assert_eq!(
            run_git_test_output(&target_repo_root, &["status", "--porcelain"]),
            ""
        );

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
            manifest_name: "coding-tutor".to_string(),
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
            source_ref: "main".to_string(),
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
        assert_eq!(
            read_skilldock_plugin_source_metadata(&plugin_root)
                .expect("read source metadata")
                .source_ref,
            "main"
        );
        assert!(!plugin_root.join(".skilldock").exists());
        assert!(!plugin_root.join("plugin-source.json").exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn skilldock_metadata_for_symlinked_git_plugins_stays_out_of_worktree() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
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
            manifest_name: "coding-tutor".to_string(),
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
            source_ref: String::new(),
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
    fn plugin_probe_source_url_preserves_selected_branch_and_path() {
        let spec = parse_market_source_url(
            "https://github.com/cloudflare/skills/tree/extra-plugin-config/plugins/cloudflare",
        )
        .expect("parse market source");

        let source_url = plugin_probe_source_url(&spec);

        assert_eq!(
            source_url,
            "https://github.com/cloudflare/skills/tree/extra-plugin-config/plugins/cloudflare"
        );
    }

    #[test]
    fn plugin_probe_source_url_uses_selected_branch_without_relative_path() {
        let spec = parse_market_source_url("https://github.com/cloudflare/skills/tree/main")
            .expect("parse market source");

        let source_url = plugin_probe_source_url(&spec);

        assert_eq!(source_url, "https://github.com/cloudflare/skills/tree/main");
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
        fs::create_dir_all(repo_root.join("skills/example-skill/reference"))
            .expect("create skill reference dir");
        fs::create_dir_all(repo_root.join("skills/example-skill/scripts"))
            .expect("create skill scripts dir");
        fs::create_dir_all(repo_root.join("agents")).expect("create agents dir");
        fs::write(
            repo_root.join("skills/example-skill/SKILL.md"),
            "---\ndescription: Example description\n---\n# Example",
        )
        .expect("write skill file");
        fs::write(
            repo_root.join("skills/example-skill/reference/company-standards.md"),
            "# Company Standards",
        )
        .expect("write skill reference file");
        fs::write(
            repo_root.join("skills/example-skill/scripts/format-check.py"),
            "print('ok')",
        )
        .expect("write skill script file");
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
        assert_eq!(preview.root_name, "example-skill");
        assert_eq!(
            preview
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "skills/example-skill",
                "skills/example-skill/SKILL.md",
                "skills/example-skill/reference",
                "skills/example-skill/reference/company-standards.md",
                "skills/example-skill/scripts",
                "skills/example-skill/scripts/format-check.py",
            ]
        );
        assert_eq!(
            preview.initial_file_path.as_deref(),
            Some("skills/example-skill/SKILL.md")
        );

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

        let results = probe_plugin_source_candidates_blocking(
            &repo_root.to_string_lossy(),
            None,
            None,
            None,
            None,
        )
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
    fn probes_gitlab_plugin_candidates_from_existing_repo_cache_before_remote_access() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("gitlab-plugin-candidates-cache");
        let home_dir = temp_dir.join("home");
        let source = "https://git.example.com/example-org/example-repo.git";
        let source_spec = parse_market_source_url(source).expect("parse source");
        let repo_key = plugin_discovery_repo_key(
            &source_spec.clone_url,
            Some("master"),
            source_spec.relative_path.as_ref(),
        );
        let repo_root = home_dir.join(".skilldock/repositories").join(&repo_key);
        let plugin_root = repo_root.join("example-plugin");

        fs::create_dir_all(plugin_root.join(".codex-plugin")).expect("create codex manifest dir");
        fs::create_dir_all(plugin_root.join("skills/workflow-code-generation"))
            .expect("create skill dir");
        fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"example-plugin","version":"0.1.0"}"#,
        )
        .expect("write plugin manifest");
        fs::write(
            plugin_root.join("skills/workflow-code-generation/SKILL.md"),
            "# workflow",
        )
        .expect("write skill");
        commit_test_repo(
            &repo_root,
            Some("https://git.example.com/example-org/example-repo.git"),
        );

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);
        let results = probe_plugin_source_candidates_blocking(
            source,
            Some("master"),
            None,
            Some("codex".into()),
            None,
        )
        .expect("probe plugin candidates from cache");
        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "example-plugin");
        assert_eq!(results[0].tool, "codex");
        assert_eq!(
            results[0].source_url,
            "https://git.example.com/example-org/example-repo/tree/master"
        );
        assert_eq!(results[0].source_ref, "master");
        assert_eq!(results[0].plugin_relative_path, "example-plugin");
        assert!(Path::new(&results[0].repo_root).ends_with(&repo_key));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn installs_latest_plugin_when_discovery_cache_is_stale() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("stale-plugin-discovery-cache");
        let home_dir = temp_dir.join("home");
        let remote_repo = temp_dir.join("remote-example-plugin.git");
        let seed_repo = temp_dir.join("seed-repo");
        let cached_repo = home_dir.join(".skilldock/repositories/plugin-cache");
        let cached_plugin_root = cached_repo.join("example-plugin");

        super::run_git_at(
            Path::new("."),
            &["init", "--bare", remote_repo.to_string_lossy().as_ref()],
        )
        .expect("init bare remote");
        super::run_git_at(&remote_repo, &["symbolic-ref", "HEAD", "refs/heads/main"])
            .expect("point remote HEAD at main");

        fs::create_dir_all(seed_repo.join("example-plugin/.cursor-plugin"))
            .expect("create seed manifest dir");
        fs::create_dir_all(seed_repo.join("example-plugin/rules"))
            .expect("create seed rules dir");
        fs::write(
            seed_repo.join("example-plugin/.cursor-plugin/plugin.json"),
            r#"{"name":"example-plugin","displayName":"Example Plugin","version":"1.0.0"}"#,
        )
        .expect("write seed manifest");
        fs::write(
            seed_repo.join("example-plugin/rules/version.mdc"),
            "# old",
        )
        .expect("write old plugin content");
        commit_test_repo(&seed_repo, Some(remote_repo.to_string_lossy().as_ref()));
        run_git_test(&seed_repo, &["push", "-u", "origin", "main"]);

        fs::create_dir_all(cached_repo.parent().expect("cache parent"))
            .expect("create repositories dir");
        run_git_test(
            &temp_dir,
            &[
                "clone",
                remote_repo.to_string_lossy().as_ref(),
                cached_repo.to_string_lossy().as_ref(),
            ],
        );
        let stale_revision = run_git_test_output(&cached_repo, &["rev-parse", "HEAD"]);

        fs::write(
            seed_repo.join("example-plugin/rules/version.mdc"),
            "# latest",
        )
        .expect("write latest plugin content");
        run_git_test(&seed_repo, &["add", "."]);
        run_git_test(&seed_repo, &["commit", "-m", "Update plugin"]);
        run_git_test(&seed_repo, &["push", "origin", "main"]);
        let latest_revision = run_git_test_output(&seed_repo, &["rev-parse", "HEAD"]);
        assert_ne!(stale_revision, latest_revision);

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);
        let source_url = format!("file://{}", remote_repo.to_string_lossy());
        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "cursor".to_string(),
                compatible_host_tools: vec!["cursor".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "example-plugin".to_string(),
                name: "Example Plugin".to_string(),
                description: "Agent workflows".to_string(),
                plugin_root: cached_plugin_root.to_string_lossy().into_owned(),
                repo_root: cached_repo.to_string_lossy().into_owned(),
                plugin_relative_path: "example-plugin".to_string(),
                manifest_path: cached_plugin_root
                    .join(".cursor-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url,
                source_ref: "main".to_string(),
                is_git_repo: true,
                git_root: cached_repo.to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "cursor-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec!["cursor".to_string()],
            None,
        )
        .expect("install plugin from stale discovery cache");
        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        let managed_repo = home_dir.join(".skilldock/plugins/example-plugin");
        assert_eq!(installed.len(), 1);
        assert_eq!(
            run_git_test_output(&managed_repo, &["rev-parse", "HEAD"]),
            latest_revision
        );
        assert_eq!(
            fs::read_to_string(managed_repo.join("example-plugin/rules/version.mdc"))
                .expect("read installed plugin content"),
            "# latest"
        );

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
                manifest_name: "example-plugin".to_string(),
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
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: temp_dir.join("repo").to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/example-plugin".to_string(),
                git_root: temp_dir.join("repo").to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "claude-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec!["claude-code".to_string()],
            None,
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
        let managed_plugin_root = home_dir.join(".skilldock/plugins/example-plugin");
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
    fn skips_creating_managed_plugin_package_when_no_selected_host_matches_probe() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("skip-unselected-plugin-package-materialization");
        let home_dir = temp_dir.join("home");
        let source_root = temp_dir.join("repo/plugins/example-plugin");
        fs::create_dir_all(source_root.join(".claude-plugin")).expect("create claude manifest dir");
        fs::write(
            source_root.join(".claude-plugin/plugin.json"),
            r#"{"name":"example-plugin","version":"1.0.0","description":"Workflow plugin"}"#,
        )
        .expect("write claude manifest");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "claude-code".to_string(),
                compatible_host_tools: vec!["claude-code".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "example-plugin".to_string(),
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
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: temp_dir.join("repo").to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/example-plugin".to_string(),
                git_root: temp_dir.join("repo").to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "claude-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec!["codex".to_string()],
            None,
        )
        .expect("skip install when no host matches probe");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(installed.is_empty());
        assert!(!home_dir.join(".skilldock/plugins").exists());

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
        let stale_cache_root =
            home_dir.join(".codex/plugins/cache/skilldock/product-design/0.1.40");
        fs::create_dir_all(stale_cache_root.join(".codex-plugin"))
            .expect("create stale codex cache manifest dir");
        fs::write(
            stale_cache_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"product-design","version":"0.1.40"}"#,
        )
        .expect("write stale codex cache manifest");
        let cli_path = temp_dir.join("codex-cli");
        let log_path = temp_dir.join("codex-cli.log");
        write_cli_logging_script(&cli_path, &log_path);

        let previous_home = env::var_os("HOME");
        let previous_codex_cli = env::var_os("SKILLDOCK_CODEX_CLI");
        env::set_var("HOME", &home_dir);
        env::set_var("SKILLDOCK_CODEX_CLI", &cli_path);
        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "codex".to_string(),
                compatible_host_tools: vec!["codex".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "product-design".to_string(),
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
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: temp_dir.join("repo").to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/product-design".to_string(),
                git_root: temp_dir.join("repo").to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "codex-marketplace".to_string(),
                warnings: Vec::new(),
            }],
            vec!["codex".to_string()],
            None,
        )
        .expect("install selected plugin");
        let listed_plugins = list_installed_plugins().expect("list installed plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
        match previous_codex_cli {
            Some(value) => env::set_var("SKILLDOCK_CODEX_CLI", value),
            None => env::remove_var("SKILLDOCK_CODEX_CLI"),
        }

        let plugin_cache_root = home_dir.join(".codex/plugins/cache/skilldock/product-design");
        let installed_root = plugin_cache_root.join("latest");
        let marketplace_plugin_root =
            home_dir.join(".codex/marketplaces/skilldock/plugins/product-design");
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
        assert_eq!(installed[0].install_source, "skilldock");
        assert_eq!(
            installed[0].display_root_path,
            plugin_cache_root.to_string_lossy().into_owned()
        );
        assert_eq!(
            listed_plugins
                .iter()
                .filter(|plugin| plugin.host_tool == "codex"
                    && plugin.manifest_name == "product-design")
                .count(),
            1
        );
        assert_eq!(installed[0].source_type, "git");
        assert_eq!(
            installed[0].source_url,
            "https://github.com/openai/role-specific-plugins.git"
        );
        let managed_plugin_root = home_dir.join(".skilldock/plugins/product-design");
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
        assert!(marketplace_plugin_root
            .join(".codex-plugin/plugin.json")
            .is_file());
        assert!(installed_root.join(".codex-plugin/plugin.json").is_file());
        assert!(paths_refer_to_same_dir(
            &marketplace_plugin_root,
            &managed_plugin_root
        ));
        assert!(!fs::symlink_metadata(&installed_root)
            .expect("read codex cache metadata")
            .file_type()
            .is_symlink());
        assert!(paths_refer_to_same_dir(
            &installed_root.join(".codex-plugin"),
            &managed_plugin_root.join(".codex-plugin")
        ));
        assert!(paths_refer_to_same_dir(
            &installed_root.join("skills"),
            &managed_plugin_root.join("skills")
        ));
        assert!(fs::symlink_metadata(&marketplace_plugin_root)
            .expect("read marketplace plugin metadata")
            .file_type()
            .is_symlink());
        assert!(fs::symlink_metadata(installed_root.join("skills"))
            .expect("read codex cache skills metadata")
            .file_type()
            .is_symlink());
        assert_eq!(
            read_skilldock_plugin_source_metadata(&marketplace_plugin_root)
                .expect("read marketplace source metadata")
                .source_url,
            "https://github.com/openai/role-specific-plugins.git"
        );
        assert_eq!(
            read_skilldock_plugin_source_metadata(&installed_root)
                .expect("read cache source metadata")
                .source_url,
            "https://github.com/openai/role-specific-plugins.git"
        );
        assert!(!plugin_cache_root.join(".codex-plugin/plugin.json").exists());
        assert!(!stale_cache_root.exists());
        assert!(!log_path.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn installs_codex_plugin_probe_replaces_legacy_direct_cache_link() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("selected-codex-plugin-legacy-cache");
        let home_dir = temp_dir.join("home");
        let source_root = temp_dir.join("source/example-plugin");
        let plugin_cache_root = home_dir.join(".codex/plugins/cache/skilldock/example-plugin");
        let installed_root = plugin_cache_root.join("latest");

        fs::create_dir_all(source_root.join(".codex-plugin")).expect("create codex manifest dir");
        fs::create_dir_all(source_root.join("skills/example-plugin"))
            .expect("create skill dir");
        fs::write(
            source_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"example-plugin","version":"0.1.0","skills":"./skills/"}"#,
        )
        .expect("write codex manifest");
        fs::write(
            source_root.join("skills/example-plugin/SKILL.md"),
            "# Example Plugin",
        )
        .expect("write skill");
        fs::create_dir_all(plugin_cache_root.parent().expect("cache parent"))
            .expect("create codex cache parent");
        std::os::unix::fs::symlink(&source_root, &plugin_cache_root)
            .expect("create legacy direct cache link");

        ensure_skilldock_codex_cache_link(
            &home_dir,
            &source_root,
            "skilldock",
            "example-plugin",
        )
        .expect("ensure codex cache link");

        assert!(plugin_cache_root.is_dir());
        assert!(!plugin_cache_root.join(".codex-plugin/plugin.json").exists());
        assert!(installed_root.join(".codex-plugin/plugin.json").is_file());
        assert!(installed_root
            .join("skills/example-plugin/SKILL.md")
            .is_file());
        assert!(!fs::symlink_metadata(&installed_root)
            .expect("read versioned cache metadata")
            .file_type()
            .is_symlink());
        assert!(paths_refer_to_same_dir(
            &installed_root.join("skills"),
            &source_root.join("skills")
        ));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn scans_legacy_codex_skilldock_symlink_from_package_identity() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("codex-skilldock-package-identity-fallback");
        let home_dir = temp_dir.join("home");
        let shared_package_root =
            home_dir.join(".skilldock/plugins/example-plugin-example-repo");
        let shared_plugin_root = shared_package_root.join("example-plugin");
        let codex_marketplace_root = home_dir.join(".codex/marketplaces/skilldock");
        let marketplace_plugin_root = codex_marketplace_root.join("plugins/example-plugin");
        let source_url = "https://git.example.com/example-org/example-repo";

        fs::create_dir_all(shared_plugin_root.join(".codex-plugin"))
            .expect("create shared codex manifest dir");
        fs::write(
            shared_plugin_root.join(".codex-plugin/plugin.json"),
            format!(
                r#"{{"name":"example-plugin","version":"0.1.0","repository":"{source_url}","interface":{{"displayName":"Example Plugin"}}}}"#
            ),
        )
        .expect("write shared codex manifest");
        fs::create_dir_all(
            marketplace_plugin_root
                .parent()
                .expect("marketplace parent"),
        )
        .expect("create marketplace plugin parent");
        std::os::unix::fs::symlink(&shared_plugin_root, &marketplace_plugin_root)
            .expect("link codex marketplace plugin");
        run_git_test(&shared_package_root, &["init", "-b", "master"]);
        run_git_test(
            &shared_package_root,
            &["config", "user.email", "skilldock@example.com"],
        );
        run_git_test(&shared_package_root, &["config", "user.name", "SkillDock"]);
        run_git_test(&shared_package_root, &["add", "."]);
        run_git_test(&shared_package_root, &["commit", "-m", "init"]);
        write_plugin_package_identity(
            &shared_package_root,
            source_url,
            Path::new("example-plugin"),
        )
        .expect("write package identity");

        fs::create_dir_all(codex_marketplace_root.join(".agents/plugins"))
            .expect("create codex marketplace manifest dir");
        fs::write(
            codex_marketplace_root.join(".agents/plugins/marketplace.json"),
            r#"{
  "plugins": [
    {
      "name": "example-plugin",
      "source": { "source": "local", "path": "./plugins/example-plugin" }
    }
  ]
}"#,
        )
        .expect("write codex marketplace manifest");
        fs::create_dir_all(home_dir.join(".codex")).expect("create codex dir");
        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."example-plugin@skilldock"]
enabled = true

[marketplaces.skilldock]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", &codex_marketplace_root.to_string_lossy()),
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
        assert_eq!(plugins[0].name, "Example Plugin");
        assert_eq!(plugins[0].install_source, "skilldock");
        assert_eq!(plugins[0].source_type, "git");
        assert_eq!(plugins[0].source_url, source_url);
        assert!(plugins[0].source_revision.len() >= 7);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn installs_selected_codex_plugin_probe_from_generic_plugin_manifest() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("selected-codex-generic-plugin-install");
        let home_dir = temp_dir.join("home");
        let source_root = temp_dir.join("repo");
        fs::create_dir_all(source_root.join("skills/shopify")).expect("create skill dir");
        fs::write(
            source_root.join("plugin.json"),
            r#"{"name":"shopify-plugin","version":"1.4.1","repository":"https://github.com/Shopify/Shopify-AI-Toolkit","interface":{"displayName":"Shopify"}}"#,
        )
        .expect("write generic manifest");
        fs::write(source_root.join("skills/shopify/SKILL.md"), "# Shopify").expect("write skill");
        fs::write(source_root.join(".mcp.json"), r#"{"mcpServers":{}}"#).expect("write mcp config");
        let cli_path = temp_dir.join("codex-cli");
        let log_path = temp_dir.join("codex-cli.log");
        write_cli_logging_script(&cli_path, &log_path);

        let previous_home = env::var_os("HOME");
        let previous_codex_cli = env::var_os("SKILLDOCK_CODEX_CLI");
        env::set_var("HOME", &home_dir);
        env::set_var("SKILLDOCK_CODEX_CLI", &cli_path);
        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "codex".to_string(),
                compatible_host_tools: vec![
                    "codex".to_string(),
                    "claude-code".to_string(),
                    "cursor".to_string(),
                ],
                kind: "plugin-repo".to_string(),
                manifest_name: "shopify-plugin".to_string(),
                name: "Shopify".to_string(),
                description: "Shopify plugin".to_string(),
                plugin_root: source_root.to_string_lossy().into_owned(),
                manifest_path: source_root
                    .join("plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url: "https://github.com/Shopify/Shopify-AI-Toolkit".to_string(),
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: source_root.to_string_lossy().into_owned(),
                plugin_relative_path: String::new(),
                git_root: source_root.to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "codex-marketplace".to_string(),
                warnings: Vec::new(),
            }],
            vec!["codex".to_string()],
            None,
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

        let managed_plugin_root = home_dir.join(".skilldock/plugins/shopify-ai-toolkit");
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].host_tool, "codex");
        assert_eq!(installed[0].name, "Shopify");
        assert!(managed_plugin_root.join("plugin.json").is_file());
        assert!(managed_plugin_root
            .join(".codex-plugin/plugin.json")
            .is_file());
        assert!(!managed_plugin_root
            .join(".claude-plugin/plugin.json")
            .exists());
        assert!(!managed_plugin_root
            .join(".cursor-plugin/plugin.json")
            .exists());
        let marketplace_plugin_root =
            home_dir.join(".codex/marketplaces/skilldock/plugins/shopify-plugin");
        let installed_root = home_dir.join(".codex/plugins/cache/skilldock/shopify-plugin/latest");
        assert!(marketplace_plugin_root
            .join(".codex-plugin/plugin.json")
            .is_file());
        assert!(installed_root.join(".codex-plugin/plugin.json").is_file());
        assert!(paths_refer_to_same_dir(
            &marketplace_plugin_root,
            &managed_plugin_root
        ));
        assert!(!fs::symlink_metadata(&installed_root)
            .expect("read codex cache metadata")
            .file_type()
            .is_symlink());
        assert!(paths_refer_to_same_dir(
            &installed_root.join(".codex-plugin"),
            &managed_plugin_root.join(".codex-plugin")
        ));
        assert!(!log_path.exists());

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

    #[cfg(unix)]
    #[test]
    fn copy_plugin_dir_preserves_symlinks() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("copy-plugin-dir-preserves-symlinks");
        let source_root = temp_dir.join("source");
        let target_root = temp_dir.join("target");

        fs::create_dir_all(source_root.join(".cursor-plugin")).expect("create plugin manifest dir");
        fs::create_dir_all(source_root.join("skills/agentcontrol/projects"))
            .expect("create source skill dir");
        fs::write(
            source_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"launchdarkly","version":"1.0.2"}"#,
        )
        .expect("write plugin manifest");
        fs::write(
            source_root.join("skills/agentcontrol/projects/SKILL.md"),
            "# Projects",
        )
        .expect("write source skill");
        std::os::unix::fs::symlink("agentcontrol/projects", source_root.join("skills/projects"))
            .expect("create skill symlink");

        copy_plugin_dir(&source_root, &target_root).expect("copy plugin dir");

        assert!(target_root.join(".cursor-plugin/plugin.json").is_file());
        assert!(fs::symlink_metadata(target_root.join("skills/projects"))
            .expect("read copied symlink metadata")
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_link(target_root.join("skills/projects")).expect("read copied symlink target"),
            PathBuf::from("agentcontrol/projects")
        );
        assert!(target_root.join("skills/projects/SKILL.md").is_file());

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
        let repo_root = home_dir.join(".skilldock/repositories/probed-plugin-install");
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
            manifest_name: "product-design".to_string(),
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
            source_ref: String::new(),
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
            None,
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
        assert!(repo_root.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn rejects_cursor_plugin_when_repo_cache_cannot_be_refreshed() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-install-from-repo-cache");
        let home_dir = temp_dir.join("home");
        let repo_root = home_dir.join(".skilldock/repositories/cursor-cache-install");
        let plugin_root = repo_root.join("plugins/coding-tutor");
        fs::create_dir_all(plugin_root.join(".cursor-plugin")).expect("create cursor manifest dir");
        fs::create_dir_all(plugin_root.join("commands")).expect("create command dir");
        fs::write(
            plugin_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"coding-tutor","displayName":"Coding Tutor","version":"1.0.0","description":"Tutor plugin"}"#,
        )
        .expect("write cursor manifest");
        fs::write(plugin_root.join("commands/teach.md"), "# teach").expect("write command");
        let source_url = "https://example.invalid/org/coding-tutor.git".to_string();
        commit_test_repo(&repo_root, Some(&source_url));

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);
        let result = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "cursor".to_string(),
                compatible_host_tools: vec!["cursor".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "coding-tutor".to_string(),
                name: "Coding Tutor".to_string(),
                description: "Tutor plugin".to_string(),
                plugin_root: plugin_root.to_string_lossy().into_owned(),
                manifest_path: plugin_root
                    .join(".cursor-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url: source_url.clone(),
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: repo_root.to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/coding-tutor".to_string(),
                git_root: repo_root.to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "cursor-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec!["cursor".to_string()],
            None,
        );

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        let installed_repo_root = home_dir.join(".cursor/plugins/local/coding-tutor");
        assert!(result.is_err());
        assert!(repo_root.exists());
        assert!(!installed_repo_root.exists());
        assert!(!home_dir.join(".skilldock/plugins/coding-tutor").exists());

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
    fn skips_unconfigured_codex_cached_plugins_when_config_source_is_remote() {
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

        assert!(
            plugins.iter().all(|plugin| plugin.name != "Documents"),
            "cache-only plugin should not be listed"
        );

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
        let repo_root = temp_dir.join("repo");
        let source_root = repo_root.join("plugins/example-plugin");
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
        commit_test_repo(&repo_root, None);
        let source_url = repo_root.to_string_lossy().into_owned();

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "cursor".to_string(),
                compatible_host_tools: vec!["cursor".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "example-plugin".to_string(),
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
                source_url: source_url.clone(),
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: repo_root.to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/example-plugin".to_string(),
                git_root: repo_root.to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "cursor-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec!["cursor".to_string()],
            None,
        )
        .expect("install selected plugin");

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        let installed_repo_root = home_dir.join(".cursor/plugins/local/example-plugin");
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].host_tool, "cursor");
        assert_eq!(installed[0].name, "Example Plugin");
        assert_eq!(installed[0].source_type, "git");
        assert!(paths_refer_to_same_dir(
            Path::new(&installed[0].root_path),
            &installed_repo_root
        ));
        assert!(installed_repo_root.is_dir());
        assert!(fs::canonicalize(installed_repo_root.join(".cursor-plugin"))
            .expect("canonicalize managed Cursor manifest directory")
            .to_string_lossy()
            .contains("/.skilldock/plugins/"));
        assert!(installed_repo_root
            .join(".cursor-plugin/plugin.json")
            .is_file());
        assert!(installed_repo_root
            .join("rules/review-checklist.mdc")
            .is_file());
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].host_tool, "cursor");
        assert_eq!(plugins[0].name, "Example Plugin");
        assert_eq!(
            plugins[0].plugin_relative_path,
            "plugins/example-plugin"
        );
        assert_ne!(plugins[0].collab_status, PLUGIN_STATUS_PENDING_PUSH);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn plugin_manifest_error_strips_windows_verbatim_prefix() {
        let error = super::ensure_plugin_manifest_for_host(
            "cursor",
            Path::new(r"\\?\C:\Users\demo\.skilldock\plugins\compound-engineering-plugin"),
        )
        .expect_err("missing manifest should fail");

        assert!(!error.contains(r"\\?\"));
        assert!(error.contains(r"C:\Users\demo\.skilldock\plugins\compound-engineering-plugin"));
    }

    #[test]
    fn installs_cursor_plugin_from_shared_package_symlink() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cloudflare-skills-name-alignment");
        let home_dir = temp_dir.join("home");
        let source_root = temp_dir.join("repo");
        fs::create_dir_all(source_root.join(".cursor-plugin")).expect("create cursor manifest dir");
        fs::create_dir_all(source_root.join("skills/browser")).expect("create skills dir");
        fs::write(
            source_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"cloudflare","displayName":"Cloudflare","version":"1.0.0","repository":"https://github.com/cloudflare/skills"}"#,
        )
        .expect("write cursor manifest");
        fs::write(source_root.join("skills/browser/SKILL.md"), "# Browser").expect("write skill");
        commit_test_repo(&source_root, None);
        let source_url = source_root.to_string_lossy().into_owned();

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "cursor".to_string(),
                compatible_host_tools: vec!["cursor".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "cloudflare".to_string(),
                name: "Cloudflare".to_string(),
                description: "Cloudflare tools".to_string(),
                plugin_root: source_root.to_string_lossy().into_owned(),
                manifest_path: source_root
                    .join(".cursor-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url,
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: source_root.to_string_lossy().into_owned(),
                plugin_relative_path: String::new(),
                git_root: source_root.to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "cursor-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec!["cursor".to_string()],
            None,
        )
        .expect("install cloudflare plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        let managed_root = home_dir.join(".skilldock/plugins/cloudflare");
        let cursor_root = home_dir.join(".cursor/plugins/local/cloudflare");
        assert_eq!(installed.len(), 1);
        assert!(managed_root.is_dir());
        assert!(cursor_root.is_dir());
        assert!(paths_refer_to_same_dir(
            &managed_root.join(".cursor-plugin"),
            &cursor_root.join(".cursor-plugin")
        ));
        assert!(cursor_root.join(".cursor-plugin/plugin.json").is_file());
        assert!(cursor_root.join("skills/browser/SKILL.md").is_file());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn installs_claude_plugin_from_nested_assets_probe_by_promoting_manifest_root() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cloudflare-skills-claude-root-promotion");
        let home_dir = temp_dir.join("home");
        let repo_root = temp_dir.join("repo");
        let nested_assets_root = repo_root.join("skills");
        fs::create_dir_all(repo_root.join(".claude-plugin")).expect("create claude manifest dir");
        fs::create_dir_all(nested_assets_root.join("browser")).expect("create nested skill dir");
        fs::write(
            repo_root.join(".claude-plugin/plugin.json"),
            r#"{"name":"cloudflare","displayName":"Cloudflare","version":"1.0.0","repository":"https://github.com/cloudflare/skills"}"#,
        )
        .expect("write claude manifest");
        fs::write(nested_assets_root.join("browser/SKILL.md"), "# Browser").expect("write skill");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "claude-code".to_string(),
                compatible_host_tools: vec!["claude-code".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "cloudflare".to_string(),
                name: "Cloudflare".to_string(),
                description: "Cloudflare tools".to_string(),
                plugin_root: nested_assets_root.to_string_lossy().into_owned(),
                manifest_path: repo_root
                    .join(".claude-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url: "https://github.com/cloudflare/skills".to_string(),
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: repo_root.to_string_lossy().into_owned(),
                plugin_relative_path: "skills".to_string(),
                git_root: repo_root.to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "claude-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec!["claude-code".to_string()],
            None,
        )
        .expect("install nested cloudflare claude plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        let managed_root = home_dir.join(".skilldock/plugins/cloudflare");
        let claude_root =
            home_dir.join(".claude/plugins/marketplaces/skilldock/plugins/cloudflare");
        assert_eq!(installed.len(), 1);
        assert!(managed_root.join(".claude-plugin/plugin.json").is_file());
        assert!(managed_root.join("skills/browser/SKILL.md").is_file());
        assert!(claude_root.join(".claude-plugin/plugin.json").is_file());
        assert!(claude_root.join("skills/browser/SKILL.md").is_file());
        assert!(!home_dir.join(".skilldock/plugins/skills-skills").exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn repairs_shared_host_manifest_polluted_by_generic_manifest() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("repair-shared-host-manifest-pollution");
        let home_dir = temp_dir.join("home");
        let source_root = temp_dir.join("repo");
        fs::create_dir_all(source_root.join(".claude-plugin")).expect("create claude manifest dir");
        fs::write(
            source_root.join("plugin.json"),
            r#"{"$schema":"https://antigravity.google/schemas/v1/plugin.json","name":"compound-engineering","version":"3.19.0","description":"Compound"}"#,
        )
        .expect("write generic manifest");
        let claude_manifest = r#"{"name":"compound-engineering","version":"3.19.0","description":"Compound","author":{"name":"Every"}}"#;
        fs::write(
            source_root.join(".claude-plugin/plugin.json"),
            claude_manifest,
        )
        .expect("write claude manifest");
        fs::create_dir_all(source_root.join("commands")).expect("create command dir");
        fs::write(source_root.join("commands/compound.md"), "# Compound").expect("write command");
        commit_test_repo(&source_root, None);
        fs::write(
            source_root.join(".claude-plugin/plugin.json"),
            fs::read_to_string(source_root.join("plugin.json")).expect("read generic manifest"),
        )
        .expect("pollute claude manifest");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "claude-code".to_string(),
                compatible_host_tools: vec!["claude-code".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "compound-engineering".to_string(),
                name: "Compound Engineering".to_string(),
                description: "Compound".to_string(),
                plugin_root: source_root.to_string_lossy().into_owned(),
                manifest_path: source_root
                    .join(".claude-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url: source_root.to_string_lossy().into_owned(),
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: source_root.to_string_lossy().into_owned(),
                plugin_relative_path: String::new(),
                git_root: source_root.to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "claude-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec!["claude-code".to_string()],
            None,
        )
        .expect("install polluted plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        let managed_root = home_dir.join(".skilldock/plugins/compound-engineering");
        assert_eq!(installed.len(), 1);
        assert_eq!(
            fs::read_to_string(managed_root.join(".claude-plugin/plugin.json"))
                .expect("read repaired managed manifest"),
            claude_manifest
        );
        assert_eq!(
            run_git_test_output(&managed_root, &["status", "--porcelain"]),
            ""
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn installs_selected_plugin_probe_into_multiple_hosts() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("selected-plugin-multi-host-install");
        let home_dir = temp_dir.join("home");
        let source_root = temp_dir.join("repo/plugins/coding-tutor");
        fs::create_dir_all(source_root.join(".claude-plugin")).expect("create claude manifest dir");
        fs::create_dir_all(source_root.join(".codex-plugin")).expect("create codex manifest dir");
        fs::create_dir_all(source_root.join("commands")).expect("create command dir");
        fs::write(
            source_root.join(".claude-plugin/plugin.json"),
            r#"{"name":"coding-tutor","version":"1.3.0","description":"Tutor plugin"}"#,
        )
        .expect("write claude manifest");
        fs::write(
            source_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"coding-tutor","version":"1.3.0","description":"Tutor plugin","interface":{"displayName":"Coding Tutor"}}"#,
        )
        .expect("write codex manifest");
        fs::create_dir_all(source_root.join(".cursor-plugin")).expect("create cursor manifest dir");
        fs::write(
            source_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"coding-tutor","displayName":"Coding Tutor","version":"1.3.0","description":"Tutor plugin"}"#,
        )
        .expect("write cursor manifest");
        fs::write(source_root.join("commands/teach-me.md"), "# Teach me").expect("write command");
        let repo_root = temp_dir.join("repo");
        commit_test_repo(&repo_root, None);
        let source_url = repo_root.to_string_lossy().into_owned();

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "claude-code".to_string(),
                compatible_host_tools: vec![
                    "claude-code".to_string(),
                    "codex".to_string(),
                    "cursor".to_string(),
                ],
                kind: "plugin-repo".to_string(),
                manifest_name: "coding-tutor".to_string(),
                name: "Coding Tutor".to_string(),
                description: "Tutor plugin".to_string(),
                plugin_root: source_root.to_string_lossy().into_owned(),
                manifest_path: source_root
                    .join(".claude-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url: source_url.clone(),
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: repo_root.to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/coding-tutor".to_string(),
                git_root: repo_root.to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "claude-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec![
                "claude-code".to_string(),
                "codex".to_string(),
                "cursor".to_string(),
            ],
            None,
        )
        .expect("install selected plugin");

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(installed.len(), 3);
        assert!(installed
            .iter()
            .any(|plugin| plugin.host_tool == "claude-code"));
        assert!(installed.iter().any(|plugin| plugin.host_tool == "codex"));
        assert!(installed.iter().any(|plugin| plugin.host_tool == "cursor"));
        assert!(plugins
            .iter()
            .any(|plugin| plugin.host_tool == "claude-code"));
        assert!(plugins.iter().any(|plugin| plugin.host_tool == "codex"));
        assert!(plugins.iter().any(|plugin| plugin.host_tool == "cursor"));
        assert!(home_dir
            .join(".claude/plugins/installed_plugins.json")
            .is_file());
        assert!(home_dir.join(".codex/config.toml").is_file());
        let cursor_root = home_dir.join(".cursor/plugins/local/coding-tutor");
        assert!(cursor_root.is_dir());
        assert!(cursor_root.join(".cursor-plugin/plugin.json").is_file());
        let claude_root = installed
            .iter()
            .find(|plugin| plugin.host_tool == "claude-code")
            .map(|plugin| PathBuf::from(&plugin.root_path))
            .expect("find claude install root");
        let codex_root = installed
            .iter()
            .find(|plugin| plugin.host_tool == "codex")
            .map(|plugin| PathBuf::from(&plugin.root_path))
            .expect("find codex install root");
        assert!(claude_root.join(".claude-plugin/plugin.json").is_file());
        assert!(codex_root.join(".codex-plugin/plugin.json").is_file());
        assert!(paths_refer_to_same_dir(
            &claude_root.join(".claude-plugin"),
            &cursor_root.join(".claude-plugin")
        ));
        assert!(paths_refer_to_same_dir(
            &codex_root.join(".codex-plugin"),
            &cursor_root.join(".codex-plugin")
        ));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn installs_cursor_plugin_by_materializing_manifest_from_codex_probe() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-install-from-codex-probe");
        let home_dir = temp_dir.join("home");
        let source_root = temp_dir.join("repo");
        fs::create_dir_all(source_root.join(".codex-plugin")).expect("create codex manifest dir");
        fs::create_dir_all(source_root.join("skills/compound")).expect("create skill dir");
        fs::write(
            source_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"compound-engineering","version":"1.0.0","description":"Compound engineering","interface":{"displayName":"Compound Engineering"}}"#,
        )
        .expect("write codex manifest");
        fs::write(source_root.join("skills/compound/SKILL.md"), "# Compound").expect("write skill");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "codex".to_string(),
                compatible_host_tools: vec!["codex".to_string(), "cursor".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "compound-engineering".to_string(),
                name: "Compound Engineering".to_string(),
                description: "Compound engineering".to_string(),
                plugin_root: source_root.to_string_lossy().into_owned(),
                manifest_path: temp_dir
                    .join("stale-probe-repo/.codex-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "local".to_string(),
                source_url: String::new(),
                source_ref: String::new(),
                is_git_repo: false,
                repo_root: String::new(),
                plugin_relative_path: String::new(),
                git_root: String::new(),
                confidence: "high".to_string(),
                install_strategy: "codex-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec!["cursor".to_string()],
            None,
        )
        .expect("install cursor plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        let cursor_root = home_dir.join(".cursor/plugins/local/compound-engineering");
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].host_tool, "cursor");
        assert!(cursor_root.is_dir());
        assert!(cursor_root.join(".cursor-plugin/plugin.json").is_file());
        assert!(cursor_root.join("skills/compound/SKILL.md").is_file());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn cursor_plugin_install_links_managed_contents_into_local_root() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-install-materializes-local-dir");
        let home_dir = temp_dir.join("home");
        let repo_root = temp_dir.join("repo");
        let source_root = repo_root.join("plugins/shopify-plugin");
        fs::create_dir_all(source_root.join(".cursor-plugin")).expect("create cursor manifest dir");
        fs::create_dir_all(source_root.join("skills")).expect("create skills dir");
        fs::write(
            source_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"shopify-plugin","displayName":"Shopify","version":"1.0.0"}"#,
        )
        .expect("write cursor manifest");
        fs::write(source_root.join("skills/SKILL.md"), "# Shopify").expect("write skill");
        commit_test_repo(&repo_root, None);
        let source_url = repo_root.to_string_lossy().into_owned();

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "cursor".to_string(),
                compatible_host_tools: vec!["cursor".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "shopify-plugin".to_string(),
                name: "Shopify".to_string(),
                description: "Shopify tools".to_string(),
                plugin_root: source_root.to_string_lossy().into_owned(),
                manifest_path: source_root
                    .join(".cursor-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url,
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: repo_root.to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/shopify-plugin".to_string(),
                git_root: repo_root.to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "cursor-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec!["cursor".to_string()],
            None,
        )
        .expect("install selected plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        let installed_root = home_dir.join(".cursor/plugins/local/shopify-plugin");
        assert_eq!(installed.len(), 1);
        assert!(installed_root.join(".cursor-plugin/plugin.json").is_file());
        assert!(installed_root.is_dir());
        assert!(!fs::symlink_metadata(&installed_root)
            .expect("read Cursor plugin root metadata")
            .file_type()
            .is_symlink());
        assert!(fs::symlink_metadata(installed_root.join(".cursor-plugin"))
            .expect("read Cursor manifest link metadata")
            .file_type()
            .is_symlink());
        assert!(fs::symlink_metadata(installed_root.join("skills"))
            .expect("read Cursor skills link metadata")
            .file_type()
            .is_symlink());
        let managed_plugin_root = fs::canonicalize(installed_root.join(".cursor-plugin"))
            .expect("canonicalize managed Cursor manifest directory")
            .parent()
            .expect("managed plugin root")
            .to_path_buf();
        assert!(managed_plugin_root
            .to_string_lossy()
            .contains("/.skilldock/plugins/"));
        assert!(paths_refer_to_same_dir(
            Path::new(&installed[0].root_path),
            &installed_root
        ));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn cursor_subdir_install_links_shared_plugin_without_snapshot() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-subdir-install-git");
        let home_dir = temp_dir.join("home");
        let repo_root = temp_dir.join("repo");
        let source_root = repo_root.join("plugins/coding-tutor");
        fs::create_dir_all(source_root.join(".cursor-plugin")).expect("create cursor manifest dir");
        fs::create_dir_all(source_root.join("commands")).expect("create commands dir");
        fs::write(
            source_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"coding-tutor","displayName":"Coding Tutor","version":"1.3.0","repository":"https://github.com/everyinc/compound-engineering-plugin","description":"Tutor plugin"}"#,
        )
        .expect("write cursor manifest");
        fs::write(source_root.join("commands/teach-me.md"), "# Teach me").expect("write command");
        commit_test_repo(&repo_root, None);
        let source_url = repo_root.to_string_lossy().into_owned();

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "cursor".to_string(),
                compatible_host_tools: vec!["cursor".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "coding-tutor".to_string(),
                name: "Coding Tutor".to_string(),
                description: "Tutor plugin".to_string(),
                plugin_root: source_root.to_string_lossy().into_owned(),
                manifest_path: source_root
                    .join(".cursor-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url: source_url.clone(),
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: repo_root.to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/coding-tutor".to_string(),
                git_root: repo_root.to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "cursor-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec!["cursor".to_string()],
            None,
        )
        .expect("install selected plugin");

        let plugins = list_installed_plugins().expect("list installed plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        let installed_repo_root = home_dir.join(".cursor/plugins/local/coding-tutor");
        assert_eq!(installed.len(), 1);
        assert!(paths_refer_to_same_dir(
            Path::new(&installed[0].root_path),
            &installed_repo_root
        ));
        assert!(installed_repo_root
            .join(".cursor-plugin/plugin.json")
            .is_file());
        assert!(installed_repo_root.is_dir());
        let managed_plugin_root = fs::canonicalize(installed_repo_root.join(".cursor-plugin"))
            .expect("canonicalize managed Cursor manifest directory")
            .parent()
            .expect("managed plugin root")
            .to_path_buf();
        assert!(managed_plugin_root
            .to_string_lossy()
            .contains("/.skilldock/plugins/"));
        assert_eq!(plugins.len(), 1);
        assert!(paths_refer_to_same_dir(
            Path::new(&plugins[0].root_path),
            &installed_repo_root
        ));
        assert_eq!(plugins[0].plugin_relative_path, "plugins/coding-tutor");
        assert!(paths_refer_to_same_dir(
            &PathBuf::from(&plugins[0].repo_root_path).join(&plugins[0].plugin_relative_path),
            &managed_plugin_root
        ));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn updates_cursor_git_plugin_in_managed_directory() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-git-update-local-repo");
        let home_dir = temp_dir.join("home");
        let repo_root = temp_dir.join("repo");
        let source_root = repo_root.join("plugins/coding-tutor");
        fs::create_dir_all(source_root.join(".cursor-plugin")).expect("create cursor manifest dir");
        fs::create_dir_all(source_root.join("commands")).expect("create commands dir");
        fs::write(
            source_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"coding-tutor","displayName":"Coding Tutor","version":"1.3.0","description":"Tutor plugin"}"#,
        )
        .expect("write cursor manifest");
        fs::write(source_root.join("commands/teach-me.md"), "# v1").expect("write command");
        commit_test_repo(&repo_root, None);
        let source_url = repo_root.to_string_lossy().into_owned();

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let installed = install_selected_plugin_probes_blocking(
            vec![PluginProbeResult {
                tool: "cursor".to_string(),
                compatible_host_tools: vec!["cursor".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "coding-tutor".to_string(),
                name: "Coding Tutor".to_string(),
                description: "Tutor plugin".to_string(),
                plugin_root: source_root.to_string_lossy().into_owned(),
                manifest_path: source_root
                    .join(".cursor-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url: source_url.clone(),
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: repo_root.to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/coding-tutor".to_string(),
                git_root: repo_root.to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "cursor-plugin-dir".to_string(),
                warnings: Vec::new(),
            }],
            vec!["cursor".to_string()],
            None,
        )
        .expect("install cursor plugin");
        let installed_root = PathBuf::from(&installed[0].root_path);
        let managed_package_root = home_dir.join(".skilldock/plugins/coding-tutor");
        run_git_test(
            &managed_package_root,
            &["remote", "add", "origin", &source_url],
        );

        fs::write(source_root.join("commands/teach-me.md"), "# v2").expect("update command");
        run_git_test(&repo_root, &["add", "."]);
        run_git_test(&repo_root, &["commit", "-m", "update cursor plugin"]);

        let updated = tauri::async_runtime::block_on(super::update_plugin(
            "cursor".to_string(),
            installed_root.to_string_lossy().into_owned(),
        ))
        .expect("update cursor plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(updated.host_tool, "cursor");
        assert!(
            fs::read_to_string(installed_root.join("commands/teach-me.md"))
                .expect("read updated command")
                .contains("v2")
        );
        assert_eq!(
            run_git_test_output(&managed_package_root, &["remote", "get-url", "origin"]),
            source_url
        );
        assert!(home_dir.join(".skilldock/plugins/coding-tutor").is_dir());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn normalizes_cursor_local_git_remote_urls_for_fetch() {
        assert_eq!(
            super::normalize_cursor_local_git_remote_url(
                "https://github.com/everyinc/compound-engineering-plugin/tree/main/plugins/coding-tutor"
            )
            .as_deref(),
            Some("https://github.com/everyinc/compound-engineering-plugin.git")
        );
        assert_eq!(
            super::normalize_cursor_local_git_remote_url(
                "https://gitlab.com/team/tools/-/tree/main/plugins/coding-tutor"
            )
            .as_deref(),
            Some("https://gitlab.com/team/tools.git")
        );
        assert_eq!(
            super::normalize_cursor_local_git_remote_url("git@github.com:team/tools.git")
                .as_deref(),
            Some("git@github.com:team/tools.git")
        );
        assert_eq!(
            super::normalize_cursor_local_git_remote_url("notaurl"),
            None
        );
    }

    #[test]
    fn cursor_scan_uses_managed_plugin_root_for_repo_metadata() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-scan-managed-root");
        let home_dir = temp_dir.join("home");
        let managed_plugin_root =
            home_dir.join(".skilldock/plugins/coding-tutor/plugins/coding-tutor");
        let local_root = home_dir.join(".cursor/plugins/local/coding-tutor");

        fs::create_dir_all(managed_plugin_root.join(".cursor-plugin"))
            .expect("create managed cursor manifest dir");
        fs::create_dir_all(managed_plugin_root.join("commands")).expect("create commands dir");
        fs::write(
            managed_plugin_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"coding-tutor","displayName":"Coding Tutor","version":"1.3.0","repository":"https://github.com/everyinc/compound-engineering-plugin","description":"Tutor"}"#,
        )
        .expect("write managed manifest");
        fs::write(
            managed_plugin_root.join("commands/teach-me.md"),
            "# Teach me",
        )
        .expect("write command");
        copy_plugin_dir(&managed_plugin_root, &local_root).expect("copy local root");
        write_plugin_package_identity(
            &managed_plugin_root
                .parent()
                .and_then(Path::parent)
                .expect("package root"),
            "https://github.com/everyinc/compound-engineering-plugin.git",
            Path::new("plugins/coding-tutor"),
        )
        .expect("write package identity");
        write_plugin_package_identity(
            &local_root,
            "https://github.com/everyinc/compound-engineering-plugin.git",
            Path::new("plugins/coding-tutor"),
        )
        .expect("write local package identity");
        write_skilldock_plugin_source_metadata(
            &local_root,
            &PluginProbeResult {
                tool: "cursor".to_string(),
                compatible_host_tools: vec!["cursor".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "coding-tutor".to_string(),
                name: "Coding Tutor".to_string(),
                description: "Tutor".to_string(),
                plugin_root: managed_plugin_root.to_string_lossy().into_owned(),
                repo_root: home_dir
                    .join(".skilldock/plugins/coding-tutor")
                    .to_string_lossy()
                    .into_owned(),
                plugin_relative_path: "plugins/coding-tutor".to_string(),
                manifest_path: managed_plugin_root
                    .join(".cursor-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url: "https://github.com/everyinc/compound-engineering-plugin".to_string(),
                source_ref: String::new(),
                is_git_repo: true,
                git_root: home_dir
                    .join(".skilldock/plugins/coding-tutor")
                    .to_string_lossy()
                    .into_owned(),
                confidence: "high".to_string(),
                install_strategy: "cursor-plugin-dir".to_string(),
                warnings: Vec::new(),
            },
        )
        .expect("write source metadata");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].host_tool, "cursor");
        assert!(plugins[0]
            .repo_root_path
            .contains(".skilldock/plugins/coding-tutor"));
        assert_eq!(plugins[0].plugin_relative_path, "plugins/coding-tutor");

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
    fn deletes_cursor_local_link_and_managed_plugin_package() {
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
        fs::create_dir_all(install_root.parent().expect("Cursor install parent"))
            .expect("create Cursor install parent");
        std::os::unix::fs::symlink(&managed_plugin_root, &install_root)
            .expect("link managed Cursor plugin");
        write_skilldock_plugin_source_metadata(
            &install_root,
            &PluginProbeResult {
                tool: "cursor".to_string(),
                compatible_host_tools: vec!["cursor".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "coding-tutor".to_string(),
                name: "Coding Tutor".to_string(),
                description: String::new(),
                plugin_root: managed_plugin_root.to_string_lossy().into_owned(),
                manifest_path: managed_plugin_root
                    .join(".cursor-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url: "https://github.com/everyinc/compound-engineering-plugin.git"
                    .to_string(),
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: managed_package_root.to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/coding-tutor".to_string(),
                git_root: managed_package_root.to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "cursor-plugin-dir".to_string(),
                warnings: Vec::new(),
            },
        )
        .expect("write source metadata");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let installed_plugins = list_installed_plugins().expect("list plugins before delete");
        let cursor_plugin_root = installed_plugins
            .iter()
            .find(|plugin| plugin.host_tool == "cursor" && plugin.name == "Coding Tutor")
            .map(|plugin| plugin.root_path.clone())
            .expect("find cursor plugin root");

        delete_plugin("cursor".to_string(), cursor_plugin_root).expect("delete cursor plugin");
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

    #[cfg(unix)]
    #[test]
    fn deletes_cursor_plugin_without_listing_all_plugins_again() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-delete-no-full-rescan");
        let home_dir = temp_dir.join("home");
        let managed_package_root = home_dir.join(".skilldock/plugins/raisely");
        let managed_plugin_root = managed_package_root.join("plugins/raisely");
        let install_root = home_dir.join(".cursor/plugins/local/raisely");

        fs::create_dir_all(managed_plugin_root.join(".cursor-plugin"))
            .expect("create managed cursor manifest dir");
        fs::write(
            managed_plugin_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"raisely","displayName":"Raisely","version":"0.1.0"}"#,
        )
        .expect("write managed cursor manifest");
        write_plugin_package_identity(
            &managed_package_root,
            "https://github.com/raisely/cursor-plugin.git",
            Path::new("plugins/raisely"),
        )
        .expect("write managed package identity");
        copy_plugin_dir(&managed_plugin_root, &install_root).expect("copy cursor plugin");
        write_plugin_package_identity(
            &install_root,
            "https://github.com/raisely/cursor-plugin.git",
            Path::new("plugins/raisely"),
        )
        .expect("write local package identity");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        delete_plugin(
            "cursor".to_string(),
            install_root.to_string_lossy().into_owned(),
        )
        .expect("delete cursor plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(fs::symlink_metadata(&install_root).is_err());
        assert!(!managed_package_root.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn deletes_cursor_local_copy_when_request_uses_managed_plugin_root() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-delete-managed-root-request");
        let home_dir = temp_dir.join("home");
        let managed_package_root = home_dir.join(".skilldock/plugins/shopify-ai-toolkit");
        let managed_plugin_root = managed_package_root.join("plugins/shopify-plugin");
        let install_root = home_dir.join(".cursor/plugins/local/shopify-plugin");

        fs::create_dir_all(managed_plugin_root.join(".cursor-plugin"))
            .expect("create managed cursor manifest dir");
        fs::create_dir_all(managed_plugin_root.join("skills")).expect("create managed skills dir");
        fs::write(
            managed_plugin_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"shopify-plugin","displayName":"Shopify","version":"1.0.0","repository":"https://github.com/Shopify/Shopify-AI-Toolkit"}"#,
        )
        .expect("write managed cursor manifest");
        fs::write(managed_plugin_root.join("skills/SKILL.md"), "# Shopify")
            .expect("write managed skill");
        write_plugin_package_identity(
            &managed_package_root,
            "https://github.com/Shopify/Shopify-AI-Toolkit",
            Path::new("plugins/shopify-plugin"),
        )
        .expect("write package identity");
        copy_plugin_dir(&managed_plugin_root, &install_root).expect("copy cursor plugin");
        write_skilldock_plugin_source_metadata(
            &install_root,
            &PluginProbeResult {
                tool: "cursor".to_string(),
                compatible_host_tools: vec!["cursor".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "shopify-plugin".to_string(),
                name: "Shopify".to_string(),
                description: "Shopify tools".to_string(),
                plugin_root: managed_plugin_root.to_string_lossy().into_owned(),
                manifest_path: managed_plugin_root
                    .join(".cursor-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "git".to_string(),
                source_url: "https://github.com/Shopify/Shopify-AI-Toolkit".to_string(),
                source_ref: String::new(),
                is_git_repo: true,
                repo_root: managed_package_root.to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/shopify-plugin".to_string(),
                git_root: managed_package_root.to_string_lossy().into_owned(),
                confidence: "high".to_string(),
                install_strategy: "cursor-plugin-dir".to_string(),
                warnings: Vec::new(),
            },
        )
        .expect("write local source metadata");
        write_plugin_package_identity(
            &install_root,
            "https://github.com/Shopify/Shopify-AI-Toolkit",
            Path::new("plugins/shopify-plugin"),
        )
        .expect("write local package identity");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        delete_plugin(
            "cursor".to_string(),
            managed_plugin_root.to_string_lossy().into_owned(),
        )
        .expect("delete cursor plugin via managed root");
        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(fs::symlink_metadata(&install_root).is_err());
        assert!(!managed_package_root.exists());
        assert!(plugins.is_empty());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn deletes_cursor_managed_package_by_manifest_when_local_copy_lacks_skilldock_metadata() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-delete-manifest-fallback");
        let home_dir = temp_dir.join("home");
        let managed_package_root = home_dir.join(".skilldock/plugins/ai-tooling");
        let install_root = home_dir.join(".cursor/plugins/local/launchdarkly");

        fs::create_dir_all(managed_package_root.join(".cursor-plugin"))
            .expect("create managed cursor manifest dir");
        fs::write(
            managed_package_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"launchdarkly","displayName":"LaunchDarkly","version":"1.0.2","repository":"https://github.com/launchdarkly/ai-tooling"}"#,
        )
        .expect("write managed cursor manifest");
        write_plugin_package_identity(
            &managed_package_root,
            "https://github.com/launchdarkly/ai-tooling",
            Path::new(""),
        )
        .expect("write managed package identity");

        copy_plugin_dir(&managed_package_root, &install_root).expect("copy cursor plugin");
        let _ = fs::remove_file(legacy_plugin_package_identity_path(&install_root));
        let _ = fs::remove_file(legacy_skilldock_plugin_source_metadata_path(&install_root));

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
        assert!(plugins.is_empty());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn deletes_broken_managed_plugin_links_and_residual_package() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("delete-broken-managed-plugin");
        let home_dir = temp_dir.join("home");
        let package_root = home_dir.join(".skilldock/plugins/example-plugin");
        let missing_plugin_root = package_root.join("example-plugin");
        let claude_link =
            home_dir.join(".claude/plugins/marketplaces/skilldock/plugins/example-plugin");
        let cursor_link = home_dir.join(".cursor/plugins/local/example-plugin");
        let cursor_agent_link = home_dir.join(".cursor/agents/agentic-review.md");
        let opencode_link = home_dir.join(".config/opencode/plugins/example-plugin.js");
        let opencode_marker =
            home_dir.join(".skilldock/disabled-plugins/opencode/example-plugin");
        let codex_link = home_dir.join(".codex/plugins/cache/skilldock/example-plugin");

        fs::create_dir_all(package_root.join(".git/info")).expect("create residual package");
        for parent in [
            claude_link.parent(),
            cursor_link.parent(),
            cursor_agent_link.parent(),
            opencode_link.parent(),
            codex_link.parent(),
        ] {
            fs::create_dir_all(parent.expect("link parent")).expect("create link parent");
        }
        fs::create_dir_all(&opencode_marker).expect("create opencode marker");
        std::os::unix::fs::symlink(&missing_plugin_root, &claude_link)
            .expect("create broken claude link");
        std::os::unix::fs::symlink(&missing_plugin_root, &cursor_link)
            .expect("create broken cursor link");
        std::os::unix::fs::symlink(
            cursor_link.join("agents/agentic-review.md"),
            &cursor_agent_link,
        )
        .expect("create broken cursor agent link");
        std::os::unix::fs::symlink(
            missing_plugin_root.join(".opencode/plugins/example-plugin.js"),
            &opencode_link,
        )
        .expect("create broken opencode link");
        std::os::unix::fs::symlink(&missing_plugin_root, &codex_link).expect("create codex link");

        fs::write(
            home_dir.join(".claude/plugins/installed_plugins.json"),
            r#"{
  "version": 2,
  "plugins": {
    "example-plugin@skilldock": [
      { "installPath": "__INSTALL_PATH__" }
    ]
  }
}"#
            .replace("__INSTALL_PATH__", &claude_link.to_string_lossy()),
        )
        .expect("write claude installed state");
        fs::write(
            home_dir.join(".claude/settings.json"),
            r#"{
  "enabledPlugins": {
    "example-plugin@skilldock": true
  }
}"#,
        )
        .expect("write claude settings");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        assert!(super::path_resolves_into_broken_package(
            &claude_link,
            &package_root,
        ));
        assert!(super::path_resolves_into_broken_package(
            &cursor_agent_link,
            &package_root,
        ));

        delete_plugin(
            "claude-code".to_string(),
            claude_link.to_string_lossy().into_owned(),
        )
        .expect("delete broken managed plugin");
        delete_plugin(
            "cursor".to_string(),
            cursor_link.to_string_lossy().into_owned(),
        )
        .expect("repeat aggregate delete after cleanup");

        let installed_content =
            fs::read_to_string(home_dir.join(".claude/plugins/installed_plugins.json"))
                .expect("read claude installed state");
        let settings_content =
            fs::read_to_string(home_dir.join(".claude/settings.json")).expect("read settings");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(fs::symlink_metadata(&claude_link).is_err());
        assert!(fs::symlink_metadata(&cursor_link).is_err());
        assert!(fs::symlink_metadata(&cursor_agent_link).is_err());
        assert!(fs::symlink_metadata(&opencode_link).is_err());
        assert!(fs::symlink_metadata(&opencode_marker).is_err());
        assert!(fs::symlink_metadata(&package_root).is_err());
        assert!(fs::symlink_metadata(&codex_link).is_ok());
        assert!(!installed_content.contains("example-plugin@skilldock"));
        assert!(!settings_content.contains("example-plugin@skilldock"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn updates_cursor_hash_plugin_via_managed_copy_and_syncs_local_copy() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-hash-update-sync");
        let home_dir = temp_dir.join("home");
        let package_root = home_dir.join(".skilldock/plugins/product-design");
        let managed_plugin_root = package_root.join("plugins/product-design");
        let local_root = home_dir.join(".cursor/plugins/local/product-design");
        let remote_repo = temp_dir.join("remote-product-design.git");

        super::run_git_at(
            Path::new("."),
            &["init", "--bare", remote_repo.to_string_lossy().as_ref()],
        )
        .expect("init bare repo");
        super::run_git_at(&remote_repo, &["symbolic-ref", "HEAD", "refs/heads/main"])
            .expect("point bare repo HEAD at main");

        let seed_repo = temp_dir.join("seed-repo");
        fs::create_dir_all(managed_plugin_root.join(".cursor-plugin"))
            .expect("create managed manifest dir");
        fs::create_dir_all(managed_plugin_root.join("skills")).expect("create skills dir");
        fs::write(
            managed_plugin_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"product-design","displayName":"Product Design","version":"1.0.0","repository":"https://github.com/example/product-design","description":"Design plugin"}"#,
        )
        .expect("write manifest");
        fs::write(managed_plugin_root.join("skills/SKILL.md"), "# v1").expect("write skill");
        write_plugin_package_identity(
            &package_root,
            remote_repo.to_string_lossy().as_ref(),
            Path::new("plugins/product-design"),
        )
        .expect("write package identity");

        copy_plugin_dir(&managed_plugin_root, &local_root).expect("copy local root");
        write_plugin_package_identity(
            &local_root,
            remote_repo.to_string_lossy().as_ref(),
            Path::new("plugins/product-design"),
        )
        .expect("write local package identity");
        write_skilldock_plugin_source_metadata(
            &local_root,
            &PluginProbeResult {
                tool: "cursor".to_string(),
                compatible_host_tools: vec!["cursor".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "product-design".to_string(),
                name: "Product Design".to_string(),
                description: "Design plugin".to_string(),
                plugin_root: managed_plugin_root.to_string_lossy().into_owned(),
                repo_root: package_root.to_string_lossy().into_owned(),
                plugin_relative_path: "plugins/product-design".to_string(),
                manifest_path: managed_plugin_root
                    .join(".cursor-plugin/plugin.json")
                    .to_string_lossy()
                    .into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "marketplace".to_string(),
                source_url: remote_repo.to_string_lossy().into_owned(),
                source_ref: String::new(),
                is_git_repo: false,
                git_root: String::new(),
                confidence: "high".to_string(),
                install_strategy: "cursor-plugin-dir".to_string(),
                warnings: Vec::new(),
            },
        )
        .expect("write source metadata");
        let baseline_hash = super::compute_plugin_dir_hash(&local_root).expect("compute baseline");
        super::write_plugin_update_metadata(
            &local_root,
            &super::SkillDockPluginUpdateMetadata { baseline_hash },
        )
        .expect("write update metadata");

        fs::create_dir_all(seed_repo.join("plugins/product-design/.cursor-plugin"))
            .expect("create seed manifest dir");
        fs::create_dir_all(seed_repo.join("plugins/product-design/skills"))
            .expect("create seed skills dir");
        fs::write(
            seed_repo.join("plugins/product-design/.cursor-plugin/plugin.json"),
            r#"{"name":"product-design","displayName":"Product Design","version":"1.1.0","repository":"https://github.com/example/product-design","description":"Design plugin"}"#,
        )
        .expect("write seed manifest");
        fs::write(
            seed_repo.join("plugins/product-design/skills/SKILL.md"),
            "# v2",
        )
        .expect("write seed skill");
        run_git_test(&seed_repo, &["init"]);
        run_git_test(&seed_repo, &["config", "user.email", "test@example.com"]);
        run_git_test(&seed_repo, &["config", "user.name", "Test User"]);
        run_git_test(&seed_repo, &["add", "."]);
        run_git_test(&seed_repo, &["commit", "-m", "seed"]);
        run_git_test(
            &seed_repo,
            &[
                "remote",
                "add",
                "origin",
                remote_repo.to_string_lossy().as_ref(),
            ],
        );
        run_git_test(&seed_repo, &["push", "origin", "HEAD:main"]);

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let updated = tauri::async_runtime::block_on(super::update_plugin(
            "cursor".to_string(),
            local_root.to_string_lossy().into_owned(),
        ))
        .expect("update plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(updated.host_tool, "cursor");
        assert!(fs::read_to_string(local_root.join("skills/SKILL.md"))
            .expect("read local skill")
            .contains("v2"));
        assert!(
            fs::read_to_string(managed_plugin_root.join("skills/SKILL.md"))
                .expect("read managed skill")
                .contains("v2")
        );

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
    fn toggles_cursor_plugin_by_moving_install_directory() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-toggle-enabled");
        let home_dir = temp_dir.join("home");
        let install_root = home_dir.join(".cursor/plugins/local/example-plugin");
        let disabled_root = home_dir.join(".skilldock/disabled-plugins/cursor/example-plugin");

        fs::create_dir_all(install_root.join(".cursor-plugin"))
            .expect("create cursor plugin manifest dir");
        fs::create_dir_all(install_root.join("skills/reviewer")).expect("create cursor skill dir");
        fs::write(
            install_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"example-plugin","displayName":"Example Plugin","version":"1.0.0"}"#,
        )
        .expect("write cursor plugin manifest");
        fs::write(install_root.join("skills/reviewer/SKILL.md"), "# Reviewer")
            .expect("write cursor skill");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let disabled_plugin = set_plugin_enabled(
            "cursor".to_string(),
            install_root.to_string_lossy().into_owned(),
            false,
        )
        .expect("disable cursor plugin");
        assert_eq!(disabled_plugin.enabled_state, "disabled");
        assert!(!install_root.exists());
        assert!(disabled_root.join("skills/reviewer/SKILL.md").is_file());

        let enabled_plugin =
            set_plugin_enabled("cursor".to_string(), disabled_plugin.root_path, true)
                .expect("enable cursor plugin");
        let plugins = list_installed_plugins().expect("list cursor plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(enabled_plugin.enabled_state, "enabled");
        assert!(install_root.join("skills/reviewer/SKILL.md").is_file());
        assert!(!disabled_root.exists());
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].enabled_state, "enabled");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn toggles_cursor_plugin_by_moving_managed_symlink() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-toggle-managed-symlink");
        let home_dir = temp_dir.join("home");
        let managed_root = home_dir.join(".skilldock/plugins/example-plugin");
        let install_root = home_dir.join(".cursor/plugins/local/example-plugin");
        let disabled_root = home_dir.join(".skilldock/disabled-plugins/cursor/example-plugin");

        fs::create_dir_all(managed_root.join(".cursor-plugin"))
            .expect("create managed Cursor plugin manifest dir");
        fs::create_dir_all(managed_root.join("skills/reviewer"))
            .expect("create managed Cursor skill dir");
        fs::write(
            managed_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"example-plugin","displayName":"Example Plugin","version":"1.0.0"}"#,
        )
        .expect("write managed Cursor plugin manifest");
        fs::write(managed_root.join("skills/reviewer/SKILL.md"), "# Reviewer")
            .expect("write managed Cursor skill");
        fs::create_dir_all(install_root.parent().expect("Cursor install parent"))
            .expect("create Cursor install parent");
        std::os::unix::fs::symlink(&managed_root, &install_root)
            .expect("link managed Cursor plugin");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let disabled_plugin = set_plugin_enabled(
            "cursor".to_string(),
            managed_root.to_string_lossy().into_owned(),
            false,
        )
        .expect("disable linked Cursor plugin");
        assert_eq!(disabled_plugin.enabled_state, "disabled");
        assert!(fs::symlink_metadata(&install_root).is_err());
        assert!(fs::symlink_metadata(&disabled_root)
            .expect("read disabled Cursor plugin link")
            .file_type()
            .is_symlink());
        assert!(managed_root.join("skills/reviewer/SKILL.md").is_file());

        let enabled_plugin =
            set_plugin_enabled("cursor".to_string(), disabled_plugin.root_path, true)
                .expect("enable linked Cursor plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(enabled_plugin.enabled_state, "enabled");
        assert!(fs::symlink_metadata(&install_root)
            .expect("read enabled Cursor plugin link")
            .file_type()
            .is_symlink());
        assert!(fs::symlink_metadata(&disabled_root).is_err());
        assert!(managed_root.join("skills/reviewer/SKILL.md").is_file());

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
    fn deletes_codex_plugin_without_invoking_cli() {
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

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
        match previous_codex_cli {
            Some(value) => env::set_var("SKILLDOCK_CODEX_CLI", value),
            None => env::remove_var("SKILLDOCK_CODEX_CLI"),
        }

        assert!(!log_path.exists());
        let config_content =
            fs::read_to_string(home_dir.join(".codex/config.toml")).expect("read codex config");
        assert!(!config_content.contains("google-drive@openai-curated"));

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

    #[cfg(unix)]
    fn create_shared_claude_codex_plugin_fixture(home_dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let shared_package_root = home_dir.join(".skilldock/plugins/coding-tutor");
        let shared_plugin_root = shared_package_root.join("plugins/coding-tutor");
        let claude_install_root =
            home_dir.join(".claude/plugins/marketplaces/skilldock/plugins/coding-tutor");
        let codex_marketplace_root = home_dir.join(".codex/marketplaces/skilldock");
        let codex_install_root = codex_marketplace_root.join("plugins/coding-tutor");

        fs::create_dir_all(shared_plugin_root.join(".claude-plugin"))
            .expect("create shared claude manifest dir");
        fs::create_dir_all(shared_plugin_root.join(".codex-plugin"))
            .expect("create shared codex manifest dir");
        fs::write(
            shared_plugin_root.join(".claude-plugin/plugin.json"),
            r#"{"name":"coding-tutor","version":"1.0.0","repository":"https://github.com/everyinc/compound-engineering-plugin","interface":{"displayName":"Coding Tutor"}}"#,
        )
        .expect("write shared claude manifest");
        fs::write(
            shared_plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"coding-tutor","version":"1.0.0","repository":"https://github.com/everyinc/compound-engineering-plugin","interface":{"displayName":"Coding Tutor"}}"#,
        )
        .expect("write shared codex manifest");
        write_plugin_package_identity(
            &shared_package_root,
            "https://github.com/everyinc/compound-engineering-plugin.git",
            Path::new("plugins/coding-tutor"),
        )
        .expect("write shared package identity");

        fs::create_dir_all(claude_install_root.parent().expect("claude parent"))
            .expect("create claude parent");
        std::os::unix::fs::symlink(&shared_plugin_root, &claude_install_root)
            .expect("link claude install to shared plugin");
        fs::create_dir_all(codex_install_root.parent().expect("codex parent"))
            .expect("create codex parent");
        std::os::unix::fs::symlink(&shared_plugin_root, &codex_install_root)
            .expect("link codex install to shared plugin");

        fs::create_dir_all(home_dir.join(".claude/plugins")).expect("create claude plugins dir");
        fs::write(
            home_dir.join(".claude/plugins/installed_plugins.json"),
            r#"{
  "version": 2,
  "plugins": {
    "coding-tutor@skilldock": [
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
    "coding-tutor@skilldock": true
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
      "name": "coding-tutor",
      "source": { "path": "./plugins/coding-tutor" }
    }
  ]
}"#,
        )
        .expect("write codex marketplace manifest");
        fs::create_dir_all(home_dir.join(".codex")).expect("create codex dir");
        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."coding-tutor@skilldock"]
enabled = true

[marketplaces.skilldock]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", &codex_marketplace_root.to_string_lossy()),
        )
        .expect("write codex config");

        (shared_package_root, claude_install_root, codex_install_root)
    }

    #[cfg(unix)]
    #[test]
    fn deleting_shared_claude_then_codex_plugin_removes_managed_package() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("delete-shared-claude-then-codex");
        let home_dir = temp_dir.join("home");
        let (shared_package_root, claude_install_root, codex_install_root) =
            create_shared_claude_codex_plugin_fixture(&home_dir);

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        delete_plugin(
            "claude-code".to_string(),
            claude_install_root.to_string_lossy().into_owned(),
        )
        .expect("delete shared claude plugin");
        assert!(shared_package_root.exists());

        delete_plugin(
            "codex".to_string(),
            codex_install_root.to_string_lossy().into_owned(),
        )
        .expect("delete shared codex plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(!shared_package_root.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn deleting_shared_claude_plugin_with_canonical_root_keeps_package_for_codex() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("delete-shared-claude-canonical-root");
        let home_dir = temp_dir.join("home");
        let (shared_package_root, claude_install_root, codex_install_root) =
            create_shared_claude_codex_plugin_fixture(&home_dir);
        let canonical_claude_root =
            fs::canonicalize(&claude_install_root).expect("canonicalize claude install root");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        delete_plugin(
            "claude-code".to_string(),
            canonical_claude_root.to_string_lossy().into_owned(),
        )
        .expect("delete shared claude plugin by canonical root");
        let installed_content =
            fs::read_to_string(home_dir.join(".claude/plugins/installed_plugins.json"))
                .expect("read installed plugins state");
        let settings_content =
            fs::read_to_string(home_dir.join(".claude/settings.json")).expect("read settings");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(!claude_install_root.exists());
        assert!(codex_install_root.exists());
        assert!(shared_package_root.exists());
        assert!(!installed_content.contains("coding-tutor@skilldock"));
        assert!(!settings_content.contains("coding-tutor@skilldock"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn deleting_shared_codex_then_claude_plugin_removes_managed_package() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("delete-shared-codex-then-claude");
        let home_dir = temp_dir.join("home");
        let (shared_package_root, claude_install_root, codex_install_root) =
            create_shared_claude_codex_plugin_fixture(&home_dir);

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        delete_plugin(
            "codex".to_string(),
            codex_install_root.to_string_lossy().into_owned(),
        )
        .expect("delete shared codex plugin");
        assert!(shared_package_root.exists());

        delete_plugin(
            "claude-code".to_string(),
            claude_install_root.to_string_lossy().into_owned(),
        )
        .expect("delete shared claude plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(!shared_package_root.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn deleting_shared_codex_then_cursor_plugin_removes_managed_package() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("delete-shared-codex-then-cursor");
        let home_dir = temp_dir.join("home");
        let shared_package_root = home_dir.join(".skilldock/plugins/example-plugin");
        let shared_plugin_root = shared_package_root.join("example-plugin");
        let codex_marketplace_root = home_dir.join(".codex/marketplaces/skilldock");
        let codex_install_root = codex_marketplace_root.join("plugins/example-plugin");
        let cursor_install_root = home_dir.join(".cursor/plugins/local/example-plugin");

        fs::create_dir_all(shared_plugin_root.join(".codex-plugin"))
            .expect("create shared Codex manifest dir");
        fs::create_dir_all(shared_plugin_root.join(".cursor-plugin"))
            .expect("create shared Cursor manifest dir");
        fs::create_dir_all(shared_plugin_root.join("skills")).expect("create shared skill dir");
        fs::write(
            shared_plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"example-plugin","version":"1.0.0","interface":{"displayName":"Example Plugin"}}"#,
        )
        .expect("write shared Codex manifest");
        fs::write(
            shared_plugin_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"example-plugin","displayName":"Example Plugin","version":"1.0.0"}"#,
        )
        .expect("write shared Cursor manifest");
        fs::write(
            shared_plugin_root.join("skills/SKILL.md"),
            "# Example Plugin",
        )
        .expect("write shared skill");
        write_plugin_package_identity(
            &shared_package_root,
            "https://code.example.com/example-repo.git",
            Path::new("example-plugin"),
        )
        .expect("write shared package identity");

        fs::create_dir_all(codex_install_root.parent().expect("Codex install parent"))
            .expect("create Codex install parent");
        std::os::unix::fs::symlink(&shared_plugin_root, &codex_install_root)
            .expect("link shared Codex plugin");
        fs::create_dir_all(codex_marketplace_root.join(".agents/plugins"))
            .expect("create Codex marketplace dir");
        fs::write(
            codex_marketplace_root.join(".agents/plugins/marketplace.json"),
            r#"{
  "plugins": [
    {
      "name": "example-plugin",
      "source": { "path": "./plugins/example-plugin" }
    }
  ]
}"#,
        )
        .expect("write Codex marketplace manifest");
        fs::create_dir_all(home_dir.join(".codex")).expect("create Codex home dir");
        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."example-plugin@skilldock"]
enabled = true

[marketplaces.skilldock]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", &codex_marketplace_root.to_string_lossy()),
        )
        .expect("write Codex config");
        super::link_cursor_plugin_dir_contents(&shared_plugin_root, &cursor_install_root)
            .expect("link shared Cursor plugin contents");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        delete_plugin(
            "codex".to_string(),
            shared_plugin_root.to_string_lossy().into_owned(),
        )
        .expect("delete shared Codex plugin");
        assert!(shared_plugin_root.exists());
        assert!(cursor_install_root.join("skills/SKILL.md").is_file());

        delete_plugin(
            "cursor".to_string(),
            cursor_install_root.to_string_lossy().into_owned(),
        )
        .expect("delete shared Cursor plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert!(!codex_install_root.exists());
        assert!(!cursor_install_root.exists());
        assert!(!shared_package_root.exists());

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
    fn links_related_host_tools_when_source_url_uses_git_web_branch_path() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("plugin-cross-host-branch-source-scan");
        let home_dir = temp_dir.join("home");
        let repo_source_url = "https://git.example.com/example-org/example-repo";
        let branch_source_url = "https://git.example.com/example-org/example-repo/tree/master";

        let codex_plugin_root = home_dir.join(".codex/plugins/cache/skilldock/example-plugin");
        fs::create_dir_all(codex_plugin_root.join(".codex-plugin"))
            .expect("create codex plugin manifest dir");
        fs::write(
            codex_plugin_root.join(".codex-plugin/plugin.json"),
            format!(
                r#"{{"name":"example-plugin","version":"1.0.0","repository":"{repo_source_url}","interface":{{"displayName":"example-plugin"}}}}"#,
            ),
        )
        .expect("write codex plugin manifest");
        fs::create_dir_all(home_dir.join(".codex")).expect("create codex home dir");
        fs::write(
            home_dir.join(".codex/config.toml"),
            r#"[plugins."example-plugin@skilldock"]
enabled = true

[marketplaces.skilldock]
source = "__SOURCE__"
"#
            .replace("__SOURCE__", repo_source_url),
        )
        .expect("write codex config");

        let claude_install_root =
            home_dir.join(".claude/plugins/cache/skilldock/example-plugin/1.0.0");
        fs::create_dir_all(claude_install_root.join(".claude-plugin"))
            .expect("create claude plugin manifest dir");
        fs::write(
            claude_install_root.join(".claude-plugin/plugin.json"),
            format!(
                r#"{{"name":"example-plugin","version":"1.0.0","repository":"{branch_source_url}","interface":{{"displayName":"example-plugin"}}}}"#,
            ),
        )
        .expect("write claude plugin manifest");
        fs::create_dir_all(home_dir.join(".claude/plugins")).expect("create claude plugins dir");
        fs::write(
            home_dir.join(".claude/plugins/installed_plugins.json"),
            r#"{
  "version": 2,
  "plugins": {
    "example-plugin@skilldock": [
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
    "example-plugin@skilldock": true
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
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("direct-cli-tools");
        let home_dir = temp_dir.join("home");
        let bin_dir = temp_dir.join("bin");
        fs::create_dir_all(&home_dir).expect("create test home");
        fs::create_dir_all(&bin_dir).expect("create test bin");
        let executable_path = bin_dir.join(if cfg!(windows) {
            "lark-cli.cmd"
        } else {
            "lark-cli"
        });
        fs::write(&executable_path, "#!/bin/sh\nexit 0\n").expect("write fake lark cli");
        #[cfg(unix)]
        {
            let mut permissions = fs::metadata(&executable_path)
                .expect("read fake cli metadata")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&executable_path, permissions).expect("make fake cli executable");
        }

        let previous_home = env::var_os("HOME");
        let previous_path = env::var_os("PATH");
        let mut search_paths = vec![bin_dir];
        if let Some(path) = &previous_path {
            search_paths.extend(env::split_paths(path));
        }
        env::set_var("HOME", &home_dir);
        env::set_var(
            "PATH",
            env::join_paths(search_paths).expect("build test PATH"),
        );

        let cli_tools = list_cli_tools().expect("list cli tools");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
        match previous_path {
            Some(value) => env::set_var("PATH", value),
            None => env::remove_var("PATH"),
        }

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

        let _ = fs::remove_dir_all(temp_dir);
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
            manifest_name: "ecc".to_string(),
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
            local_modified_source: String::new(),
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
            manifest_name: "everything-claude-code".to_string(),
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
            local_modified_source: String::new(),
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

    #[test]
    fn probes_opencode_plugin_entrypoints_without_json_manifest() {
        let temp_dir = temp_test_dir("opencode-probe");
        let plugin_root = temp_dir.join("demo-plugin");
        fs::create_dir_all(plugin_root.join(".opencode/plugins"))
            .expect("create OpenCode plugin directory");
        fs::write(
            plugin_root.join("package.json"),
            r#"{"name":"demo-opencode","version":"1.2.3","description":"Demo plugin"}"#,
        )
        .expect("write package manifest");
        fs::write(
            plugin_root.join(".opencode/plugins/demo.ts"),
            "export const Demo = async () => ({})",
        )
        .expect("write OpenCode entrypoint");

        let result = probe_plugin_repo(
            plugin_root.to_string_lossy().into_owned(),
            Some("opencode".to_string()),
        )
        .expect("probe OpenCode plugin");

        assert_eq!(result.tool, "opencode");
        assert_eq!(result.compatible_host_tools, vec!["opencode".to_string()]);
        assert_eq!(result.kind, "plugin-repo");
        assert_eq!(result.install_strategy, "opencode-plugin-link");
        assert!(result.manifest_path.ends_with(".opencode/plugins/demo.ts"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn manages_opencode_links_from_skilldock_source_without_overwriting_conflicts() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("opencode-link-lifecycle");
        let home_dir = temp_dir.join("home");
        let plugin_root = home_dir.join(".skilldock/plugins/demo-opencode");
        let entry_root = plugin_root.join(".opencode/plugins");
        fs::create_dir_all(&entry_root).expect("create managed OpenCode plugin");
        fs::write(
            plugin_root.join("package.json"),
            r#"{"name":"demo-opencode","version":"1.0.0"}"#,
        )
        .expect("write package manifest");
        let first_entry = entry_root.join("first.ts");
        fs::write(&first_entry, "export const First = async () => ({})")
            .expect("write first entrypoint");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        super::ensure_opencode_links_enabled(&home_dir, &plugin_root)
            .expect("enable OpenCode links");
        let expected_links = super::opencode_expected_links(&home_dir, &plugin_root)
            .expect("resolve expected OpenCode links");
        assert_eq!(expected_links.len(), 1);
        let first_link = expected_links[0].1.clone();
        assert!(fs::symlink_metadata(&first_link)
            .expect("read OpenCode link")
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::canonicalize(&first_link).expect("resolve link"),
            fs::canonicalize(&first_entry).expect("resolve first entrypoint")
        );

        let installed = super::scan_opencode_installed_plugins(super::PluginScanMode::Local);
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].host_tool, "opencode");
        assert_eq!(installed[0].enabled_state, "enabled");
        assert!(paths_refer_to_same_dir(
            Path::new(&installed[0].root_path),
            &plugin_root
        ));

        let custom_link = first_link
            .parent()
            .expect("OpenCode target parent")
            .join("user-custom.ts");
        std::os::unix::fs::symlink(&first_entry, &custom_link)
            .expect("create user-owned same-source link");
        super::ensure_opencode_links_disabled(&home_dir, &plugin_root)
            .expect("disable OpenCode links");
        assert!(fs::symlink_metadata(&first_link).is_err());
        assert!(fs::symlink_metadata(&custom_link)
            .expect("read preserved user link")
            .file_type()
            .is_symlink());
        let disabled = super::scan_opencode_installed_plugins(super::PluginScanMode::Local);
        assert_eq!(disabled.len(), 1);
        assert_eq!(disabled[0].enabled_state, "disabled");

        fs::create_dir_all(first_link.parent().expect("link parent"))
            .expect("create OpenCode target root");
        fs::write(&first_link, "user-owned").expect("write conflicting user plugin");
        let conflict = super::ensure_opencode_links_enabled(&home_dir, &plugin_root)
            .expect_err("real file conflict must fail");
        assert!(conflict.contains("不属于当前 SkillDock 插件"));
        assert_eq!(
            fs::read_to_string(&first_link).expect("read preserved conflict"),
            "user-owned"
        );

        fs::remove_file(&first_link).expect("remove test conflict");
        super::ensure_opencode_links_enabled(&home_dir, &plugin_root)
            .expect("re-enable OpenCode links");
        fs::remove_file(&first_entry).expect("remove old entrypoint");
        let second_entry = entry_root.join("second.js");
        fs::write(&second_entry, "export const Second = async () => ({})")
            .expect("write second entrypoint");
        super::ensure_opencode_links_enabled(&home_dir, &plugin_root)
            .expect("reconcile renamed entrypoint");
        let updated_links = super::opencode_expected_links(&home_dir, &plugin_root)
            .expect("resolve updated OpenCode links");
        assert_eq!(updated_links.len(), 1);
        assert!(fs::symlink_metadata(&first_link).is_err());
        assert_eq!(
            fs::canonicalize(&updated_links[0].1).expect("resolve updated link"),
            fs::canonicalize(&second_entry).expect("resolve second entrypoint")
        );

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_escaping_opencode_entries_and_avoids_sanitized_name_collisions() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("opencode-entry-safety");
        let home_dir = temp_dir.join("home");
        let plugin_root = home_dir.join(".skilldock/plugins/demo-opencode");
        let entry_root = plugin_root.join(".opencode/plugins");
        fs::create_dir_all(&entry_root).expect("create managed OpenCode plugin");
        fs::write(entry_root.join("foo-bar.ts"), "export const A = 1")
            .expect("write first colliding entry");
        fs::write(entry_root.join("foo_bar.ts"), "export const B = 2")
            .expect("write second colliding entry");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let links = super::opencode_expected_links(&home_dir, &plugin_root)
            .expect("resolve collision-safe OpenCode links");
        assert_eq!(links.len(), 2);
        assert_ne!(links[0].1, links[1].1);
        super::ensure_opencode_links_enabled(&home_dir, &plugin_root)
            .expect("enable collision-safe OpenCode links");
        assert!(links
            .iter()
            .all(|(_, link)| fs::symlink_metadata(link).is_ok()));

        super::remove_opencode_installation(&home_dir, &plugin_root)
            .expect("remove collision-safe OpenCode links");
        fs::remove_file(entry_root.join("foo-bar.ts")).expect("remove first entry");
        fs::remove_file(entry_root.join("foo_bar.ts")).expect("remove second entry");
        let outside_entry = temp_dir.join("outside.ts");
        fs::write(&outside_entry, "export const Outside = 1").expect("write outside entry");
        std::os::unix::fs::symlink(&outside_entry, entry_root.join("escape.ts"))
            .expect("create escaping entry link");

        let error = super::ensure_opencode_links_enabled(&home_dir, &plugin_root)
            .expect_err("escaping OpenCode entry must be rejected");
        assert!(error.contains("缺少 OpenCode 插件入口"));

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn installs_opencode_plugin_into_skilldock_before_linking_it() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("opencode-managed-install");
        let home_dir = temp_dir.join("home");
        let source_root = temp_dir.join("source");
        let entry_path = source_root.join(".opencode/plugins/demo.ts");
        fs::create_dir_all(entry_path.parent().expect("entry parent"))
            .expect("create OpenCode source");
        fs::write(
            source_root.join("package.json"),
            r#"{"name":"demo-opencode","version":"1.0.0"}"#,
        )
        .expect("write package manifest");
        fs::write(&entry_path, "export const Demo = async () => ({})")
            .expect("write OpenCode entrypoint");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let installed = super::install_shared_plugin_probe_for_hosts(
            &home_dir,
            &PluginProbeResult {
                tool: "opencode".to_string(),
                compatible_host_tools: vec!["opencode".to_string()],
                kind: "plugin-repo".to_string(),
                manifest_name: "demo-opencode".to_string(),
                name: "demo-opencode".to_string(),
                description: "Demo OpenCode plugin".to_string(),
                plugin_root: source_root.to_string_lossy().into_owned(),
                manifest_path: entry_path.to_string_lossy().into_owned(),
                marketplace_manifest_path: String::new(),
                components: Vec::new(),
                source_type: "local".to_string(),
                source_url: String::new(),
                source_ref: String::new(),
                is_git_repo: false,
                repo_root: source_root.to_string_lossy().into_owned(),
                plugin_relative_path: String::new(),
                git_root: String::new(),
                confidence: "high".to_string(),
                install_strategy: "opencode-plugin-link".to_string(),
                warnings: Vec::new(),
            },
            vec!["opencode".to_string()],
            None,
        )
        .expect("install OpenCode plugin");

        assert_eq!(installed.len(), 1);
        let installed_root =
            fs::canonicalize(&installed[0].1).expect("canonicalize installed OpenCode root");
        let managed_root = fs::canonicalize(home_dir.join(".skilldock/plugins"))
            .expect("canonicalize managed plugin root");
        assert!(installed_root.starts_with(&managed_root));
        assert!(!paths_refer_to_same_dir(&installed_root, &source_root));
        let links = super::opencode_expected_links(&home_dir, &installed_root)
            .expect("resolve installed OpenCode links");
        assert_eq!(links.len(), 1);
        assert_eq!(
            fs::canonicalize(&links[0].1).expect("resolve installed OpenCode link"),
            fs::canonicalize(&links[0].0).expect("resolve managed OpenCode source")
        );
        assert!(links[0].0.starts_with(&managed_root));

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn portable_plugin_targets_default_missing_disabled_hosts() {
        let target: super::PortablePluginTarget = serde_json::from_str(
            r#"{
                "schemaVersion": 1,
                "packageId": "demo-opencode",
                "directoryName": "demo-opencode",
                "hostTools": ["opencode"],
                "cursorWasDisabled": false,
                "contentHash": "abc123"
            }"#,
        )
        .expect("deserialize legacy portable plugin target");

        assert!(target.disabled_host_tools.is_empty());
        assert!(target.plugin_relative_path.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn restores_disabled_nested_opencode_plugin_from_portable_target() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("opencode-portable-restore");
        let home_dir = temp_dir.join("home");
        let package_root = home_dir.join(".skilldock/plugins/demo-package");
        let plugin_root = package_root.join("plugins/demo-opencode");
        let entry_path = plugin_root.join(".opencode/plugins/demo.ts");
        fs::create_dir_all(entry_path.parent().expect("entry parent"))
            .expect("create nested OpenCode plugin");
        fs::write(&entry_path, "export const Demo = async () => ({})")
            .expect("write nested OpenCode entry");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let warnings = super::align_portable_plugin_targets(&[super::PortablePluginTarget {
            schema_version: 1,
            package_id: "demo-package".to_string(),
            directory_name: "demo-package".to_string(),
            host_tools: vec!["opencode".to_string()],
            cursor_was_disabled: false,
            disabled_host_tools: vec!["opencode".to_string()],
            plugin_relative_path: "plugins/demo-opencode".to_string(),
            content_hash: "abc123".to_string(),
        }])
        .expect("restore portable OpenCode target");
        assert!(warnings.is_empty());
        let restored = super::scan_opencode_installed_plugins(super::PluginScanMode::Local);
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].enabled_state, "disabled");
        assert!(paths_refer_to_same_dir(
            Path::new(&restored[0].root_path),
            &plugin_root
        ));
        assert!(
            super::collect_opencode_links_for_plugin(&home_dir, &plugin_root)
                .expect("collect restored OpenCode links")
                .is_empty()
        );

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
        let _ = fs::remove_dir_all(temp_dir);
    }
}
