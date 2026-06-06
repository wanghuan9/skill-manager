use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
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
use crate::workspace;

const CLAUDE_PLUGIN_MANIFEST: &str = ".claude-plugin/plugin.json";
const CLAUDE_MARKETPLACE_MANIFEST: &str = ".claude-plugin/marketplace.json";
const CURSOR_PLUGIN_MANIFEST: &str = ".cursor-plugin/plugin.json";
const CODEX_PLUGIN_MANIFEST: &str = ".codex-plugin/plugin.json";
const CODEX_MARKETPLACE_MANIFEST: &str = ".agents/plugins/marketplace.json";

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
    scopes: Vec<PluginScopeSummary>,
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
pub fn list_installed_plugins() -> Result<Vec<PluginSummary>, String> {
    let mut plugins = Vec::new();
    plugins.extend(scan_codex_installed_plugins());
    plugins.extend(scan_claude_installed_plugins());
    plugins.extend(scan_cursor_installed_plugins());
    dedupe_and_sort_plugins(plugins)
}

#[tauri::command]
pub fn install_selected_plugin_probes(
    probes: Vec<PluginProbeResult>,
    host_tools: Vec<String>,
) -> Result<Vec<PluginSummary>, String> {
    let home_dir = workspace::home_dir_option().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let mut installed_roots = Vec::new();

    for probe in probes {
        let source_root = canonicalize_existing_dir(Path::new(&probe.plugin_root))?;
        for host_tool in &host_tools {
            if !plugin_probe_supports_host(&probe, host_tool) {
                continue;
            }
            let installed_root =
                install_plugin_probe_for_host(&home_dir, &source_root, &probe, host_tool)?;
            installed_roots.push((host_tool.clone(), installed_root));
        }
    }

    let installed_plugins = list_installed_plugins()?;
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

fn scan_codex_installed_plugins() -> Vec<PluginSummary> {
    let Some(home_dir) = workspace::home_dir_option() else {
        return Vec::new();
    };
    let cache_root = home_dir.join(".codex/plugins/cache");
    let config_path = home_dir.join(".codex/config.toml");
    let Ok(config_content) = fs::read_to_string(&config_path) else {
        return scan_codex_cached_plugins(&home_dir, None, &BTreeSet::new());
    };
    let Ok(config) = parse_codex_config(&config_content) else {
        return scan_codex_cached_plugins(&home_dir, None, &BTreeSet::new());
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

        let source_type = if find_git_root(&plugin_root).is_some() {
            "git".to_string()
        } else {
            "marketplace".to_string()
        };
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
            root: plugin_root,
            manifest_path,
            source_type,
            source_label: marketplace_name.to_string(),
            source_url: if marketplace_config.source.trim().is_empty() {
                source_url
            } else {
                marketplace_config.source.clone()
            },
            source_ref: marketplace_config.source_ref.clone(),
            source_revision: marketplace_config.last_revision.clone(),
            current_version: String::new(),
            current_commit: String::new(),
            installed_at: String::new(),
            updated_at: String::new(),
            install_state: "installed".to_string(),
            scopes,
        }) {
            installed_roots.insert(summary.root_path.clone());
            installed.push(summary);
        }
    }
    installed.extend(scan_codex_cached_plugins(
        &home_dir,
        Some(&config_path),
        &installed_roots,
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
            scopes,
        }) {
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

fn scan_claude_installed_plugins() -> Vec<PluginSummary> {
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
                let source_type = if find_git_root(&plugin_root).is_some() {
                    "git".to_string()
                } else {
                    "marketplace".to_string()
                };
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
                        manifest_path,
                        source_type,
                        source_label,
                        source_url,
                        source_ref: String::new(),
                        source_revision: String::new(),
                        current_version: install_entry.version,
                        current_commit: install_entry.git_commit_sha,
                        installed_at: install_entry.installed_at,
                        updated_at: install_entry.last_updated,
                        install_state: "installed".to_string(),
                        scopes,
                    })
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
        installed.extend(scan_claude_marketplace_roots(&home_dir));
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

    let modified_at = file_modified_timestamp(&marketplace_manifest_path)
        .or_else(|| file_modified_timestamp(&root))
        .unwrap_or_default();
    let last_scanned_at = current_timestamp_millis();

    Some(PluginSummary {
        id: plugin_id,
        name: entry
            .display_name
            .clone()
            .unwrap_or_else(|| plugin_name.to_string()),
        description: entry.description,
        host_tool: "claude-code".to_string(),
        related_host_tools: Vec::new(),
        kind: "plugin-repo".to_string(),
        root_path: path_to_string(&root),
        manifest_path: path_to_string(&marketplace_manifest_path),
        source_type: "marketplace".to_string(),
        source_label: marketplace_name.to_string(),
        source_url: entry.source_url,
        source_ref: String::new(),
        source_revision: String::new(),
        current_version: if install_entry.version.trim().is_empty() {
            entry.version
        } else {
            install_entry.version
        },
        current_branch: String::new(),
        current_commit: install_entry.git_commit_sha,
        is_git_repo: find_git_root(&root).is_some(),
        update_mode: "auto".to_string(),
        update_available: false,
        installed_at: if install_entry.installed_at.trim().is_empty() {
            modified_at.clone()
        } else {
            install_entry.installed_at
        },
        updated_at: if install_entry.last_updated.trim().is_empty() {
            modified_at
        } else {
            install_entry.last_updated
        },
        last_scanned_at,
        status: "ready".to_string(),
        install_state: "installed".to_string(),
        enabled_state: aggregate_plugin_enabled_state(&scopes),
        scopes,
        components,
    })
}

