use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const STATE_DIR_NAME: &str = ".skillm";
const MCP_STATE_FILE_NAME: &str = "mcp-servers.json";
const APP_CLAUDE_CODE: &str = "claude-code";
const APP_CODEX: &str = "codex";
const APP_GEMINI: &str = "gemini";
const APP_OPENCODE: &str = "opencode";
const APP_OPENCLAW: &str = "openclaw";
const APP_CURSOR: &str = "cursor";
const APP_WINDSURF: &str = "windsurf";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTargetApp {
    pub id: String,
    pub name: String,
    pub config_path: String,
    pub status_label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAppStatus {
    pub app_id: String,
    pub app_name: String,
    pub config_path: String,
    pub status_label: String,
    pub is_enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRecord {
    pub id: String,
    pub name: String,
    pub server: Value,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub source_url: String,
    #[serde(default)]
    pub enabled_app_ids: Vec<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSummary {
    pub id: String,
    pub name: String,
    pub server_type: String,
    pub command_label: String,
    pub description: String,
    pub source_url: String,
    pub server_json: String,
    pub enabled_app_count: usize,
    pub apps: Vec<McpAppStatus>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpWorkspaceSnapshot {
    pub storage_path: String,
    pub apps: Vec<McpTargetApp>,
    pub servers: Vec<McpServerSummary>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct McpPersistence {
    #[serde(default)]
    servers: Vec<McpServerRecord>,
}

#[derive(Clone)]
struct McpTargetAppSpec {
    id: &'static str,
    name: &'static str,
    config_path: PathBuf,
    config_dir: PathBuf,
    is_mcp_supported: bool,
}

#[derive(Debug, Deserialize)]
struct NpmPackageMetadata {
    description: Option<String>,
    repository: Option<NpmRepository>,
    homepage: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum NpmRepository {
    Object { url: Option<String> },
    String(String),
}

#[derive(Debug, Deserialize)]
struct GithubRepositoryMetadata {
    description: Option<String>,
    html_url: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct McpResolvedMetadata {
    description: String,
    source_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpMarketplaceServer {
    pub id: String,
    pub name: String,
    pub source_site: String,
    pub description: String,
    pub publisher: String,
    pub category: String,
    pub transport_label: String,
    pub source_url: String,
    pub popularity_label: String,
    pub avatar_url: Option<String>,
    pub server: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpDirectoryServersResponse {
    #[serde(default)]
    servers: Vec<McpDirectoryServer>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpDirectoryServer {
    id: String,
    fastmcp_id: Option<u64>,
    name: String,
    slug: String,
    #[serde(default)]
    short_description: String,
    #[serde(default)]
    classification: String,
    #[serde(default)]
    transport_type: Vec<String>,
    #[serde(default)]
    stars: u64,
    github_stars: Option<u64>,
    npm_weekly_downloads: Option<u64>,
    #[serde(default)]
    publisher: McpDirectoryPublisher,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpDirectoryPublisher {
    #[serde(default)]
    name: String,
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpDirectoryInstallConfigsResponse {
    #[serde(default)]
    install_configs: Vec<McpDirectoryInstallConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpDirectoryInstallConfig {
    #[serde(default)]
    client_slug: String,
    config_json: String,
}

#[tauri::command]
pub fn list_mcp_workspace() -> Result<McpWorkspaceSnapshot, String> {
    build_mcp_workspace_snapshot()
}

#[tauri::command]
pub async fn list_mcp_marketplace_servers(
    _source_site: Option<String>,
    page: Option<usize>,
    limit: Option<usize>,
    query: Option<String>,
    refresh: Option<bool>,
) -> Result<Vec<McpMarketplaceServer>, String> {
    let safe_page = page.unwrap_or(1).max(1);
    let safe_limit = limit.unwrap_or(24).max(1);
    let normalized_query = query.unwrap_or_default().trim().to_string();
    let is_searching = !normalized_query.is_empty();

    if !refresh.unwrap_or(false) && !is_searching {
        if let Some(cached_page) = load_mcp_marketplace_cache_page(safe_page) {
            return Ok(cached_page);
        }
    }

    let client = match mcp_http_client() {
        Ok(client) => client,
        Err(error) => {
            if safe_page == 1 {
                return Ok(default_mcp_marketplace_servers());
            }
            return Err(error);
        }
    };
    let mut servers = fetch_mcp_directory_servers_page(
        &client,
        safe_page,
        safe_limit,
        if is_searching {
            Some(normalized_query.as_str())
        } else {
            None
        },
    )
    .await
    .unwrap_or_default();

    if servers.is_empty() {
        servers = if is_searching {
            fetch_mcp_directory_query(&client, &normalized_query)
                .await
                .unwrap_or_default()
        } else if safe_page == 1 {
            default_mcp_marketplace_servers()
        } else {
            Vec::new()
        };
    }

    if !normalized_query.is_empty() {
        let query_lower = normalized_query.to_lowercase();
        servers.retain(|server| {
            format!(
                "{} {} {} {}",
                server.name, server.description, server.publisher, server.category
            )
            .to_lowercase()
            .contains(&query_lower)
        });
    }

    if !is_searching && !servers.is_empty() {
        save_mcp_marketplace_cache_page(safe_page, &servers);
    }

    Ok(servers)
}

#[tauri::command]
pub async fn install_mcp_server_from_marketplace(
    server: McpMarketplaceServer,
) -> Result<McpWorkspaceSnapshot, String> {
    let server_config = match server.server.clone() {
        Some(config) => config,
        None => fetch_mcp_marketplace_install_config(&server)
            .await?
            .ok_or_else(|| format!("{} 暂未提供可自动安装的 MCP 配置", server.name))?,
    };

    let server_id = normalize_mcp_marketplace_server_id(&server.name);
    validate_mcp_server(&server_id, &server_config)?;

    let mut records = load_mcp_records()?;
    if records.iter().any(|record| record.id == server_id) {
        return build_mcp_workspace_snapshot();
    }

    let mut record = McpServerRecord {
        id: server_id,
        name: server.name.trim().to_string(),
        server: server_config,
        description: String::new(),
        source_url: git_repository_source_url(&server.source_url).unwrap_or_default(),
        enabled_app_ids: Vec::new(),
        updated_at: now_label(),
    };
    enrich_mcp_record_metadata(&mut record, mcp_metadata_client().as_ref()).await;
    if record.description == fallback_mcp_description(&record)
        && !server.description.trim().is_empty()
    {
        record.description = server.description.trim().to_string();
    }
    records.push(record);
    sort_records(&mut records);
    save_mcp_records(&records)?;
    build_mcp_workspace_snapshot()
}

#[tauri::command]
pub async fn import_mcp_servers_from_apps() -> Result<usize, String> {
    let mut records = load_mcp_records()?;
    let metadata_client = mcp_metadata_client();
    let mut imported_count = 0;

    for app in target_app_specs()? {
        let servers = match read_servers_from_app(&app) {
            Ok(value) => value,
            Err(error) => {
                log::warn!("导入 {} MCP 配置失败: {}", app.name, error);
                continue;
            }
        };

        for (id, server) in servers {
            validate_mcp_server(&id, &server)?;
            imported_count +=
                upsert_imported_record(&mut records, &id, &app, server, metadata_client.as_ref())
                    .await;
        }
    }

    save_mcp_records(&records)?;
    Ok(imported_count)
}

#[tauri::command]
pub async fn upsert_mcp_server(server: McpServerRecord) -> Result<McpWorkspaceSnapshot, String> {
    validate_mcp_server(&server.id, &server.server)?;
    let mut records = load_mcp_records()?;
    let mut normalized = normalize_record(server)?;
    if let Some(previous) = records.iter().find(|item| item.id == normalized.id) {
        if normalized.description.trim().is_empty() {
            normalized.description = previous.description.clone();
        }
        if normalized.source_url.trim().is_empty() {
            normalized.source_url = previous.source_url.clone();
        }
    }
    enrich_mcp_record_metadata(&mut normalized, mcp_metadata_client().as_ref()).await;

    for app_id in &normalized.enabled_app_ids {
        sync_server_to_app(app_id, &normalized.id, &normalized.server)?;
    }

    let enabled_ids = normalized
        .enabled_app_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if let Some(previous) = records.iter().find(|item| item.id == normalized.id) {
        for app_id in &previous.enabled_app_ids {
            if !enabled_ids.contains(app_id) {
                remove_server_from_app(app_id, &normalized.id)?;
            }
        }
    }

    records.retain(|item| item.id != normalized.id);
    records.push(normalized);
    sort_records(&mut records);
    save_mcp_records(&records)?;
    build_mcp_workspace_snapshot()
}

#[tauri::command]
pub async fn delete_mcp_server(id: &str) -> Result<McpWorkspaceSnapshot, String> {
    let mut records = load_mcp_records()?;
    let Some(record) = records.iter().find(|item| item.id == id).cloned() else {
        return Err(format!("未找到 MCP 服务器：{id}"));
    };

    for app_id in record.enabled_app_ids {
        remove_server_from_app(&app_id, id)?;
    }

    records.retain(|item| item.id != id);
    save_mcp_records(&records)?;
    build_mcp_workspace_snapshot()
}

#[tauri::command]
pub async fn toggle_mcp_server_app(
    server_id: &str,
    app_id: &str,
    enabled: bool,
) -> Result<McpWorkspaceSnapshot, String> {
    let mut records = load_mcp_records()?;
    let record = records
        .iter_mut()
        .find(|item| item.id == server_id)
        .ok_or_else(|| format!("未找到 MCP 服务器：{server_id}"))?;

    if enabled {
        sync_server_to_app(app_id, &record.id, &record.server)?;
        if !record.enabled_app_ids.iter().any(|item| item == app_id) {
            record.enabled_app_ids.push(app_id.to_string());
            record.enabled_app_ids.sort();
        }
    } else {
        remove_server_from_app(app_id, &record.id)?;
        record.enabled_app_ids.retain(|item| item != app_id);
    }
    record.updated_at = now_label();

    save_mcp_records(&records)?;
    build_mcp_workspace_snapshot()
}

fn build_mcp_workspace_snapshot() -> Result<McpWorkspaceSnapshot, String> {
    let records = load_mcp_records()?;
    let apps = target_apps()?;
    let mut servers = Vec::with_capacity(records.len());
    for record in records {
        servers.push(to_server_summary(&record, &apps)?);
    }

    Ok(McpWorkspaceSnapshot {
        storage_path: mcp_state_file()?.to_string_lossy().to_string(),
        apps,
        servers,
    })
}

fn to_server_summary(
    record: &McpServerRecord,
    apps: &[McpTargetApp],
) -> Result<McpServerSummary, String> {
    let enabled_app_ids = record
        .enabled_app_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let app_statuses = apps
        .iter()
        .map(|app| McpAppStatus {
            app_id: app.id.clone(),
            app_name: app.name.clone(),
            config_path: app.config_path.clone(),
            status_label: app.status_label.clone(),
            is_enabled: enabled_app_ids.contains(&app.id),
        })
        .collect::<Vec<_>>();
    let server_type = mcp_server_type(&record.server);
    let server_json = serde_json::to_string_pretty(&record.server)
        .map_err(|error| format!("序列化 MCP 配置失败: {error}"))?;

    Ok(McpServerSummary {
        id: record.id.clone(),
        name: record.name.clone(),
        server_type,
        command_label: mcp_command_label(&record.server),
        description: stored_mcp_description(record),
        source_url: record.source_url.trim().to_string(),
        server_json,
        enabled_app_count: record.enabled_app_ids.len(),
        apps: app_statuses,
    })
}

fn target_apps() -> Result<Vec<McpTargetApp>, String> {
    Ok(target_app_specs()?
        .into_iter()
        .map(|spec| {
            let is_installed = spec.config_path.exists() || spec.config_dir.exists();
            McpTargetApp {
                id: spec.id.to_string(),
                name: spec.name.to_string(),
                config_path: if spec.is_mcp_supported {
                    spec.config_path.to_string_lossy().to_string()
                } else {
                    String::new()
                },
                status_label: if is_installed {
                    "已安装"
                } else {
                    "未安装"
                }
                .to_string(),
            }
        })
        .collect())
}

fn target_app_specs() -> Result<Vec<McpTargetAppSpec>, String> {
    let home_dir = home_dir()?;

    Ok(vec![
        supported_app_spec(
            APP_CLAUDE_CODE,
            "Claude Code",
            home_dir.join(".claude.json"),
            home_dir.join(".claude"),
        ),
        supported_app_spec(
            APP_CODEX,
            "Codex",
            home_dir.join(".codex/config.toml"),
            home_dir.join(".codex"),
        ),
        supported_app_spec(
            APP_OPENCODE,
            "OpenCode",
            home_dir.join(".config/opencode/opencode.json"),
            home_dir.join(".config/opencode"),
        ),
        supported_app_spec(
            APP_CURSOR,
            "Cursor",
            home_dir.join(".cursor/mcp.json"),
            home_dir.join(".cursor"),
        ),
        supported_app_spec(
            APP_GEMINI,
            "Gemini CLI",
            home_dir.join(".gemini/settings.json"),
            home_dir.join(".gemini"),
        ),
        unsupported_app_spec(
            "antigravity",
            "Antigravity",
            home_dir.join(".gemini/antigravity"),
        ),
        supported_app_spec(
            APP_WINDSURF,
            "Windsurf",
            home_dir.join(".codeium/windsurf/mcp_config.json"),
            home_dir.join(".codeium/windsurf"),
        ),
        supported_app_spec(
            APP_OPENCLAW,
            "OpenClaw",
            home_dir.join(".openclaw/openclaw.json"),
            home_dir.join(".openclaw"),
        ),
        supported_app_spec(
            "continue",
            "Continue",
            home_dir.join(".continue/config.yaml"),
            home_dir.join(".continue"),
        ),
        unsupported_app_spec("iflow", "iFlow", home_dir.join(".iflow")),
        unsupported_app_spec("codebuddy", "CodeBuddy", home_dir.join(".codebuddy")),
        unsupported_app_spec("trae", "Trae", home_dir.join(".trae")),
        unsupported_app_spec("droid", "Droid", home_dir.join(".factory")),
        unsupported_app_spec("augment", "Augment", home_dir.join(".augment")),
        unsupported_app_spec("cline", "Cline", home_dir.join(".cline")),
        unsupported_app_spec("commandcode", "CommandCode", home_dir.join(".commandcode")),
        unsupported_app_spec("crush", "Crush", home_dir.join(".config/crush")),
        unsupported_app_spec("goose", "Goose", home_dir.join(".config/goose")),
        unsupported_app_spec("junie", "Junie", home_dir.join(".junie")),
        unsupported_app_spec("kilo-code", "Kilo Code", home_dir.join(".kilocode")),
        unsupported_app_spec("kiro", "Kiro", home_dir.join(".kiro")),
        unsupported_app_spec("qoder", "Qoder", home_dir.join(".qoder")),
        unsupported_app_spec("qwen-code", "Qwen Code", home_dir.join(".qwen")),
        unsupported_app_spec("roo-code", "Roo Code", home_dir.join(".roo")),
        unsupported_app_spec("zencoder", "Zencoder", home_dir.join(".zencoder")),
        unsupported_app_spec("trae-cn", "Trae CN", home_dir.join(".trae-cn")),
        unsupported_app_spec("hermes", "Hermes", home_dir.join(".hermes")),
        unsupported_app_spec(
            "github-copilot",
            "GitHub Copilot",
            home_dir.join(".copilot"),
        ),
    ])
}

fn supported_app_spec(
    id: &'static str,
    name: &'static str,
    config_path: PathBuf,
    config_dir: PathBuf,
) -> McpTargetAppSpec {
    McpTargetAppSpec {
        id,
        name,
        config_path,
        config_dir,
        is_mcp_supported: true,
    }
}

fn unsupported_app_spec(
    id: &'static str,
    name: &'static str,
    config_dir: PathBuf,
) -> McpTargetAppSpec {
    McpTargetAppSpec {
        id,
        name,
        config_path: PathBuf::new(),
        config_dir,
        is_mcp_supported: false,
    }
}

fn read_servers_from_app(app: &McpTargetAppSpec) -> Result<Vec<(String, Value)>, String> {
    match app.id {
        APP_CLAUDE_CODE => read_json_mcp_servers(&app.config_path, "mcpServers", false),
        APP_GEMINI => read_gemini_mcp_servers(&app.config_path),
        APP_CODEX => read_codex_mcp_servers(&app.config_path),
        APP_CURSOR => read_json_mcp_servers(&app.config_path, "mcpServers", false),
        APP_OPENCODE => read_agent_json_mcp_servers(&app.config_path),
        APP_WINDSURF => read_json_mcp_servers(&app.config_path, "mcpServers", false),
        APP_OPENCLAW => read_agent_json_mcp_servers(&app.config_path),
        _ => Ok(Vec::new()),
    }
}

fn sync_server_to_app(app_id: &str, server_id: &str, server: &Value) -> Result<(), String> {
    let spec = find_app_spec(app_id)?;
    validate_app_is_ready(&spec)?;
    match app_id {
        APP_CLAUDE_CODE => {
            upsert_json_mcp_server(&spec.config_path, "mcpServers", server_id, server)
        }
        APP_GEMINI => upsert_gemini_mcp_server(&spec.config_path, server_id, server),
        APP_CODEX => upsert_codex_mcp_server(&spec.config_path, server_id, server),
        APP_CURSOR => upsert_json_mcp_server(&spec.config_path, "mcpServers", server_id, server),
        APP_OPENCODE => upsert_agent_json_mcp_server(&spec.config_path, server_id, server),
        APP_WINDSURF => upsert_json_mcp_server(&spec.config_path, "mcpServers", server_id, server),
        APP_OPENCLAW => upsert_agent_json_mcp_server(&spec.config_path, server_id, server),
        _ => Err(format!("不支持的 MCP 应用：{app_id}")),
    }
}

fn remove_server_from_app(app_id: &str, server_id: &str) -> Result<(), String> {
    let spec = find_app_spec(app_id)?;
    match app_id {
        APP_CLAUDE_CODE => remove_json_mcp_server(&spec.config_path, "mcpServers", server_id),
        APP_GEMINI => remove_json_mcp_server(&spec.config_path, "mcpServers", server_id),
        APP_CODEX => remove_codex_mcp_server(&spec.config_path, server_id),
        APP_CURSOR => remove_json_mcp_server(&spec.config_path, "mcpServers", server_id),
        APP_OPENCODE => remove_agent_json_mcp_server(&spec.config_path, server_id),
        APP_WINDSURF => remove_json_mcp_server(&spec.config_path, "mcpServers", server_id),
        APP_OPENCLAW => remove_agent_json_mcp_server(&spec.config_path, server_id),
        _ => Err(format!("不支持的 MCP 应用：{app_id}")),
    }
}

fn find_app_spec(app_id: &str) -> Result<McpTargetAppSpec, String> {
    target_app_specs()?
        .into_iter()
        .find(|item| item.id == app_id)
        .ok_or_else(|| format!("不支持的 MCP 应用：{app_id}"))
}

fn validate_app_is_ready(app: &McpTargetAppSpec) -> Result<(), String> {
    if !app.is_mcp_supported {
        return Err(format!("{} 暂未支持 MCP 配置同步", app.name));
    }

    if app.config_dir.exists() || app.config_path.exists() {
        return Ok(());
    }

    Err(format!(
        "{} 尚未初始化，未找到配置目录：{}",
        app.name,
        app.config_dir.display()
    ))
}

fn read_json_mcp_servers(
    path: &Path,
    field_name: &str,
    allow_json5: bool,
) -> Result<Vec<(String, Value)>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let root = read_json_value(path, allow_json5)?;
    let servers = root
        .get(field_name)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    Ok(servers.into_iter().collect())
}

fn upsert_json_mcp_server(
    path: &Path,
    field_name: &str,
    server_id: &str,
    server: &Value,
) -> Result<(), String> {
    let mut root = if path.exists() {
        read_json_value(path, false)?
    } else {
        json!({})
    };

    let obj = root
        .as_object_mut()
        .ok_or_else(|| format!("{} 根节点必须是 JSON 对象", path.display()))?;
    let entry = obj
        .entry(field_name.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let servers = entry
        .as_object_mut()
        .ok_or_else(|| format!("{field_name} 必须是 JSON 对象"))?;
    servers.insert(server_id.to_string(), server.clone());
    write_json_value(path, &root)
}

fn remove_json_mcp_server(path: &Path, field_name: &str, server_id: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let mut root = read_json_value(path, false)?;
    if let Some(servers) = root.get_mut(field_name).and_then(Value::as_object_mut) {
        servers.remove(server_id);
    }
    write_json_value(path, &root)
}

fn read_gemini_mcp_servers(path: &Path) -> Result<Vec<(String, Value)>, String> {
    let mut servers = read_json_mcp_servers(path, "mcpServers", false)?;
    for (_, spec) in &mut servers {
        if let Some(obj) = spec.as_object_mut() {
            if let Some(http_url) = obj.remove("httpUrl") {
                obj.insert("url".to_string(), http_url);
                obj.insert("type".to_string(), Value::String("http".to_string()));
            }
            if obj.get("type").is_none() {
                let inferred_type = if obj.contains_key("command") {
                    Some("stdio")
                } else if obj.contains_key("url") {
                    Some("sse")
                } else {
                    None
                };
                if let Some(server_type) = inferred_type {
                    obj.insert("type".to_string(), Value::String(server_type.to_string()));
                }
            }
        }
    }
    Ok(servers)
}

fn upsert_gemini_mcp_server(path: &Path, server_id: &str, server: &Value) -> Result<(), String> {
    let mut gemini_server = server
        .as_object()
        .cloned()
        .ok_or_else(|| "MCP 服务器定义必须为 JSON 对象".to_string())?;
    if gemini_server.get("type").and_then(Value::as_str) == Some("http") {
        if let Some(url) = gemini_server.remove("url") {
            gemini_server.insert("httpUrl".to_string(), url);
        }
    }
    gemini_server.remove("type");
    upsert_json_mcp_server(path, "mcpServers", server_id, &Value::Object(gemini_server))
}

fn read_codex_mcp_servers(path: &Path) -> Result<Vec<(String, Value)>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content =
        fs::read_to_string(path).map_err(|error| format!("读取 Codex 配置失败: {error}"))?;
    let doc = content
        .parse::<toml_edit::DocumentMut>()
        .map_err(|error| format!("解析 Codex config.toml 失败: {error}"))?;
    let mut servers = Vec::new();
    if let Some(table) = doc.get("mcp_servers").and_then(|item| item.as_table()) {
        for (id, item) in table.iter() {
            if let Some(server_table) = item.as_table() {
                servers.push((id.to_string(), codex_table_to_json(server_table)));
            }
        }
    }
    if let Some(table) = doc
        .get("mcp")
        .and_then(|item| item.as_table())
        .and_then(|table| table.get("servers"))
        .and_then(|item| item.as_table())
    {
        for (id, item) in table.iter() {
            if let Some(server_table) = item.as_table() {
                servers.push((id.to_string(), codex_table_to_json(server_table)));
            }
        }
    }
    Ok(servers)
}

fn upsert_codex_mcp_server(path: &Path, server_id: &str, server: &Value) -> Result<(), String> {
    let mut doc = read_toml_document(path)?;
    if !doc.as_table().contains_key("mcp_servers") {
        doc["mcp_servers"] = toml_edit::table();
    }
    if let Some(mcp) = doc.get_mut("mcp").and_then(|item| item.as_table_like_mut()) {
        mcp.remove("servers");
    }

    let table = json_server_to_toml_table(server)?;
    doc["mcp_servers"][server_id] = toml_edit::Item::Table(table);
    write_text_value(path, &doc.to_string())
}

fn remove_codex_mcp_server(path: &Path, server_id: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let mut doc = read_toml_document(path)?;
    if let Some(table) = doc
        .get_mut("mcp_servers")
        .and_then(|item| item.as_table_mut())
    {
        table.remove(server_id);
    }
    if let Some(table) = doc
        .get_mut("mcp")
        .and_then(|item| item.as_table_mut())
        .and_then(|table| table.get_mut("servers"))
        .and_then(|item| item.as_table_mut())
    {
        table.remove(server_id);
    }
    write_text_value(path, &doc.to_string())
}

fn read_toml_document(path: &Path) -> Result<toml_edit::DocumentMut, String> {
    if !path.exists() {
        return Ok(toml_edit::DocumentMut::new());
    }

    let content =
        fs::read_to_string(path).map_err(|error| format!("读取 TOML 配置失败: {error}"))?;
    if content.trim().is_empty() {
        return Ok(toml_edit::DocumentMut::new());
    }

    content
        .parse::<toml_edit::DocumentMut>()
        .map_err(|error| format!("解析 TOML 配置失败: {error}"))
}

fn codex_table_to_json(table: &toml_edit::Table) -> Value {
    let mut obj = Map::new();
    let server_type = table
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("stdio");
    obj.insert("type".to_string(), Value::String(server_type.to_string()));

    for (key, item) in table.iter() {
        if key == "http_headers" {
            if let Some(headers) = toml_table_like_to_string_map(item) {
                obj.insert("headers".to_string(), Value::Object(headers));
            }
            continue;
        }
        if let Some(value) = toml_item_to_json(item) {
            obj.insert(key.to_string(), value);
        }
    }

    Value::Object(obj)
}

fn json_server_to_toml_table(server: &Value) -> Result<toml_edit::Table, String> {
    let obj = server
        .as_object()
        .ok_or_else(|| "MCP 服务器定义必须为 JSON 对象".to_string())?;
    let server_type = obj.get("type").and_then(Value::as_str).unwrap_or("stdio");
    let mut table = toml_edit::Table::new();
    table["type"] = toml_edit::value(server_type);

    match server_type {
        "stdio" => {
            let command = obj
                .get("command")
                .and_then(Value::as_str)
                .ok_or_else(|| "stdio 类型 MCP 服务器缺少 command".to_string())?;
            table["command"] = toml_edit::value(command);
            if let Some(args) = obj.get("args").and_then(Value::as_array) {
                let mut arr = toml_edit::Array::default();
                for arg in args.iter().filter_map(Value::as_str) {
                    arr.push(arg);
                }
                if !arr.is_empty() {
                    table["args"] = toml_edit::Item::Value(toml_edit::Value::Array(arr));
                }
            }
            if let Some(cwd) = obj.get("cwd").and_then(Value::as_str) {
                if !cwd.trim().is_empty() {
                    table["cwd"] = toml_edit::value(cwd);
                }
            }
            if let Some(env) = obj.get("env").and_then(Value::as_object) {
                table["env"] = toml_edit::Item::Table(json_string_map_to_toml_table(env));
            }
        }
        "http" | "sse" => {
            let url = obj
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{server_type} 类型 MCP 服务器缺少 url"))?;
            table["url"] = toml_edit::value(url);
            if let Some(headers) = obj.get("headers").and_then(Value::as_object) {
                table["http_headers"] =
                    toml_edit::Item::Table(json_string_map_to_toml_table(headers));
            }
        }
        _ => return Err(format!("不支持的 MCP 类型：{server_type}")),
    }

    for (key, value) in obj {
        if matches!(
            key.as_str(),
            "type" | "command" | "args" | "cwd" | "env" | "url" | "headers"
        ) {
            continue;
        }
        if let Some(item) = json_value_to_toml_item(value) {
            table[key] = item;
        }
    }

    Ok(table)
}

fn read_agent_json_mcp_servers(path: &Path) -> Result<Vec<(String, Value)>, String> {
    let mut servers = read_json_mcp_servers(path, "mcp", true)?;
    for (_, spec) in &mut servers {
        *spec = agent_json_to_unified(spec)?;
    }
    Ok(servers)
}

fn upsert_agent_json_mcp_server(
    path: &Path,
    server_id: &str,
    server: &Value,
) -> Result<(), String> {
    let agent_server = unified_to_agent_json(server)?;
    upsert_json_mcp_server(path, "mcp", server_id, &agent_server)
}

fn remove_agent_json_mcp_server(path: &Path, server_id: &str) -> Result<(), String> {
    remove_json_mcp_server(path, "mcp", server_id)
}

fn unified_to_agent_json(server: &Value) -> Result<Value, String> {
    let obj = server
        .as_object()
        .ok_or_else(|| "MCP 服务器定义必须为 JSON 对象".to_string())?;
    let server_type = obj.get("type").and_then(Value::as_str).unwrap_or("stdio");
    let mut out = Map::new();

    match server_type {
        "stdio" => {
            out.insert("type".to_string(), Value::String("local".to_string()));
            let command = obj
                .get("command")
                .and_then(Value::as_str)
                .ok_or_else(|| "stdio 类型 MCP 服务器缺少 command".to_string())?;
            let mut command_parts = vec![Value::String(command.to_string())];
            if let Some(args) = obj.get("args").and_then(Value::as_array) {
                command_parts.extend(args.iter().cloned());
            }
            out.insert("command".to_string(), Value::Array(command_parts));
            if let Some(env) = obj.get("env") {
                out.insert("environment".to_string(), env.clone());
            }
            out.insert("enabled".to_string(), Value::Bool(true));
        }
        "http" | "sse" => {
            out.insert("type".to_string(), Value::String("remote".to_string()));
            if let Some(url) = obj.get("url") {
                out.insert("url".to_string(), url.clone());
            }
            if let Some(headers) = obj.get("headers") {
                out.insert("headers".to_string(), headers.clone());
            }
            out.insert("enabled".to_string(), Value::Bool(true));
        }
        _ => return Err(format!("不支持的 MCP 类型：{server_type}")),
    }

    Ok(Value::Object(out))
}

fn agent_json_to_unified(server: &Value) -> Result<Value, String> {
    let obj = server
        .as_object()
        .ok_or_else(|| "MCP 服务器定义必须为 JSON 对象".to_string())?;
    let agent_type = obj.get("type").and_then(Value::as_str).unwrap_or("local");
    let mut out = Map::new();

    match agent_type {
        "local" => {
            out.insert("type".to_string(), Value::String("stdio".to_string()));
            if let Some(command_parts) = obj.get("command").and_then(Value::as_array) {
                if let Some(command) = command_parts.first().and_then(Value::as_str) {
                    out.insert("command".to_string(), Value::String(command.to_string()));
                }
                if command_parts.len() > 1 {
                    out.insert(
                        "args".to_string(),
                        Value::Array(command_parts[1..].to_vec()),
                    );
                }
            }
            if let Some(env) = obj.get("environment") {
                out.insert("env".to_string(), env.clone());
            }
        }
        "remote" => {
            out.insert("type".to_string(), Value::String("sse".to_string()));
            if let Some(url) = obj.get("url") {
                out.insert("url".to_string(), url.clone());
            }
            if let Some(headers) = obj.get("headers") {
                out.insert("headers".to_string(), headers.clone());
            }
        }
        _ => return Err(format!("不支持的 MCP 类型：{agent_type}")),
    }

    Ok(Value::Object(out))
}

async fn upsert_imported_record(
    records: &mut Vec<McpServerRecord>,
    id: &str,
    app: &McpTargetAppSpec,
    server: Value,
    metadata_client: Option<&Client>,
) -> usize {
    if let Some(record) = records.iter_mut().find(|item| item.id == id) {
        let previous_description = record.description.clone();
        let previous_source_url = record.source_url.clone();
        enrich_mcp_record_metadata(record, metadata_client).await;
        if !record.enabled_app_ids.iter().any(|item| item == app.id) {
            record.enabled_app_ids.push(app.id.to_string());
            record.enabled_app_ids.sort();
            record.updated_at = now_label();
            return 1;
        }
        if record.description != previous_description || record.source_url != previous_source_url {
            record.updated_at = now_label();
        }
        return 0;
    }

    let mut record = McpServerRecord {
        id: id.to_string(),
        name: id.to_string(),
        server,
        description: String::new(),
        source_url: String::new(),
        enabled_app_ids: vec![app.id.to_string()],
        updated_at: now_label(),
    };
    enrich_mcp_record_metadata(&mut record, metadata_client).await;
    records.push(record);
    sort_records(records);
    1
}

fn normalize_record(mut record: McpServerRecord) -> Result<McpServerRecord, String> {
    let normalized_id = record.id.trim().to_string();
    if normalized_id.is_empty() {
        return Err("MCP 服务器 ID 不能为空".to_string());
    }
    record.id = normalized_id;
    record.name = record.name.trim().to_string();
    if record.name.is_empty() {
        record.name = record.id.clone();
    }
    record.description = record.description.trim().to_string();
    record.source_url = record.source_url.trim().to_string();
    let supported_app_ids = target_app_specs()?
        .into_iter()
        .map(|app| app.id.to_string())
        .collect::<BTreeSet<_>>();
    record
        .enabled_app_ids
        .retain(|app_id| supported_app_ids.contains(app_id));
    record.enabled_app_ids.sort();
    record.enabled_app_ids.dedup();
    record.updated_at = now_label();
    Ok(record)
}

fn validate_mcp_server(id: &str, server: &Value) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("MCP 服务器 ID 不能为空".to_string());
    }
    if !id
        .chars()
        .all(|item| item.is_ascii_alphanumeric() || matches!(item, '-' | '_' | '.'))
    {
        return Err("MCP 服务器 ID 仅支持字母、数字、-、_、.".to_string());
    }

    let obj = server
        .as_object()
        .ok_or_else(|| "MCP 服务器定义必须为 JSON 对象".to_string())?;
    let server_type = obj.get("type").and_then(Value::as_str).unwrap_or("stdio");
    match server_type {
        "stdio" => {
            let command = obj.get("command").and_then(Value::as_str).unwrap_or("");
            if command.trim().is_empty() {
                return Err("stdio 类型 MCP 服务器必须填写 command".to_string());
            }
        }
        "http" | "sse" => {
            let url = obj.get("url").and_then(Value::as_str).unwrap_or("");
            if url.trim().is_empty() {
                return Err(format!("{server_type} 类型 MCP 服务器必须填写 url"));
            }
        }
        _ => return Err("MCP 服务器 type 必须是 stdio、http 或 sse".to_string()),
    }
    Ok(())
}

fn mcp_server_type(server: &Value) -> String {
    server
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("stdio")
        .to_string()
}

fn mcp_command_label(server: &Value) -> String {
    match mcp_server_type(server).as_str() {
        "stdio" => {
            let command = server.get("command").and_then(Value::as_str).unwrap_or("");
            let args = server
                .get("args")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            format!("{command} {args}").trim().to_string()
        }
        "http" | "sse" => server
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        _ => "未知 MCP 配置".to_string(),
    }
}

fn explicit_mcp_description(server: &Value) -> Option<String> {
    server
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn explicit_mcp_source_url(server: &Value) -> Option<String> {
    ["sourceUrl", "source_url", "repository", "homepage"]
        .into_iter()
        .find_map(|key| {
            server
                .get(key)
                .and_then(Value::as_str)
                .and_then(git_repository_source_url)
        })
}

fn git_repository_source_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized = trimmed
        .trim_start_matches("git+")
        .trim_end_matches(".git")
        .to_string();
    let lower = normalized.to_lowercase();
    if lower.contains("github.com")
        || lower.contains("gitlab.com")
        || lower.contains("gitee.com")
        || lower.starts_with("git@github.com:")
        || lower.starts_with("git@gitlab.com:")
        || lower.starts_with("git@gitee.com:")
    {
        return Some(normalized);
    }

    None
}

fn stored_mcp_description(record: &McpServerRecord) -> String {
    let stored_description = record.description.trim();
    if !stored_description.is_empty() {
        return stored_description.to_string();
    }

    explicit_mcp_description(&record.server).unwrap_or_else(|| fallback_mcp_description(record))
}

async fn enrich_mcp_record_metadata(record: &mut McpServerRecord, client: Option<&Client>) {
    let needs_description = record.description.trim().is_empty();
    let needs_source_url = record.source_url.trim().is_empty();
    if !needs_description && !needs_source_url {
        return;
    }

    let metadata = resolve_mcp_metadata(record, client).await;
    if needs_description {
        record.description = metadata.description;
    }
    if needs_source_url {
        record.source_url = metadata.source_url;
    }
}

async fn resolve_mcp_metadata(
    record: &McpServerRecord,
    client: Option<&Client>,
) -> McpResolvedMetadata {
    let mut metadata = McpResolvedMetadata {
        description: explicit_mcp_description(&record.server).unwrap_or_default(),
        source_url: explicit_mcp_source_url(&record.server).unwrap_or_default(),
    };

    if let (Some(client), Some(package_name)) =
        (client, npm_package_from_mcp_server(&record.server))
    {
        let package_metadata = metadata_for_npm_package(client, &package_name).await;
        if metadata.description.trim().is_empty() {
            metadata.description = package_metadata.description;
        }
        if metadata.source_url.trim().is_empty() {
            metadata.source_url = package_metadata.source_url;
        }
    }

    if metadata.description.trim().is_empty() {
        metadata.description = fallback_mcp_description(record);
    }
    metadata.description = metadata.description.trim().to_string();
    metadata.source_url = metadata.source_url.trim().to_string();
    metadata
}

fn fallback_mcp_description(record: &McpServerRecord) -> String {
    let command_label = mcp_command_label(&record.server);
    let source_label = if command_label.is_empty() {
        record.name.as_str()
    } else {
        command_label.as_str()
    };

    match mcp_server_type(&record.server).as_str() {
        "stdio" => format!("通过本地命令 {source_label} 启动的 MCP 服务。"),
        "sse" => format!("连接到 {source_label} 的远程 SSE MCP 服务。"),
        "http" => format!("连接到 {source_label} 的远程 HTTP MCP 服务。"),
        _ => format!("用于向已安装工具同步 {} MCP 配置。", record.name),
    }
}

fn mcp_metadata_client() -> Option<Client> {
    Client::builder()
        .timeout(Duration::from_secs(4))
        .user_agent("skillm/0.1 MCP metadata resolver")
        .build()
        .ok()
}

async fn metadata_for_npm_package(client: &Client, package_name: &str) -> McpResolvedMetadata {
    let Some(metadata) = fetch_npm_package_metadata(client, package_name).await else {
        return McpResolvedMetadata::default();
    };
    let source_url = metadata
        .repository
        .as_ref()
        .and_then(npm_repository_url)
        .or(metadata.homepage.as_deref())
        .and_then(git_repository_source_url);

    let mut resolved = McpResolvedMetadata {
        description: metadata.description.unwrap_or_default().trim().to_string(),
        source_url: source_url.clone().unwrap_or_default(),
    };

    if let Some((owner, repo)) = source_url.as_deref().and_then(github_repo_from_url) {
        if let Some(repo_metadata) = fetch_github_repo_metadata(client, &owner, &repo).await {
            if let Some(description) = repo_metadata
                .description
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            {
                resolved.description = description;
            }
            if let Some(html_url) = repo_metadata
                .html_url
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            {
                resolved.source_url = html_url;
            }
        }
    }

    resolved
}

async fn fetch_npm_package_metadata(
    client: &Client,
    package_name: &str,
) -> Option<NpmPackageMetadata> {
    let encoded_package_name = package_name.replace('/', "%2F");
    let url = format!("https://registry.npmjs.org/{encoded_package_name}");
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }

    response.json::<NpmPackageMetadata>().await.ok()
}

async fn fetch_github_repo_metadata(
    client: &Client,
    owner: &str,
    repo: &str,
) -> Option<GithubRepositoryMetadata> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}");
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }

    response.json::<GithubRepositoryMetadata>().await.ok()
}

fn npm_repository_url(repository: &NpmRepository) -> Option<&str> {
    match repository {
        NpmRepository::Object { url } => url.as_deref(),
        NpmRepository::String(url) => Some(url.as_str()),
    }
}

fn github_repo_from_url(value: &str) -> Option<(String, String)> {
    let normalized = value
        .trim()
        .trim_start_matches("git+")
        .trim_end_matches(".git");
    if let Some(path) = normalized.strip_prefix("git@github.com:") {
        return github_repo_from_path(path);
    }

    let parsed = url::Url::parse(normalized).ok()?;
    if parsed.host_str() != Some("github.com") {
        return None;
    }

    github_repo_from_path(parsed.path())
}

fn github_repo_from_path(path: &str) -> Option<(String, String)> {
    let segments = path
        .trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.len() < 2 {
        return None;
    }

    let owner = segments[0].to_string();
    let repo = segments[1].trim_end_matches(".git").to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }

    Some((owner, repo))
}

fn npm_package_from_mcp_server(server: &Value) -> Option<String> {
    if mcp_server_type(server) != "stdio" {
        return None;
    }

    let command = server.get("command").and_then(Value::as_str)?;
    let command_name = Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(command);
    let args = server
        .get("args")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();

    match command_name {
        "npx" | "bunx" => npm_package_from_exec_args(&args),
        "npm" => npm_package_from_exec_args(strip_leading_exec_command(&args)),
        "pnpm" => npm_package_from_exec_args(strip_leading_pnpm_command(&args)),
        _ => None,
    }
}

fn strip_leading_exec_command<'a>(args: &'a [&'a str]) -> &'a [&'a str] {
    match args.first().copied() {
        Some("exec" | "x") => &args[1..],
        _ => args,
    }
}

fn strip_leading_pnpm_command<'a>(args: &'a [&'a str]) -> &'a [&'a str] {
    match args.first().copied() {
        Some("dlx" | "exec") => &args[1..],
        _ => args,
    }
}

fn npm_package_from_exec_args(args: &[&str]) -> Option<String> {
    let mut index = 0;
    while index < args.len() {
        let item = args[index];
        if item == "--" {
            index += 1;
            continue;
        }
        if matches!(item, "-p" | "--package") {
            return args
                .get(index + 1)
                .map(|value| strip_npm_package_version(value));
        }
        if option_consumes_next_value(item) {
            index += 2;
            continue;
        }
        if item.starts_with('-') {
            index += 1;
            continue;
        }
        if is_npm_package_candidate(item) {
            return Some(strip_npm_package_version(item));
        }
        index += 1;
    }

    None
}

fn option_consumes_next_value(value: &str) -> bool {
    matches!(value, "--registry" | "--cache")
}

fn is_npm_package_candidate(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && !value.starts_with('.')
        && !value.starts_with('/')
        && !value.starts_with("http://")
        && !value.starts_with("https://")
}

fn strip_npm_package_version(value: &str) -> String {
    if value.starts_with('@') {
        if let Some(slash_index) = value.find('/') {
            let version_start = value[slash_index + 1..]
                .find('@')
                .map(|index| slash_index + 1 + index);
            return version_start
                .map(|index| value[..index].to_string())
                .unwrap_or_else(|| value.to_string());
        }
        return value.to_string();
    }

    value
        .find('@')
        .map(|index| value[..index].to_string())
        .unwrap_or_else(|| value.to_string())
}

fn read_json_value(path: &Path, allow_json5: bool) -> Result<Value, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取 JSON 配置失败（{}）：{error}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(json!({}));
    }
    if allow_json5 {
        json5::from_str(&content)
            .map_err(|error| format!("解析 JSON5 配置失败（{}）：{error}", path.display()))
    } else {
        serde_json::from_str(&content)
            .map_err(|error| format!("解析 JSON 配置失败（{}）：{error}", path.display()))
    }
}

fn write_json_value(path: &Path, value: &Value) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(value)
        .map_err(|error| format!("序列化 JSON 配置失败: {error}"))?;
    write_text_value(path, &payload)
}

fn write_text_value(path: &Path, value: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败: {error}"))?;
    }

    let temp_path = path.with_extension(format!("tmp-{}", unix_millis()));
    fs::write(&temp_path, value).map_err(|error| format!("写入临时配置失败: {error}"))?;
    fs::rename(&temp_path, path).map_err(|error| format!("替换配置文件失败: {error}"))
}

fn load_mcp_records() -> Result<Vec<McpServerRecord>, String> {
    let state_file = mcp_state_file()?;
    if !state_file.exists() {
        return Ok(Vec::new());
    }

    let content =
        fs::read_to_string(&state_file).map_err(|error| format!("读取 MCP 状态失败: {error}"))?;
    let persistence = serde_json::from_str::<McpPersistence>(&content)
        .map_err(|error| format!("解析 MCP 状态失败: {error}"))?;
    Ok(persistence.servers)
}

fn save_mcp_records(records: &[McpServerRecord]) -> Result<(), String> {
    let state_file = mcp_state_file()?;
    let parent = state_file
        .parent()
        .ok_or_else(|| "MCP 状态目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建 MCP 状态目录失败: {error}"))?;
    let persistence = McpPersistence {
        servers: records.to_vec(),
    };
    let payload = serde_json::to_string_pretty(&persistence)
        .map_err(|error| format!("序列化 MCP 状态失败: {error}"))?;
    fs::write(state_file, payload).map_err(|error| format!("写入 MCP 状态失败: {error}"))
}

fn mcp_state_file() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(STATE_DIR_NAME).join(MCP_STATE_FILE_NAME))
}

