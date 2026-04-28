use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;

use crate::git_state::{clear_skill_update_cache, enrich_skill_with_git_state};
use crate::library::{
    clone_repo_for_discovery, clone_repo_for_discovery_with_sparse_paths, clone_repo_skill,
    create_skill_symlink, ensure_repo_skill_with_sparse_paths, get_tool_skills_path,
    install_market_skill_from_source, parse_market_source_url,
    remove_reserved_workspace_symlinks_from_all_tools, remove_skill_symlink,
    remove_skill_symlinks_from_all_tools, sanitize_storage_name, skill_directory,
};
use crate::models::{
    GitAccountSummary, GitChangeFile, LocalSkillCandidate, MarketplaceSkill, PushBranchOption,
    PushPreviewSnapshot, PushTargetSnapshot, RepoSkillCandidate, SkillFileBrowserSnapshot,
    SkillFileDocument, SkillFileEntry, SkillSummary, ToolConfig, ToolSyncStatus,
    UpdatePreviewSnapshot, WorkspaceSnapshot,
};
use crate::state::{load_installed_skills, save_installed_skills, scan_local_skill_candidates};

fn default_installed_skills() -> Vec<SkillSummary> {
    Vec::new()
}

async fn fetch_skills_sh_live_description(client: &Client, item: &SkillsShSkill) -> Option<String> {
    let source = normalize_repo_key_from_source(&item.source);
    let skill_id = item.skill_id.trim_matches('/').to_lowercase();
    if source.is_empty() || skill_id.is_empty() || !source.contains('/') {
        return None;
    }

    let cache_key = format!("{source}#{skill_id}");
    let live_cache = SKILLS_SH_LIVE_DESCRIPTION_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = live_cache.lock() {
        if let Some(cached) = guard.get(&cache_key) {
            return if cached.is_empty() {
                None
            } else {
                Some(cached.clone())
            };
        }
    }

    let candidate_urls = [
        format!("https://raw.githubusercontent.com/{source}/main/{skill_id}/SKILL.md"),
        format!("https://raw.githubusercontent.com/{source}/main/skills/{skill_id}/SKILL.md"),
        format!("https://raw.githubusercontent.com/{source}/main/{skill_id}/README.md"),
        format!("https://raw.githubusercontent.com/{source}/main/skills/{skill_id}/README.md"),
        format!("https://raw.githubusercontent.com/{source}/master/{skill_id}/SKILL.md"),
        format!("https://raw.githubusercontent.com/{source}/master/skills/{skill_id}/SKILL.md"),
        format!("https://raw.githubusercontent.com/{source}/master/{skill_id}/README.md"),
        format!("https://raw.githubusercontent.com/{source}/master/skills/{skill_id}/README.md"),
    ];

    for url in candidate_urls {
        let response = match client
            .get(&url)
            .timeout(Duration::from_millis(1200))
            .send()
            .await
        {
            Ok(value) => value,
            Err(_) => continue,
        };
        let response = match response.error_for_status() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let content = match response.text().await {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Some(description) = parse_skill_description_from_content(&content) else {
            continue;
        };
        let normalized = description.trim();
        if normalized.is_empty() {
            continue;
        }
        if let Ok(mut guard) = live_cache.lock() {
            guard.insert(cache_key.clone(), normalized.to_string());
        }
        return Some(normalized.to_string());
    }

    if let Ok(mut guard) = live_cache.lock() {
        guard.insert(cache_key, String::new());
    }
    None
}

fn normalize_marketplace_source_key_from_repo_url(url: &str) -> String {
    let parsed = match url::Url::parse(url) {
        Ok(value) => value,
        Err(_) => return String::new(),
    };
    let segments = parsed
        .path_segments()
        .map(|items| items.filter(|item| !item.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    if segments.len() >= 2 {
        return format!(
            "{}/{}",
            segments[0].to_lowercase(),
            segments[1].trim_end_matches(".git").to_lowercase()
        );
    }

    parsed.host_str().unwrap_or_default().to_lowercase()
}

fn source_label_for_type(source_type: &str) -> &'static str {
    match source_type {
        "github" => "GitHub",
        "gitlab" => "GitLab",
        "gitee" => "Gitee",
        "local" => "本地",
        _ => "仓库",
    }
}

const MARKETPLACE_FETCH_LIMIT: usize = 36;
static SKILLS_SH_DESCRIPTION_CACHE: OnceLock<HashMap<String, String>> = OnceLock::new();
static SKILLS_SH_LIVE_DESCRIPTION_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static SKILLS_SH_PAGE_CACHE: OnceLock<Mutex<HashMap<usize, SkillsShPagePayload>>> = OnceLock::new();
static SKILLS_MANAGER_SKILLS_CACHE: OnceLock<Vec<SkillsManagerCachedSkill>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillsShPagePayload {
    skills: Vec<SkillsShSkill>,
}

#[derive(Clone, Debug)]
struct SkillsManagerCachedSkill {
    source: String,
    skill_id: String,
    name: String,
    description: String,
    installs: u64,
}

#[derive(Clone, Debug, Deserialize)]
struct SkillsShSkill {
    source: String,
    #[serde(rename = "skillId")]
    skill_id: String,
    name: String,
    installs: u64,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillsMpResponse {
    skills: Vec<SkillsMpSkill>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillsMpSkill {
    id: String,
    name: String,
    author: String,
    author_avatar: String,
    description: String,
    github_url: String,
    stars: u64,
    updated_at: String,
}

fn default_marketplace_skills() -> Vec<MarketplaceSkill> {
    Vec::new()
}

fn marketplace_http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("skillm/0.1 (+https://github.com/wanghuan)")
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| format!("创建市场请求客户端失败: {error}"))
}

fn format_compact_number(value: u64) -> String {
    if value >= 1_000_000 {
        format!("{:.1}M", value as f64 / 1_000_000.0)
    } else if value >= 1_000 {
        format!("{:.1}K", value as f64 / 1_000.0)
    } else {
        value.to_string()
    }
}

fn source_type_for_url(source_url: &str) -> &'static str {
    if source_url.contains("gitlab.com") {
        "gitlab"
    } else if source_url.contains("gitee.com") {
        "gitee"
    } else {
        "github"
    }
}

fn maintainer_from_source(source: &str) -> String {
    source.split('/').next().unwrap_or(source).to_string()
}

fn skills_sh_source_url(source: &str, skill_id: &str) -> String {
    if source.starts_with("http://") || source.starts_with("https://") {
        return source.to_string();
    }

    if source.contains('/') {
        let normalized_skill_id = skill_id.trim_matches('/');
        if normalized_skill_id.is_empty() {
            return format!("https://github.com/{source}");
        }
        // 始终生成包含 /tree/ 的 URL，以便使用 sparse checkout
        return format!("https://github.com/{source}/tree/main/{normalized_skill_id}");
    }

    format!("https://skills.sh/")
}

fn skills_sh_marketplace_id(source: &str, skill_id: &str) -> String {
    let normalized_source = normalize_repo_key_from_source(source);
    let normalized_skill_id = skill_id.trim_matches('/').to_lowercase();
    if normalized_source.is_empty() {
        return format!("skills.sh-{normalized_skill_id}");
    }
    format!("skills.sh-{normalized_source}::{normalized_skill_id}")
}

fn parse_skills_sh_marketplace_id(skill_id: &str) -> (Option<String>, String) {
    let trimmed = skill_id.trim();
    let normalized = trimmed.trim_start_matches("skills.sh-");
    if let Some((source, path)) = normalized.split_once("::") {
        return (
            Some(normalize_repo_key_from_source(source)),
            path.trim_matches('/').to_lowercase(),
        );
    }
    (None, normalized.trim_matches('/').to_lowercase())
}

fn resolve_skills_sh_skill_path(source: &str, skill_id: &str, skill_name: &str) -> String {
    let normalized_source = normalize_repo_key_from_source(source);
    let normalized_skill_id = skill_id.trim_matches('/').to_lowercase();
    let normalized_name = skill_name.trim().to_lowercase();
    if normalized_source.is_empty() {
        return normalized_skill_id;
    }

    let cache = SKILLS_MANAGER_SKILLS_CACHE.get_or_init(load_skills_manager_cached_items);
    if normalized_skill_id.contains('/')
        && cache.iter().any(|item| {
            item.source.eq_ignore_ascii_case(&normalized_source)
                && item
                    .skill_id
                    .trim_matches('/')
                    .eq_ignore_ascii_case(&normalized_skill_id)
        })
    {
        return normalized_skill_id;
    }

    let mut by_name = None;
    let mut by_suffix = None;
    let mut by_exact = None;

    for item in cache {
        if !item.source.eq_ignore_ascii_case(&normalized_source) {
            continue;
        }
        let cached_path = item.skill_id.trim_matches('/');
        if cached_path.is_empty() {
            continue;
        }
        let cached_path_lower = cached_path.to_lowercase();
        if !normalized_name.is_empty() && item.name.trim().eq_ignore_ascii_case(&normalized_name) {
            by_name = Some(cached_path.to_string());
            if cached_path_lower.contains('/') {
                break;
            }
        }
        if !normalized_skill_id.is_empty() {
            if cached_path_lower == normalized_skill_id {
                by_exact = Some(cached_path.to_string());
            } else if cached_path_lower.ends_with(&format!("/{normalized_skill_id}")) {
                by_suffix = Some(cached_path.to_string());
            }
        }
    }

    by_name
        .or(by_suffix)
        .or(by_exact)
        .unwrap_or(normalized_skill_id)
}

fn normalize_marketplace_query(query: Option<&str>) -> Option<String> {
    let normalized = query.unwrap_or_default().trim().to_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn matches_marketplace_query(skill: &MarketplaceSkill, query: Option<&str>) -> bool {
    let Some(normalized) = normalize_marketplace_query(query) else {
        return true;
    };
    let searchable = format!(
        "{} {} {} {}",
        skill.name, skill.description, skill.maintainer, skill.source_site
    )
    .to_lowercase();
    searchable.contains(&normalized)
}

async fn fetch_skills_sh_marketplace(
    client: &Client,
    page: usize,
    limit: usize,
    _with_descriptions: bool,
    is_searching: bool,
    query: Option<&str>,
) -> Result<Vec<MarketplaceSkill>, String> {
    let paged_items = if is_searching {
        load_skills_sh_search_items(client, query, limit * 10).await?
    } else {
        let fetch_limit = limit;
        if let Some(items) = load_skills_manager_cached_items_page(page, fetch_limit) {
            items
        } else {
            load_skills_sh_paged_items(client, page, fetch_limit).await?
        }
    };

    let mut skills = Vec::with_capacity(paged_items.len());
    for item in paged_items {
        let resolved_skill_id =
            resolve_skills_sh_skill_path(&item.source, &item.skill_id, &item.name);
        let source_url = skills_sh_source_url(&item.source, &resolved_skill_id);
        let item_for_lookup = SkillsShSkill {
            source: item.source.clone(),
            skill_id: resolved_skill_id.clone(),
            name: item.name.clone(),
            installs: item.installs,
            description: item.description.clone(),
        };
        let cached_description =
            lookup_skills_sh_cached_description(&item_for_lookup).or_else(|| {
                item_for_lookup
                    .description
                    .clone()
                    .filter(|value| !value.trim().is_empty())
            });
        let description = if let Some(description) = cached_description {
            description
        } else {
            format!("来自 {} 的公开 skill（{}）", item.source, item.name)
        };
        skills.push(MarketplaceSkill {
            id: skills_sh_marketplace_id(&item.source, &resolved_skill_id),
            name: item.name,
            source_type: source_type_for_url(&source_url).into(),
            source_site: "skills.sh".into(),
            description,
            maintainer: maintainer_from_source(&item.source),
            updated_at: String::new(),
            install_label: "按安装量排序".into(),
            source_url,
            popularity_label: format_compact_number(item.installs),
            avatar_url: None,
            skill_path: resolved_skill_id.clone(),
        });
    }

    Ok(skills)
}

async fn load_skills_sh_search_items(
    client: &Client,
    query: Option<&str>,
    limit: usize,
) -> Result<Vec<SkillsShSkill>, String> {
    let normalized = query.unwrap_or_default().trim();
    if normalized.len() < 2 {
        return Ok(Vec::new());
    }

    let payload: serde_json::Value = client
        .get("https://skills.sh/api/search")
        .query(&[
            ("q", normalized.to_string()),
            ("limit", limit.max(20).to_string()),
        ])
        .send()
        .await
        .map_err(|error| format!("请求 skills.sh 搜索失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("skills.sh 搜索返回异常状态: {error}"))?
        .json()
        .await
        .map_err(|error| format!("解析 skills.sh 搜索响应失败: {error}"))?;

    let Some(items) = payload.get("skills").and_then(|value| value.as_array()) else {
        return Ok(Vec::new());
    };
    Ok(items
        .iter()
        .filter_map(|item| {
            Some(SkillsShSkill {
                source: item.get("source")?.as_str()?.to_string(),
                skill_id: item.get("skillId")?.as_str()?.to_string(),
                name: item.get("name")?.as_str()?.to_string(),
                installs: item
                    .get("installs")
                    .and_then(|value| value.as_u64())
                    .unwrap_or_default(),
                description: None,
            })
        })
        .collect())
}

fn load_skills_manager_cached_items_page(page: usize, limit: usize) -> Option<Vec<SkillsShSkill>> {
    let all_items = SKILLS_MANAGER_SKILLS_CACHE.get_or_init(load_skills_manager_cached_items);
    if all_items.is_empty() {
        return None;
    }

    let safe_page = page.max(1);
    let safe_limit = limit.max(1);
    let start = (safe_page - 1) * safe_limit;
    if start >= all_items.len() {
        return None;
    }
    let end = (start + safe_limit).min(all_items.len());
    if end - start < safe_limit {
        return None;
    }

    Some(
        all_items[start..end]
            .iter()
            .map(|item| SkillsShSkill {
                source: item.source.clone(),
                skill_id: item.skill_id.clone(),
                name: item.name.clone(),
                installs: item.installs,
                description: Some(item.description.clone()),
            })
            .collect(),
    )
}

fn load_skills_manager_cached_items() -> Vec<SkillsManagerCachedSkill> {
    let home_dir = match env::var("HOME") {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let cache_path = PathBuf::from(home_dir)
        .join(".skills-manager")
        .join("cache")
        .join("marketplace-skills.json");
    let content = match fs::read_to_string(cache_path) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let payload: serde_json::Value = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let Some(pages) = payload.get("pages").and_then(|value| value.as_array()) else {
        return Vec::new();
    };

    let mut page_entries = pages
        .iter()
        .filter_map(|page| {
            let page_number = page.get("page").and_then(|value| value.as_u64())? as usize;
            let skills = page
                .get("response")
                .and_then(|value| value.get("skills"))
                .and_then(|value| value.as_array())?;
            Some((page_number, skills))
        })
        .collect::<Vec<_>>();
    page_entries.sort_by_key(|(page_number, _)| *page_number);

    let mut items = Vec::new();
    for (_, skills) in page_entries {
        for skill in skills {
            let Some(source_name) = skill.get("source_name").and_then(|value| value.as_str())
            else {
                continue;
            };
            if source_name != "skills.sh" {
                continue;
            }
            let Some(slug) = skill.get("slug").and_then(|value| value.as_str()) else {
                continue;
            };
            let parts = slug
                .split('/')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            if parts.len() < 3 {
                continue;
            }
            let source = format!("{}/{}", parts[0].to_lowercase(), parts[1].to_lowercase());
            let skill_id = skill
                .get("skill_path")
                .and_then(|value| value.as_str())
                .unwrap_or(parts[2])
                .trim_matches('/')
                .to_string();
            let name = skill
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or(&skill_id)
                .to_string();
            let description = skill
                .get("description")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            let installs = skill
                .get("install_count")
                .and_then(|value| value.as_u64())
                .unwrap_or_default();

            items.push(SkillsManagerCachedSkill {
                source,
                skill_id,
                name,
                description,
                installs,
            });
        }
    }

    items.sort_by(|a, b| b.installs.cmp(&a.installs));
    items
}

async fn load_skills_sh_paged_items(
    client: &Client,
    page: usize,
    limit: usize,
) -> Result<Vec<SkillsShSkill>, String> {
    const SKILLS_SH_REMOTE_PAGE_SIZE: usize = 200;
    let safe_page = page.max(1);
    let safe_limit = limit.max(1);
    let start_index = (safe_page - 1) * safe_limit;
    let end_index = start_index + safe_limit;

    let first_remote_page = (start_index / SKILLS_SH_REMOTE_PAGE_SIZE) + 1;
    let last_remote_page = ((end_index - 1) / SKILLS_SH_REMOTE_PAGE_SIZE) + 1;

    let mut merged = Vec::new();
    for remote_page in first_remote_page..=last_remote_page {
        let payload = load_skills_sh_remote_page(client, remote_page).await?;
        merged.extend(payload.skills);
    }

    let local_start = start_index % SKILLS_SH_REMOTE_PAGE_SIZE;
    Ok(merged
        .into_iter()
        .skip(local_start)
        .take(safe_limit)
        .collect())
}

async fn load_skills_sh_remote_page(
    client: &Client,
    page: usize,
) -> Result<SkillsShPagePayload, String> {
    let page_cache = SKILLS_SH_PAGE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = page_cache.lock() {
        if let Some(cached) = guard.get(&page) {
            return Ok(cached.clone());
        }
    }

    let endpoint = format!("https://skills.sh/api/skills/all-time/{page}");
    let payload = client
        .get(&endpoint)
        .send()
        .await
        .map_err(|error| format!("请求 skills.sh 分页失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("skills.sh 分页返回异常状态: {error}"))?
        .json::<SkillsShPagePayload>()
        .await
        .map_err(|error| format!("解析 skills.sh 分页响应失败: {error}"))?;

    if let Ok(mut guard) = page_cache.lock() {
        guard.insert(page, payload.clone());
    }

    Ok(payload)
}

fn lookup_skills_sh_cached_description(item: &SkillsShSkill) -> Option<String> {
    let cache = SKILLS_SH_DESCRIPTION_CACHE.get_or_init(load_skills_sh_description_cache);
    let source = normalize_repo_key_from_source(&item.source);
    let skill_id = item.skill_id.trim_matches('/').to_lowercase();
    let skill_name = item.name.trim().to_lowercase();

    if source.is_empty() || skill_id.is_empty() {
        return None;
    }

    let path_key = format!("{source}#{skill_id}");
    if let Some(description) = cache.get(&path_key) {
        return Some(description.clone());
    }

    let name_key = format!("{source}#{skill_name}");
    cache.get(&name_key).cloned()
}

fn normalize_repo_key_from_source(source: &str) -> String {
    let normalized = source.trim().trim_end_matches('/');
    if normalized.is_empty() {
        return String::new();
    }

    if normalized.starts_with("http://") || normalized.starts_with("https://") {
        let from_url = normalize_repo_key_from_url(normalized);
        if !from_url.is_empty() {
            return from_url;
        }
    }

    let without_scheme = normalized
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let mut segments = without_scheme
        .split('/')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.is_empty() {
        return String::new();
    }

    let host = if segments[0].contains('.') {
        segments[0].to_lowercase()
    } else {
        String::new()
    };

    if segments[0].contains('.') {
        segments.remove(0);
    }

    if segments.len() == 1 && !host.is_empty() {
        return host;
    }

    if segments.len() < 2 {
        return String::new();
    }

    format!(
        "{}/{}",
        segments[0].to_lowercase(),
        segments[1].trim_end_matches(".git").to_lowercase()
    )
}

fn load_skills_sh_description_cache() -> HashMap<String, String> {
    let mut result = HashMap::new();
    let home_dir = match env::var("HOME") {
        Ok(value) => value,
        Err(_) => return result,
    };
    let cache_path = PathBuf::from(home_dir)
        .join(".skills-manager")
        .join("cache")
        .join("marketplace-skills.json");
    let content = match fs::read_to_string(cache_path) {
        Ok(value) => value,
        Err(_) => return result,
    };

    let payload: serde_json::Value = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(_) => return result,
    };
    let Some(pages) = payload.get("pages").and_then(|value| value.as_array()) else {
        return result;
    };

    for page in pages {
        let Some(skills) = page
            .get("response")
            .and_then(|value| value.get("skills"))
            .and_then(|value| value.as_array())
        else {
            continue;
        };
        for skill in skills {
            let Some(source_name) = skill.get("source_name").and_then(|value| value.as_str())
            else {
                continue;
            };
            if source_name != "skills.sh" {
                continue;
            }
            let Some(repo_url) = skill.get("repo_url").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(description) = skill.get("description").and_then(|value| value.as_str())
            else {
                continue;
            };
            let normalized_description = description.trim();
            if normalized_description.is_empty() {
                continue;
            }
            let repo_key = normalize_marketplace_source_key_from_repo_url(repo_url);
            if repo_key.is_empty() {
                continue;
            }
            if let Some(skill_path) = skill.get("skill_path").and_then(|value| value.as_str()) {
                let key = format!("{repo_key}#{}", skill_path.trim_matches('/').to_lowercase());
                result.insert(key, normalized_description.to_string());
            }
            if let Some(name) = skill.get("name").and_then(|value| value.as_str()) {
                let key = format!("{repo_key}#{}", name.trim().to_lowercase());
                result.insert(key, normalized_description.to_string());
            }
            if let Some(slug) = skill.get("slug").and_then(|value| value.as_str()) {
                let parts = slug
                    .split('/')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>();
                if parts.len() >= 3 {
                    let source_key =
                        format!("{}/{}", parts[0].to_lowercase(), parts[1].to_lowercase());
                    let slug_path = parts[2..].join("/").to_lowercase();
                    if !slug_path.is_empty() {
                        result.insert(
                            format!("{source_key}#{slug_path}"),
                            normalized_description.to_string(),
                        );
                    }
                }
            }
        }
    }

    result
}

fn normalize_repo_key_from_url(url: &str) -> String {
    let parsed = match url::Url::parse(url) {
        Ok(value) => value,
        Err(_) => return String::new(),
    };
    let segments = parsed
        .path_segments()
        .map(|items| items.filter(|item| !item.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    if segments.len() < 2 {
        return String::new();
    }
    format!(
        "{}/{}",
        segments[0].to_lowercase(),
        segments[1].trim_end_matches(".git").to_lowercase()
    )
}

fn persist_skill_timestamps(_skill: &SkillSummary) {
    // 预留钩子：后续可把安装/更新时间落盘到独立缓存文件。
}

async fn fetch_skillsmp_marketplace(
    client: &Client,
    page: usize,
    limit: usize,
    query: Option<&str>,
) -> Result<Vec<MarketplaceSkill>, String> {
    let safe_page = page.max(1);
    let safe_limit = limit.max(1);
    let mut request = client.get("https://skillsmp.com/api/skills").query(&[
        ("page", safe_page.to_string()),
        ("limit", safe_limit.to_string()),
        ("sortBy", "stars".to_string()),
    ]);
    if let Some(normalized_query) = normalize_marketplace_query(query) {
        request = request.query(&[("search", normalized_query)]);
    }
    let response: SkillsMpResponse = request
        .send()
        .await
        .map_err(|error| format!("请求 skillsmp 失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("skillsmp 返回异常状态: {error}"))?
        .json()
        .await
        .map_err(|error| format!("解析 skillsmp 技能列表失败: {error}"))?;

    Ok(response
        .skills
        .into_iter()
        .map(|item| {
            // 尝试从 github_url 解析 skill 路径
            let skill_path = if let Ok(spec) = parse_market_source_url(&item.github_url) {
                spec.relative_path
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default()
            } else {
                String::new()
            };
            MarketplaceSkill {
                id: format!("skillsmp-{}", item.id),
                name: item.name,
                source_type: source_type_for_url(&item.github_url).into(),
                source_site: "skillsmp".into(),
                description: item.description,
                maintainer: item.author,
                updated_at: item.updated_at,
                install_label: "默认按热度排序".into(),
                source_url: item.github_url,
                popularity_label: format_compact_number(item.stars),
                avatar_url: Some(item.author_avatar),
                skill_path,
            }
        })
        .collect())
}

fn marketplace_cache_file() -> Option<PathBuf> {
    let home_dir = env::var("HOME").ok()?;
    Some(
        PathBuf::from(home_dir)
            .join(".skillm")
            .join("cache")
            .join("marketplace.json"),
    )
}

fn load_marketplace_cache() -> Option<Vec<MarketplaceSkill>> {
    let cache_path = marketplace_cache_file()?;
    let content = fs::read_to_string(cache_path).ok()?;
    let cached: serde_json::Value = serde_json::from_str(&content).ok()?;
    let skills_array = cached.get("skills").and_then(|v| v.as_array())?;
    let timestamp = cached
        .get("timestamp")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // 缓存有效期 1 小时
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();

    if now - timestamp > 3600 {
        return None;
    }

    Some(
        skills_array
            .iter()
            .filter_map(|skill| serde_json::from_value(skill.clone()).ok())
            .collect(),
    )
}

fn save_marketplace_cache(skills: &[MarketplaceSkill]) {
    let cache_path = match marketplace_cache_file() {
        Some(path) => path,
        None => return,
    };

    let parent_dir = match cache_path.parent() {
        Some(dir) => dir,
        None => return,
    };

    let _ = fs::create_dir_all(parent_dir);

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let cache_data = serde_json::json!({
        "timestamp": timestamp,
        "skills": skills
    });

    let _ = fs::write(
        cache_path,
        serde_json::to_string_pretty(&cache_data).unwrap_or_default(),
    );
}

async fn build_marketplace_skills(
    source_site: Option<&str>,
    page: usize,
    limit: usize,
    query: Option<&str>,
    with_descriptions: bool,
) -> Vec<MarketplaceSkill> {
    let source = source_site.unwrap_or_default();
    let is_searching = query.is_some() && !query.unwrap_or_default().trim().is_empty();

    // 如果是第一页且不是搜索，尝试从缓存读取
    if page == 1 && !is_searching {
        if let Some(cached_skills) = load_marketplace_cache() {
            let filtered: Vec<MarketplaceSkill> = cached_skills
                .into_iter()
                .filter(|skill| matches_marketplace_query(skill, query))
                .filter(|skill| source.is_empty() || skill.source_site == source)
                .take(limit)
                .collect();

            if !filtered.is_empty() {
                return filtered;
            }
        }
    }

    let client = match marketplace_http_client() {
        Ok(client) => client,
        Err(_) => return default_marketplace_skills(),
    };

    let mut skills = Vec::new();

    if source.is_empty() || source == "skills.sh" {
        let normalized_query = normalize_marketplace_query(query);
        if let Ok(mut skills_sh) = fetch_skills_sh_marketplace(
            &client,
            page,
            limit,
            with_descriptions,
            is_searching,
            normalized_query.as_deref(),
        )
        .await
        {
            skills.append(&mut skills_sh);
        }
    }

    if source.is_empty() || source == "skillsmp" {
        let normalized_query = normalize_marketplace_query(query);
        if let Ok(mut skills_mp) =
            fetch_skillsmp_marketplace(&client, page, limit, normalized_query.as_deref()).await
        {
            skills.append(&mut skills_mp);
        } else if let Ok(mut skills_mp) =
            fetch_skillsmp_marketplace(&client, page, limit, None).await
        {
            skills_mp.retain(|skill| matches_marketplace_query(skill, normalized_query.as_deref()));
            skills.append(&mut skills_mp);
        }
    }

    skills.retain(|skill| matches_marketplace_query(skill, query));
    if !source.is_empty() {
        skills.retain(|skill| skill.source_site == source);
    }

    let result = if skills.is_empty() {
        default_marketplace_skills()
            .into_iter()
            .filter(|skill| source.is_empty() || skill.source_site == source)
            .filter(|skill| matches_marketplace_query(skill, query))
            .take(limit.max(1))
            .collect()
    } else {
        skills
    };

    // 如果是第一页且不是搜索，保存到缓存
    if page == 1 && !is_searching && !result.is_empty() {
        save_marketplace_cache(&result);
    }

    result
}

fn build_local_candidates(installed_skills: &[SkillSummary]) -> Vec<LocalSkillCandidate> {
    scan_local_skill_candidates(installed_skills)
        .into_iter()
        .map(|(name, detected_from)| {
            let local_path = format!("{detected_from}/{name}");
            LocalSkillCandidate {
                description: format!("从 {detected_from} 发现的本地技能。"),
                source_hint: "检测到本地技能目录，可一键纳入统一管理".into(),
                name,
                local_path,
                detected_from,
            }
        })
        .collect()
}

fn detect_tool_installation_label(paths: &[PathBuf]) -> String {
    if paths.iter().any(|path| path.exists()) {
        "已安装".to_string()
    } else {
        "未安装".to_string()
    }
}

fn build_tool_configs() -> Vec<ToolConfig> {
    let home_dir = env::var("HOME").unwrap_or_else(|_| "~".to_string());
    let home_path = PathBuf::from(&home_dir);
    let tool_specs = [
        (
            "claude-code",
            "Claude Code",
            home_path.join(".claude/skills"),
            true,
            "cli",
            vec!["cli", "desktop", "ide-plugin"],
            false,
            vec![home_path.join(".claude")],
        ),
        (
            "codex",
            "Codex",
            home_path.join(".codex/skills"),
            true,
            "desktop",
            vec!["desktop", "cli"],
            false,
            vec![home_path.join(".codex")],
        ),
        (
            "opencode",
            "OpenCode",
            home_path.join(".config/opencode/skills"),
            true,
            "cli",
            vec!["cli", "desktop", "ide-plugin"],
            false,
            vec![home_path.join(".config/opencode")],
        ),
        (
            "cursor",
            "Cursor",
            home_path.join(".cursor/skills"),
            true,
            "editor",
            vec!["editor"],
            true,
            vec![
                home_path.join(".cursor"),
                PathBuf::from("/Applications/Cursor.app"),
            ],
        ),
        (
            "gemini",
            "Gemini CLI",
            home_path.join(".gemini/skills"),
            true,
            "cli",
            vec!["cli"],
            false,
            vec![home_path.join(".gemini")],
        ),
        (
            "antigravity",
            "Antigravity",
            home_path.join(".gemini/antigravity/skills"),
            true,
            "editor",
            vec!["editor"],
            true,
            vec![
                home_path.join(".gemini/antigravity"),
                PathBuf::from("/Applications/Antigravity.app"),
            ],
        ),
        (
            "windsurf",
            "Windsurf",
            home_path.join(".codeium/windsurf/skills"),
            true,
            "editor",
            vec!["editor"],
            true,
            vec![
                home_path.join(".windsurf"),
                home_path.join(".codeium/windsurf"),
                PathBuf::from("/Applications/Windsurf.app"),
            ],
        ),
        (
            "openclaw",
            "OpenClaw",
            home_path.join(".openclaw/skills"),
            true,
            "desktop",
            vec!["desktop"],
            false,
            vec![home_path.join(".openclaw")],
        ),
        (
            "continue",
            "Continue",
            home_path.join(".continue/skills"),
            true,
            "editor",
            vec!["editor", "ide-plugin"],
            false,
            vec![home_path.join(".continue")],
        ),
        (
            "iflow",
            "iFlow",
            home_path.join(".iflow/skills"),
            true,
            "cli",
            vec!["cli"],
            false,
            vec![home_path.join(".iflow")],
        ),
        (
            "codebuddy",
            "CodeBuddy",
            home_path.join(".codebuddy/skills"),
            true,
            "editor",
            vec!["editor", "ide-plugin"],
            false,
            vec![home_path.join(".codebuddy")],
        ),
        (
            "trae",
            "Trae",
            home_path.join(".trae/skills"),
            true,
            "editor",
            vec!["editor"],
            true,
            vec![
                home_path.join(".trae"),
                PathBuf::from("/Applications/Trae.app"),
            ],
        ),
        (
            "droid",
            "Droid",
            home_path.join(".factory/skills"),
            true,
            "editor",
            vec!["editor"],
            false,
            vec![home_path.join(".factory")],
        ),
        (
            "augment",
            "Augment",
            home_path.join(".augment/skills"),
            true,
            "editor",
            vec!["editor", "ide-plugin", "desktop"],
            false,
            vec![home_path.join(".augment")],
        ),
        (
            "cline",
            "Cline",
            home_path.join(".cline/skills"),
            true,
            "editor",
            vec!["editor", "cli"],
            false,
            vec![home_path.join(".cline")],
        ),
        (
            "commandcode",
            "CommandCode",
            home_path.join(".commandcode/skills"),
            true,
            "editor",
            vec!["editor"],
            false,
            vec![home_path.join(".commandcode")],
        ),
        (
            "crush",
            "Crush",
            home_path.join(".config/crush/skills"),
            true,
            "cli",
            vec!["cli"],
            false,
            vec![home_path.join(".config/crush")],
        ),
        (
            "goose",
            "Goose",
            home_path.join(".config/goose/skills"),
            true,
            "cli",
            vec!["cli"],
            false,
            vec![home_path.join(".config/goose")],
        ),
        (
            "junie",
            "Junie",
            home_path.join(".junie/skills"),
            true,
            "editor",
            vec!["editor", "ide-plugin"],
            false,
            vec![home_path.join(".junie")],
        ),
        (
            "kilo-code",
            "Kilo Code",
            home_path.join(".kilocode/skills"),
            true,
            "editor",
            vec!["editor"],
            false,
            vec![home_path.join(".kilocode")],
        ),
        (
            "kiro",
            "Kiro",
            home_path.join(".kiro/skills"),
            true,
            "editor",
            vec!["editor", "cli"],
            true,
            vec![
                home_path.join(".kiro"),
                PathBuf::from("/Applications/Kiro.app"),
            ],
        ),
        (
            "qoder",
            "Qoder",
            home_path.join(".qoder/skills"),
            true,
            "editor",
            vec!["editor", "ide-plugin"],
            false,
            vec![home_path.join(".qoder")],
        ),
        (
            "qwen-code",
            "Qwen Code",
            home_path.join(".qwen/skills"),
            true,
            "cli",
            vec!["cli"],
            false,
            vec![home_path.join(".qwen")],
        ),
        (
            "roo-code",
            "Roo Code",
            home_path.join(".roo/skills"),
            true,
            "editor",
            vec!["editor"],
            false,
            vec![home_path.join(".roo")],
        ),
        (
            "zencoder",
            "Zencoder",
            home_path.join(".zencoder/skills"),
            true,
            "editor",
            vec!["editor", "ide-plugin", "desktop"],
            false,
            vec![home_path.join(".zencoder")],
        ),
        (
            "trae-cn",
            "Trae CN",
            home_path.join(".trae-cn/skills"),
            true,
            "editor",
            vec!["editor"],
            false,
            vec![home_path.join(".trae-cn")],
        ),
        (
            "hermes",
            "Hermes",
            home_path.join(".hermes/skills"),
            true,
            "cli",
            vec!["cli"],
            false,
            vec![home_path.join(".hermes")],
        ),
        (
            "github-copilot",
            "GitHub Copilot",
            home_path.join(".copilot/skills"),
            true,
            "editor",
            vec!["editor", "ide-plugin"],
            false,
            vec![home_path.join(".copilot")],
        ),
    ];

    tool_specs
        .into_iter()
        .map(
            |(
                id,
                name,
                skills_path,
                is_enabled,
                primary_type,
                surface_types,
                supports_direct_open,
                detection_paths,
            )| ToolConfig {
                id: id.into(),
                name: name.into(),
                skills_path: skills_path.to_string_lossy().to_string(),
                status_label: detect_tool_installation_label(&detection_paths),
                is_enabled,
                primary_type: primary_type.into(),
                surface_types: surface_types.into_iter().map(|item| item.into()).collect(),
                supports_direct_open,
            },
        )
        .collect()
}

fn build_git_account() -> GitAccountSummary {
    GitAccountSummary {
        provider: "GitHub".into(),
        account_name: "wanghuan".into(),
        status_label: "已连接，可发起 PR".into(),
    }
}

fn installed_tool_sync_entries() -> Vec<ToolSyncStatus> {
    build_tool_configs()
        .into_iter()
        .filter(|tool| tool.status_label == "已安装")
        .map(|tool| ToolSyncStatus {
            name: tool.name,
            status_label: "未启用".into(),
        })
        .collect()
}

fn normalize_skill_tools(skill: &SkillSummary) -> SkillSummary {
    let mut tool_status_map = skill
        .tools
        .iter()
        .cloned()
        .map(|tool| (tool.name.clone(), tool.status_label))
        .collect::<BTreeMap<_, _>>();
    let merged_tools = installed_tool_sync_entries()
        .into_iter()
        .map(|tool| ToolSyncStatus {
            name: tool.name.clone(),
            status_label: tool_status_map
                .remove(&tool.name)
                .unwrap_or(tool.status_label),
        })
        .collect::<Vec<_>>();
    let synced_tool_count = merged_tools
        .iter()
        .filter(|tool| {
            matches!(
                tool.status_label.as_str(),
                "已同步" | "已启用" | "需要重同步"
            )
        })
        .count();

    SkillSummary {
        synced_tool_count,
        tools: merged_tools,
        ..skill.clone()
    }
}

fn resolve_installed_skills() -> Vec<SkillSummary> {
    let skills = load_installed_skills(&default_installed_skills());
    skills.iter().map(normalize_skill_tools).collect()
}

#[tauri::command]
pub async fn refresh_git_states() -> Vec<SkillSummary> {
    let skills = load_installed_skills(&default_installed_skills());
    skills
        .iter()
        .map(normalize_skill_tools)
        .map(|skill| enrich_skill_with_git_state(&skill))
        .collect()
}

const GIT_BINARY: &str = "git";
const ORIGIN_REMOTE: &str = "origin";
const REMOTE_PREFIX: &str = "origin/";
const WORKSPACE_DIR: &str = ".skillm";
const RESERVED_WORKSPACE_NAMES: [&str; 5] =
    ["state.json", "skills", "repo-cache", "cache", "imports"];
/// Resolved info for opening a directory with an editor.
/// Dynamically detected from the installed .app bundle on the user's system.
struct EditorOpenInfo {
    /// CLI binary path found inside the .app bundle (e.g. .../Cursor.app/Contents/Resources/app/bin/cursor).
    cli_path: Option<String>,
    /// Display name extracted from the .app bundle filename (e.g. "Cursor").
    app_display_name: Option<String>,
}

/// Scan /Applications for .app bundles whose name (case-insensitive) matches one of the given candidates.
fn find_app_bundle(app_name_candidates: &[&str]) -> Option<String> {
    let apps_dir = PathBuf::from("/Applications");
    if let Ok(entries) = std::fs::read_dir(&apps_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.ends_with(".app") {
                continue;
            }
            let stem = name_str.trim_end_matches(".app");
            for candidate in app_name_candidates {
                if stem.eq_ignore_ascii_case(candidate) {
                    return Some(entry.path().to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

/// Discover a CLI binary inside an .app bundle.
/// Checks Contents/Resources/app/bin/ for executables matching the app name.
fn discover_cli_in_bundle(app_bundle_path: &str) -> Option<String> {
    let bundle = PathBuf::from(app_bundle_path);
    let stem = bundle.file_stem()?.to_str()?.to_string();
    // Common CLI locations in Electron / JetBrains apps
    let candidate_paths = [
        bundle.join("Contents/Resources/app/bin").join(&stem),
        bundle
            .join("Contents/Resources/app/bin")
            .join(&stem.to_lowercase()),
        bundle.join("Contents/MacOS").join(&stem),
    ];
    for path in &candidate_paths {
        if path.exists() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

/// Map editor_id to possible .app display names for scanning /Applications.
fn editor_app_name_candidates(editor_id: &str) -> &[&str] {
    match editor_id {
        "cursor" => &["Cursor"],
        "windsurf" => &["Windsurf"],
        "kiro" => &["Kiro", "Kiro CLI"],
        "trae" => &["Trae", "TRAE"],
        "intellij" => &[
            "IntelliJ IDEA",
            "IntelliJ IDEA CE",
            "IntelliJ IDEA Ultimate",
        ],
        _ => &[],
    }
}

/// Dynamically resolve editor launch info by scanning the user's installed apps.
fn resolve_editor_open_info(editor_id: &str) -> Result<EditorOpenInfo, String> {
    let candidates = editor_app_name_candidates(editor_id);
    if candidates.is_empty() {
        return Err("暂不支持该编辑器。".into());
    }

    let app_bundle_path = find_app_bundle(candidates);
    let cli_path = app_bundle_path
        .as_ref()
        .and_then(|p| discover_cli_in_bundle(p));
    let app_display_name = app_bundle_path.as_ref().and_then(|p| {
        PathBuf::from(p)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
    });

    if cli_path.is_none() && app_display_name.is_none() {
        return Err(format!("未找到编辑器，请确认已安装对应应用。"));
    }

    Ok(EditorOpenInfo {
        cli_path,
        app_display_name,
    })
}

struct RepoInstallSpec {
    clone_url: String,
    repo_key: String,
    source_type: String,
    source_url: String,
    path_hint: Option<String>,
}

fn tool_name_to_id(tool_name: &str) -> Result<String, String> {
    match tool_name {
        "Claude Code" => Ok("claude-code".to_string()),
        "Codex" => Ok("codex".to_string()),
        "OpenCode" => Ok("opencode".to_string()),
        "Cursor" => Ok("cursor".to_string()),
        "Gemini CLI" => Ok("gemini".to_string()),
        "Antigravity" => Ok("antigravity".to_string()),
        "Windsurf" => Ok("windsurf".to_string()),
        "OpenClaw" => Ok("openclaw".to_string()),
        "Continue" => Ok("continue".to_string()),
        "iFlow" => Ok("iflow".to_string()),
        "CodeBuddy" => Ok("codebuddy".to_string()),
        "Trae" => Ok("trae".to_string()),
        "Droid" => Ok("droid".to_string()),
        "Augment" => Ok("augment".to_string()),
        "Cline" => Ok("cline".to_string()),
        "CommandCode" => Ok("commandcode".to_string()),
        "Crush" => Ok("crush".to_string()),
        "Goose" => Ok("goose".to_string()),
        "Junie" => Ok("junie".to_string()),
        "Kilo Code" => Ok("kilo-code".to_string()),
        "Kiro" => Ok("kiro".to_string()),
        "Qoder" => Ok("qoder".to_string()),
        "Qwen Code" => Ok("qwen-code".to_string()),
        "Roo Code" => Ok("roo-code".to_string()),
        "Zencoder" => Ok("zencoder".to_string()),
        "Trae CN" => Ok("trae-cn".to_string()),
        "Hermes" => Ok("hermes".to_string()),
        "GitHub Copilot" => Ok("github-copilot".to_string()),
        _ => Err(format!("未知的工具名称: {tool_name}")),
    }
}

fn find_skill_by_name(skill_name: &str) -> Result<(Vec<SkillSummary>, usize), String> {
    let installed_skills = load_installed_skills(&default_installed_skills());
    let skill_index = installed_skills
        .iter()
        .position(|skill| skill.name == skill_name)
        .ok_or_else(|| format!("未找到技能 {skill_name}"))?;

    Ok((installed_skills, skill_index))
}

fn run_git_command_with_allowed_codes(
    skill_path: &str,
    args: &[&str],
    allowed_codes: &[i32],
) -> Result<String, String> {
    let output = Command::new(GIT_BINARY)
        .args(["-C", skill_path])
        .args(args)
        .output()
        .map_err(|error| format!("执行 git 命令失败: {error}"))?;

    let status_code = output.status.code().unwrap_or(-1);
    if !allowed_codes.contains(&status_code) {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("git {} 失败: {}", args.join(" "), message));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git_command(skill_path: &str, args: &[&str]) -> Result<String, String> {
    run_git_command_with_allowed_codes(skill_path, args, &[0])
}

fn current_branch_name(skill_path: &str) -> Result<String, String> {
    run_git_command(skill_path, &["rev-parse", "--abbrev-ref", "HEAD"])
}

fn collect_known_branches(skill_path: &str, current_branch: &str) -> Result<Vec<String>, String> {
    let local_branches = run_git_command(
        skill_path,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )?;
    let remote_branches = run_git_command(
        skill_path,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/remotes/origin",
        ],
    )?;
    let mut branches = vec![current_branch.to_string()];
    let mut seen = BTreeSet::from([current_branch.to_string()]);

    for line in local_branches.lines().chain(remote_branches.lines()) {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed == "origin/HEAD" {
            continue;
        }

        let normalized = trimmed
            .strip_prefix(REMOTE_PREFIX)
            .unwrap_or(trimmed)
            .to_string();
        if seen.insert(normalized.clone()) {
            branches.push(normalized);
        }
    }

    Ok(branches)
}

fn resolve_remote_branch_name(skill_path: &str, branch_name: &str) -> Result<String, String> {
    let upstream = run_git_command(
        skill_path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    );
    if let Ok(upstream) = upstream {
        if !upstream.trim().is_empty() {
            return Ok(upstream);
        }
    }

    let remote_branch = format!("{ORIGIN_REMOTE}/{branch_name}");
    let remote_ref = format!("refs/remotes/{remote_branch}");
    run_git_command(
        skill_path,
        &["show-ref", "--verify", "--quiet", &remote_ref],
    )?;
    Ok(remote_branch)
}

fn branch_divergence_counts(
    skill_path: &str,
    remote_branch: &str,
) -> Result<(usize, usize), String> {
    let output = run_git_command(
        skill_path,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{remote_branch}...HEAD"),
            "--",
            ".",
        ],
    )?;
    let mut parts = output.split_whitespace();
    let behind = parts
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let ahead = parts
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    Ok((behind, ahead))
}

fn parse_name_status_line(line: &str) -> Option<(String, String)> {
    let mut parts = line.split_whitespace();
    let status = parts.next()?.to_string();
    let path = parts.last()?.to_string();
    Some((status, path))
}

fn git_diff_for_path(skill_path: &str, args: &[&str], path: &str) -> String {
    let mut diff_args = args.to_vec();
    diff_args.extend(["--", path]);
    run_git_command(skill_path, &diff_args).unwrap_or_default()
}

fn git_diff_for_untracked_path(skill_path: &str, path: &str) -> String {
    run_git_command_with_allowed_codes(
        skill_path,
        &["diff", "--no-index", "--", "/dev/null", path],
        &[0, 1],
    )
    .unwrap_or_default()
}

fn combine_working_tree_diff(skill_path: &str, status: &str, path: &str) -> String {
    if status.contains('?') {
        return git_diff_for_untracked_path(skill_path, path);
    }

    let mut diff_parts = Vec::new();
    let index_status = status.chars().next().unwrap_or(' ');
    let worktree_status = status.chars().nth(1).unwrap_or(' ');
    if index_status != ' ' {
        let staged_diff = git_diff_for_path(skill_path, &["diff", "--cached"], path);
        if !staged_diff.trim().is_empty() {
            diff_parts.push(staged_diff);
        }
    }
    if worktree_status != ' ' {
        let unstaged_diff = git_diff_for_path(skill_path, &["diff"], path);
        if !unstaged_diff.trim().is_empty() {
            diff_parts.push(unstaged_diff);
        }
    }

    diff_parts.join("\n")
}

fn collect_name_status_changes(
    skill_path: &str,
    name_status_args: &[&str],
    diff_args: &[&str],
) -> Result<Vec<GitChangeFile>, String> {
    let name_status = run_git_command(skill_path, name_status_args)?;
    let changes = name_status
        .lines()
        .filter_map(parse_name_status_line)
        .map(|(status, path)| {
            let diff = git_diff_for_path(skill_path, diff_args, &path);
            GitChangeFile { path, status, diff }
        })
        .collect();
    Ok(changes)
}

fn collect_working_tree_changes(skill_path: &str) -> Result<Vec<GitChangeFile>, String> {
    let porcelain = run_git_command(skill_path, &["status", "--porcelain", "--", "."])?;
    let changes = porcelain
        .lines()
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            let raw_status = line.get(..2)?.to_string();
            let status = raw_status.trim().to_string();
            let path = line.get(3..)?.trim().to_string();
            let diff = combine_working_tree_diff(skill_path, &raw_status, &path);
            Some(GitChangeFile { path, status, diff })
        })
        .collect();
    Ok(changes)
}

fn refresh_and_persist_skill(skill_name: &str) -> Result<SkillSummary, String> {
    let (mut installed_skills, skill_index) = find_skill_by_name(skill_name)?;
    let refreshed_skill = enrich_skill_with_git_state(&installed_skills[skill_index]);
    installed_skills[skill_index] = refreshed_skill.clone();
    save_installed_skills(&installed_skills)?;
    Ok(refreshed_skill)
}

fn skill_base_path(skill_name: &str) -> Result<PathBuf, String> {
    let (installed_skills, skill_index) = find_skill_by_name(skill_name)?;
    Ok(PathBuf::from(&installed_skills[skill_index].local_path))
}

fn relative_file_path(skill_name: &str, relative_path: &str) -> Result<PathBuf, String> {
    if relative_path.trim().is_empty() {
        return Err("文件路径不能为空".into());
    }

    let base_path = skill_base_path(skill_name)?;
    let full_path = base_path.join(relative_path);
    if !full_path.starts_with(&base_path) {
        return Err("不允许访问 skill 目录之外的文件".into());
    }

    Ok(full_path)
}

fn is_supported_text_file(path: &Path) -> bool {
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

fn collect_skill_entries(
    base_path: &Path,
    current_path: &Path,
    depth: usize,
    entries: &mut Vec<SkillFileEntry>,
) -> Result<bool, String> {
    let mut child_paths = fs::read_dir(current_path)
        .map_err(|error| format!("读取 skill 目录失败: {error}"))?
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
                .strip_prefix(base_path)
                .map_err(|error| format!("解析目录路径失败: {error}"))?
                .to_string_lossy()
                .to_string();
            entries.push(SkillFileEntry {
                path: relative_path,
                name: name.to_string(),
                entry_type: "directory".into(),
                depth,
            });
            let before_children = entries.len();
            let child_has_visible =
                collect_skill_entries(base_path, &child_path, depth + 1, entries)?;
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

        if !is_supported_text_file(&child_path) {
            continue;
        }

        let relative_path = child_path
            .strip_prefix(base_path)
            .map_err(|error| format!("解析文件路径失败: {error}"))?
            .to_string_lossy()
            .to_string();
        entries.push(SkillFileEntry {
            path: relative_path,
            name: name.to_string(),
            entry_type: "file".into(),
            depth,
        });
        has_visible_child = true;
    }

    Ok(has_visible_child)
}

fn managed_workspace_root() -> Result<PathBuf, String> {
    let home_dir = env::var("HOME").map_err(|_| "无法读取 HOME 环境变量".to_string())?;
    Ok(PathBuf::from(home_dir).join(WORKSPACE_DIR))
}

fn should_remove_local_directory(path: &Path) -> Result<bool, String> {
    let workspace_root = managed_workspace_root()?;
    let managed_skills_root = workspace_root.join("skills");
    let managed_imports_root = workspace_root.join("imports");

    let removable_under_skills =
        path.starts_with(&managed_skills_root) && path != managed_skills_root.as_path();
    let removable_under_imports =
        path.starts_with(&managed_imports_root) && path != managed_imports_root.as_path();

    Ok((removable_under_skills || removable_under_imports) && !is_reserved_workspace_path(path))
}

fn is_reserved_workspace_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return true;
    };

    RESERVED_WORKSPACE_NAMES.contains(&name)
}

fn managed_delete_target(path: &Path) -> Result<PathBuf, String> {
    if path.join(".git").exists() {
        return Ok(path.to_path_buf());
    }

    let workspace_root = managed_workspace_root()?;
    let mut current = path.to_path_buf();
    while let Some(parent) = current.parent() {
        if parent == workspace_root {
            break;
        }
        if parent.join(".git").exists() {
            return Ok(parent.to_path_buf());
        }
        current = parent.to_path_buf();
    }

    Ok(path.to_path_buf())
}

fn repository_root_path(skill_path: &str) -> Result<String, String> {
    let root = run_git_command(skill_path, &["rev-parse", "--show-toplevel"])?;
    if root.trim().is_empty() {
        return Err("无法识别 canonical repo 工作区。".into());
    }

    Ok(root)
}

fn open_path_with_finder(path: &str) -> Result<(), String> {
    let output = Command::new("open")
        .arg(path)
        .output()
        .map_err(|error| format!("打开 Finder 失败: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!("打开 Finder 失败: {stderr}"))
}

/// Open a directory path using the editor's CLI binary.
/// This is the most reliable way to launch an editor and open a directory,
/// especially for Electron-based apps like Cursor that fail with `open -a`.
fn open_path_with_cli(cli_path: &str, path: &str) -> Result<(), String> {
    Command::new(cli_path)
        .arg(path)
        .spawn()
        .map_err(|error| format!("启动编辑器 CLI 失败: {error}"))?;
    Ok(())
}

/// Fallback: open a directory using `open -a AppName path`.
fn open_path_with_open_a(app_name: &str, path: &str) -> Result<(), String> {
    let output = Command::new("open")
        .args(["-a", app_name, path])
        .output()
        .map_err(|error| format!("打开编辑器失败: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!("打开编辑器失败: {stderr}"))
}

/// Check whether an editor app is currently running by looking for its process.
fn is_editor_running(app_display_name: &str) -> bool {
    Command::new("pgrep")
        .args(["-x", app_display_name])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Open a directory with an editor, using dynamically resolved info.
/// Strategy:
/// - If editor is already running: use `open -a` to open in existing instance (no flicker)
/// - If editor is not running: use CLI to launch and open directory (reliable cold start)
fn open_path_with_editor(path: &str, editor_id: &str) -> Result<(), String> {
    let info = resolve_editor_open_info(editor_id)?;

    // If we have a display name, check if the app is already running
    if let Some(ref app_name) = info.app_display_name {
        if is_editor_running(app_name) {
            // App is running: use `open -a` to open in existing instance (no flicker)
            return open_path_with_open_a(app_name, path);
        }
    }

    // App is not running: use CLI to launch and open directory (reliable cold start)
    if let Some(ref cli_path) = info.cli_path {
        return open_path_with_cli(cli_path, path);
    }

    // Fallback to `open -a` using the display name
    if let Some(ref app_name) = info.app_display_name {
        return open_path_with_open_a(app_name, path);
    }

    Err("打开编辑器失败，请确认已安装对应应用。".into())
}

fn update_skill_repo(skill: &SkillSummary) -> Result<(), String> {
    let skill_path = Path::new(&skill.local_path);
    if !skill_path.exists()
        || run_git_command(&skill.local_path, &["rev-parse", "--is-inside-work-tree"]).is_err()
    {
        return Ok(());
    }

    let local_changes = collect_working_tree_changes(&skill.local_path)?;
    if !local_changes.is_empty() {
        return Err("本地存在未提交改动，请先推送或清理后再更新。".into());
    }

    let current_branch = current_branch_name(&skill.local_path)?;
    run_git_command(&skill.local_path, &["fetch", ORIGIN_REMOTE, "--quiet"])?;
    run_git_command(
        &skill.local_path,
        &["pull", "--ff-only", ORIGIN_REMOTE, &current_branch],
    )?;
    Ok(())
}

fn parse_repo_install_spec(repo_input: &str) -> Result<RepoInstallSpec, String> {
    let trimmed = repo_input.trim();
    if trimmed.is_empty() {
        return Err("仓库地址不能为空".into());
    }

    let normalized = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        let segments = trimmed
            .split('/')
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>();
        if segments.len() == 2 {
            format!("https://github.com/{}/{}", segments[0], segments[1])
        } else {
            return Err("当前仓库地址格式无法识别，请输入完整 Git URL 或 user/repo".into());
        }
    };

    let url = url::Url::parse(&normalized).map_err(|error| format!("仓库地址解析失败: {error}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| "仓库地址缺少主机名".to_string())?;
    let segments = url
        .path_segments()
        .map(|items| items.filter(|item| !item.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    if segments.len() < 2 {
        return Err("仓库地址缺少 owner/repo".into());
    }

    let owner = segments[0];
    let repo_name = segments[1].trim_end_matches(".git");
    let path_hint = if segments.get(2) == Some(&"tree") && segments.len() > 4 {
        Some(segments[4..].join("/"))
    } else if segments.get(2) == Some(&"-")
        && segments.get(3) == Some(&"tree")
        && segments.len() > 5
    {
        Some(segments[5..].join("/"))
    } else {
        None
    };
    let clone_url = format!("https://{host}/{owner}/{repo_name}.git");
    let source_type = detect_repo_source_type(&normalized).to_string();
    let repo_key = sanitize_storage_name(&format!("{host}-{owner}-{repo_name}"));

    Ok(RepoInstallSpec {
        clone_url,
        repo_key,
        source_type,
        source_url: normalized,
        path_hint,
    })
}

fn build_repo_skill_source_url(spec: &RepoInstallSpec, relative_path: &str) -> String {
    if relative_path.is_empty() {
        spec.source_url.clone()
    } else {
        format!(
            "{}/tree/main/{}",
            spec.source_url.trim_end_matches('/'),
            relative_path
        )
    }
}

fn scan_repo_skill_candidates(
    repo_root: &Path,
    path_hint: Option<&str>,
) -> Result<Vec<RepoSkillCandidate>, String> {
    let scan_root = if let Some(path) = path_hint {
        repo_root.join(path)
    } else {
        repo_root.to_path_buf()
    };
    if !scan_root.exists() {
        return Err("指定的仓库路径不存在，无法识别技能。".into());
    }

    let mut candidates = Vec::new();
    collect_repo_skill_candidates(repo_root, &scan_root, &mut candidates)?;
    candidates.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(candidates)
}

fn collect_repo_skill_candidates(
    repo_root: &Path,
    current_path: &Path,
    candidates: &mut Vec<RepoSkillCandidate>,
) -> Result<(), String> {
    let skill_file = current_path.join("SKILL.md");
    if skill_file.exists() {
        let relative_path = current_path
            .strip_prefix(repo_root)
            .map_err(|error| format!("解析 skill 路径失败: {error}"))?
            .to_string_lossy()
            .to_string();
        let name = current_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("skill")
            .to_string();
        let description = read_skill_description(&skill_file);
        candidates.push(RepoSkillCandidate {
            id: sanitize_storage_name(&if relative_path.is_empty() {
                name.clone()
            } else {
                relative_path.clone()
            }),
            name,
            description,
            relative_path,
        });
        return Ok(());
    }

    let mut child_paths = fs::read_dir(current_path)
        .map_err(|error| format!("读取仓库目录失败: {error}"))?
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    child_paths.sort();

    for child_path in child_paths {
        let Some(name) = child_path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.starts_with('.') || matches!(name, ".git" | "node_modules" | "dist" | "target") {
            continue;
        }
        if child_path.is_dir() {
            collect_repo_skill_candidates(repo_root, &child_path, candidates)?;
        }
    }

    Ok(())
}

fn read_skill_description(skill_file: &Path) -> String {
    let Ok(content) = fs::read_to_string(skill_file) else {
        return "未提供简介".into();
    };
    parse_skill_description_from_content(&content).unwrap_or_else(|| "未提供简介".into())
}

fn parse_skill_description_from_content(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.contains('|') {
            continue;
        }
        let cells = trimmed
            .trim_matches('|')
            .split('|')
            .map(str::trim)
            .collect::<Vec<_>>();
        if cells.len() < 2 {
            continue;
        }
        if !cells[0].eq_ignore_ascii_case("description") {
            continue;
        }
        let value = cells[1].trim_matches('"').trim_matches('\'').trim();
        if !value.is_empty() && value != "---" && value != "..." {
            return Some(value.to_string());
        }
    }

    let mut lines = content.lines().peekable();
    if lines.peek().is_some_and(|line| line.trim() == "---") {
        lines.next();
        let mut frontmatter_description = None;
        for line in lines.by_ref() {
            let trimmed = line.trim();
            if trimmed == "---" {
                break;
            }
            if let Some(value) = trimmed.strip_prefix("description:") {
                let normalized = value.trim().trim_matches('"').trim_matches('\'');
                if !normalized.is_empty() && normalized != "---" && normalized != "..." {
                    frontmatter_description = Some(normalized.to_string());
                }
            }
        }
        if frontmatter_description.is_some() {
            return frontmatter_description;
        }
    }

    for line in lines {
        let trimmed = line.trim();
        let looks_like_frontmatter_field = trimmed.split_once(':').is_some_and(|(key, _)| {
            !key.is_empty()
                && key.chars().all(|character| {
                    character.is_ascii_alphanumeric() || character == '-' || character == '_'
                })
        });
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || trimmed == "---"
            || trimmed == "..."
            || looks_like_frontmatter_field
        {
            continue;
        }
        return Some(trimmed.to_string());
    }

    None
}

#[tauri::command]
pub async fn get_workspace_snapshot() -> WorkspaceSnapshot {
    let _ = remove_reserved_workspace_symlinks_from_all_tools();
    let installed_skills = resolve_installed_skills();

    WorkspaceSnapshot {
        local_candidates: build_local_candidates(&installed_skills),
        installed_skills,
        marketplace_skills: build_marketplace_skills(None, 1, MARKETPLACE_FETCH_LIMIT, None, true)
            .await,
        tool_configs: build_tool_configs(),
        git_account: build_git_account(),
    }
}

#[tauri::command]
pub fn list_installed_skills() -> Vec<SkillSummary> {
    let _ = remove_reserved_workspace_symlinks_from_all_tools();
    resolve_installed_skills()
}

#[tauri::command]
pub async fn list_marketplace_skills(
    source_site: Option<String>,
    page: Option<usize>,
    limit: Option<usize>,
    query: Option<String>,
) -> Vec<MarketplaceSkill> {
    let page = page.unwrap_or(1).max(1);
    let limit = limit.unwrap_or(MARKETPLACE_FETCH_LIMIT).max(1);
    build_marketplace_skills(source_site.as_deref(), page, limit, query.as_deref(), true).await
}

#[tauri::command]
pub async fn get_marketplace_skill_description(
    source_site: String,
    source_url: String,
    skill_id: String,
    skill_name: String,
    fallback_description: Option<String>,
) -> String {
    let fallback = fallback_description
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "---" && *value != "...")
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("来自 {} 的公开 skill（{}）", source_site, skill_name));

    if source_site != "skills.sh" {
        return fallback;
    }

    let (source_from_id, normalized_skill_id) = parse_skills_sh_marketplace_id(&skill_id);
    let normalized_source = source_from_id
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| normalize_repo_key_from_source(&source_url));
    if normalized_source.is_empty() || normalized_skill_id.is_empty() {
        return fallback;
    }

    let resolved_skill_id =
        resolve_skills_sh_skill_path(&normalized_source, &normalized_skill_id, &skill_name);

    let item = SkillsShSkill {
        source: normalized_source,
        skill_id: resolved_skill_id,
        name: skill_name,
        installs: 0,
        description: None,
    };

    if let Some(description) = lookup_skills_sh_cached_description(&item) {
        return description;
    }

    let client = match marketplace_http_client() {
        Ok(value) => value,
        Err(_) => return fallback,
    };

    fetch_skills_sh_live_description(&client, &item)
        .await
        .unwrap_or(fallback)
}

#[tauri::command]
pub fn list_local_skill_candidates() -> Vec<LocalSkillCandidate> {
    let _ = remove_reserved_workspace_symlinks_from_all_tools();
    let installed_skills = load_installed_skills(&default_installed_skills());
    build_local_candidates(&installed_skills)
}

#[tauri::command]
pub fn list_tool_configs() -> Vec<ToolConfig> {
    build_tool_configs()
}

#[tauri::command]
pub fn get_git_account_summary() -> GitAccountSummary {
    build_git_account()
}

#[tauri::command]
pub async fn install_skill_from_market(skill: MarketplaceSkill) -> Result<SkillSummary, String> {
    tauri::async_runtime::spawn_blocking(move || install_skill_from_market_blocking(skill))
        .await
        .map_err(|error| format!("后台安装 marketplace skill 失败: {error}"))?
}

fn install_skill_from_market_blocking(skill: MarketplaceSkill) -> Result<SkillSummary, String> {
    if skill.name.trim().is_empty() {
        return Err("未找到目标安装技能".to_string());
    }
    if skill.source_url.trim().is_empty() {
        return Err("安装来源地址无效，请刷新后重试".to_string());
    }

    let mut installed_skills = load_installed_skills(&default_installed_skills());
    let mut installed_skill = SkillSummary {
        name: skill.name.clone(),
        source_label: source_label_for_type(&skill.source_type).into(),
        source_type: skill.source_type.clone(),
        source_url: skill.source_url.clone(),
        description: skill.description.clone(),
        local_path: String::new(),
        branch: "stable".into(),
        collab_status: "clean".into(),
        status_text: "刚安装完成，建议同步到常用工具。".into(),
        last_synced_at: "刚刚".into(),
        last_checked_at: "刚刚".into(),
        synced_tool_count: 1,
        last_editor: skill.maintainer.clone(),
        commit_label: "v1.0.0".into(),
        git_linked: true,
        tools: vec![ToolSyncStatus {
            name: "Codex".into(),
            status_label: "待同步".into(),
        }],
    };
    installed_skill.local_path = install_market_skill_from_source(
        &installed_skill,
        if skill.skill_path.is_empty() {
            None
        } else {
            Some(skill.skill_path.as_str())
        },
    )?;
    let skill_description_path = Path::new(&installed_skill.local_path).join("SKILL.md");
    if skill_description_path.is_file() {
        installed_skill.description = read_skill_description(&skill_description_path);
    }

    let installed_skill = enrich_skill_with_git_state(&normalize_skill_tools(&installed_skill));
    installed_skills.retain(|skill| skill.name != installed_skill.name);
    installed_skills.insert(0, installed_skill.clone());
    save_installed_skills(&installed_skills)?;

    Ok(installed_skill)
}

#[tauri::command]
pub fn install_skill_from_repo(repo_url: &str) -> Result<SkillSummary, String> {
    let repo_name = repo_url
        .trim_end_matches('/')
        .split('/')
        .last()
        .unwrap_or("custom-skill");

    let mut installed_skills = load_installed_skills(&default_installed_skills());
    let cloned_path = clone_repo_skill(repo_url, repo_name)?;
    let installed_skill = SkillSummary {
        name: repo_name.into(),
        source_label: "自定义仓库".into(),
        source_type: detect_repo_source_type(repo_url).into(),
        source_url: repo_url.into(),
        description: "从仓库导入的 skill，后续可继续同步和检查更新。".into(),
        local_path: cloned_path,
        branch: "main".into(),
        collab_status: "clean".into(),
        status_text: "仓库已导入，可继续同步到目标工具。".into(),
        last_synced_at: "刚刚".into(),
        last_checked_at: "刚刚".into(),
        synced_tool_count: 0,
        last_editor: "".into(),
        commit_label: "initial".into(),
        git_linked: true,
        tools: vec![],
    };

    let installed_skill = enrich_skill_with_git_state(&normalize_skill_tools(&installed_skill));
    installed_skills.retain(|skill| skill.name != installed_skill.name);
    installed_skills.insert(0, installed_skill.clone());
    save_installed_skills(&installed_skills)?;

    Ok(installed_skill)
}

#[tauri::command]
pub async fn discover_repo_skills(repo_url: String) -> Result<Vec<RepoSkillCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let spec = parse_repo_install_spec(&repo_url)?;
        let sparse_paths = spec
            .path_hint
            .as_ref()
            .map(|path| vec![path.clone()])
            .unwrap_or_default();
        let candidates = if sparse_paths.is_empty() {
            discover_repo_skills_without_path_hint(&spec)?
        } else {
            let repo_root = clone_repo_for_discovery_with_sparse_paths(
                &spec.clone_url,
                &spec.repo_key,
                &sparse_paths,
            )?;
            let candidates = scan_repo_skill_candidates(&repo_root, spec.path_hint.as_deref());
            cleanup_discovery_repo(&repo_root);
            candidates?
        };
        if candidates.is_empty() {
            return Err("未在仓库中识别到任何包含 SKILL.md 的技能目录。".into());
        }
        Ok(candidates)
    })
    .await
    .map_err(|error| format!("后台识别仓库技能失败: {error}"))?
}

fn discover_repo_skills_without_path_hint(
    spec: &RepoInstallSpec,
) -> Result<Vec<RepoSkillCandidate>, String> {
    if let Ok(repo_root) = clone_repo_for_discovery_with_sparse_paths(
        &spec.clone_url,
        &spec.repo_key,
        &["skills".to_string()],
    ) {
        let candidates = scan_repo_skill_candidates(&repo_root, None).unwrap_or_default();
        cleanup_discovery_repo(&repo_root);
        if !candidates.is_empty() {
            return Ok(candidates);
        }
    }

    let repo_root = clone_repo_for_discovery(&spec.clone_url, &spec.repo_key)?;
    let candidates = scan_repo_skill_candidates(&repo_root, None);
    cleanup_discovery_repo(&repo_root);
    candidates
}

fn cleanup_discovery_repo(repo_root: &Path) {
    let _ = fs::remove_dir_all(repo_root);
}

#[tauri::command]
pub async fn install_selected_repo_skills(
    repo_url: String,
    selected_paths: Vec<String>,
) -> Result<Vec<SkillSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if selected_paths.is_empty() {
            return Err("请至少选择一个技能再安装。".into());
        }

        let spec = parse_repo_install_spec(&repo_url)?;
        let mut installed_skills = load_installed_skills(&default_installed_skills());
        let mut installed_results = Vec::new();

        for selected_path in &selected_paths {
            let normalized_path = selected_path.trim_matches('/').to_string();
            let skill_name = Path::new(&normalized_path)
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    spec.source_url
                        .trim_end_matches('/')
                        .split('/')
                        .last()
                        .unwrap_or("custom-skill")
                })
                .to_string();
            if let Some(existing_skill) = installed_skills
                .iter()
                .find(|skill| skill.name == skill_name)
            {
                installed_results.push(existing_skill.clone());
                continue;
            }

            let skill_dir = skill_directory(&skill_name)
                .map_err(|error| format!("无法确定 skill 目录: {error}"))?;
            if skill_dir.exists() {
                std::fs::remove_dir_all(&skill_dir)
                    .map_err(|error| format!("清理旧 skill 目录失败: {error}"))?;
            }
            if let Some(parent) = skill_dir.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("创建 skill 目录失败: {error}"))?;
            }

            let local_path = if normalized_path.is_empty() {
                clone_repo_skill(&spec.clone_url, &skill_name)?
            } else {
                let sparse_paths = vec![normalized_path.clone()];
                ensure_repo_skill_with_sparse_paths(&spec.clone_url, &skill_name, &sparse_paths)?;
                // 不移动文件，直接返回子目录路径，保持 git 索引正确
                let subdir = skill_dir.join(&normalized_path);
                if !subdir.is_dir() || !subdir.join("SKILL.md").is_file() {
                    return Err(format!("未找到待安装技能路径: {selected_path}"));
                }
                subdir.to_string_lossy().to_string()
            };
            let skill_file = Path::new(&local_path).join("SKILL.md");
            let description = if skill_file.is_file() {
                read_skill_description(&skill_file)
            } else {
                "从仓库导入的 skill，后续可继续同步和检查更新。".into()
            };
            let installed_skill = SkillSummary {
                name: skill_name,
                source_label: "自定义仓库".into(),
                source_type: spec.source_type.clone(),
                source_url: build_repo_skill_source_url(&spec, selected_path),
                description,
                local_path,
                branch: "main".into(),
                collab_status: "clean".into(),
                status_text: "仓库技能已导入，可继续同步到目标工具。".into(),
                last_synced_at: "刚刚".into(),
                last_checked_at: "刚刚".into(),
                synced_tool_count: 0,
                last_editor: "".into(),
                commit_label: "initial".into(),
                git_linked: true,
                tools: vec![],
            };
            let enriched = enrich_skill_with_git_state(&normalize_skill_tools(&installed_skill));
            persist_skill_timestamps(&enriched);
            installed_skills.retain(|skill| skill.name != enriched.name);
            installed_skills.insert(0, enriched.clone());
            installed_results.push(enriched);
        }

        save_installed_skills(&installed_skills)?;
        Ok(installed_results)
    })
    .await
    .map_err(|error| format!("后台安装仓库技能失败: {error}"))?
}

#[tauri::command]
pub fn import_local_skill(local_path: &str) -> Result<SkillSummary, String> {
    let skill_name = local_path
        .trim_end_matches('/')
        .split('/')
        .last()
        .unwrap_or("imported-skill");

    let mut installed_skills = load_installed_skills(&default_installed_skills());
    let installed_skill = SkillSummary {
        name: skill_name.into(),
        source_label: "本地导入".into(),
        source_type: "local".into(),
        source_url: local_path.into(),
        description: "从本机已有目录导入的 skill。".into(),
        local_path: local_path.into(),
        branch: "local".into(),
        collab_status: "clean".into(),
        status_text: "本地技能已纳入统一管理。".into(),
        last_synced_at: "刚刚".into(),
        last_checked_at: "刚刚".into(),
        synced_tool_count: 0,
        last_editor: "".into(),
        commit_label: "local-only".into(),
        git_linked: false,
        tools: vec![],
    };

    let installed_skill = enrich_skill_with_git_state(&normalize_skill_tools(&installed_skill));
    persist_skill_timestamps(&installed_skill);
    installed_skills.retain(|skill| skill.name != installed_skill.name);
    installed_skills.insert(0, installed_skill.clone());
    save_installed_skills(&installed_skills)?;

    Ok(installed_skill)
}

#[tauri::command]
pub fn get_push_target_snapshot(skill_name: &str) -> Result<PushTargetSnapshot, String> {
    let (installed_skills, skill_index) = find_skill_by_name(skill_name)?;
    let skill = &installed_skills[skill_index];
    let current_branch = current_branch_name(&skill.local_path)?;
    let branches = collect_known_branches(&skill.local_path, &current_branch)?
        .into_iter()
        .map(|branch_name| PushBranchOption {
            is_current: branch_name == current_branch,
            name: branch_name,
        })
        .collect();

    Ok(PushTargetSnapshot {
        current_branch,
        branches,
    })
}

#[tauri::command]
pub fn get_push_preview_snapshot(
    skill_name: &str,
    target_branch: &str,
    create_branch_name: Option<String>,
) -> Result<PushPreviewSnapshot, String> {
    let (installed_skills, skill_index) = find_skill_by_name(skill_name)?;
    let skill = &installed_skills[skill_index];
    let branch_name = create_branch_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(target_branch);
    let remote_branch = resolve_remote_branch_name(&skill.local_path, target_branch).ok();
    let unpushed_commit_count = remote_branch
        .as_deref()
        .and_then(|remote| branch_divergence_counts(&skill.local_path, remote).ok())
        .map(|(_, ahead)| ahead)
        .unwrap_or(0);
    let will_create_branch = create_branch_name
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());

    Ok(PushPreviewSnapshot {
        target_branch: branch_name.to_string(),
        will_create_branch,
        repository_path: repository_root_path(&skill.local_path)?,
        uncommitted_files: collect_working_tree_changes(&skill.local_path)?,
        unpushed_commit_count,
    })
}

#[tauri::command]
pub fn get_update_preview_snapshot(skill_name: &str) -> Result<UpdatePreviewSnapshot, String> {
    let (installed_skills, skill_index) = find_skill_by_name(skill_name)?;
    let skill = &installed_skills[skill_index];
    let current_branch = current_branch_name(&skill.local_path)?;
    run_git_command(&skill.local_path, &["fetch", ORIGIN_REMOTE, "--quiet"])?;
    let remote_branch = resolve_remote_branch_name(&skill.local_path, &current_branch)?;
    let (commits_to_pull, _) = branch_divergence_counts(&skill.local_path, &remote_branch)?;
    let uncommitted_files = collect_working_tree_changes(&skill.local_path)?;
    let changed_files = collect_name_status_changes(
        &skill.local_path,
        &["diff", "--name-status", "HEAD", &remote_branch, "--", "."],
        &["diff", "HEAD", &remote_branch],
    )?;

    Ok(UpdatePreviewSnapshot {
        current_branch,
        remote_branch,
        commits_to_pull,
        changed_files,
        has_local_changes: !uncommitted_files.is_empty(),
    })
}

#[tauri::command]
pub fn open_skill_repository(skill_name: &str) -> Result<(), String> {
    let (installed_skills, skill_index) = find_skill_by_name(skill_name)?;
    let skill = &installed_skills[skill_index];
    let repository_path = repository_root_path(&skill.local_path)?;
    let output = Command::new("open")
        .arg(&repository_path)
        .output()
        .map_err(|error| format!("打开仓库目录失败: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("打开仓库目录失败: {stderr}"));
    }

    Ok(())
}

#[tauri::command]
pub fn open_external_link(url: &str) -> Result<(), String> {
    let target = url.trim();
    if !(target.starts_with("http://") || target.starts_with("https://")) {
        return Err("仅支持打开 http(s) 链接".into());
    }

    let output = Command::new("open")
        .arg(target)
        .output()
        .map_err(|error| format!("打开链接失败: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("打开链接失败: {stderr}"));
    }
    Ok(())
}

#[tauri::command]
pub fn open_skill_in_editor(skill_name: &str, editor_id: &str) -> Result<(), String> {
    let (installed_skills, skill_index) = find_skill_by_name(skill_name)?;
    let skill = &installed_skills[skill_index];
    if editor_id == "finder" {
        return open_path_with_finder(&skill.local_path);
    }

    open_path_with_editor(&skill.local_path, editor_id)
}

#[tauri::command]
pub fn update_skill(skill_name: &str) -> Result<SkillSummary, String> {
    let (installed_skills, skill_index) = find_skill_by_name(skill_name)?;
    let skill = &installed_skills[skill_index];
    update_skill_repo(skill)?;
    clear_skill_update_cache(skill);
    refresh_and_persist_skill(skill_name)
}

#[tauri::command]
pub fn get_skill_file_browser(skill_name: &str) -> Result<SkillFileBrowserSnapshot, String> {
    let base_path = skill_base_path(skill_name)?;
    let root_name = base_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(skill_name)
        .to_string();
    let mut entries = vec![SkillFileEntry {
        path: String::new(),
        name: root_name.clone(),
        entry_type: "directory".into(),
        depth: 0,
    }];
    collect_skill_entries(&base_path, &base_path, 1, &mut entries)?;
    let initial_file_path = entries
        .iter()
        .find(|entry| entry.entry_type == "file")
        .map(|entry| entry.path.clone());

    Ok(SkillFileBrowserSnapshot {
        skill_name: skill_name.into(),
        root_name,
        entries,
        initial_file_path,
    })
}

#[tauri::command]
pub fn get_skill_file_content(
    skill_name: &str,
    relative_path: &str,
) -> Result<SkillFileDocument, String> {
    let full_path = relative_file_path(skill_name, relative_path)?;
    let content =
        fs::read_to_string(&full_path).map_err(|error| format!("读取文件失败: {error}"))?;

    Ok(SkillFileDocument {
        path: relative_path.into(),
        content,
    })
}

#[tauri::command]
pub fn save_skill_file_content(
    skill_name: &str,
    relative_path: &str,
    content: &str,
) -> Result<SkillFileDocument, String> {
    let full_path = relative_file_path(skill_name, relative_path)?;
    if let Some(parent_dir) = full_path.parent() {
        fs::create_dir_all(parent_dir).map_err(|error| format!("创建父目录失败: {error}"))?;
    }
    fs::write(&full_path, content).map_err(|error| format!("保存文件失败: {error}"))?;

    Ok(SkillFileDocument {
        path: relative_path.into(),
        content: content.into(),
    })
}

#[tauri::command]
pub fn delete_skill(skill_name: &str) -> Result<(), String> {
    let (installed_skills, skill_index) = find_skill_by_name(skill_name)?;
    let skill = installed_skills[skill_index].clone();

    // 删除所有工具中的符号链接
    let skill_path = PathBuf::from(&skill.local_path);
    remove_skill_symlinks_from_all_tools(&skill.name)?;
    if let Some(legacy_skill_dir_name) = skill_path.file_name().and_then(|name| name.to_str()) {
        if legacy_skill_dir_name != skill.name {
            remove_skill_symlinks_from_all_tools(legacy_skill_dir_name)?;
        }
    }

    let local_path = PathBuf::from(&skill.local_path);
    let delete_target = managed_delete_target(&local_path)?;
    if delete_target.exists() && should_remove_local_directory(&delete_target)? {
        fs::remove_dir_all(&delete_target)
            .map_err(|error| format!("删除 skill 目录失败: {error}"))?;
    }

    let mut next_installed_skills = installed_skills;
    next_installed_skills.remove(skill_index);
    save_installed_skills(&next_installed_skills)?;

    Ok(())
}

#[tauri::command]
pub fn toggle_skill_tool_status(skill_name: &str, tool_name: &str) -> Result<SkillSummary, String> {
    let _ = remove_reserved_workspace_symlinks_from_all_tools();
    let (mut installed_skills, skill_index) = find_skill_by_name(skill_name)?;
    let skill_local_path = installed_skills[skill_index].local_path.clone();
    let tool_id = tool_name_to_id(tool_name)?;

    {
        let normalized_skill = normalize_skill_tools(&installed_skills[skill_index]);
        installed_skills[skill_index] = normalized_skill;
        let skill = &mut installed_skills[skill_index];
        let tool = skill
            .tools
            .iter_mut()
            .find(|tool| tool.name == tool_name)
            .ok_or_else(|| format!("未找到工具 {tool_name}"))?;

        let is_enabling = !matches!(
            tool.status_label.as_str(),
            "已同步" | "已启用" | "需要重同步"
        );

        if is_enabling {
            // 启用：创建符号链接
            let tool_skills_path = get_tool_skills_path(&tool_id)?;
            create_skill_symlink(&skill_local_path, skill_name, &tool_skills_path)?;
            tool.status_label = "已启用".into();
        } else {
            // 停用：删除符号链接
            let tool_skills_path = get_tool_skills_path(&tool_id)?;
            remove_skill_symlink(&tool_skills_path, skill_name)?;
            let skill_path = PathBuf::from(&skill_local_path);
            if let Some(legacy_skill_dir_name) =
                skill_path.file_name().and_then(|name| name.to_str())
            {
                if legacy_skill_dir_name != skill_name {
                    remove_skill_symlink(&tool_skills_path, legacy_skill_dir_name)?;
                }
            }
            tool.status_label = "未启用".into();
        }
    }

    save_installed_skills(&installed_skills)?;
    Ok(installed_skills[skill_index].clone())
}

fn detect_repo_source_type(repo_url: &str) -> &'static str {
    if repo_url.contains("gitlab.com") {
        return "gitlab";
    }
    if repo_url.contains("gitee.com") {
        return "gitee";
    }

    "github"
}