fn scan_claude_marketplace_roots(home_dir: &Path) -> Vec<PluginSummary> {
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

        let source_type = if find_git_root(&plugin_root).is_some() {
            "git".to_string()
        } else {
            "marketplace".to_string()
        };
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
            root: plugin_root,
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
            install_state: "installed".to_string(),
            scopes: vec![build_plugin_scope_summary(
                "user",
                "用户级",
                "unknown",
                &home_dir.join(".claude/settings.json"),
            )],
        }) {
            installed.push(summary);
        }
    }

    installed
}

fn scan_cursor_installed_plugins() -> Vec<PluginSummary> {
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
        let source_type = if find_git_root(&canonical_root).is_some() {
            "git".to_string()
        } else if is_under_cursor_local_plugins(&home_dir, &canonical_root) {
            "local".to_string()
        } else {
            "marketplace".to_string()
        };
        let source_metadata = read_skilldock_plugin_source_metadata(&canonical_root);
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
            scopes: vec![build_plugin_scope_summary(
                "user",
                "用户级",
                "enabled",
                &manifest_path,
            )],
        }) {
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
    let target_root = canonicalize_existing_dir(Path::new(root_path))?;
    ensure_plugin_manifest_for_host("codex", &target_root)?;
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
    roots_to_remove.insert(path_to_string(&target_root), target_root.clone());

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
                if let Some(marketplace_config) = config.marketplaces.get(&marketplace_name) {
                    if let Some(configured_root) = resolve_configured_codex_plugin_root(
                        &cache_root,
                        &marketplace_name,
                        marketplace_config,
                        &plugin_name,
                    ) {
                        roots_to_remove.insert(path_to_string(&configured_root), configured_root);
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

    if let Some((plugin_key, _, _)) = config_update.as_ref() {
        if remove_codex_plugin_via_cli(&home_dir, plugin_key).is_ok() {
            return Ok(());
        }
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
    for root in roots {
        match fs::remove_dir_all(&root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "删除 Codex 插件目录失败（{}）: {error}",
                    root.display()
                ));
            }
        }
    }

    Ok(())
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
    let target_root = canonicalize_existing_dir(Path::new(root_path))?;
    ensure_plugin_manifest_for_host("claude-code", &target_root)?;
    let plugin_key = installed_state
        .as_ref()
        .and_then(|state| find_claude_plugin_key_for_root(state, &target_root).ok());

    if installed_state.is_some() {
        remove_claude_installed_plugin_entry(&installed_state_path, &target_root)?;
    }
    if let Some(plugin_key) = plugin_key {
        remove_claude_enabled_plugin_entry(&settings_path, &plugin_key)?;
    }

    fs::remove_dir_all(&target_root).map_err(|error| {
        format!(
            "删除 Claude 插件目录失败（{}）: {error}",
            target_root.display()
        )
    })
}

fn delete_cursor_plugin(root_path: &str) -> Result<(), String> {
    let target_root = canonicalize_existing_dir(Path::new(root_path))?;
    ensure_plugin_manifest_for_host("cursor", &target_root)?;
    fs::remove_dir_all(&target_root).map_err(|error| {
        format!(
            "删除 Cursor 插件目录失败（{}）: {error}",
            target_root.display()
        )
    })
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
    list_installed_plugins()?
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

    list_installed_plugins()?
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

fn plugin_probe_supports_host(probe: &PluginProbeResult, host_tool: &str) -> bool {
    if probe.tool == host_tool {
        return true;
    }

    probe
        .compatible_host_tools
        .iter()
        .any(|tool| tool == host_tool)
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
    copy_plugin_dir(source_root, &target_root)?;
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
    copy_plugin_dir(source_root, &linked_plugin_root)?;
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

    copy_plugin_dir(source_root, &plugin_root)?;

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
    copy_plugin_dir(source_root, &target_root)?;
    write_skilldock_plugin_source_metadata(&target_root, probe)?;
    Ok(target_root)
}

fn skilldock_plugin_source_metadata_path(plugin_root: &Path) -> PathBuf {
    plugin_root.join(".skilldock/plugin-source.json")
}

fn write_skilldock_plugin_source_metadata(
    plugin_root: &Path,
    probe: &PluginProbeResult,
) -> Result<(), String> {
    let metadata = SkillDockPluginSourceMetadata {
        source_url: probe.source_url.trim().to_string(),
        source_type: probe.source_type.trim().to_string(),
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
    })
}