fn home_dir() -> Result<PathBuf, String> {
    env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "无法读取 HOME 环境变量".to_string())
}

fn sort_records(records: &mut [McpServerRecord]) {
    records.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
}

fn now_label() -> String {
    unix_millis().to_string()
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default()
}

fn json_string_map_to_toml_table(map: &Map<String, Value>) -> toml_edit::Table {
    let mut table = toml_edit::Table::new();
    for (key, value) in map {
        if let Some(text) = value.as_str() {
            table[key] = toml_edit::value(text);
        }
    }
    table
}

fn json_value_to_toml_item(value: &Value) -> Option<toml_edit::Item> {
    match value {
        Value::String(text) => Some(toml_edit::value(text.as_str())),
        Value::Bool(value) => Some(toml_edit::value(*value)),
        Value::Number(number) => number
            .as_i64()
            .map(toml_edit::value)
            .or_else(|| number.as_f64().map(toml_edit::value)),
        Value::Array(values) => {
            let mut arr = toml_edit::Array::default();
            for value in values {
                if let Some(text) = value.as_str() {
                    arr.push(text);
                } else if let Some(integer) = value.as_i64() {
                    arr.push(integer);
                } else if let Some(float) = value.as_f64() {
                    arr.push(float);
                } else if let Some(boolean) = value.as_bool() {
                    arr.push(boolean);
                } else {
                    return None;
                }
            }
            Some(toml_edit::Item::Value(toml_edit::Value::Array(arr)))
        }
        Value::Object(map) => {
            let mut table = toml_edit::InlineTable::new();
            for (key, value) in map {
                let text = value.as_str()?;
                table.insert(key, text.into());
            }
            Some(toml_edit::Item::Value(toml_edit::Value::InlineTable(table)))
        }
        Value::Null => None,
    }
}

