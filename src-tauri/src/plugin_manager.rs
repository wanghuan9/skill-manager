use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use toml_edit::{DocumentMut, Item};

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

#[derive(Debug, Deserialize, Default)]
struct MarketplaceManifest {
    #[serde(default)]
    plugins: Vec<MarketplacePluginEntry>,
}

#[derive(Debug, Deserialize, Default)]
struct MarketplacePluginEntry {
    #[serde(default)]
    name: String,
    #[serde(default)]
    source: MarketplacePluginSource,
}

#[derive(Debug, Deserialize, Default)]
struct MarketplacePluginSource {
    #[serde(default)]
    path: String,
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
pub fn list_installed_plugins() -> Result<Vec<PluginSummary>, String> {
    let mut plugins = Vec::new();
    plugins.extend(scan_codex_installed_plugins());
    plugins.extend(scan_claude_installed_plugins());
    plugins.extend(scan_cursor_installed_plugins());
    dedupe_and_sort_plugins(plugins)
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

        let (install_state, scopes) =
            resolve_cached_codex_plugin_state(&canonical_root, &manifest_path, config_path);
        let source_type = if find_git_root(&canonical_root).is_some() {
            "git".to_string()
        } else {
            "marketplace".to_string()
        };
        let source_url = read_plugin_manifest(&manifest_path)
            .ok()
            .map(|manifest| source_url_from_manifest(&manifest))
            .unwrap_or_default();
        let source_label = plugin_source_label_from_cache_root(home_dir, &canonical_root);

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
    plugin_root: &Path,
    manifest_path: &Path,
    config_path: Option<&Path>,
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

    for (plugin_key, plugin_config) in config.plugins {
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

                if let Some(summary) = build_installed_plugin_summary(InstalledPluginDescriptor {
                    host_tool: "claude-code".to_string(),
                    root: plugin_root,
                    manifest_path,
                    source_type,
                    source_label: plugin_key
                        .rsplit_once('@')
                        .map(|(_, marketplace_name)| marketplace_name.to_string())
                        .unwrap_or_default(),
                    source_url,
                    source_ref: String::new(),
                    source_revision: String::new(),
                    current_version: install_entry.version,
                    current_commit: install_entry.git_commit_sha,
                    installed_at: install_entry.installed_at,
                    updated_at: install_entry.last_updated,
                    install_state: "installed".to_string(),
                    scopes,
                }) {
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
        &home_dir.join(".cursor/plugins/cache"),
        0,
        &mut plugin_roots,
    );
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
        let source_url = read_plugin_manifest(&manifest_path)
            .ok()
            .map(|manifest| source_url_from_manifest(&manifest))
            .unwrap_or_default();

        if let Some(summary) = build_installed_plugin_summary(InstalledPluginDescriptor {
            host_tool: "cursor".to_string(),
            root: canonical_root.clone(),
            manifest_path: manifest_path.clone(),
            source_type,
            source_label: cursor_plugin_source_label(&home_dir, &canonical_root),
            source_url,
            source_ref: String::new(),
            source_revision: cursor_plugin_source_revision(&home_dir, &canonical_root),
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

    let plugins_table = document
        .get_mut("plugins")
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| "Codex config.toml 缺少 plugins 配置".to_string())?;
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
    find_plugin_after_enabled_change("codex", &target_root)
}

fn find_codex_plugin_key_for_root(
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
        let tool = normalized_hint.unwrap_or_else(|| "unknown".to_string());
        let confidence = if tool == "unknown" { "low" } else { "medium" };
        return build_probe_result(ProbeBuildArgs {
            tool: tool.as_str(),
            kind: "standalone-assets",
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
        kind: "unknown",
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
        kind: "plugin-repo",
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
                kind: "marketplace-root",
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
        kind: args.kind.to_string(),
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
        components.push(build_component(
            &path,
            Path::new(relative),
            relative,
            "mcp",
            owner_plugin_id,
        ));
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
    let candidate = root.join(relative_path);
    if asset_type == "skill" {
        let skill_file = candidate.join("SKILL.md");
        if skill_file.is_file() {
            return Ok(skill_file);
        }
    }
    if candidate.is_file() {
        return Ok(candidate);
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
    kind: &'a str,
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
        get_plugin_component_preview, list_cli_tools, list_installed_plugins, probe_plugin_repo,
        set_plugin_enabled,
    };
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
    fn lists_cursor_installed_plugins_from_plugin_cache() {
        let _guard = TEST_ENV_LOCK.lock().expect("lock test env");
        let temp_dir = temp_test_dir("cursor-installed-scan");
        let home_dir = temp_dir.join("home");
        let install_root = home_dir.join(
            ".cursor/plugins/cache/cursor-public/prisma/4584a0a9175ba74053d7ee946c6234d3369a5a33",
        );

        fs::create_dir_all(install_root.join(".cursor-plugin"))
            .expect("create cursor plugin manifest dir");
        fs::create_dir_all(install_root.join(".git")).expect("create cursor plugin git dir");
        fs::create_dir_all(install_root.join("rules")).expect("create rules dir");
        fs::write(
            install_root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"prisma","displayName":"Prisma","version":"1.0.0","repository":"https://github.com/prisma/prisma","description":"Prisma Cursor plugin"}"#,
        )
        .expect("write cursor plugin manifest");
        fs::write(
            install_root.join("rules/schema-conventions.mdc"),
            "# Schema conventions",
        )
        .expect("write cursor rule");
        fs::write(install_root.join("mcp.json"), r#"{"mcpServers":{}}"#).expect("write cursor mcp");

        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home_dir);

        let plugins = list_installed_plugins().expect("list plugins");

        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].host_tool, "cursor");
        assert_eq!(plugins[0].name, "Prisma");
        assert_eq!(plugins[0].source_type, "git");
        assert_eq!(plugins[0].source_label, "cursor-public/prisma");
        assert_eq!(
            plugins[0].source_revision,
            "4584a0a9175ba74053d7ee946c6234d3369a5a33"
        );
        assert_eq!(plugins[0].source_url, "https://github.com/prisma/prisma");
        assert_eq!(plugins[0].enabled_state, "enabled");
        assert_eq!(plugins[0].install_state, "installed");
        assert_eq!(plugins[0].scopes.len(), 1);
        assert_eq!(plugins[0].scopes[0].scope_id, "user");
        assert_eq!(plugins[0].scopes[0].enabled_state, "enabled");
        assert_eq!(plugins[0].components.len(), 2);
        assert!(plugins[0]
            .components
            .iter()
            .any(|component| component.asset_type == "mcp"));
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