fn read_skilldock_plugin_source_metadata(
    plugin_root: &Path,
) -> Option<SkillDockPluginSourceMetadata> {
    let metadata_path = skilldock_plugin_source_metadata_path(plugin_root);
    let content = fs::read_to_string(metadata_path).ok()?;
    serde_json::from_str::<SkillDockPluginSourceMetadata>(&content).ok()
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
    let normalized_source = normalize_plugin_source_identity(&plugin.source_url);
    let normalized_package = normalize_plugin_source_identity(&plugin_package_name(plugin));
    if normalized_source.is_empty() || normalized_package.is_empty() {
        return None;
    }

    Some(format!("source:{normalized_source}:{normalized_package}"))
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

fn build_installed_plugin_summary(descriptor: InstalledPluginDescriptor) -> Option<PluginSummary> {
    let root = canonicalize_existing_dir(&descriptor.root).ok()?;
    let manifest = read_plugin_manifest(&descriptor.manifest_path).ok()?;
    let git_root = find_git_root(&root);
    let plugin_id = build_plugin_id(&descriptor.host_tool, &manifest, &root);
    let mut components = collect_asset_components(&root, &plugin_id);

    if components.is_empty() {
        components = collect_asset_components(&root, &plugin_id);
    }

    let modified_at = file_modified_timestamp(&descriptor.manifest_path)
        .or_else(|| file_modified_timestamp(&root))
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

    Some(PluginSummary {
        id: plugin_id,
        name: plugin_display_name(&manifest, &root),
        description: plugin_description(&manifest),
        host_tool: descriptor.host_tool,
        related_host_tools: Vec::new(),
        kind: "plugin-repo".to_string(),
        root_path: path_to_string(&root),
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
        current_branch: String::new(),
        current_commit: descriptor.current_commit,
        is_git_repo: git_root.is_some(),
        update_mode: update_mode.to_string(),
        update_available: false,
        installed_at: if descriptor.installed_at.trim().is_empty() {
            modified_at.clone()
        } else {
            descriptor.installed_at
        },
        updated_at: if descriptor.updated_at.trim().is_empty() {
            modified_at
        } else {
            descriptor.updated_at
        },
        last_scanned_at,
        status: "ready".to_string(),
        install_state: descriptor.install_state,
        enabled_state: aggregate_plugin_enabled_state(&descriptor.scopes),
        scopes: descriptor.scopes,
        components,
    })
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
    canonicalize_existing_dir(&probe_root).map(|root| probe_plugin_root(&root, hint_host_tool))
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
    canonicalize_existing_dir(&probe_root)
        .map(|root| probe_plugin_candidates(&root, hint_host_tool))
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
        copy_plugin_dir, delete_plugin, ensure_skilldock_claude_marketplace,
        ensure_skilldock_codex_marketplace, get_plugin_component_preview,
        install_selected_plugin_probes, list_cli_tools, list_installed_plugins,
        newest_codex_plugin_root_under, probe_plugin_repo, probe_plugin_source_candidates_blocking,
        set_plugin_enabled,
    };
    use crate::models::PluginProbeResult;
    use crate::workspace::TEST_ENV_LOCK;
    use std::env;
    use std::fs;
    use std::path::PathBuf;
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
        let installed = install_selected_plugin_probes(
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
        assert!(installed[0]
            .root_path
            .ends_with(".claude/plugins/marketplaces/skilldock/plugins/example-plugin"));
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
        let installed = install_selected_plugin_probes(
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
        assert!(
            installed[0]
                .root_path
                .contains(".codex/plugins/cache/skilldock/product-design")
                || installed[0]
                    .root_path
                    .contains(".codex/marketplaces/skilldock/plugins/product-design")
        );
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
        let repo_root = temp_dir.join("repo");
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

        let probes = probe_plugin_source_candidates_blocking(
            &repo_root.to_string_lossy(),
            None,
            None,
            Some("claude-code".to_string()),
        )
        .expect("probe plugin candidates");
        let target_probe = probes
            .into_iter()
            .find(|probe| probe.plugin_root.ends_with("plugins/product-design"))
            .expect("find product-design probe");

        let installed =
            install_selected_plugin_probes(vec![target_probe], vec!["claude-code".to_string()])
                .expect("install selected plugin");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].host_tool, "claude-code");
        assert_eq!(installed[0].name, "product-design");
        assert!(installed[0]
            .root_path
            .ends_with(".claude/plugins/marketplaces/product-design"));
        assert!(home_dir
            .join(".claude/plugins/installed_plugins.json")
            .is_file());
        assert!(home_dir.join(".claude/settings.json").is_file());

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
        assert_eq!(plugins[0].source_url, "https://github.com/raisely/cursor-plugin");
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

        let installed = install_selected_plugin_probes(
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
        assert_eq!(installed[0].source_type, "local");
        assert!(installed[0]
            .root_path
            .ends_with(".cursor/plugins/local/example-plugin"));
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
}