fn toml_item_to_json(item: &toml_edit::Item) -> Option<Value> {
    if let Some(value) = item.as_value() {
        return toml_value_to_json(value);
    }
    if let Some(map) = toml_table_like_to_string_map(item) {
        return Some(Value::Object(map));
    }
    None
}

fn toml_table_like_to_string_map(item: &toml_edit::Item) -> Option<Map<String, Value>> {
    let table = item.as_table_like()?;
    let mut out = Map::new();
    for (key, value) in table.iter() {
        if let Some(text) = value.as_str() {
            out.insert(key.to_string(), Value::String(text.to_string()));
        }
    }
    Some(out)
}

fn toml_value_to_json(value: &toml_edit::Value) -> Option<Value> {
    if let Some(text) = value.as_str() {
        return Some(Value::String(text.to_string()));
    }
    if let Some(integer) = value.as_integer() {
        return Some(Value::Number(integer.into()));
    }
    if let Some(float) = value.as_float() {
        return Some(json!(float));
    }
    if let Some(boolean) = value.as_bool() {
        return Some(Value::Bool(boolean));
    }
    if let Some(array) = value.as_array() {
        let values = array
            .iter()
            .filter_map(toml_value_to_json)
            .collect::<Vec<_>>();
        return Some(Value::Array(values));
    }
    None
}

fn mcp_http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("skillm/0.1 MCP marketplace")
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(14))
        .build()
        .map_err(|error| format!("创建 MCP 市场请求客户端失败: {error}"))
}

fn mcp_marketplace_cache_file() -> Option<PathBuf> {
    let home_dir = env::var("HOME").ok()?;
    Some(
        PathBuf::from(home_dir)
            .join(".skillm")
            .join("cache")
            .join("mcp-marketplace.json"),
    )
}

fn load_mcp_marketplace_cache_page(page: usize) -> Option<Vec<McpMarketplaceServer>> {
    let cache_path = mcp_marketplace_cache_file()?;
    let content = fs::read_to_string(cache_path).ok()?;
    let cached: Value = serde_json::from_str(&content).ok()?;
    let version = cached
        .get("version")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    if version < 1 {
        return None;
    }

    let timestamp = cached
        .get("timestamp")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    if now.saturating_sub(timestamp) > 3600 {
        return None;
    }

    let page_key = page.to_string();
    let page_value = cached
        .get("sources")
        .and_then(Value::as_object)?
        .get("mcp.directory")?
        .get("pages")
        .and_then(Value::as_object)?
        .get(&page_key)?;

    serde_json::from_value(page_value.clone()).ok()
}

fn save_mcp_marketplace_cache_page(page: usize, servers: &[McpMarketplaceServer]) {
    let Some(cache_path) = mcp_marketplace_cache_file() else {
        return;
    };
    let Some(parent_dir) = cache_path.parent() else {
        return;
    };
    let _ = fs::create_dir_all(parent_dir);

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let mut cache_data = fs::read_to_string(&cache_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or_else(|| json!({}));
    let Some(cache_object) = cache_data.as_object_mut() else {
        return;
    };
    cache_object.insert("version".into(), json!(1_u64));
    cache_object.insert("timestamp".into(), json!(timestamp));
    let sources_value = cache_object.entry("sources").or_insert_with(|| json!({}));
    let Some(sources_object) = sources_value.as_object_mut() else {
        return;
    };
    let source_value = sources_object
        .entry("mcp.directory")
        .or_insert_with(|| json!({ "pages": {} }));
    let Some(source_object) = source_value.as_object_mut() else {
        return;
    };
    source_object.insert("timestamp".into(), json!(timestamp));
    let pages_value = source_object.entry("pages").or_insert_with(|| json!({}));
    let Some(pages_object) = pages_value.as_object_mut() else {
        return;
    };
    pages_object.insert(page.to_string(), json!(servers));

    let _ = fs::write(
        cache_path,
        serde_json::to_string_pretty(&cache_data).unwrap_or_default(),
    );
}

async fn fetch_mcp_directory_servers_page(
    client: &Client,
    page: usize,
    limit: usize,
    query: Option<&str>,
) -> Result<Vec<McpMarketplaceServer>, String> {
    let offset = (page.saturating_sub(1)) * limit;
    let mut params = vec![
        ("limit", limit.to_string()),
        ("offset", offset.to_string()),
        ("sort", "trending".to_string()),
    ];
    if let Some(query) = query {
        let trimmed = query.trim();
        if !trimmed.is_empty() {
            params.push(("q", trimmed.to_string()));
        }
    }

    let payload = client
        .get("https://mcp.directory/api/v1/servers")
        .query(&params)
        .send()
        .await
        .map_err(|error| format!("请求 MCP.Directory 服务列表失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("MCP.Directory 服务列表返回异常状态: {error}"))?
        .json::<McpDirectoryServersResponse>()
        .await
        .map_err(|error| format!("解析 MCP.Directory 服务列表失败: {error}"))?;

    Ok(payload
        .servers
        .into_iter()
        .map(map_mcp_directory_server)
        .collect())
}

fn map_mcp_directory_server(server: McpDirectoryServer) -> McpMarketplaceServer {
    let slug = server.slug.trim().to_string();
    let name = server.name.trim().to_string();
    let source_url = if slug.is_empty() {
        "https://mcp.directory/servers".to_string()
    } else {
        format!("https://mcp.directory/servers/{slug}")
    };
    let publisher = if server.publisher.name.trim().is_empty() {
        "MCP.Directory".to_string()
    } else {
        server.publisher.name.trim().to_string()
    };
    let transport_label = if server.transport_type.is_empty() {
        "需补全".to_string()
    } else {
        server
            .transport_type
            .iter()
            .map(|transport| match transport.as_str() {
                "streamable-http" => "HTTP".to_string(),
                value => value.to_string(),
            })
            .collect::<Vec<_>>()
            .join(" / ")
    };
    let popularity = server
        .github_stars
        .or(Some(server.stars))
        .filter(|value| *value > 0)
        .or(server.npm_weekly_downloads)
        .unwrap_or_default();
    let category = match server.classification.as_str() {
        "official" => "Official",
        "reference" => "Reference",
        "community" => "Community",
        value if !value.trim().is_empty() => value,
        _ => "MCP",
    }
    .to_string();
    let id_suffix = if !slug.is_empty() {
        slug
    } else if let Some(fastmcp_id) = server.fastmcp_id {
        fastmcp_id.to_string()
    } else if !server.id.trim().is_empty() {
        server.id
    } else {
        normalize_mcp_marketplace_server_id(&name)
    };

    McpMarketplaceServer {
        id: format!("mcp-directory-{id_suffix}"),
        name,
        source_site: "MCP.Directory".to_string(),
        description: server.short_description.trim().to_string(),
        publisher,
        category,
        transport_label,
        source_url,
        popularity_label: if popularity > 0 {
            format_compact_count(popularity)
        } else {
            "MCP.Directory".to_string()
        },
        avatar_url: server.publisher.avatar_url,
        server: None,
    }
}

async fn fetch_mcp_marketplace_install_config(
    server: &McpMarketplaceServer,
) -> Result<Option<Value>, String> {
    let slug = server
        .source_url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .trim();
    if slug.is_empty() || server.source_url.trim().is_empty() {
        return Ok(None);
    }

    let client = mcp_http_client()?;
    let endpoint = format!(
        "https://mcp.directory/api/v1/servers/{}/install-configs",
        encode_query_component(slug)
    );
    let payload = client
        .get(endpoint)
        .send()
        .await
        .map_err(|error| format!("请求 MCP 安装配置失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("MCP 安装配置返回异常状态: {error}"))?
        .json::<McpDirectoryInstallConfigsResponse>()
        .await
        .map_err(|error| format!("解析 MCP 安装配置失败: {error}"))?;

    Ok(select_mcp_install_config(
        &payload.install_configs,
        &server.description,
    ))
}

fn select_mcp_install_config(
    configs: &[McpDirectoryInstallConfig],
    description: &str,
) -> Option<Value> {
    const PREFERRED_CLIENTS: [&str; 4] = ["claude-desktop", "cursor", "vscode", "codex"];
    for preferred_client in PREFERRED_CLIENTS {
        if let Some(config) = configs
            .iter()
            .find(|item| item.client_slug == preferred_client)
            .and_then(|item| parse_mcp_install_config(&item.config_json, description))
        {
            return Some(config);
        }
    }

    configs
        .iter()
        .find_map(|item| parse_mcp_install_config(&item.config_json, description))
}

fn parse_mcp_install_config(config_json: &str, description: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(config_json).ok()?;
    let server_value = value
        .get("mcpServers")
        .or_else(|| value.get("mcp").and_then(|mcp| mcp.get("servers")))
        .and_then(Value::as_object)
        .and_then(|servers| servers.values().next())
        .cloned()?;
    normalize_mcp_install_config(server_value, description)
}

fn normalize_mcp_install_config(mut server: Value, description: &str) -> Option<Value> {
    let obj = server.as_object_mut()?;
    if !obj.contains_key("type") {
        if obj.get("url").and_then(Value::as_str).is_some() {
            obj.insert("type".into(), Value::String("http".into()));
        } else if obj.get("command").and_then(Value::as_str).is_some() {
            obj.insert("type".into(), Value::String("stdio".into()));
        }
    }
    if obj.get("type").and_then(Value::as_str) == Some("streamable-http") {
        obj.insert("type".into(), Value::String("http".into()));
    }
    if !description.trim().is_empty() {
        obj.entry("description")
            .or_insert_with(|| Value::String(description.trim().to_string()));
    }
    Some(server)
}

async fn fetch_mcp_directory_query(
    client: &Client,
    query: &str,
) -> Result<Vec<McpMarketplaceServer>, String> {
    let endpoint = format!(
        "https://mcp.directory/servers?q={}",
        encode_query_component(query)
    );
    let html = client
        .get(endpoint)
        .send()
        .await
        .map_err(|error| format!("请求 MCP.Directory 失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("MCP.Directory 返回异常状态: {error}"))?
        .text()
        .await
        .map_err(|error| format!("读取 MCP.Directory 响应失败: {error}"))?;

    if let Some(server) = parse_mcp_directory_detail(&html) {
        return Ok(vec![server]);
    }

    Ok(Vec::new())
}

fn parse_mcp_directory_detail(html: &str) -> Option<McpMarketplaceServer> {
    let payload = extract_json_ld_payload(html, "SoftwareApplication")?;
    let name = payload.get("name")?.as_str()?.trim().to_string();
    let description = payload
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let category = payload
        .get("applicationCategory")
        .and_then(Value::as_str)
        .unwrap_or("MCP")
        .trim()
        .to_string();
    let publisher = payload
        .get("author")
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("MCP.Directory")
        .trim()
        .to_string();
    let avatar_url = payload
        .get("author")
        .and_then(|value| value.get("logo"))
        .and_then(|value| value.get("url"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let popularity_label = payload
        .get("aggregateRating")
        .and_then(|value| value.get("ratingCount"))
        .and_then(Value::as_u64)
        .map(format_compact_count)
        .unwrap_or_else(|| "MCP.Directory".to_string());
    let source_url = payload
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("https://mcp.directory/servers")
        .to_string();
    let server = extract_mcp_server_config(html, &name, &description);
    let transport_label = transport_label_for_market_config(server.as_ref());

    Some(McpMarketplaceServer {
        id: format!(
            "mcp-directory-{}",
            normalize_mcp_marketplace_server_id(&name)
        ),
        name,
        source_site: "MCP.Directory".to_string(),
        description,
        publisher,
        category,
        transport_label,
        source_url,
        popularity_label,
        avatar_url,
        server,
    })
}

fn extract_json_ld_payload(html: &str, expected_type: &str) -> Option<Value> {
    let marker = r#"<script type="application/ld+json">"#;
    let mut search_from = 0;
    while let Some(relative_start) = html[search_from..].find(marker) {
        let content_start = search_from + relative_start + marker.len();
        let relative_end = html[content_start..].find("</script>")?;
        let content_end = content_start + relative_end;
        let content = &html[content_start..content_end];
        search_from = content_end + "</script>".len();

        let parsed = serde_json::from_str::<Value>(content).ok()?;
        if parsed.get("@type").and_then(Value::as_str) == Some(expected_type) {
            return Some(parsed);
        }
    }
    None
}

fn extract_mcp_server_config(html: &str, server_name: &str, description: &str) -> Option<Value> {
    if let Some(config) = extract_cursor_install_config(html, description) {
        return Some(config);
    }

    let name_lower = server_name.to_lowercase();
    if name_lower.contains("context7") {
        return Some(json!({
            "type": "http",
            "url": "https://mcp.context7.com/mcp",
            "description": description
        }));
    }
    if name_lower.contains("playwright") {
        return Some(json!({
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@playwright/mcp"],
            "description": description
        }));
    }

    None
}

fn extract_cursor_install_config(html: &str, description: &str) -> Option<Value> {
    let config_marker = "config=";
    let config_start = html.find(config_marker)? + config_marker.len();
    let encoded = html[config_start..]
        .split(|character| matches!(character, '&' | '"' | '\'' | ')' | '<'))
        .next()?;
    let decoded = percent_decode(encoded);
    let bytes = base64_url_decode(&decoded)?;
    let mut value = serde_json::from_slice::<Value>(&bytes).ok()?;
    if let Some(obj) = value.as_object_mut() {
        if obj.contains_key("url") && !obj.contains_key("type") {
            obj.insert("type".to_string(), Value::String("http".to_string()));
        }
        obj.entry("description")
            .or_insert_with(|| Value::String(description.to_string()));
    }
    Some(value)
}

fn default_mcp_marketplace_servers() -> Vec<McpMarketplaceServer> {
    vec![
        McpMarketplaceServer {
            id: "mcp-directory-context7".to_string(),
            name: "context7".to_string(),
            source_site: "MCP.Directory".to_string(),
            description:
                "Injects up-to-date documentation and code examples into AI coding prompts."
                    .to_string(),
            publisher: "upstash".to_string(),
            category: "AI/ML".to_string(),
            transport_label: "HTTP / stdio".to_string(),
            source_url: "https://mcp.directory/servers/context7".to_string(),
            popularity_label: "36.7K".to_string(),
            avatar_url: Some("https://github.com/upstash.png".to_string()),
            server: Some(json!({
                "type": "http",
                "url": "https://mcp.context7.com/mcp",
                "description": "Injects up-to-date documentation and code examples into AI coding prompts."
            })),
        },
        McpMarketplaceServer {
            id: "mcp-directory-playwright".to_string(),
            name: "playwright".to_string(),
            source_site: "MCP.Directory".to_string(),
            description:
                "Browser automation MCP server for testing and visual inspection workflows."
                    .to_string(),
            publisher: "microsoft".to_string(),
            category: "Browser Automation".to_string(),
            transport_label: "stdio".to_string(),
            source_url: "https://mcp.directory/servers/playwright".to_string(),
            popularity_label: "12.4K".to_string(),
            avatar_url: Some("https://github.com/microsoft.png".to_string()),
            server: Some(json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@playwright/mcp"],
                "description": "Browser automation MCP server for testing and visual inspection workflows."
            })),
        },
    ]
}

fn transport_label_for_market_config(server: Option<&Value>) -> String {
    let Some(server) = server else {
        return "需补全".to_string();
    };
    match server
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("stdio")
    {
        "http" => "HTTP".to_string(),
        "sse" => "SSE".to_string(),
        "stdio" => "stdio".to_string(),
        value => value.to_string(),
    }
}

fn normalize_mcp_marketplace_server_id(name: &str) -> String {
    let normalized = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if normalized.is_empty() {
        "mcp-server".to_string()
    } else {
        normalized
    }
}

fn format_compact_count(value: u64) -> String {
    if value >= 1_000_000 {
        format!("{:.1}M", value as f64 / 1_000_000.0)
    } else if value >= 1_000 {
        format!("{:.1}K", value as f64 / 1_000.0)
    } else {
        value.to_string()
    }
}

fn percent_decode(value: &str) -> String {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(hex);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| value.to_string())
}

fn encode_query_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn base64_url_decode(value: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    URL_SAFE_NO_PAD.decode(value.as_bytes()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_npx_scoped_package_with_version() {
        let server = json!({
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@browsermcp/mcp@latest"]
        });

        assert_eq!(
            npm_package_from_mcp_server(&server),
            Some("@browsermcp/mcp".to_string())
        );
    }

    #[test]
    fn parses_github_repository_from_npm_git_url() {
        assert_eq!(
            github_repo_from_url("git+https://github.com/upstash/context7.git"),
            Some(("upstash".to_string(), "context7".to_string()))
        );
    }

    #[test]
    fn records_git_source_over_marketplace_source() {
        let server = json!({
            "sourceUrl": "https://mcp.directory/servers/context7",
            "repository": "git+https://github.com/upstash/context7.git"
        });

        assert_eq!(
            explicit_mcp_source_url(&server),
            Some("https://github.com/upstash/context7".to_string())
        );
    }
}
