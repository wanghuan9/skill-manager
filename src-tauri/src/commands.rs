use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex::{Regex, RegexBuilder};
use reqwest::Client;
use serde::{Deserialize, Deserializer, Serialize};
use zip::ZipArchive;

use crate::git_state::{
    clear_skill_update_cache, enrich_newly_installed_skill_with_git_state,
    enrich_skill_with_cached_update_state, enrich_skill_with_git_state,
    enrich_skill_with_local_git_state,
};
use crate::library::{
    clone_repo_for_discovery, clone_repo_for_discovery_with_sparse_paths, clone_repo_skill,
    create_skill_symlink, ensure_repo_skill_with_sparse_paths, get_tool_skills_path,
    install_market_skill_from_source, parse_market_source_url, reconcile_tool_skill_symlinks,
    remove_reserved_workspace_entries, remove_reserved_workspace_symlinks_from_all_tools,
    remove_skill_symlink, remove_skill_symlinks_from_all_tools, sanitize_storage_name,
    skill_directory,
};
use crate::models::{
    AppSettings, GitAccountSummary, GitChangeFile, LocalInstallSkillCandidate, LocalSkillCandidate,
    MarketplaceSkill, PushBranchOption, PushPreviewSnapshot, PushTargetSnapshot,
    RepoSkillCandidate, SkillFileBrowserSnapshot, SkillFileDocument, SkillFileEntry, SkillSummary,
    ToolConfig, ToolSyncStatus, UpdatePreviewSnapshot, WorkspaceSnapshot,
};
use crate::state::{
    load_app_settings, load_installed_skills, normalize_skill_install_activation,
    save_app_settings, save_installed_skills, scan_local_skill_candidates,
};
use crate::workspace::{self, APP_BRAND_NAME};

const REFRESH_GIT_STATES_CONCURRENCY: usize = 5;

fn default_installed_skills() -> Vec<SkillSummary> {
    Vec::new()
}

const GIT_COMMAND_TIMEOUT_SECS: u64 = 45;

fn sync_trace_enabled() -> bool {
    env::var("SKILLM_TRACE_SYNC").ok().as_deref() == Some("1")
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
static SKILLS_SH_HOMEPAGE_CACHE: OnceLock<Mutex<Option<Vec<SkillsShSkill>>>> = OnceLock::new();
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
struct SkillsMpSkill {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    author: String,
    #[serde(default, alias = "author_avatar")]
    author_avatar: String,
    #[serde(default)]
    description: String,
    #[serde(default, alias = "github_url")]
    github_url: String,
    #[serde(default, deserialize_with = "deserialize_u64_or_string")]
    stars: u64,
    #[serde(default, alias = "updated_at")]
    updated_at: String,
}

fn default_marketplace_skills() -> Vec<MarketplaceSkill> {
    Vec::new()
}

fn marketplace_http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("skilldock/0.1 (+https://github.com/wanghuan)")
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

fn deserialize_u64_or_string<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    if let Some(number) = value.as_u64() {
        return Ok(number);
    }
    if let Some(label) = value.as_str() {
        return Ok(label
            .trim()
            .replace(',', "")
            .parse::<u64>()
            .unwrap_or_default());
    }

    Ok(0)
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
        return format!("https://github.com/{source}/tree/HEAD/{normalized_skill_id}");
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
        match load_skills_sh_paged_items(client, page, fetch_limit).await {
            Ok(items) => items,
            Err(remote_error) => {
                if let Some(items) = load_skills_manager_cached_items_page(page, fetch_limit) {
                    items
                } else {
                    return Err(remote_error);
                }
            }
        }
    };

    Ok(map_skills_sh_items_to_marketplace(paged_items))
}

fn map_skills_sh_items_to_marketplace(paged_items: Vec<SkillsShSkill>) -> Vec<MarketplaceSkill> {
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

    skills
}

fn paginate_marketplace_skills(
    skills: &[MarketplaceSkill],
    page: usize,
    limit: usize,
) -> Vec<MarketplaceSkill> {
    let safe_page = page.max(1);
    let safe_limit = limit.max(1);
    let start = (safe_page - 1) * safe_limit;
    if start >= skills.len() {
        return Vec::new();
    }

    let end = (start + safe_limit).min(skills.len());
    skills[start..end].to_vec()
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
    collect_skills_manager_cached_items(&payload)
}

async fn load_skills_sh_homepage_items(client: &Client) -> Result<Vec<SkillsShSkill>, String> {
    let homepage_cache = SKILLS_SH_HOMEPAGE_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = homepage_cache.lock() {
        if let Some(items) = guard.as_ref() {
            return Ok(items.clone());
        }
    }

    let html = client
        .get("https://skills.sh")
        .send()
        .await
        .map_err(|error| format!("请求 skills.sh 首页榜单失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("skills.sh 首页榜单返回异常状态: {error}"))?
        .text()
        .await
        .map_err(|error| format!("读取 skills.sh 首页榜单内容失败: {error}"))?;

    let items = parse_skills_sh_homepage_items(&html);
    if items.is_empty() {
        return Err("解析 skills.sh 首页榜单失败".into());
    }

    if let Ok(mut guard) = homepage_cache.lock() {
        *guard = Some(items.clone());
    }

    Ok(items)
}

fn parse_skills_sh_homepage_items(html: &str) -> Vec<SkillsShSkill> {
    static LEADERBOARD_ROW_REGEX: OnceLock<Regex> = OnceLock::new();

    let Some(start) = html.find("Skills Leaderboard") else {
        return Vec::new();
    };
    let end = html[start..]
        .find("</main>")
        .map(|offset| start + offset)
        .unwrap_or(html.len());
    let section = &html[start..end];
    let row_regex = LEADERBOARD_ROW_REGEX.get_or_init(|| {
        RegexBuilder::new(
            r##"href="/(?P<href>[^"#?]+)"[^>]*>\s*<div class="lg:col-span-1 text-left">\s*<span[^>]*>(?P<rank>\d+)</span>\s*</div>\s*<div class="lg:col-span-13[^>]*>\s*<h3[^>]*>(?P<name>[^<]+)</h3>\s*<p[^>]*>(?P<source>[^<]+)</p>\s*</div>\s*<div class="lg:col-span-2[^>]*>.*?<span class="font-mono text-sm text-foreground">(?P<installs>[^<]+)</span>"##,
        )
        .dot_matches_new_line(true)
        .build()
        .expect("skills.sh 首页榜单正则应当有效")
    });

    row_regex
        .captures_iter(section)
        .filter_map(|captures| {
            let href = decode_skills_sh_html_text(captures.name("href")?.as_str());
            let path_segments = href
                .trim_matches('/')
                .split('/')
                .map(str::trim)
                .filter(|segment| !segment.is_empty())
                .collect::<Vec<_>>();
            if path_segments.len() < 3 {
                return None;
            }

            let source_text = decode_skills_sh_html_text(captures.name("source")?.as_str());
            let source = {
                let normalized = normalize_repo_key_from_source(&source_text);
                if normalized.is_empty() {
                    format!(
                        "{}/{}",
                        path_segments[0].to_lowercase(),
                        path_segments[1].trim_end_matches(".git").to_lowercase()
                    )
                } else {
                    normalized
                }
            };
            let name = decode_skills_sh_html_text(captures.name("name")?.as_str());
            let skill_id = path_segments[2..]
                .join("/")
                .trim_matches('/')
                .to_lowercase();
            let installs_label = decode_skills_sh_html_text(captures.name("installs")?.as_str());
            let installs = parse_skills_sh_compact_number(&installs_label).unwrap_or_default();
            if source.is_empty() || skill_id.is_empty() || name.trim().is_empty() {
                return None;
            }

            Some(SkillsShSkill {
                source,
                skill_id,
                name,
                installs,
                description: None,
            })
        })
        .collect()
}

fn decode_skills_sh_html_text(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn parse_skills_sh_compact_number(value: &str) -> Option<u64> {
    let normalized = value.trim().replace(',', "");
    if normalized.is_empty() {
        return None;
    }

    let (number_part, multiplier) = if let Some(number) = normalized.strip_suffix('M') {
        (number, 1_000_000_f64)
    } else if let Some(number) = normalized.strip_suffix('K') {
        (number, 1_000_f64)
    } else if let Some(number) = normalized.strip_suffix('B') {
        (number, 1_000_000_000_f64)
    } else {
        return normalized.parse::<u64>().ok();
    };

    number_part
        .trim()
        .parse::<f64>()
        .ok()
        .map(|number| (number * multiplier).round() as u64)
}

fn should_use_skills_sh_homepage_page(page: usize, page_len: usize, limit: usize) -> bool {
    let safe_page = page.max(1);
    let safe_limit = limit.max(1);
    safe_page == 1 || page_len >= safe_limit
}

fn collect_skills_manager_cached_items(
    payload: &serde_json::Value,
) -> Vec<SkillsManagerCachedSkill> {
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

    // 保持缓存文件中的原始榜单顺序，避免本地再次排序后与 skills.sh 官网顺序不一致。
    items
}

async fn load_skills_sh_paged_items(
    client: &Client,
    page: usize,
    limit: usize,
) -> Result<Vec<SkillsShSkill>, String> {
    if let Ok(items) = load_skills_sh_homepage_items(client).await {
        let safe_page = page.max(1);
        let safe_limit = limit.max(1);
        let start = (safe_page - 1) * safe_limit;
        if start < items.len() {
            let end = (start + safe_limit).min(items.len());
            let homepage_page = items[start..end].to_vec();
            if should_use_skills_sh_homepage_page(safe_page, homepage_page.len(), safe_limit) {
                return Ok(homepage_page);
            }
        }
    }

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

fn now_timestamp_label() -> String {
    format_system_time_label(SystemTime::now()).unwrap_or_else(|| "刚刚".into())
}

fn format_system_time_label(value: SystemTime) -> Option<String> {
    let seconds = value.duration_since(UNIX_EPOCH).ok()?.as_secs().to_string();
    let output = Command::new("date")
        .args(["-r", &seconds, "+%Y/%-m/%-d %H:%M:%S"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let formatted = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if formatted.is_empty() {
        None
    } else {
        Some(formatted)
    }
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
    let payload: serde_json::Value = request
        .send()
        .await
        .map_err(|error| format!("请求 skillsmp 失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("skillsmp 返回异常状态: {error}"))?
        .json()
        .await
        .map_err(|error| format!("解析 skillsmp 技能列表失败: {error}"))?;

    Ok(map_skillsmp_items_to_marketplace(collect_skillsmp_items(
        &payload,
    )))
}

fn collect_skillsmp_items(payload: &serde_json::Value) -> Vec<SkillsMpSkill> {
    let items = payload
        .as_array()
        .or_else(|| payload.get("skills").and_then(|value| value.as_array()))
        .or_else(|| payload.get("items").and_then(|value| value.as_array()))
        .or_else(|| payload.get("data").and_then(|value| value.as_array()))
        .or_else(|| {
            payload
                .get("data")
                .and_then(|value| value.get("skills"))
                .and_then(|value| value.as_array())
        });

    items
        .into_iter()
        .flatten()
        .filter_map(|item| serde_json::from_value(item.clone()).ok())
        .collect()
}

fn map_skillsmp_items_to_marketplace(items: Vec<SkillsMpSkill>) -> Vec<MarketplaceSkill> {
    items
        .into_iter()
        .filter_map(|item| {
            let name = item.name.trim();
            let source_url = item.github_url.trim();
            if name.is_empty() || source_url.is_empty() {
                return None;
            }

            // 尝试从 github_url 解析 skill 路径
            let skill_path = if let Ok(spec) = parse_market_source_url(source_url) {
                spec.relative_path
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default()
            } else {
                String::new()
            };
            let marketplace_id = if item.id.trim().is_empty() {
                sanitize_storage_name(name)
            } else {
                item.id.trim().to_string()
            };
            let description = if item.description.trim().is_empty() {
                format!("来自 skillsmp 的公开 skill（{name}）")
            } else {
                item.description.trim().to_string()
            };
            let maintainer = if item.author.trim().is_empty() {
                let fallback = maintainer_from_source(&normalize_repo_key_from_url(source_url));
                if fallback.trim().is_empty() {
                    "skillsmp".to_string()
                } else {
                    fallback
                }
            } else {
                item.author.trim().to_string()
            };
            let avatar_url = item.author_avatar.trim();

            Some(MarketplaceSkill {
                id: format!("skillsmp-{marketplace_id}"),
                name: name.to_string(),
                source_type: source_type_for_url(source_url).into(),
                source_site: "skillsmp".into(),
                description,
                maintainer,
                updated_at: item.updated_at.trim().to_string(),
                install_label: "默认按热度排序".into(),
                source_url: source_url.to_string(),
                popularity_label: format_compact_number(item.stars),
                avatar_url: if avatar_url.is_empty() {
                    None
                } else {
                    Some(avatar_url.to_string())
                },
                skill_path,
            })
        })
        .collect()
}

fn marketplace_cache_file() -> Option<PathBuf> {
    workspace::managed_workspace_root()
        .ok()
        .map(|workspace_root| workspace_root.join("cache").join("marketplace.json"))
}

fn marketplace_cache_key(source: &str) -> String {
    if source.trim().is_empty() {
        "all".into()
    } else {
        source.trim().to_lowercase()
    }
}

fn load_marketplace_cache(source: &str) -> Option<Vec<MarketplaceSkill>> {
    let cache_path = marketplace_cache_file()?;
    let content = fs::read_to_string(cache_path).ok()?;
    let cached: serde_json::Value = serde_json::from_str(&content).ok()?;
    let source_key = marketplace_cache_key(source);
    let version = cached
        .get("version")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    if version < 2 {
        return None;
    }
    let sources = cached.get("sources")?.as_object()?;
    let source_entry = sources.get(&source_key)?;
    let skills_array = source_entry.get("skills").and_then(|v| v.as_array())?;
    Some(
        skills_array
            .iter()
            .filter_map(|skill| serde_json::from_value(skill.clone()).ok())
            .map(normalize_cached_marketplace_skill)
            .collect(),
    )
}

fn load_marketplace_cache_page(
    source: &str,
    page: usize,
    limit: usize,
) -> Option<Vec<MarketplaceSkill>> {
    let cached_skills = load_marketplace_cache(source)?;
    let page_skills = paginate_marketplace_skills(&cached_skills, page, limit);
    if page_skills.is_empty() {
        return None;
    }

    Some(page_skills)
}

fn normalize_cached_marketplace_skill(mut skill: MarketplaceSkill) -> MarketplaceSkill {
    if skill.source_site != "skills.sh" {
        return skill;
    }

    let (source_from_id, path_from_id) = parse_skills_sh_marketplace_id(&skill.id);
    let source =
        source_from_id.unwrap_or_else(|| normalize_repo_key_from_source(&skill.source_url));
    if source.is_empty() {
        return skill;
    }

    let path_hint = if skill.skill_path.trim().is_empty() {
        path_from_id
    } else {
        skill.skill_path.clone()
    };
    let resolved_skill_path = resolve_skills_sh_skill_path(&source, &path_hint, &skill.name);
    if resolved_skill_path.trim().is_empty() {
        return skill;
    }

    skill.id = skills_sh_marketplace_id(&source, &resolved_skill_path);
    skill.source_url = skills_sh_source_url(&source, &resolved_skill_path);
    skill.source_type = source_type_for_url(&skill.source_url).into();
    skill.skill_path = resolved_skill_path;
    skill
}

fn save_marketplace_cache(source: &str, skills: &[MarketplaceSkill]) {
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

    let source_key = marketplace_cache_key(source);
    let mut cache_data = fs::read_to_string(&cache_path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let Some(cache_object) = cache_data.as_object_mut() else {
        return;
    };
    cache_object.insert("version".into(), serde_json::json!(2_u64));
    cache_object.insert("timestamp".into(), serde_json::json!(timestamp));
    let sources_value = cache_object
        .entry("sources")
        .or_insert_with(|| serde_json::json!({}));
    let Some(sources_object) = sources_value.as_object_mut() else {
        return;
    };
    sources_object.insert(
        source_key,
        serde_json::json!({
            "timestamp": timestamp,
            "skills": skills
        }),
    );

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
    refresh: bool,
) -> Vec<MarketplaceSkill> {
    let source = source_site.unwrap_or_default();
    let is_searching = query.is_some() && !query.unwrap_or_default().trim().is_empty();

    if !refresh && !is_searching && page == 1 {
        if let Some(cached_page) = load_marketplace_cache_page(source, page, limit) {
            return cached_page;
        }
    }

    let client = match marketplace_http_client() {
        Ok(client) => client,
        Err(_) => return default_marketplace_skills(),
    };

    if source == "skills.sh" && !is_searching {
        match load_skills_sh_homepage_items(&client).await {
            Ok(homepage_items) => {
                let homepage_skills = map_skills_sh_items_to_marketplace(homepage_items);
                if !homepage_skills.is_empty() {
                    let homepage_page = paginate_marketplace_skills(&homepage_skills, page, limit);
                    if page == 1 && !homepage_page.is_empty() {
                        save_marketplace_cache(source, &homepage_page);
                    }
                    if should_use_skills_sh_homepage_page(page, homepage_page.len(), limit) {
                        return homepage_page;
                    }
                }
            }
            Err(error) => {
                if page == 1 {
                    if let Some(cached_page) = load_marketplace_cache_page(source, page, limit) {
                        return cached_page;
                    }
                }
                eprintln!("Failed to load live skills.sh homepage leaderboard: {error}");
            }
        }
    }

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

    if !is_searching {
        skills.retain(|skill| matches_marketplace_query(skill, query));
    }
    if !source.is_empty() {
        skills.retain(|skill| skill.source_site == source);
    }

    let result = if skills.is_empty() {
        if page == 1 && !is_searching {
            if let Some(cached_page) = load_marketplace_cache_page(source, page, limit) {
                cached_page
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        }
    } else {
        skills
    };

    // 如果是第一页且不是搜索，保存到缓存
    if page == 1 && !is_searching && !result.is_empty() {
        save_marketplace_cache(source, &result);
    }

    result
}

fn build_local_candidates(installed_skills: &[SkillSummary]) -> Vec<LocalSkillCandidate> {
    scan_local_skill_candidates(installed_skills)
        .into_iter()
        .map(|(name, detected_from)| {
            let local_path = format!("{detected_from}/{name}");
            let source_hint = local_candidate_source_hint(&local_path).to_string();
            LocalSkillCandidate {
                description: format!("从 {detected_from} 发现的本地技能。"),
                source_hint,
                name,
                local_path,
                detected_from,
            }
        })
        .collect()
}

fn local_candidate_source_hint(local_path: &str) -> &'static str {
    fs::symlink_metadata(Path::new(local_path))
        .map(|metadata| {
            if metadata.file_type().is_symlink() {
                "符号链接"
            } else {
                "本地文件"
            }
        })
        .unwrap_or("本地文件")
}

#[derive(Clone, Copy)]
struct SoftwareDetectionSpec {
    app_names: &'static [&'static str],
    executable_names: &'static [&'static str],
}

fn software_spec(
    app_names: &'static [&'static str],
    executable_names: &'static [&'static str],
) -> SoftwareDetectionSpec {
    SoftwareDetectionSpec {
        app_names,
        executable_names,
    }
}

const EDITOR_HOST_APPS: &[&str] = &[
    "Cursor",
    "Visual Studio Code",
    "Visual Studio Code - Insiders",
    "Windsurf",
    "Trae",
    "TRAE",
    "Trae CN",
    "IntelliJ IDEA",
    "IntelliJ IDEA CE",
    "IntelliJ IDEA Ultimate",
    "WebStorm",
    "PyCharm",
];

const EDITOR_HOST_EXECUTABLES: &[&str] = &["cursor", "code", "windsurf", "trae", "idea"];

fn find_executable_path(executable_name: &str) -> Option<String> {
    if executable_name.contains('/') {
        return Path::new(executable_name)
            .exists()
            .then(|| executable_name.to_string());
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
        executable_path
            .exists()
            .then(|| executable_path.to_string_lossy().to_string())
    })
}

fn executable_exists(executable_name: &str) -> bool {
    find_executable_path(executable_name).is_some()
}

fn software_exists(spec: &SoftwareDetectionSpec) -> bool {
    (!spec.app_names.is_empty() && find_app_bundle(spec.app_names).is_some())
        || spec
            .executable_names
            .iter()
            .any(|executable_name| executable_exists(executable_name))
}

fn detect_tool_installation_label(
    config_paths: &[PathBuf],
    software_spec: &SoftwareDetectionSpec,
    requires_software_detection: bool,
) -> String {
    let has_config = config_paths.is_empty() || config_paths.iter().any(|path| path.exists());
    if has_config && (!requires_software_detection || software_exists(software_spec)) {
        "已安装".to_string()
    } else {
        "未安装".to_string()
    }
}

fn mcp_config_path_for_tool(tool_id: &str, home_path: &Path) -> PathBuf {
    match tool_id {
        "augment" => home_path.join(".augment/settings.json"),
        "claude-code" => home_path.join(".claude.json"),
        "cline" => home_path.join(".cline/data/settings/cline_mcp_settings.json"),
        "codebuddy" => home_path.join(".codebuddy/.mcp.json"),
        "codex" => home_path.join(".codex/config.toml"),
        "commandcode" => home_path.join(".commandcode/mcp.json"),
        "cursor" => home_path.join(".cursor/mcp.json"),
        "gemini" => home_path.join(".gemini/settings.json"),
        "antigravity" => home_path.join(".gemini/config/mcp_config.json"),
        "github-copilot" => home_path.join(".copilot/mcp-config.json"),
        "goose" => home_path.join(".config/goose/config.yaml"),
        "hermes" => home_path.join(".hermes/config.yaml"),
        "iflow" => home_path.join(".iflow/settings.json"),
        "junie" => home_path.join(".junie/mcp/mcp.json"),
        "kilo-code" => home_path.join(
            "Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/settings/mcp_settings.json",
        ),
        "kiro" => home_path.join(".kiro/settings/mcp.json"),
        "opencode" => home_path.join(".config/opencode/opencode.json"),
        "qoder" => home_path.join(".config/Qoder/SharedClientCache/mcp.json"),
        "qwen-code" => home_path.join(".qwen/settings.json"),
        "roo-code" => home_path.join(
            "Library/Application Support/Code/User/globalStorage/RooVeterinaryInc.roo-cline/settings/mcp_settings.json",
        ),
        "trae" => home_path.join("Library/Application Support/Trae/User/mcp.json"),
        "trae-cn" => home_path.join("Library/Application Support/Trae CN/User/mcp.json"),
        "droid" => home_path.join(".factory/mcp.json"),
        "windsurf" => home_path.join(".codeium/windsurf/mcp_config.json"),
        "openclaw" => home_path.join(".openclaw/openclaw.json"),
        "continue" => home_path.join(".continue/config.yaml"),
        "crush" => home_path.join(".config/crush/crush.json"),
        "zencoder" => home_path.join(".zencoder/settings.json"),
        _ => PathBuf::new(),
    }
}

fn supports_mcp_for_tool(tool_id: &str) -> bool {
    matches!(
        tool_id,
        "augment"
            | "claude-code"
            | "cline"
            | "codebuddy"
            | "codex"
            | "commandcode"
            | "cursor"
            | "gemini"
            | "github-copilot"
            | "goose"
            | "hermes"
            | "iflow"
            | "junie"
            | "kilo-code"
            | "kiro"
            | "opencode"
            | "openclaw"
            | "qoder"
            | "qwen-code"
            | "roo-code"
            | "trae"
            | "trae-cn"
            | "windsurf"
            | "zencoder"
            | "droid"
            | "crush"
            | "antigravity"
    )
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
            software_spec(&["Claude"], &["claude"]),
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
            software_spec(&["Codex"], &["codex"]),
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
            software_spec(&["OpenCode"], &["opencode"]),
        ),
        (
            "cursor",
            "Cursor",
            home_path.join(".cursor/skills"),
            true,
            "editor",
            vec!["editor"],
            true,
            vec![home_path.join(".cursor")],
            software_spec(&["Cursor"], &["cursor"]),
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
            software_spec(&[], &["gemini"]),
        ),
        (
            "antigravity",
            "Antigravity",
            home_path.join(".gemini/config/skills"),
            true,
            "desktop",
            vec!["desktop", "cli"],
            false,
            vec![home_path.join(".gemini/antigravity")],
            software_spec(&["Antigravity"], &[]),
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
            ],
            software_spec(&["Windsurf"], &["windsurf"]),
        ),
        (
            "intellij",
            "IntelliJ IDEA",
            home_path.join(".junie/skills"),
            true,
            "editor",
            vec!["editor"],
            true,
            vec![],
            software_spec(
                &[
                    "IntelliJ IDEA",
                    "IntelliJ IDEA CE",
                    "IntelliJ IDEA Ultimate",
                ],
                &["idea"],
            ),
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
            software_spec(&["OpenClaw"], &["openclaw"]),
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
            software_spec(EDITOR_HOST_APPS, EDITOR_HOST_EXECUTABLES),
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
            software_spec(&["iFlow"], &["iflow"]),
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
            software_spec(&["CodeBuddy"], &["codebuddy"]),
        ),
        (
            "trae",
            "Trae",
            home_path.join(".trae/skills"),
            true,
            "editor",
            vec!["editor"],
            true,
            vec![home_path.join(".trae")],
            software_spec(&["Trae", "TRAE"], &["trae"]),
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
            software_spec(&["Droid", "Factory"], &["droid"]),
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
            software_spec(&["Augment"], &["augment"]),
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
            software_spec(EDITOR_HOST_APPS, EDITOR_HOST_EXECUTABLES),
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
            software_spec(&["CommandCode"], &["commandcode"]),
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
            software_spec(&["Crush"], &["crush"]),
        ),
        (
            "goose",
            "Goose",
            home_path.join(".agents/skills"),
            true,
            "cli",
            vec!["cli"],
            false,
            vec![home_path.join(".config/goose")],
            software_spec(&["Goose"], &["goose"]),
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
            software_spec(EDITOR_HOST_APPS, EDITOR_HOST_EXECUTABLES),
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
            software_spec(EDITOR_HOST_APPS, EDITOR_HOST_EXECUTABLES),
        ),
        (
            "kiro",
            "Kiro",
            home_path.join(".kiro/skills"),
            true,
            "editor",
            vec!["editor", "cli"],
            true,
            vec![home_path.join(".kiro")],
            software_spec(&["Kiro", "Kiro CLI"], &["kiro"]),
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
            software_spec(&["Qoder"], &["qoder"]),
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
            software_spec(&[], &["qwen"]),
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
            software_spec(EDITOR_HOST_APPS, EDITOR_HOST_EXECUTABLES),
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
            software_spec(&["Zencoder"], &["zencoder"]),
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
            software_spec(&["Trae CN", "TRAE CN"], &["trae-cn", "trae"]),
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
            software_spec(&["Hermes"], &["hermes"]),
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
            software_spec(EDITOR_HOST_APPS, EDITOR_HOST_EXECUTABLES),
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
                config_paths,
                software_spec,
            )| {
                let mcp_config_path = mcp_config_path_for_tool(id, &home_path);
                let supports_mcp = supports_mcp_for_tool(id);
                let mcp_config_path_recognized = !mcp_config_path.as_os_str().is_empty();

                ToolConfig {
                    id: id.into(),
                    name: name.into(),
                    skills_path: skills_path.to_string_lossy().to_string(),
                    mcp_config_path: mcp_config_path.to_string_lossy().to_string(),
                    supports_mcp,
                    mcp_config_path_recognized,
                    status_label: detect_tool_installation_label(
                        &config_paths,
                        &software_spec,
                        primary_type == "editor",
                    ),
                    is_enabled,
                    primary_type: primary_type.into(),
                    surface_types: surface_types.into_iter().map(|item| item.into()).collect(),
                    supports_direct_open,
                }
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

fn installed_tool_sync_entries_from_configs(tool_configs: &[ToolConfig]) -> Vec<ToolSyncStatus> {
    tool_configs
        .iter()
        .filter(|tool| tool.status_label == "已安装" && tool.id != "intellij")
        .map(|tool| ToolSyncStatus {
            name: tool.name.clone(),
            status_label: "未启用".into(),
        })
        .collect()
}

fn normalize_skill_tools_with_entries(
    skill: &SkillSummary,
    installed_tool_entries: &[ToolSyncStatus],
) -> SkillSummary {
    let mut tool_status_map = skill
        .tools
        .iter()
        .cloned()
        .map(|tool| (tool.name.clone(), tool.status_label))
        .collect::<BTreeMap<_, _>>();
    let merged_tools = installed_tool_entries
        .iter()
        .map(|tool| ToolSyncStatus {
            name: tool.name.clone(),
            status_label: tool_status_map
                .remove(&tool.name)
                .unwrap_or_else(|| tool.status_label.clone()),
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

fn normalize_skill_tools(skill: &SkillSummary) -> SkillSummary {
    let tool_configs = build_tool_configs();
    let installed_tool_entries = installed_tool_sync_entries_from_configs(&tool_configs);
    normalize_skill_tools_with_entries(skill, &installed_tool_entries)
}

fn normalize_git_remote_repository_url(remote_url: &str) -> Option<String> {
    let trimmed = remote_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }

    if let Some(rest) = trimmed.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        return Some(format!(
            "https://{}/{}",
            host.trim_end_matches('/'),
            path.trim_start_matches('/').trim_end_matches(".git")
        ));
    }

    let parsed = url::Url::parse(trimmed).ok()?;
    let host = parsed.host_str()?;
    let segments = parsed
        .path_segments()
        .map(|items| items.filter(|item| !item.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    if segments.len() < 2 {
        return None;
    }

    Some(format!(
        "https://{host}/{}/{}",
        segments[0],
        segments[1].trim_end_matches(".git")
    ))
}

fn build_tree_source_url(
    repository_url: &str,
    source_type: &str,
    branch: Option<&str>,
    relative_path: &str,
) -> String {
    let normalized_repository_url = repository_url.trim_end_matches('/');
    let normalized_relative_path = relative_path.trim_matches('/');
    if normalized_relative_path.is_empty() {
        return normalized_repository_url.to_string();
    }

    let branch_segment = branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("HEAD");
    match source_type {
        "gitlab" => format!(
            "{normalized_repository_url}/-/tree/{branch_segment}/{normalized_relative_path}"
        ),
        _ => {
            format!("{normalized_repository_url}/tree/{branch_segment}/{normalized_relative_path}")
        }
    }
}

fn git_repo_root(skill_path: &str) -> Option<PathBuf> {
    Some(PathBuf::from(
        run_git_command(skill_path, &["rev-parse", "--show-toplevel"]).ok()?,
    ))
}

fn origin_default_branch_name(skill_path: &str) -> Option<String> {
    let symbolic_ref = run_git_command(
        skill_path,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .ok()?;
    symbolic_ref
        .trim()
        .strip_prefix(REMOTE_PREFIX)
        .map(ToOwned::to_owned)
}

fn source_branch_hint_from_url(source_url: &str) -> Option<String> {
    let parsed = url::Url::parse(source_url.trim()).ok()?;
    let segments = parsed
        .path_segments()
        .map(|items| items.filter(|item| !item.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    if segments.len() >= 4 && segments[2] == "tree" {
        return Some(segments[3].to_string());
    }
    if segments.len() >= 5 && segments[2] == "-" && segments[3] == "tree" {
        return Some(segments[4].to_string());
    }
    None
}

fn normalize_installed_skill_source_url(skill: &SkillSummary) -> SkillSummary {
    if !skill.git_linked || skill.source_type == "local" {
        return skill.clone();
    }
    let should_repair_missing_source_url = skill.source_url.trim().is_empty();
    if !should_repair_missing_source_url {
        return skill.clone();
    }

    let Some(repository_url) =
        run_git_command(&skill.local_path, &["config", "--get", "remote.origin.url"])
            .ok()
            .and_then(|remote_url| normalize_git_remote_repository_url(&remote_url))
    else {
        return skill.clone();
    };

    let Some(repo_root) = git_repo_root(&skill.local_path) else {
        return skill.clone();
    };
    let skill_path =
        fs::canonicalize(&skill.local_path).unwrap_or_else(|_| PathBuf::from(&skill.local_path));
    let repo_root =
        fs::canonicalize(repo_root).unwrap_or_else(|_| PathBuf::from(&skill.local_path));
    let relative_path = skill_path
        .strip_prefix(&repo_root)
        .ok()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let branch = origin_default_branch_name(&skill.local_path)
        .or_else(|| source_branch_hint_from_url(&skill.source_url))
        .or_else(|| current_branch_name(&skill.local_path).ok());

    let mut normalized = skill.clone();
    let source_type = source_type_for_url(&repository_url);
    normalized.source_url = build_tree_source_url(
        &repository_url,
        source_type,
        branch.as_deref(),
        &relative_path,
    );
    normalized.source_type = source_type_for_url(&normalized.source_url).into();
    normalized.source_label = source_label_for_type(&normalized.source_type).into();
    normalized
}

fn apply_skill_install_activation(
    skill: SkillSummary,
    installed_skills: &[SkillSummary],
) -> Result<SkillSummary, String> {
    let app_settings = load_app_settings();
    if normalize_skill_install_activation(&app_settings.skill_install_activation)
        != "apply-all-tools"
    {
        return Ok(skill);
    }

    enable_skill_for_all_installed_tools(skill, installed_skills)
}

fn enable_skill_for_all_installed_tools(
    skill: SkillSummary,
    installed_skills: &[SkillSummary],
) -> Result<SkillSummary, String> {
    let installed_tool_configs = build_tool_configs()
        .into_iter()
        .filter(|tool| tool.status_label == "已安装" && tool.id != "intellij")
        .collect::<Vec<_>>();
    if installed_tool_configs.is_empty() {
        return Ok(skill);
    }

    let mut updated_skill = normalize_skill_tools(&skill);
    let normalized_existing_skills = installed_skills
        .iter()
        .map(normalize_skill_tools)
        .collect::<Vec<_>>();
    for tool_config in installed_tool_configs {
        if !updated_skill
            .tools
            .iter()
            .any(|tool| tool.name == tool_config.name)
        {
            continue;
        }

        let tool_skills_path = get_tool_skills_path(&tool_config.id)?;
        let _ = remove_reserved_workspace_entries(&tool_skills_path);
        let skill_name = updated_skill.name.clone();
        let tool_name = tool_config.name.clone();
        set_skill_tool_enabled_status(
            std::slice::from_mut(&mut updated_skill),
            &skill_name,
            &tool_name,
            true,
        )?;
        let mut enabled_skills = enabled_skills_for_tool(&normalized_existing_skills, &tool_name)
            .into_iter()
            .filter(|skill| skill.name != updated_skill.name)
            .collect::<Vec<_>>();
        enabled_skills.push(updated_skill.clone());
        reconcile_tool_skill_symlinks(&tool_skills_path, &enabled_skills)?;
    }

    Ok(updated_skill)
}

fn resolve_startup_installed_skills() -> Vec<SkillSummary> {
    let tool_configs = build_tool_configs();
    let installed_tool_entries = installed_tool_sync_entries_from_configs(&tool_configs);
    let installed_skills = load_installed_skills(&default_installed_skills());
    let normalized_skills = installed_skills
        .iter()
        .map(normalize_installed_skill_source_url)
        .collect::<Vec<_>>();
    if normalized_skills
        .iter()
        .zip(installed_skills.iter())
        .any(|(current, original)| {
            current.source_url != original.source_url
                || current.source_type != original.source_type
                || current.source_label != original.source_label
        })
    {
        let _ = save_installed_skills(&normalized_skills);
    }

    normalized_skills
        .iter()
        .map(|skill| normalize_skill_tools_with_entries(&skill, &installed_tool_entries))
        .map(|skill| enrich_skill_with_cached_update_state(&skill))
        .collect()
}

fn resolve_installed_skills() -> Vec<SkillSummary> {
    resolve_startup_installed_skills()
}

fn load_interactive_installed_skills() -> Vec<SkillSummary> {
    load_installed_skills(&default_installed_skills())
}

const GIT_BINARY: &str = "git";
const ORIGIN_REMOTE: &str = "origin";
const REMOTE_PREFIX: &str = "origin/";
const RESERVED_WORKSPACE_NAMES: [&str; 5] =
    ["state.json", "skills", "repo-cache", "cache", "imports"];

fn is_reserved_workspace_name(name: &str) -> bool {
    RESERVED_WORKSPACE_NAMES.contains(&name)
}

fn tool_status_is_enabled(status_label: &str) -> bool {
    matches!(status_label, "已同步" | "已启用" | "需要重同步")
}

fn set_skill_tool_enabled_status(
    installed_skills: &mut [SkillSummary],
    skill_name: &str,
    tool_name: &str,
    enabled: bool,
) -> Result<SkillSummary, String> {
    let skill = installed_skills
        .iter_mut()
        .find(|skill| skill.name == skill_name)
        .ok_or_else(|| format!("未找到技能 {skill_name}"))?;
    let tool = skill
        .tools
        .iter_mut()
        .find(|tool| tool.name == tool_name)
        .ok_or_else(|| format!("未找到工具 {tool_name}"))?;

    tool.status_label = if enabled {
        "已启用".into()
    } else {
        "未启用".into()
    };
    skill.synced_tool_count = skill
        .tools
        .iter()
        .filter(|item| tool_status_is_enabled(&item.status_label))
        .count();

    Ok(skill.clone())
}

fn normalize_known_tool_names(tool_names: &[String]) -> Vec<String> {
    let mut known_tool_names = Vec::new();
    let mut seen_tool_names = BTreeSet::new();

    for tool_name in tool_names {
        let normalized_tool_name = tool_name.trim();
        if normalized_tool_name.is_empty()
            || !seen_tool_names.insert(normalized_tool_name.to_string())
        {
            continue;
        }
        known_tool_names.push(normalized_tool_name.to_string());
    }

    known_tool_names
}

fn align_skill_tools_with_known_names(skill: &mut SkillSummary, tool_names: &[String]) {
    let known_tool_names = normalize_known_tool_names(tool_names);
    if known_tool_names.is_empty() {
        skill.synced_tool_count = skill
            .tools
            .iter()
            .filter(|tool| tool_status_is_enabled(&tool.status_label))
            .count();
        return;
    }

    let known_tool_name_set = known_tool_names.iter().cloned().collect::<BTreeSet<_>>();
    let mut existing_status_by_name = skill
        .tools
        .iter()
        .cloned()
        .map(|tool| (tool.name, tool.status_label))
        .collect::<BTreeMap<_, _>>();
    let mut merged_tools = known_tool_names
        .into_iter()
        .map(|tool_name| ToolSyncStatus {
            status_label: existing_status_by_name
                .remove(&tool_name)
                .unwrap_or_else(|| "未启用".into()),
            name: tool_name,
        })
        .collect::<Vec<_>>();

    merged_tools.extend(
        skill
            .tools
            .iter()
            .filter(|tool| !known_tool_name_set.contains(&tool.name))
            .cloned(),
    );

    skill.synced_tool_count = merged_tools
        .iter()
        .filter(|tool| tool_status_is_enabled(&tool.status_label))
        .count();
    skill.tools = merged_tools;
}

fn align_installed_skills_with_known_tools(
    installed_skills: &mut [SkillSummary],
    skill_names: &[String],
    tool_names: &[String],
) {
    let target_skill_names = skill_names
        .iter()
        .map(|name| name.trim())
        .collect::<BTreeSet<_>>();
    if target_skill_names.is_empty() {
        return;
    }

    for skill in installed_skills
        .iter_mut()
        .filter(|skill| target_skill_names.contains(skill.name.as_str()))
    {
        align_skill_tools_with_known_names(skill, tool_names);
    }
}

fn enabled_skills_for_tool(
    installed_skills: &[SkillSummary],
    tool_name: &str,
) -> Vec<SkillSummary> {
    installed_skills
        .iter()
        .filter(|skill| {
            skill
                .tools
                .iter()
                .find(|tool| tool.name == tool_name)
                .is_some_and(|tool| tool_status_is_enabled(&tool.status_label))
        })
        .cloned()
        .collect()
}

/// Resolved info for opening a directory with an editor.
/// Dynamically detected from the installed .app bundle on the user's system.
struct EditorOpenInfo {
    /// CLI binary path found inside the .app bundle (e.g. .../Cursor.app/Contents/Resources/app/bin/cursor).
    cli_path: Option<String>,
    /// Display name extracted from the .app bundle filename (e.g. "Cursor").
    app_display_name: Option<String>,
}

/// Scan common macOS application directories for .app bundles whose name matches a candidate.
fn find_app_bundle(app_name_candidates: &[&str]) -> Option<String> {
    let mut app_dirs = vec![PathBuf::from("/Applications")];
    if let Some(home_dir) = env::var_os("HOME") {
        app_dirs.push(PathBuf::from(home_dir).join("Applications"));
    }

    for apps_dir in app_dirs {
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
    }
    None
}

/// Discover a CLI binary inside an .app bundle.
/// Checks Contents/Resources/app/bin/ for executables matching the app name.
fn discover_cli_in_bundle(app_bundle_path: &str) -> Option<String> {
    let bundle = PathBuf::from(app_bundle_path);
    let stem = bundle.file_stem()?.to_str()?.to_string();
    // Common CLI locations in Electron / JetBrains apps
    let mut candidate_paths = vec![
        bundle.join("Contents/Resources/app/bin").join(&stem),
        bundle
            .join("Contents/Resources/app/bin")
            .join(&stem.to_lowercase()),
        bundle.join("Contents/MacOS").join(&stem),
    ];
    if stem.to_lowercase().starts_with("intellij idea") {
        candidate_paths.push(bundle.join("Contents/MacOS/idea"));
    }

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
        "antigravity" => &["Antigravity"],
        "cursor" => &["Cursor"],
        "windsurf" => &["Windsurf"],
        "kiro" => &["Kiro", "Kiro CLI"],
        "trae" => &["Trae", "TRAE"],
        "trae-cn" => &["Trae CN", "TRAE CN"],
        "qoder" => &["Qoder"],
        "intellij" => &[
            "IntelliJ IDEA",
            "IntelliJ IDEA CE",
            "IntelliJ IDEA Ultimate",
        ],
        _ => &[],
    }
}

fn editor_cli_name_candidates(editor_id: &str) -> &[&str] {
    match editor_id {
        "cursor" => &["cursor"],
        "windsurf" => &["windsurf"],
        "kiro" => &["kiro"],
        "trae" => &["trae"],
        "trae-cn" => &["trae-cn", "trae"],
        "qoder" => &["qoder"],
        "intellij" => &["idea"],
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
        .and_then(|p| discover_cli_in_bundle(p))
        .or_else(|| {
            editor_cli_name_candidates(editor_id)
                .iter()
                .find_map(|name| find_executable_path(name))
        });
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
    repository_url: String,
    source_url: String,
    branch_hint: Option<String>,
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
        "IntelliJ IDEA" => Ok("intellij".to_string()),
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
    let mut child = Command::new(GIT_BINARY)
        .args(["-C", skill_path])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("执行 git 命令失败: {error}"))?;
    let timeout = Duration::from_secs(GIT_COMMAND_TIMEOUT_SECS);
    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started_at.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "git {} 超时，请检查网络或远端认证后重试。",
                    args.join(" ")
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(format!("等待 git 命令失败: {error}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("读取 git 命令输出失败: {error}"))?;

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
    let refreshed_skill = enrich_skill_with_git_state(&normalize_installed_skill_source_url(
        &installed_skills[skill_index],
    ));
    installed_skills[skill_index] = refreshed_skill.clone();
    save_installed_skills(&installed_skills)?;
    Ok(refreshed_skill)
}

fn refresh_and_persist_local_git_skill(skill_name: &str) -> Result<SkillSummary, String> {
    let (mut installed_skills, skill_index) = find_skill_by_name(skill_name)?;
    let refreshed_skill = enrich_skill_with_local_git_state(&normalize_installed_skill_source_url(
        &installed_skills[skill_index],
    ));
    installed_skills[skill_index] = refreshed_skill.clone();
    save_installed_skills(&installed_skills)?;
    Ok(refreshed_skill)
}

fn refresh_installed_skill_git_state(skill: &SkillSummary) -> SkillSummary {
    let normalized_skill = normalize_installed_skill_source_url(skill);
    let normalized_skill = normalize_skill_tools(&normalized_skill);
    enrich_skill_with_git_state(&normalized_skill)
}

fn map_in_parallel_preserving_order<T, R, F>(items: &[T], concurrency: usize, mapper: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync,
{
    let safe_concurrency = concurrency.max(1);
    let mut mapped_items = Vec::with_capacity(items.len());
    for chunk in items.chunks(safe_concurrency) {
        let chunk_results = thread::scope(|scope| {
            let handles = chunk
                .iter()
                .map(|item| {
                    let mapper = &mapper;
                    scope.spawn(move || mapper(item))
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| {
                    handle
                        .join()
                        .expect("parallel refresh worker should finish")
                })
                .collect::<Vec<_>>()
        });
        mapped_items.extend(chunk_results);
    }
    mapped_items
}

fn refresh_installed_skill_git_states(skills: &[SkillSummary]) -> Vec<SkillSummary> {
    map_in_parallel_preserving_order(
        skills,
        REFRESH_GIT_STATES_CONCURRENCY,
        refresh_installed_skill_git_state,
    )
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
    workspace::managed_workspace_root()
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

    let canonical_root = fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(root.trim()));
    Ok(canonical_root.to_string_lossy().to_string())
}

fn open_target_path_for_skill(skill_path: &str) -> String {
    repository_root_path(skill_path).unwrap_or_else(|_| skill_path.to_string())
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

fn path_to_jetbrains_macro(path: &Path) -> String {
    if let Some(home_dir) = env::var_os("HOME") {
        let home_path = PathBuf::from(home_dir);
        if let Ok(relative_path) = path.strip_prefix(&home_path) {
            let relative = relative_path.to_string_lossy();
            if relative.is_empty() {
                return "$USER_HOME$".to_string();
            }

            return format!("$USER_HOME$/{}", relative);
        }
    }

    path.to_string_lossy().to_string()
}

fn xml_escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn insert_trusted_project_path(xml: &str, trusted_path: &str) -> String {
    if xml.contains(&format!("key=\"{}\"", xml_escape_attribute(trusted_path))) {
        return xml.to_string();
    }

    let entry = format!(
        "        <entry key=\"{}\" value=\"true\" />\n",
        xml_escape_attribute(trusted_path)
    );

    if let Some(map_end_index) = xml.find("      </map>") {
        let mut next_xml = xml.to_string();
        next_xml.insert_str(map_end_index, &entry);
        return next_xml;
    }

    if let Some(component_end_index) = xml.find("  </component>") {
        let option = format!(
            "    <option name=\"TRUSTED_PROJECT_PATHS\">\n      <map>\n{}      </map>\n    </option>\n",
            entry
        );
        let mut next_xml = xml.to_string();
        next_xml.insert_str(component_end_index, &option);
        return next_xml;
    }

    format!(
        "<application>\n  <component name=\"Trusted.Paths\">\n    <option name=\"TRUSTED_PROJECT_PATHS\">\n      <map>\n{}      </map>\n    </option>\n  </component>\n</application>\n",
        entry
    )
}

fn remove_trusted_project_paths<F>(xml: &str, should_remove: F) -> String
where
    F: Fn(&str) -> bool,
{
    let mut filtered_lines = Vec::new();
    for line in xml.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("<entry key=\"") {
            let key_start = trimmed.find("key=\"").map(|index| index + 5);
            let key_end =
                key_start.and_then(|start| trimmed[start..].find('"').map(|end| start + end));
            if let (Some(start), Some(end)) = (key_start, key_end) {
                let key = trimmed[start..end]
                    .replace("&quot;", "\"")
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("&amp;", "&");
                if should_remove(&key) {
                    continue;
                }
            }
        }
        filtered_lines.push(line);
    }

    let mut next_xml = filtered_lines.join("\n");
    if xml.ends_with('\n') {
        next_xml.push('\n');
    }
    next_xml
}

fn upsert_trusted_project_path(config_path: &Path, trusted_path: &str) -> Result<(), String> {
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建 IDEA 配置目录失败: {error}"))?;
    }

    let current_xml = if config_path.exists() {
        fs::read_to_string(config_path)
            .map_err(|error| format!("读取 IDEA 信任配置失败: {error}"))?
    } else {
        String::new()
    };
    let next_xml = insert_trusted_project_path(&current_xml, trusted_path);
    if next_xml == current_xml {
        return Ok(());
    }

    fs::write(config_path, next_xml).map_err(|error| format!("写入 IDEA 信任配置失败: {error}"))
}

fn remove_trusted_project_paths_by_prefix(config_path: &Path, prefix: &str) -> Result<(), String> {
    if !config_path.exists() {
        return Ok(());
    }

    let current_xml = fs::read_to_string(config_path)
        .map_err(|error| format!("读取 IDEA 信任配置失败: {error}"))?;
    let next_xml = remove_trusted_project_paths(&current_xml, |path| path.starts_with(prefix));
    if next_xml == current_xml {
        return Ok(());
    }

    fs::write(config_path, next_xml).map_err(|error| format!("写入 IDEA 信任配置失败: {error}"))
}

fn intellij_trusted_locations_for_project(project_path: &Path) -> Vec<PathBuf> {
    if let Ok(managed_skills_root) = workspace::managed_skill_library_root() {
        if project_path.starts_with(&managed_skills_root) {
            return vec![managed_skills_root];
        }
    }

    let mut trusted_locations = Vec::new();
    if project_path.join(".git").exists() {
        trusted_locations.push(project_path.to_path_buf());
    } else {
        trusted_locations.push(project_path.parent().unwrap_or(project_path).to_path_buf());
    }

    trusted_locations
}

fn intellij_config_dirs() -> Result<Vec<PathBuf>, String> {
    let home_dir = env::var_os("HOME").ok_or_else(|| "无法读取 HOME 环境变量".to_string())?;
    let jetbrains_dir = PathBuf::from(home_dir).join("Library/Application Support/JetBrains");
    if !jetbrains_dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&jetbrains_dir)
        .map_err(|error| format!("读取 JetBrains 配置目录失败: {error}"))?;
    let mut config_dirs = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("IntelliJIdea"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    config_dirs.sort();
    Ok(config_dirs)
}

fn ensure_intellij_managed_skills_root_trusted() -> Result<(), String> {
    let managed_skills_root = workspace::managed_skill_library_root()?;
    let managed_skills_root_macro = path_to_jetbrains_macro(&managed_skills_root);
    let managed_skill_prefix = format!("{managed_skills_root_macro}/");
    for config_dir in intellij_config_dirs()? {
        let trusted_paths_path = config_dir.join("options/trusted-paths.xml");
        remove_trusted_project_paths_by_prefix(&trusted_paths_path, &managed_skill_prefix)?;
        upsert_trusted_project_path(&trusted_paths_path, &managed_skills_root_macro)?;
    }

    Ok(())
}

fn trust_intellij_project_path(project_path: &str) -> Result<(), String> {
    let project_path =
        fs::canonicalize(project_path).unwrap_or_else(|_| PathBuf::from(project_path));
    let trusted_paths = intellij_trusted_locations_for_project(&project_path)
        .into_iter()
        .map(|path| path_to_jetbrains_macro(&path))
        .collect::<Vec<_>>();
    for config_dir in intellij_config_dirs()? {
        let trusted_paths_path = config_dir.join("options/trusted-paths.xml");
        for trusted_path in &trusted_paths {
            upsert_trusted_project_path(&trusted_paths_path, trusted_path)?;
        }
    }

    Ok(())
}

fn open_path_with_default_text_editor(path: &str) -> Result<(), String> {
    let output = Command::new("open")
        .args(["-t", path])
        .output()
        .map_err(|error| format!("打开默认文本编辑器失败: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!("打开默认文本编辑器失败: {stderr}"))
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

    // JetBrains' command-line launcher opens projects in a trusted headless flow.
    // Prefer it consistently so IDEA does not fall back to Finder-style open behavior.
    if editor_id == "intellij" {
        if let Some(ref cli_path) = info.cli_path {
            return open_path_with_cli(cli_path, path);
        }
    }

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

fn ensure_text_config_file(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败: {error}"))?;
    }

    if path.exists() {
        return Ok(());
    }

    let initial_content = match path.extension().and_then(|value| value.to_str()) {
        Some("json") => "{}\n",
        _ => "",
    };
    fs::write(path, initial_content).map_err(|error| format!("创建 MCP 配置文件失败: {error}"))
}

fn open_config_file_with_preferred_editor(
    path: &Path,
    editor_id: Option<&str>,
) -> Result<(), String> {
    let path_string = path.to_string_lossy().to_string();
    if let Some(editor_id) = editor_id.map(str::trim).filter(|value| !value.is_empty()) {
        if editor_id != "finder" && open_path_with_editor(&path_string, editor_id).is_ok() {
            return Ok(());
        }
    }

    open_path_with_default_text_editor(&path_string)
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
    let branch_hint = if segments.get(2) == Some(&"tree") && segments.len() > 3 {
        Some(segments[3].to_string())
    } else if segments.get(2) == Some(&"-")
        && segments.get(3) == Some(&"tree")
        && segments.len() > 4
    {
        Some(segments[4].to_string())
    } else {
        None
    };
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
    let repository_url = format!("https://{host}/{owner}/{repo_name}");

    Ok(RepoInstallSpec {
        clone_url,
        repo_key,
        source_type,
        repository_url,
        source_url: normalized,
        branch_hint,
        path_hint,
    })
}

fn build_repo_skill_source_url(spec: &RepoInstallSpec, relative_path: &str) -> String {
    build_tree_source_url(
        &spec.repository_url,
        &spec.source_type,
        spec.branch_hint.as_deref(),
        relative_path,
    )
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
    let current_name = current_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if skill_file.exists() && !is_reserved_workspace_name(current_name) {
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
    if sync_trace_enabled() {
        eprintln!("[sync-trace] command get_workspace_snapshot");
    }
    let _ = remove_reserved_workspace_symlinks_from_all_tools();
    let installed_skills = resolve_installed_skills();

    WorkspaceSnapshot {
        local_candidates: build_local_candidates(&installed_skills),
        installed_skills,
        marketplace_skills: build_marketplace_skills(
            None,
            1,
            MARKETPLACE_FETCH_LIMIT,
            None,
            true,
            false,
        )
        .await,
        tool_configs: build_tool_configs(),
        git_account: build_git_account(),
    }
}

#[tauri::command]
pub async fn list_startup_installed_skills() -> Vec<SkillSummary> {
    if sync_trace_enabled() {
        eprintln!("[sync-trace] command list_startup_installed_skills");
    }
    tauri::async_runtime::spawn_blocking(|| {
        let _ = remove_reserved_workspace_symlinks_from_all_tools();
        resolve_startup_installed_skills()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub fn list_installed_skills() -> Vec<SkillSummary> {
    if sync_trace_enabled() {
        eprintln!("[sync-trace] command list_installed_skills");
    }
    let _ = remove_reserved_workspace_symlinks_from_all_tools();
    resolve_installed_skills()
}

#[tauri::command]
pub async fn list_marketplace_skills(
    source_site: Option<String>,
    page: Option<usize>,
    limit: Option<usize>,
    query: Option<String>,
    refresh: Option<bool>,
) -> Vec<MarketplaceSkill> {
    let page = page.unwrap_or(1).max(1);
    let limit = limit.unwrap_or(MARKETPLACE_FETCH_LIMIT).max(1);
    build_marketplace_skills(
        source_site.as_deref(),
        page,
        limit,
        query.as_deref(),
        true,
        refresh.unwrap_or(false),
    )
    .await
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
    let tool_configs = build_tool_configs();
    if tool_configs
        .iter()
        .any(|tool| tool.id == "intellij" && tool.status_label == "已安装")
    {
        let _ = ensure_intellij_managed_skills_root_trusted();
    }

    tool_configs
}

#[tauri::command]
pub fn get_git_account_summary() -> GitAccountSummary {
    build_git_account()
}

#[tauri::command]
pub fn get_app_settings() -> AppSettings {
    load_app_settings()
}

#[tauri::command]
pub fn update_app_settings(settings: AppSettings) -> Result<AppSettings, String> {
    save_app_settings(settings)
}

#[tauri::command]
pub async fn detect_preferred_app_language() -> Result<AppSettingsLanguageDetection, String> {
    Ok(AppSettingsLanguageDetection {
        language: detect_preferred_app_language_from_system().to_string(),
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsLanguageDetection {
    pub language: String,
}

fn detect_preferred_app_language_from_system() -> &'static str {
    detect_preferred_app_language_from_locale_env()
        .or_else(detect_preferred_app_language_from_apple_languages)
        .unwrap_or("en")
}

fn detect_preferred_app_language_from_locale_env() -> Option<&'static str> {
    let locale_candidates = [
        env::var("LC_ALL").ok(),
        env::var("LC_MESSAGES").ok(),
        env::var("LANG").ok(),
    ];

    locale_candidates
        .into_iter()
        .flatten()
        .find_map(|locale| detect_preferred_app_language_from_locale(&locale))
}

fn detect_preferred_app_language_from_locale(locale: &str) -> Option<&'static str> {
    let normalized_locale = locale.trim().to_lowercase();
    if normalized_locale.is_empty()
        || matches!(normalized_locale.as_str(), "c" | "c.utf-8" | "posix")
    {
        return None;
    }

    if normalized_locale.starts_with("zh") {
        return Some("zh-CN");
    }

    Some("en")
}

fn detect_preferred_app_language_from_apple_languages() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("defaults")
            .args(["read", "-g", "AppleLanguages"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        return parse_apple_languages_output(&stdout);
    }

    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn parse_apple_languages_output(output: &str) -> Option<&'static str> {
    output.lines().find_map(|line| {
        let language = line
            .split('"')
            .nth(1)
            .map(str::trim)
            .filter(|value| !value.is_empty())?;
        detect_preferred_app_language_from_locale(language)
    })
}

#[tauri::command]
pub async fn refresh_git_states() -> Vec<SkillSummary> {
    tauri::async_runtime::spawn_blocking(|| {
        let skills = load_installed_skills(&default_installed_skills());
        let refreshed_skills = refresh_installed_skill_git_states(&skills);
        let _ = save_installed_skills(&refreshed_skills);
        refreshed_skills
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn refresh_local_git_states() -> Vec<SkillSummary> {
    tauri::async_runtime::spawn_blocking(|| {
        let skills = load_installed_skills(&default_installed_skills());
        skills
            .iter()
            .map(normalize_skill_tools)
            .map(|skill| enrich_skill_with_local_git_state(&skill))
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn refresh_local_git_state(skill_name: String) -> Result<SkillSummary, String> {
    tauri::async_runtime::spawn_blocking(move || refresh_and_persist_local_git_skill(&skill_name))
        .await
        .map_err(|error| format!("后台刷新本地 Git 状态失败: {error}"))?
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

    let installed_at = now_timestamp_label();
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
        remote_updated_at: skill.updated_at.clone(),
        local_updated_at: installed_at.clone(),
        last_synced_at: installed_at.clone(),
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
    let normalized_skill = normalize_skill_tools(&installed_skill);
    let git_skill = normalized_skill.clone();
    let git_state_handle =
        thread::spawn(move || enrich_newly_installed_skill_with_git_state(&git_skill));
    let description_handle = thread::spawn(move || {
        if skill_description_path.is_file() {
            Some(read_skill_description(&skill_description_path))
        } else {
            None
        }
    });
    let mut installed_skill = git_state_handle
        .join()
        .unwrap_or_else(|_| enrich_newly_installed_skill_with_git_state(&normalized_skill));
    if let Ok(Some(description)) = description_handle.join() {
        installed_skill.description = description;
    }
    installed_skill = apply_skill_install_activation(installed_skill, &installed_skills)?;
    persist_skill_timestamps(&installed_skill);
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

    let installed_at = now_timestamp_label();
    let mut installed_skills = load_installed_skills(&default_installed_skills());
    let cloned_path = clone_repo_skill(repo_url, repo_name)?;
    let installed_skill = SkillSummary {
        name: repo_name.into(),
        source_label: source_label_for_type(detect_repo_source_type(repo_url)).into(),
        source_type: detect_repo_source_type(repo_url).into(),
        source_url: repo_url.into(),
        description: "从仓库导入的 skill，后续可继续同步和检查更新。".into(),
        local_path: cloned_path,
        branch: "main".into(),
        collab_status: "clean".into(),
        status_text: "仓库已导入，可继续同步到目标工具。".into(),
        remote_updated_at: "刚刚".into(),
        local_updated_at: installed_at.clone(),
        last_synced_at: installed_at.clone(),
        last_checked_at: "刚刚".into(),
        synced_tool_count: 0,
        last_editor: "".into(),
        commit_label: "initial".into(),
        git_linked: true,
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
        let installed_at = now_timestamp_label();
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
            if is_reserved_workspace_name(&skill_name) {
                return Err(format!(
                    "仓库路径 `{selected_path}` 指向内部容器目录，请选择具体的 skill 目录。"
                ));
            }
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
                source_label: source_label_for_type(&spec.source_type).into(),
                source_type: spec.source_type.clone(),
                source_url: build_repo_skill_source_url(&spec, selected_path),
                description,
                local_path,
                branch: "main".into(),
                collab_status: "clean".into(),
                status_text: "仓库技能已导入，可继续同步到目标工具。".into(),
                remote_updated_at: "刚刚".into(),
                local_updated_at: installed_at.clone(),
                last_synced_at: installed_at.clone(),
                last_checked_at: "刚刚".into(),
                synced_tool_count: 0,
                last_editor: "".into(),
                commit_label: "initial".into(),
                git_linked: true,
                tools: vec![],
            };
            let enriched = enrich_newly_installed_skill_with_git_state(&normalize_skill_tools(
                &installed_skill,
            ));
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
pub async fn install_local_skill(
    local_path: String,
    skill_name: Option<String>,
) -> Result<SkillSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_local_skill_blocking(&local_path, skill_name)
    })
    .await
    .map_err(|error| format!("后台安装本地技能失败: {error}"))?
}

#[tauri::command]
pub async fn discover_local_install_skills(
    local_path: String,
) -> Result<Vec<LocalInstallSkillCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        discover_local_install_skills_blocking(&local_path)
    })
    .await
    .map_err(|error| format!("后台识别本地技能失败: {error}"))?
}

#[tauri::command]
pub async fn install_selected_local_skills(
    local_path: String,
    selected_paths: Vec<String>,
) -> Result<Vec<SkillSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if selected_paths.is_empty() {
            return Err("请至少选择一个技能再安装。".into());
        }

        let source_path = PathBuf::from(local_path.trim());
        if !source_path.exists() {
            return Err("本地路径不存在，请检查后重试。".into());
        }

        let (scan_root, cleanup_dir) = resolve_local_install_scan_root(&source_path)?;
        let install_result =
            install_selected_local_skill_dirs(&source_path, &scan_root, &selected_paths);
        if let Some(dir) = cleanup_dir {
            let _ = fs::remove_dir_all(dir);
        }

        install_result
    })
    .await
    .map_err(|error| format!("后台安装本地技能失败: {error}"))?
}

fn install_local_skill_blocking(
    local_path: &str,
    skill_name: Option<String>,
) -> Result<SkillSummary, String> {
    let source_path = PathBuf::from(local_path.trim());
    if !source_path.exists() {
        return Err("本地路径不存在，请检查后重试。".into());
    }

    let (source_dir, cleanup_dir) = resolve_local_install_source(&source_path)?;
    let installed_skill =
        install_local_skill_from_source_dir(&source_path, &source_dir, skill_name)?;

    if let Some(dir) = cleanup_dir {
        let _ = fs::remove_dir_all(dir);
    }

    Ok(installed_skill)
}

fn install_local_skill_from_source_dir(
    source_path: &Path,
    source_dir: &Path,
    skill_name: Option<String>,
) -> Result<SkillSummary, String> {
    let inferred_name = skill_name
        .and_then(|value| normalize_optional_skill_name(&value))
        .or_else(|| read_skill_name(&source_dir.join("SKILL.md")))
        .or_else(|| {
            source_dir
                .file_name()
                .and_then(|value| value.to_str())
                .map(sanitize_storage_name)
        })
        .unwrap_or_else(|| "local-skill".into());
    let target_dir = skill_directory(&inferred_name)
        .map_err(|error| format!("无法确定 skill 安装目录: {error}"))?;
    let cleanup_on_error = !matches!(
        (source_dir.canonicalize(), target_dir.exists().then(|| target_dir.canonicalize())),
        (Ok(source_canonical), Some(Ok(target_canonical))) if source_canonical == target_canonical
    );
    let installed_local_path = copy_local_skill_dir(&source_dir, &target_dir)?;

    let installed_at = now_timestamp_label();
    let skill_file = Path::new(&installed_local_path).join("SKILL.md");
    let description = read_skill_description(&skill_file);
    let installed_skill = SkillSummary {
        name: inferred_name,
        source_label: "本地安装".into(),
        source_type: "local".into(),
        source_url: source_path.to_string_lossy().to_string(),
        description,
        local_path: installed_local_path,
        branch: "local".into(),
        collab_status: "clean".into(),
        status_text: "本地技能已安装，可继续同步到目标工具。".into(),
        remote_updated_at: String::new(),
        local_updated_at: installed_at.clone(),
        last_synced_at: installed_at.clone(),
        last_checked_at: "刚刚".into(),
        synced_tool_count: 0,
        last_editor: "".into(),
        commit_label: "local-only".into(),
        git_linked: false,
        tools: vec![],
    };

    cleanup_local_skill_install_on_error(&target_dir, cleanup_on_error, || {
        let installed_skill = enrich_skill_with_git_state(&normalize_skill_tools(&installed_skill));
        let mut installed_skills = load_installed_skills(&default_installed_skills());
        let installed_skill = apply_skill_install_activation(installed_skill, &installed_skills)?;
        persist_skill_timestamps(&installed_skill);
        installed_skills.retain(|skill| skill.name != installed_skill.name);
        installed_skills.insert(0, installed_skill.clone());
        save_installed_skills(&installed_skills)?;

        Ok(installed_skill)
    })
}

fn discover_local_install_skills_blocking(
    local_path: &str,
) -> Result<Vec<LocalInstallSkillCandidate>, String> {
    let source_path = PathBuf::from(local_path.trim());
    if !source_path.exists() {
        return Err("本地路径不存在，请检查后重试。".into());
    }

    let (scan_root, cleanup_dir) = resolve_local_install_scan_root(&source_path)?;
    let candidates_result = scan_local_install_skill_candidates(&scan_root);

    if let Some(dir) = cleanup_dir {
        let _ = fs::remove_dir_all(dir);
    }

    let candidates = candidates_result?;
    if candidates.is_empty() {
        return Err("未识别到 skill，请选择包含 SKILL.md 的目录或压缩包。".into());
    }

    Ok(candidates)
}

fn install_selected_local_skill_dirs(
    source_path: &Path,
    scan_root: &Path,
    selected_paths: &[String],
) -> Result<Vec<SkillSummary>, String> {
    let mut installed_skills = Vec::new();
    for selected_path in selected_paths {
        let skill_path = resolve_selected_local_skill_path(scan_root, selected_path)?;
        let installed_skill = install_local_skill_from_source_dir(source_path, &skill_path, None)?;
        installed_skills.push(installed_skill);
    }

    Ok(installed_skills)
}

fn resolve_selected_local_skill_path(
    scan_root: &Path,
    selected_path: &str,
) -> Result<PathBuf, String> {
    let normalized_path = selected_path.trim_matches('/');
    if normalized_path.contains("..") {
        return Err("本地技能路径无效，请重新选择。".into());
    }

    let skill_path = scan_root.join(normalized_path);
    let is_valid_skill = skill_path.is_dir() && skill_path.join("SKILL.md").is_file();
    if !is_valid_skill {
        return Err(format!("未找到待安装技能路径: {selected_path}"));
    }

    Ok(skill_path)
}

fn resolve_local_install_scan_root(
    source_path: &Path,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    if source_path.is_dir() {
        return Ok((source_path.to_path_buf(), None));
    }

    if !source_path.is_file() {
        return Err("请选择 skill 文件夹、项目目录或 .zip/.skill 压缩包。".into());
    }

    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "zip" | "skill") {
        return Err("仅支持 skill 文件夹、项目目录、.zip 或 .skill 文件。".into());
    }

    let extract_dir = local_import_extract_dir(source_path)?;
    if extract_dir.exists() {
        fs::remove_dir_all(&extract_dir).map_err(|error| format!("清理导入缓存失败: {error}"))?;
    }
    fs::create_dir_all(&extract_dir).map_err(|error| format!("创建导入缓存失败: {error}"))?;
    extract_skill_archive(source_path, &extract_dir)?;
    Ok((extract_dir.clone(), Some(extract_dir)))
}

fn scan_local_install_skill_candidates(
    scan_root: &Path,
) -> Result<Vec<LocalInstallSkillCandidate>, String> {
    let skill_dirs = collect_local_skill_dirs(scan_root, 0, 4)?;
    let mut candidates = Vec::new();
    for skill_dir in skill_dirs {
        let relative_path = skill_dir
            .strip_prefix(scan_root)
            .map_err(|error| format!("解析本地 skill 路径失败: {error}"))?
            .to_string_lossy()
            .to_string();
        let name = skill_dir
            .file_name()
            .and_then(|value| value.to_str())
            .map(sanitize_storage_name)
            .unwrap_or_else(|| "local-skill".into());
        let skill_file = skill_dir.join("SKILL.md");
        candidates.push(LocalInstallSkillCandidate {
            id: sanitize_storage_name(&if relative_path.is_empty() {
                name.clone()
            } else {
                relative_path.clone()
            }),
            name,
            description: read_skill_description(&skill_file),
            relative_path,
        });
    }
    candidates.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(candidates)
}

fn normalize_optional_skill_name(value: &str) -> Option<String> {
    let normalized = sanitize_storage_name(value.trim());
    if normalized.is_empty() || normalized == "skill" {
        None
    } else {
        Some(normalized)
    }
}

fn resolve_local_install_source(source_path: &Path) -> Result<(PathBuf, Option<PathBuf>), String> {
    if source_path.is_dir() {
        return find_single_local_skill_dir(source_path).map(|path| (path, None));
    }

    if !source_path.is_file() {
        return Err("请选择 skill 文件夹或 .zip/.skill 压缩包。".into());
    }

    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "zip" | "skill") {
        return Err("仅支持 skill 文件夹、.zip 或 .skill 文件。".into());
    }

    let extract_dir = local_import_extract_dir(source_path)?;
    if extract_dir.exists() {
        fs::remove_dir_all(&extract_dir).map_err(|error| format!("清理导入缓存失败: {error}"))?;
    }
    fs::create_dir_all(&extract_dir).map_err(|error| format!("创建导入缓存失败: {error}"))?;
    extract_skill_archive(source_path, &extract_dir)?;
    let skill_dir = find_single_local_skill_dir(&extract_dir)?;
    Ok((skill_dir, Some(extract_dir)))
}

fn local_import_extract_dir(source_path: &Path) -> Result<PathBuf, String> {
    let source_name = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_storage_name)
        .unwrap_or_else(|| "skill".into());
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("生成导入缓存目录失败: {error}"))?
        .as_millis();
    Ok(workspace::managed_workspace_root()?
        .join("imports")
        .join(format!("{source_name}-{timestamp}")))
}

fn extract_skill_archive(archive_path: &Path, target_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path).map_err(|error| format!("打开压缩包失败: {error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("读取压缩包失败: {error}"))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取压缩包条目失败: {error}"))?;
        let Some(enclosed_name) = entry.enclosed_name() else {
            continue;
        };
        let output_path = target_dir.join(enclosed_name);
        if entry.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("创建压缩包目录失败: {error}"))?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建压缩包目录失败: {error}"))?;
        }
        let mut output_file = fs::File::create(&output_path)
            .map_err(|error| format!("写入压缩包文件失败: {error}"))?;
        std::io::copy(&mut entry, &mut output_file)
            .map_err(|error| format!("解压压缩包文件失败: {error}"))?;
    }

    Ok(())
}

fn find_single_local_skill_dir(root: &Path) -> Result<PathBuf, String> {
    let skill_dirs = collect_local_skill_dirs(root, 0, 4)?;
    if skill_dirs.is_empty() {
        return Err("未识别到 skill，请选择包含 SKILL.md 的目录或压缩包。".into());
    }
    if skill_dirs.len() > 1 {
        return Err("该路径包含多个 skill，请选择具体的技能目录。".into());
    }

    Ok(skill_dirs[0].clone())
}

fn collect_local_skill_dirs(
    root: &Path,
    depth: usize,
    max_depth: usize,
) -> Result<Vec<PathBuf>, String> {
    let current_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if root.join("SKILL.md").is_file() && !is_reserved_workspace_name(current_name) {
        return Ok(vec![root.to_path_buf()]);
    }
    if depth >= max_depth {
        return Ok(Vec::new());
    }

    let mut skill_dirs = Vec::new();
    let mut child_paths = fs::read_dir(root)
        .map_err(|error| format!("读取本地路径失败: {error}"))?
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    child_paths.sort();
    for child_path in child_paths {
        let Some(name) = child_path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !child_path.is_dir()
            || name.starts_with('.')
            || matches!(name, "node_modules" | "dist" | "target")
        {
            continue;
        }
        skill_dirs.extend(collect_local_skill_dirs(&child_path, depth + 1, max_depth)?);
    }

    Ok(skill_dirs)
}

fn copy_local_skill_dir(source_dir: &Path, target_dir: &Path) -> Result<String, String> {
    let source_canonical = source_dir
        .canonicalize()
        .map_err(|error| format!("解析本地技能目录失败: {error}"))?;
    if target_dir.exists() {
        let target_canonical = target_dir
            .canonicalize()
            .map_err(|error| format!("解析目标技能目录失败: {error}"))?;
        if source_canonical == target_canonical {
            return Ok(target_dir.to_string_lossy().to_string());
        }
        fs::remove_dir_all(target_dir)
            .map_err(|error| format!("清理旧 skill 目录失败: {error}"))?;
    }
    if let Some(parent) = target_dir.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建 skill 目录失败: {error}"))?;
    }
    let install_result = copy_dir_contents(&source_canonical, target_dir)
        .map(|_| target_dir.to_string_lossy().to_string());
    if install_result.is_err() {
        let _ = fs::remove_dir_all(target_dir);
    }
    install_result
}

fn cleanup_local_skill_install_on_error<T>(
    target_dir: &Path,
    cleanup_on_error: bool,
    install: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let install_result = install();
    if install_result.is_err() && cleanup_on_error {
        let _ = fs::remove_dir_all(target_dir);
    }
    install_result
}

fn copy_dir_contents(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(target_dir).map_err(|error| format!("创建 skill 目录失败: {error}"))?;
    for entry in
        fs::read_dir(source_dir).map_err(|error| format!("读取本地技能目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取本地技能条目失败: {error}"))?;
        let path = entry.path();
        let file_name = entry.file_name();
        if file_name.to_string_lossy() == ".git" {
            continue;
        }
        let target_path = target_dir.join(file_name);
        if path.is_dir() {
            copy_dir_contents(&path, &target_path)?;
        } else {
            fs::copy(&path, &target_path)
                .map_err(|error| format!("复制 skill 文件失败: {error}"))?;
        }
    }
    Ok(())
}

fn read_skill_name(skill_file: &Path) -> Option<String> {
    let content = fs::read_to_string(skill_file).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("name:") {
            let normalized = value.trim().trim_matches('"').trim_matches('\'');
            return normalize_optional_skill_name(normalized);
        }
        if !trimmed.is_empty() && !trimmed.contains(':') {
            return None;
        }
    }
    None
}

#[tauri::command]
pub fn import_local_skill(local_path: &str) -> Result<SkillSummary, String> {
    let source_path = PathBuf::from(local_path.trim());
    if !source_path.is_dir() || !source_path.join("SKILL.md").is_file() {
        return Err("请选择包含 SKILL.md 的本地 skill 目录。".into());
    }

    let skill_name = read_skill_name(&source_path.join("SKILL.md"))
        .or_else(|| {
            source_path
                .file_name()
                .and_then(|value| value.to_str())
                .map(sanitize_storage_name)
        })
        .unwrap_or_else(|| "imported-skill".into());
    let target_dir = skill_directory(&skill_name)
        .map_err(|error| format!("无法确定 skill 安装目录: {error}"))?;
    let cleanup_on_error = !matches!(
        (source_path.canonicalize(), target_dir.exists().then(|| target_dir.canonicalize())),
        (Ok(source_canonical), Some(Ok(target_canonical))) if source_canonical == target_canonical
    );
    let installed_local_path = copy_local_skill_dir(&source_path, &target_dir)?;
    cleanup_local_skill_install_on_error(&target_dir, cleanup_on_error, || {
        let installed_at = now_timestamp_label();
        let mut installed_skills = load_installed_skills(&default_installed_skills());
        let installed_skill = SkillSummary {
            name: skill_name,
            source_label: "本地导入".into(),
            source_type: "local".into(),
            source_url: local_path.into(),
            description: read_skill_description(&Path::new(&installed_local_path).join("SKILL.md")),
            local_path: installed_local_path,
            branch: "local".into(),
            collab_status: "clean".into(),
            status_text: format!("本地技能已复制到 {APP_BRAND_NAME} 并纳入统一管理。"),
            remote_updated_at: String::new(),
            local_updated_at: installed_at.clone(),
            last_synced_at: installed_at.clone(),
            last_checked_at: "刚刚".into(),
            synced_tool_count: 0,
            last_editor: "".into(),
            commit_label: "local-only".into(),
            git_linked: false,
            tools: vec![],
        };

        let installed_skill = enrich_skill_with_git_state(&normalize_skill_tools(&installed_skill));
        let installed_skill = apply_skill_install_activation(installed_skill, &installed_skills)?;
        persist_skill_timestamps(&installed_skill);
        installed_skills.retain(|skill| skill.name != installed_skill.name);
        installed_skills.insert(0, installed_skill.clone());
        save_installed_skills(&installed_skills)?;

        Ok(installed_skill)
    })
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
pub fn push_skill_to_current_branch(skill_name: &str) -> Result<SkillSummary, String> {
    let (installed_skills, skill_index) = find_skill_by_name(skill_name)?;
    let skill = &installed_skills[skill_index];
    let current_branch = current_branch_name(&skill.local_path)?;
    if current_branch == "HEAD" {
        return Err("当前仓库处于 detached HEAD，无法直接推送到当前分支。".into());
    }

    let local_changes = collect_working_tree_changes(&skill.local_path)?;
    if !local_changes.is_empty() {
        run_git_command(&skill.local_path, &["add", "--", "."])?;
        let commit_message = format!("chore: update {}", skill.name);
        run_git_command(
            &skill.local_path,
            &["commit", "-m", &commit_message, "--", "."],
        )?;
    }

    run_git_command(&skill.local_path, &["push", ORIGIN_REMOTE, &current_branch])?;
    refresh_and_persist_skill(skill_name)
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
pub fn open_tool_skills_folder(tool_id: &str) -> Result<(), String> {
    let skills_path = get_tool_skills_path(tool_id)?;
    open_path_with_finder(&skills_path)
}

#[tauri::command]
pub fn open_path_in_finder(path: &str) -> Result<(), String> {
    let normalized_path = path.trim();
    if normalized_path.is_empty() {
        return Err("路径不能为空。".into());
    }

    open_path_with_finder(normalized_path)
}

#[tauri::command]
pub fn open_tool_mcp_config(tool_id: &str, editor_id: Option<String>) -> Result<(), String> {
    let home_dir = env::var("HOME").map_err(|error| format!("读取 HOME 失败: {error}"))?;
    let config_path = mcp_config_path_for_tool(tool_id, &PathBuf::from(home_dir));
    if config_path.as_os_str().is_empty() {
        return Err("暂未识别该工具的 MCP 配置文件。".into());
    }

    ensure_text_config_file(&config_path)?;
    open_config_file_with_preferred_editor(&config_path, editor_id.as_deref())
}

#[tauri::command]
pub fn open_skill_in_editor(skill_name: &str, editor_id: &str) -> Result<(), String> {
    let (installed_skills, skill_index) = find_skill_by_name(skill_name)?;
    let skill = &installed_skills[skill_index];
    let target_path = open_target_path_for_skill(&skill.local_path);
    let resolved_target_path = if editor_id == "intellij" {
        fs::canonicalize(&target_path)
            .unwrap_or_else(|_| PathBuf::from(&target_path))
            .to_string_lossy()
            .to_string()
    } else {
        target_path
    };
    if editor_id == "finder" {
        return open_path_with_finder(&resolved_target_path);
    }
    if editor_id == "intellij" {
        trust_intellij_project_path(&resolved_target_path)?;
    }

    open_path_with_editor(&resolved_target_path, editor_id)
}

#[tauri::command]
pub async fn update_skill(skill_name: String) -> Result<SkillSummary, String> {
    tauri::async_runtime::spawn_blocking(move || update_skill_blocking(&skill_name))
        .await
        .map_err(|error| format!("更新任务执行失败: {error}"))?
}

fn update_skill_blocking(skill_name: &str) -> Result<SkillSummary, String> {
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
pub async fn toggle_skill_tool_status(
    skill_name: String,
    tool_name: String,
    tool_names: Vec<String>,
) -> Result<SkillSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        toggle_skill_tool_status_blocking(&skill_name, &tool_name, &tool_names)
    })
    .await
    .map_err(|error| format!("切换 skill 工具状态失败: {error}"))?
}

fn toggle_skill_tool_status_blocking(
    skill_name: &str,
    tool_name: &str,
    tool_names: &[String],
) -> Result<SkillSummary, String> {
    if sync_trace_enabled() {
        eprintln!(
            "[sync-trace] command toggle_skill_tool_status skill_name={skill_name} tool_name={tool_name}"
        );
    }
    let mut installed_skills = load_interactive_installed_skills();
    align_installed_skills_with_known_tools(
        &mut installed_skills,
        &[skill_name.to_string()],
        tool_names,
    );
    let skill_index = installed_skills
        .iter()
        .position(|skill| skill.name == skill_name)
        .ok_or_else(|| format!("未找到技能 {skill_name}"))?;
    let tool_id = tool_name_to_id(tool_name)?;
    let tool_skills_path = get_tool_skills_path(&tool_id)?;
    let is_enabling = installed_skills[skill_index]
        .tools
        .iter()
        .find(|tool| tool.name == tool_name)
        .is_none_or(|tool| !tool_status_is_enabled(&tool.status_label));

    let updated_skill =
        set_skill_tool_enabled_status(&mut installed_skills, skill_name, tool_name, is_enabling)?;
    if is_enabling {
        create_skill_symlink(&updated_skill.local_path, skill_name, &tool_skills_path)?;
    } else {
        remove_skill_symlink(&tool_skills_path, skill_name)?;
        let skill_path = PathBuf::from(&updated_skill.local_path);
        if let Some(legacy_skill_dir_name) = skill_path.file_name().and_then(|name| name.to_str()) {
            if legacy_skill_dir_name != skill_name {
                remove_skill_symlink(&tool_skills_path, legacy_skill_dir_name)?;
            }
        }
    }

    save_installed_skills(&installed_skills)?;
    Ok(installed_skills[skill_index].clone())
}

#[tauri::command]
pub async fn set_tool_skill_statuses(
    tool_name: String,
    skill_names: Vec<String>,
    enabled: bool,
    tool_names: Vec<String>,
) -> Result<Vec<SkillSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_tool_skill_statuses_blocking(&tool_name, skill_names, enabled, &tool_names)
    })
    .await
    .map_err(|error| format!("批量切换 skill 工具状态失败: {error}"))?
}

fn set_tool_skill_statuses_blocking(
    tool_name: &str,
    skill_names: Vec<String>,
    enabled: bool,
    tool_names: &[String],
) -> Result<Vec<SkillSummary>, String> {
    if sync_trace_enabled() {
        eprintln!(
            "[sync-trace] command set_tool_skill_statuses tool_name={tool_name} enabled={enabled} skill_names={skill_names:?}"
        );
    }
    let tool_id = tool_name_to_id(tool_name)?;
    let tool_skills_path = get_tool_skills_path(&tool_id)?;
    let target_skill_names = skill_names
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect::<BTreeSet<_>>();
    if target_skill_names.is_empty() {
        return Ok(resolve_installed_skills());
    }

    let mut installed_skills = load_interactive_installed_skills();
    let target_skill_name_list = target_skill_names.iter().cloned().collect::<Vec<_>>();
    align_installed_skills_with_known_tools(
        &mut installed_skills,
        &target_skill_name_list,
        tool_names,
    );
    let mut updated_skill_names = BTreeSet::new();
    for skill_name in &target_skill_names {
        let updated =
            set_skill_tool_enabled_status(&mut installed_skills, skill_name, tool_name, enabled)?;
        updated_skill_names.insert(updated.name);
        if !enabled {
            remove_skill_symlink(&tool_skills_path, skill_name)?;
            let skill_path = PathBuf::from(&updated.local_path);
            if let Some(legacy_skill_dir_name) =
                skill_path.file_name().and_then(|name| name.to_str())
            {
                if legacy_skill_dir_name != skill_name {
                    remove_skill_symlink(&tool_skills_path, legacy_skill_dir_name)?;
                }
            }
        }
    }

    let enabled_skills = enabled_skills_for_tool(&installed_skills, tool_name);
    reconcile_tool_skill_symlinks(&tool_skills_path, &enabled_skills)?;
    save_installed_skills(&installed_skills)?;

    Ok(installed_skills
        .into_iter()
        .filter(|skill| updated_skill_names.contains(&skill.name))
        .collect())
}

#[tauri::command]
pub async fn set_skill_all_tool_statuses(
    skill_name: String,
    enabled: bool,
    tool_names: Vec<String>,
) -> Result<SkillSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_skill_all_tool_statuses_blocking(&skill_name, enabled, &tool_names)
    })
    .await
    .map_err(|error| format!("批量切换 skill 全部工具状态失败: {error}"))?
}

fn set_skill_all_tool_statuses_blocking(
    skill_name: &str,
    enabled: bool,
    tool_names: &[String],
) -> Result<SkillSummary, String> {
    if sync_trace_enabled() {
        eprintln!(
            "[sync-trace] command set_skill_all_tool_statuses skill_name={skill_name} enabled={enabled}"
        );
    }

    let mut installed_skills = load_interactive_installed_skills();
    align_installed_skills_with_known_tools(
        &mut installed_skills,
        &[skill_name.to_string()],
        tool_names,
    );
    let skill_index = installed_skills
        .iter()
        .position(|skill| skill.name == skill_name)
        .ok_or_else(|| format!("未找到技能 {skill_name}"))?;
    let target_tool_name_set = normalize_known_tool_names(tool_names)
        .into_iter()
        .collect::<BTreeSet<_>>();
    let target_tool_names = installed_skills[skill_index]
        .tools
        .iter()
        .filter(|tool| {
            target_tool_name_set.contains(&tool.name)
                && tool_status_is_enabled(&tool.status_label) != enabled
        })
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();

    if target_tool_names.is_empty() {
        return Ok(installed_skills[skill_index].clone());
    }

    for tool_name in &target_tool_names {
        let tool_id = tool_name_to_id(tool_name)?;
        let tool_skills_path = get_tool_skills_path(&tool_id)?;
        let updated_skill =
            set_skill_tool_enabled_status(&mut installed_skills, skill_name, tool_name, enabled)?;

        if enabled {
            create_skill_symlink(&updated_skill.local_path, skill_name, &tool_skills_path)?;
        } else {
            remove_skill_symlink(&tool_skills_path, skill_name)?;
            let skill_path = PathBuf::from(&updated_skill.local_path);
            if let Some(legacy_skill_dir_name) =
                skill_path.file_name().and_then(|name| name.to_str())
            {
                if legacy_skill_dir_name != skill_name {
                    remove_skill_symlink(&tool_skills_path, legacy_skill_dir_name)?;
                }
            }
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        build_local_candidates, build_repo_skill_source_url, cleanup_local_skill_install_on_error,
        collect_local_skill_dirs, collect_skills_manager_cached_items, collect_skillsmp_items,
        copy_local_skill_dir, detect_preferred_app_language_from_system, import_local_skill,
        insert_trusted_project_path, install_selected_local_skill_dirs,
        intellij_trusted_locations_for_project, load_marketplace_cache_page,
        map_in_parallel_preserving_order, map_skillsmp_items_to_marketplace,
        normalize_installed_skill_source_url, open_target_path_for_skill,
        parse_apple_languages_output, parse_repo_install_spec, parse_skills_sh_homepage_items,
        remove_trusted_project_paths, resolve_startup_installed_skills, save_marketplace_cache,
        scan_local_install_skill_candidates, scan_repo_skill_candidates,
        should_use_skills_sh_homepage_page, REFRESH_GIT_STATES_CONCURRENCY,
    };
    use crate::models::{MarketplaceSkill, SkillSummary, WorkspacePersistence};
    use crate::workspace::TEST_ENV_LOCK;
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(label: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be available")
            .as_nanos();
        let temp_dir = env::temp_dir().join(format!(
            "skilldock-commands-test-{label}-{}-{}",
            std::process::id(),
            timestamp
        ));
        fs::create_dir_all(&temp_dir).expect("create temp test dir");
        temp_dir
    }

    fn run_git_test(current_dir: &PathBuf, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(current_dir)
            .args(args)
            .output()
            .expect("git should run");
        assert!(
            output.status.success(),
            "git command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn prepend_fake_executable_to_path(
        temp_dir: &std::path::Path,
        executable_name: &str,
    ) -> Option<std::ffi::OsString> {
        let fake_bin_dir = temp_dir.join("bin");
        fs::create_dir_all(&fake_bin_dir).expect("create fake bin dir");
        fs::write(fake_bin_dir.join(executable_name), "").expect("write fake executable");

        let original_path = env::var_os("PATH");
        let next_path = if let Some(path) = original_path.as_ref() {
            let mut paths = env::split_paths(path).collect::<Vec<_>>();
            paths.insert(0, fake_bin_dir);
            env::join_paths(paths).expect("join PATH entries")
        } else {
            fake_bin_dir.into_os_string()
        };
        // SAFETY: tests using this helper hold ENV_LOCK and restore PATH before returning.
        unsafe {
            env::set_var("PATH", next_path);
        }
        original_path
    }

    fn restore_env_var(name: &str, original_value: Option<std::ffi::OsString>) {
        if let Some(value) = original_value {
            // SAFETY: tests using this helper hold ENV_LOCK while restoring process env.
            unsafe {
                env::set_var(name, value);
            }
        } else {
            // SAFETY: tests using this helper hold ENV_LOCK while restoring process env.
            unsafe {
                env::remove_var(name);
            }
        }
    }

    #[test]
    fn parallel_map_preserves_order_and_handles_partial_batches() {
        let items = (0..7).collect::<Vec<_>>();
        let active_count = Arc::new(AtomicUsize::new(0));
        let max_active_count = Arc::new(AtomicUsize::new(0));
        let batch_barrier = Arc::new(Barrier::new(REFRESH_GIT_STATES_CONCURRENCY));

        let mapped_items =
            map_in_parallel_preserving_order(&items, REFRESH_GIT_STATES_CONCURRENCY, |item| {
                let active = active_count.fetch_add(1, Ordering::SeqCst) + 1;
                max_active_count.fetch_max(active, Ordering::SeqCst);
                if *item < REFRESH_GIT_STATES_CONCURRENCY {
                    batch_barrier.wait();
                }
                active_count.fetch_sub(1, Ordering::SeqCst);
                item * 10
            });

        assert_eq!(mapped_items, vec![0, 10, 20, 30, 40, 50, 60]);
        assert_eq!(
            max_active_count.load(Ordering::SeqCst),
            REFRESH_GIT_STATES_CONCURRENCY
        );

        let underfilled_items = [1, 2, 3];
        let underfilled_mapped_items = map_in_parallel_preserving_order(
            &underfilled_items,
            REFRESH_GIT_STATES_CONCURRENCY,
            |item| item * 10,
        );

        assert_eq!(underfilled_mapped_items, vec![10, 20, 30]);
    }

    #[test]
    fn local_candidates_mark_real_directory_as_local_file() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_dir = temp_test_dir("local-candidate-real-file-hint");
        let home_dir = temp_dir.join("home");
        let skill_dir = home_dir.join(".cursor/skills/real-skill");
        fs::create_dir_all(&skill_dir).expect("create real skill dir");
        fs::write(skill_dir.join("SKILL.md"), "# real-skill").expect("write skill file");

        let original_home = env::var_os("HOME");
        // SAFETY: this test holds ENV_LOCK and restores HOME before returning.
        unsafe {
            env::set_var("HOME", &home_dir);
        }

        let candidates = build_local_candidates(&[]);

        restore_env_var("HOME", original_home);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].name, "real-skill");
        assert_eq!(candidates[0].source_hint, "本地文件");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn local_candidates_mark_symlink_as_symbolic_link() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_dir = temp_test_dir("local-candidate-symlink-hint");
        let home_dir = temp_dir.join("home");
        let legacy_skill_dir = temp_dir.join("legacy/linked-skill");
        let codex_skills_dir = home_dir.join(".codex/skills");
        let codex_skill_link = codex_skills_dir.join("linked-skill");
        fs::create_dir_all(&legacy_skill_dir).expect("create legacy skill dir");
        fs::create_dir_all(&codex_skills_dir).expect("create codex skills dir");
        fs::write(legacy_skill_dir.join("SKILL.md"), "# linked-skill").expect("write skill file");
        std::os::unix::fs::symlink(&legacy_skill_dir, &codex_skill_link)
            .expect("create skill symlink");

        let original_home = env::var_os("HOME");
        // SAFETY: this test holds ENV_LOCK and restores HOME before returning.
        unsafe {
            env::set_var("HOME", &home_dir);
        }

        let candidates = build_local_candidates(&[]);

        restore_env_var("HOME", original_home);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].name, "linked-skill");
        assert_eq!(candidates[0].source_hint, "符号链接");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn preserves_skills_sh_cache_page_order() {
        let payload = json!({
            "pages": [
                {
                    "page": 2,
                    "response": {
                        "skills": [
                            {
                                "source_name": "skills.sh",
                                "slug": "team/repo/third-skill",
                                "skill_path": "third-skill",
                                "name": "third-skill",
                                "description": "third",
                                "install_count": 9999
                            }
                        ]
                    }
                },
                {
                    "page": 1,
                    "response": {
                        "skills": [
                            {
                                "source_name": "skills.sh",
                                "slug": "team/repo/first-skill",
                                "skill_path": "first-skill",
                                "name": "first-skill",
                                "description": "first",
                                "install_count": 10
                            },
                            {
                                "source_name": "skills.sh",
                                "slug": "team/repo/second-skill",
                                "skill_path": "second-skill",
                                "name": "second-skill",
                                "description": "second",
                                "install_count": 8
                            }
                        ]
                    }
                }
            ]
        });

        let items = collect_skills_manager_cached_items(&payload);
        let names = items
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["first-skill", "second-skill", "third-skill"]);
    }

    #[test]
    fn maps_skillsmp_current_api_payload() {
        let payload = json!({
            "skills": [
                {
                    "id": "openclaw-openclaw-agents-skills-clawsweeper-skill-md",
                    "name": "clawsweeper",
                    "author": "openclaw",
                    "authorAvatar": "https://avatars.githubusercontent.com/u/252820863?v=4",
                    "description": "Use for ClawSweeper work.",
                    "githubUrl": "https://github.com/openclaw/openclaw/tree/main/.agents/skills/clawsweeper",
                    "stars": 370546,
                    "updatedAt": "1778307787"
                }
            ]
        });

        let skills = map_skillsmp_items_to_marketplace(collect_skillsmp_items(&payload));

        assert_eq!(skills.len(), 1);
        assert_eq!(
            skills[0].id,
            "skillsmp-openclaw-openclaw-agents-skills-clawsweeper-skill-md"
        );
        assert_eq!(skills[0].name, "clawsweeper");
        assert_eq!(skills[0].source_site, "skillsmp");
        assert_eq!(skills[0].maintainer, "openclaw");
        assert_eq!(skills[0].popularity_label, "370.5K");
        assert_eq!(skills[0].skill_path, ".agents/skills/clawsweeper");
    }

    #[test]
    fn maps_skillsmp_legacy_or_partial_payload_without_dropping_page() {
        let payload = json!({
            "data": {
                "skills": [
                    {
                        "id": "legacy-id",
                        "name": "legacy-skill",
                        "author_avatar": "",
                        "description": "",
                        "github_url": "https://github.com/team/repo/tree/main/skills/legacy-skill",
                        "stars": "1,024",
                        "updated_at": "2026-05-14"
                    },
                    {
                        "id": "missing-url",
                        "name": "missing-url"
                    }
                ]
            }
        });

        let skills = map_skillsmp_items_to_marketplace(collect_skillsmp_items(&payload));

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "skillsmp-legacy-id");
        assert_eq!(
            skills[0].description,
            "来自 skillsmp 的公开 skill（legacy-skill）"
        );
        assert_eq!(skills[0].maintainer, "team");
        assert_eq!(skills[0].popularity_label, "1.0K");
        assert_eq!(skills[0].avatar_url, None);
    }

    #[test]
    fn marketplace_cache_pages_skillsmp_source() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_dir = temp_test_dir("marketplace-cache-skillsmp");
        let home_dir = temp_dir.join("home");
        fs::create_dir_all(&home_dir).expect("create home dir");
        let original_home = env::var_os("HOME");
        // SAFETY: this test holds ENV_LOCK and restores HOME before returning.
        unsafe {
            env::set_var("HOME", &home_dir);
        }

        let skills = vec![MarketplaceSkill {
            id: "skillsmp-demo".into(),
            name: "demo".into(),
            source_type: "github".into(),
            source_site: "skillsmp".into(),
            description: "cached".into(),
            maintainer: "team".into(),
            updated_at: "2026-05-14".into(),
            install_label: "默认按热度排序".into(),
            source_url: "https://github.com/team/repo/tree/main/skills/demo".into(),
            popularity_label: "1.0K".into(),
            avatar_url: None,
            skill_path: "skills/demo".into(),
        }];

        save_marketplace_cache("skillsmp", &skills);
        let cached = load_marketplace_cache_page("skillsmp", 1, 18).expect("load cache page");

        restore_env_var("HOME", original_home);

        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0].id, "skillsmp-demo");
        assert_eq!(cached[0].source_site, "skillsmp");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn preferred_app_language_follows_system_locale() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let original_lc_all = env::var_os("LC_ALL");
        let original_lc_messages = env::var_os("LC_MESSAGES");
        let original_lang = env::var_os("LANG");

        unsafe {
            env::set_var("LC_ALL", "zh_CN.UTF-8");
            env::remove_var("LC_MESSAGES");
            env::remove_var("LANG");
        }
        assert_eq!(detect_preferred_app_language_from_system(), "zh-CN");

        unsafe {
            env::set_var("LC_ALL", "en_US.UTF-8");
        }
        assert_eq!(detect_preferred_app_language_from_system(), "en");

        unsafe {
            env::remove_var("LC_ALL");
            env::remove_var("LC_MESSAGES");
            env::set_var("LANG", "fr_FR.UTF-8");
        }
        assert_eq!(detect_preferred_app_language_from_system(), "en");

        restore_env_var("LC_ALL", original_lc_all);
        restore_env_var("LC_MESSAGES", original_lc_messages);
        restore_env_var("LANG", original_lang);
    }

    #[test]
    fn parses_apple_languages_output_for_chinese_locale() {
        let output = "(\n    \"zh-Hans-CN\",\n    \"en-US\"\n)\n";

        assert_eq!(parse_apple_languages_output(output), Some("zh-CN"));
    }

    #[test]
    fn parses_apple_languages_output_for_non_chinese_locale() {
        let output = "(\n    \"fr-FR\",\n    \"en-US\"\n)\n";

        assert_eq!(parse_apple_languages_output(output), Some("en"));
    }

    #[test]
    fn parses_skills_sh_homepage_leaderboard_order() {
        let html = r#"
        <main>
          <h2>Skills Leaderboard</h2>
          <div>
            <a href="/vercel-labs/skills/find-skills">
              <div class="lg:col-span-1 text-left"><span>1</span></div>
              <div class="lg:col-span-13 min-w-1 flex flex-col lg:flex-row lg:items-baseline lg:gap-2">
                <h3>find-skills</h3>
                <p>vercel-labs/skills</p>
              </div>
              <div class="lg:col-span-2 text-right flex items-center justify-end gap-2">
                <span class="font-mono text-sm text-foreground">1.4M</span>
              </div>
            </a>
            <a href="/anthropics/skills/frontend-design">
              <div class="lg:col-span-1 text-left"><span>2</span></div>
              <div class="lg:col-span-13 min-w-1 flex flex-col lg:flex-row lg:items-baseline lg:gap-2">
                <h3>frontend-design</h3>
                <p>anthropics/skills</p>
              </div>
              <div class="lg:col-span-2 text-right flex items-center justify-end gap-2">
                <span class="font-mono text-sm text-foreground">380.5K</span>
              </div>
            </a>
            <a href="/vercel-labs/agent-skills/vercel-react-best-practices">
              <div class="lg:col-span-1 text-left"><span>3</span></div>
              <div class="lg:col-span-13 min-w-1 flex flex-col lg:flex-row lg:items-baseline lg:gap-2">
                <h3>vercel-react-best-practices</h3>
                <p>vercel-labs/agent-skills</p>
              </div>
              <div class="lg:col-span-2 text-right flex items-center justify-end gap-2">
                <span class="font-mono text-sm text-foreground">380.3K</span>
              </div>
            </a>
          </div>
        </main>
        "#;

        let items = parse_skills_sh_homepage_items(html);
        let names = items
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>();
        let sources = items
            .iter()
            .map(|item| item.source.as_str())
            .collect::<Vec<_>>();
        let installs = items.iter().map(|item| item.installs).collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "find-skills",
                "frontend-design",
                "vercel-react-best-practices"
            ]
        );
        assert_eq!(
            sources,
            vec![
                "vercel-labs/skills",
                "anthropics/skills",
                "vercel-labs/agent-skills"
            ]
        );
        assert_eq!(installs, vec![1_400_000, 380_500, 380_300]);
    }

    #[test]
    fn falls_back_when_homepage_tail_page_is_short() {
        assert!(should_use_skills_sh_homepage_page(1, 5, 18));
        assert!(should_use_skills_sh_homepage_page(3, 18, 18));
        assert!(!should_use_skills_sh_homepage_page(11, 8, 18));
    }

    #[test]
    fn creates_intellij_trusted_project_paths_config() {
        let xml = insert_trusted_project_path("", "$USER_HOME$/.skilldock/skills");

        assert!(xml.contains("<component name=\"Trusted.Paths\">"));
        assert!(xml.contains("<option name=\"TRUSTED_PROJECT_PATHS\">"));
        assert!(xml.contains("<entry key=\"$USER_HOME$/.skilldock/skills\" value=\"true\" />"));
    }

    #[test]
    fn appends_intellij_trusted_project_path_without_duplicates() {
        let existing_xml = r#"<application>
  <component name="Trusted.Paths">
    <option name="TRUSTED_PROJECT_PATHS">
      <map>
        <entry key="$USER_HOME$/Projects" value="true" />
      </map>
    </option>
  </component>
</application>
"#;

        let xml = insert_trusted_project_path(existing_xml, "$USER_HOME$/.skilldock/skills");
        let duplicate_xml = insert_trusted_project_path(&xml, "$USER_HOME$/.skilldock/skills");

        assert!(xml.contains("<entry key=\"$USER_HOME$/Projects\" value=\"true\" />"));
        assert!(xml.contains("<entry key=\"$USER_HOME$/.skilldock/skills\" value=\"true\" />"));
        assert_eq!(xml, duplicate_xml);
    }

    #[test]
    fn trusts_managed_skill_locations_for_intellij_projects() {
        let home_dir = env::var_os("HOME").expect("HOME should exist in tests");
        let managed_root = PathBuf::from(&home_dir).join(".skilldock/skills");
        let project_path = managed_root.join("drawio-diagram/skills/drawio-diagram");

        assert_eq!(
            intellij_trusted_locations_for_project(&project_path),
            vec![managed_root]
        );
    }

    #[test]
    fn trusts_repo_root_for_non_managed_git_projects() {
        let temp_dir = temp_test_dir("intellij-repo-root");
        let project_path = temp_dir.join("repo");
        fs::create_dir_all(project_path.join(".git")).expect("create .git marker");

        assert_eq!(
            intellij_trusted_locations_for_project(&project_path),
            vec![project_path]
        );
    }

    #[test]
    fn removes_managed_skill_entries_but_keeps_managed_root() {
        let xml = concat!(
            "<application>\n",
            "  <component name=\"Trusted.Paths\">\n",
            "    <option name=\"TRUSTED_PROJECT_PATHS\">\n",
            "      <map>\n",
            "        <entry key=\"$USER_HOME$/.skilldock/skills\" value=\"true\" />\n",
            "        <entry key=\"$USER_HOME$/.skilldock/skills/lark-calendar\" value=\"true\" />\n",
            "        <entry key=\"$USER_HOME$/.skilldock/skills/planning-with-files-zh\" value=\"true\" />\n",
            "        <entry key=\"$USER_HOME$/data/workspace/macos-skill-manager\" value=\"true\" />\n",
            "      </map>\n",
            "    </option>\n",
            "  </component>\n",
            "</application>\n"
        );

        let next_xml = remove_trusted_project_paths(xml, |path| {
            path.starts_with("$USER_HOME$/.skilldock/skills/")
        });

        assert!(next_xml.contains("<entry key=\"$USER_HOME$/.skilldock/skills\" value=\"true\" />"));
        assert!(!next_xml.contains("lark-calendar"));
        assert!(!next_xml.contains("planning-with-files-zh"));
        assert!(next_xml.contains("$USER_HOME$/data/workspace/macos-skill-manager"));
    }

    #[test]
    fn opens_git_repository_root_for_nested_skill_paths() {
        let temp_dir = temp_test_dir("open-target-git-root");
        let repo_path = temp_dir.join("repo");
        fs::create_dir_all(repo_path.join("skills/example-skill"))
            .expect("create nested skill path");

        let status = Command::new("git")
            .args(["init", "--quiet"])
            .arg(&repo_path)
            .status()
            .expect("git init should run");
        assert!(status.success(), "git init should succeed");

        let nested_skill_path = repo_path.join("skills/example-skill");
        let expected_repo_path = fs::canonicalize(&repo_path).expect("canonicalize repo path");
        assert_eq!(
            open_target_path_for_skill(&nested_skill_path.to_string_lossy()),
            expected_repo_path.to_string_lossy()
        );
    }

    #[test]
    fn falls_back_to_skill_path_when_git_root_is_missing() {
        let temp_dir = temp_test_dir("open-target-no-git");
        let skill_path = temp_dir.join("skills/example-skill");
        fs::create_dir_all(&skill_path).expect("create skill path");

        assert_eq!(
            open_target_path_for_skill(&skill_path.to_string_lossy()),
            skill_path.to_string_lossy()
        );
    }

    #[test]
    fn repo_scan_skips_reserved_container_directory() {
        let repo_root = temp_test_dir("repo-scan");
        let reserved_container = repo_root.join("skills");
        let nested_skill = reserved_container.join("multi-search-engine");
        fs::create_dir_all(&nested_skill).expect("create nested skill dir");
        fs::write(reserved_container.join("SKILL.md"), "# skills").expect("write container SKILL");
        fs::write(nested_skill.join("SKILL.md"), "# multi-search-engine")
            .expect("write nested SKILL");

        let candidates = scan_repo_skill_candidates(&repo_root, None).expect("scan repo skills");
        let candidate_paths = candidates
            .into_iter()
            .map(|candidate| candidate.relative_path)
            .collect::<Vec<_>>();

        assert_eq!(
            candidate_paths,
            vec!["skills/multi-search-engine".to_string()]
        );

        let _ = fs::remove_dir_all(repo_root);
    }

    #[test]
    fn local_install_scan_skips_reserved_container_directory() {
        let local_root = temp_test_dir("local-scan");
        let reserved_container = local_root.join("skills");
        let nested_skill = reserved_container.join("subagent-driven-development");
        fs::create_dir_all(&nested_skill).expect("create nested skill dir");
        fs::write(reserved_container.join("SKILL.md"), "# skills").expect("write container SKILL");
        fs::write(
            nested_skill.join("SKILL.md"),
            "# subagent-driven-development",
        )
        .expect("write nested SKILL");

        let skill_dirs =
            collect_local_skill_dirs(&reserved_container, 0, 4).expect("collect local skill dirs");

        assert_eq!(skill_dirs, vec![nested_skill.clone()]);

        let _ = fs::remove_dir_all(local_root);
    }

    #[test]
    fn local_install_scan_returns_project_skill_candidates() {
        let local_root = temp_test_dir("local-project-scan");
        let first_skill = local_root.join("skills/service-observer");
        let second_skill = local_root.join("skills/release-scribe");
        fs::create_dir_all(&first_skill).expect("create first skill dir");
        fs::create_dir_all(&second_skill).expect("create second skill dir");
        fs::write(
            first_skill.join("SKILL.md"),
            "---\nname: service-observer\ndescription: 巡检服务稳定性\n---",
        )
        .expect("write first SKILL");
        fs::write(second_skill.join("SKILL.md"), "# release-scribe").expect("write second SKILL");

        let candidates =
            scan_local_install_skill_candidates(&local_root).expect("scan local candidates");
        let candidate_paths = candidates
            .into_iter()
            .map(|candidate| candidate.relative_path)
            .collect::<Vec<_>>();

        assert_eq!(
            candidate_paths,
            vec![
                "skills/release-scribe".to_string(),
                "skills/service-observer".to_string(),
            ]
        );

        let _ = fs::remove_dir_all(local_root);
    }

    #[test]
    fn local_install_installs_selected_project_skill_dirs() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let home_dir = temp_test_dir("local-project-install-home");
        let local_root = temp_test_dir("local-project-install");
        let skill_dir = local_root.join("skills/service-observer");
        fs::create_dir_all(&skill_dir).expect("create skill dir");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: service-observer\ndescription: 巡检服务稳定性\n---",
        )
        .expect("write skill file");

        let original_home = env::var_os("HOME");
        // SAFETY: this test restores HOME before returning.
        unsafe {
            env::set_var("HOME", &home_dir);
        }

        let installed = install_selected_local_skill_dirs(
            &local_root,
            &local_root,
            &["skills/service-observer".to_string()],
        )
        .expect("install selected local skills");

        if let Some(home) = original_home {
            // SAFETY: restore HOME after this test's isolated mutation.
            unsafe {
                env::set_var("HOME", home);
            }
        } else {
            // SAFETY: restore HOME after this test's isolated mutation.
            unsafe {
                env::remove_var("HOME");
            }
        }

        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].name, "service-observer");
        assert!(home_dir
            .join(".skilldock/skills/service-observer/SKILL.md")
            .is_file());

        let _ = fs::remove_dir_all(home_dir);
        let _ = fs::remove_dir_all(local_root);
    }

    #[cfg(unix)]
    #[test]
    fn local_install_default_activation_replaces_existing_external_symlink() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_dir = temp_test_dir("local-install-default-sync");
        let home_dir = temp_dir.join("home");
        let local_root = temp_dir.join("local-project");
        let skill_dir = local_root.join("skills/service-observer");
        let legacy_skill_dir = temp_dir.join("legacy/service-observer");
        let codex_skills_dir = home_dir.join(".codex/skills");
        let codex_skill_link = codex_skills_dir.join("service-observer");
        fs::create_dir_all(&skill_dir).expect("create local skill dir");
        fs::create_dir_all(&legacy_skill_dir).expect("create legacy skill dir");
        fs::create_dir_all(&codex_skills_dir).expect("create codex skills dir");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: service-observer\ndescription: 巡检服务稳定性\n---",
        )
        .expect("write local skill file");
        fs::write(
            legacy_skill_dir.join("SKILL.md"),
            "# legacy service-observer",
        )
        .expect("write legacy skill file");
        std::os::unix::fs::symlink(&legacy_skill_dir, &codex_skill_link)
            .expect("create existing external symlink");

        let original_home = env::var_os("HOME");
        let original_path = prepend_fake_executable_to_path(&temp_dir, "codex");
        // SAFETY: this test holds ENV_LOCK and restores HOME before returning.
        unsafe {
            env::set_var("HOME", &home_dir);
        }

        let installed = install_selected_local_skill_dirs(
            &local_root,
            &local_root,
            &["skills/service-observer".to_string()],
        )
        .expect("install selected local skill");

        restore_env_var("HOME", original_home);
        restore_env_var("PATH", original_path);

        let managed_skill_dir = home_dir.join(".skilldock/skills/service-observer");
        assert_eq!(installed.len(), 1);
        assert_eq!(
            installed[0].local_path,
            managed_skill_dir.to_string_lossy().to_string()
        );
        assert!(managed_skill_dir.join("SKILL.md").is_file());
        assert_eq!(
            fs::read_link(&codex_skill_link).expect("read codex symlink"),
            managed_skill_dir
        );
        assert!(installed[0]
            .tools
            .iter()
            .any(|tool| { tool.name == "Codex" && tool.status_label == "已启用" }));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn local_import_copies_external_skill_into_skilldock_before_syncing() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_dir = temp_test_dir("local-import-default-sync");
        let home_dir = temp_dir.join("home");
        let legacy_skill_dir = temp_dir.join("legacy/excalidraw-diagram");
        let codex_skills_dir = home_dir.join(".codex/skills");
        let codex_skill_link = codex_skills_dir.join("excalidraw-diagram");
        fs::create_dir_all(&legacy_skill_dir).expect("create legacy skill dir");
        fs::create_dir_all(&codex_skills_dir).expect("create codex skills dir");
        fs::write(
            legacy_skill_dir.join("SKILL.md"),
            "---\nname: excalidraw-diagram\ndescription: 生成手绘图\n---",
        )
        .expect("write legacy skill file");
        std::os::unix::fs::symlink(&legacy_skill_dir, &codex_skill_link)
            .expect("create existing external symlink");

        let original_home = env::var_os("HOME");
        let original_path = prepend_fake_executable_to_path(&temp_dir, "codex");
        // SAFETY: this test holds ENV_LOCK and restores HOME before returning.
        unsafe {
            env::set_var("HOME", &home_dir);
        }

        let imported =
            import_local_skill(codex_skill_link.to_string_lossy().as_ref()).expect("import skill");

        restore_env_var("HOME", original_home);
        restore_env_var("PATH", original_path);

        let managed_skill_dir = home_dir.join(".skilldock/skills/excalidraw-diagram");
        assert_eq!(
            imported.local_path,
            managed_skill_dir.to_string_lossy().to_string()
        );
        assert!(managed_skill_dir.join("SKILL.md").is_file());
        assert_eq!(
            fs::read_link(&codex_skill_link).expect("read codex symlink"),
            managed_skill_dir
        );
        assert!(imported
            .tools
            .iter()
            .any(|tool| { tool.name == "Codex" && tool.status_label == "已启用" }));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn local_import_replaces_existing_tool_directory_with_symlink() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_dir = temp_test_dir("local-import-replace-real-tool-dir");
        let home_dir = temp_dir.join("home");
        let cursor_skill_dir = home_dir.join(".cursor/skills/ahs-persistence");
        fs::create_dir_all(&cursor_skill_dir).expect("create cursor skill dir");
        fs::write(
            cursor_skill_dir.join("SKILL.md"),
            "---\nname: ahs-persistence\ndescription: 持久化助手\n---",
        )
        .expect("write cursor skill file");

        let original_home = env::var_os("HOME");
        let original_path = prepend_fake_executable_to_path(&temp_dir, "cursor");
        // SAFETY: this test holds ENV_LOCK and restores HOME before returning.
        unsafe {
            env::set_var("HOME", &home_dir);
        }

        let imported =
            import_local_skill(cursor_skill_dir.to_string_lossy().as_ref()).expect("import skill");

        restore_env_var("HOME", original_home);
        restore_env_var("PATH", original_path);

        let managed_skill_dir = home_dir.join(".skilldock/skills/ahs-persistence");
        assert_eq!(
            imported.local_path,
            managed_skill_dir.to_string_lossy().to_string()
        );
        assert!(managed_skill_dir.join("SKILL.md").is_file());
        assert!(cursor_skill_dir.is_symlink());
        assert_eq!(
            fs::read_link(&cursor_skill_dir).expect("read cursor symlink"),
            managed_skill_dir
        );
        assert!(imported
            .tools
            .iter()
            .any(|tool| { tool.name == "Cursor" && tool.status_label == "已启用" }));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn local_import_cleans_up_partial_skill_directory_on_failure() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_dir = temp_test_dir("local-import-cleanup-on-failure");
        let home_dir = temp_dir.join("home");
        let legacy_skill_dir = temp_dir.join("legacy/broken-skill");
        let codex_skills_dir = home_dir.join(".codex/skills");
        let codex_skill_link = codex_skills_dir.join("broken-skill");
        fs::create_dir_all(&legacy_skill_dir).expect("create legacy skill dir");
        fs::create_dir_all(&codex_skills_dir).expect("create codex skills dir");
        fs::write(
            legacy_skill_dir.join("SKILL.md"),
            "---\nname: broken-skill\ndescription: 测试失败回滚\n---",
        )
        .expect("write legacy skill file");
        std::os::unix::fs::symlink(&legacy_skill_dir, &codex_skill_link)
            .expect("create existing external symlink");

        let original_home = env::var_os("HOME");
        // SAFETY: this test holds ENV_LOCK and restores HOME before returning.
        unsafe {
            env::set_var("HOME", &home_dir);
        }

        let target_dir = home_dir.join(".skilldock/skills/broken-skill");
        let result: Result<(), String> =
            cleanup_local_skill_install_on_error(&target_dir, true, || {
                let _ = copy_local_skill_dir(&legacy_skill_dir, &target_dir)?;
                Err("forced failure".into())
            });

        restore_env_var("HOME", original_home);

        assert!(result.is_err());
        assert!(!target_dir.exists());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn repo_install_source_url_keeps_branch_hint_from_tree_url() {
        let spec = parse_repo_install_spec(
            "https://github.com/OthmanAdi/planning-with-files/tree/master/skills",
        )
        .expect("parse repo install spec");

        assert_eq!(
            build_repo_skill_source_url(&spec, "skills/planning-with-files-zh"),
            "https://github.com/OthmanAdi/planning-with-files/tree/master/skills/planning-with-files-zh"
        );
    }

    #[test]
    fn keeps_existing_installed_skill_source_url() {
        let temp_dir = temp_test_dir("normalize-source-url");
        let repo_path = temp_dir.join("planning-with-files");
        let skill_path = repo_path.join("skills/planning-with-files-zh");
        fs::create_dir_all(&skill_path).expect("create skill path");
        fs::write(skill_path.join("SKILL.md"), "# planning-with-files-zh")
            .expect("write skill file");

        run_git_test(
            &temp_dir,
            &["init", "--quiet", repo_path.to_str().expect("repo path")],
        );
        run_git_test(&repo_path, &["checkout", "-b", "master"]);
        run_git_test(
            &repo_path,
            &[
                "remote",
                "add",
                "origin",
                "git@github.com:OthmanAdi/planning-with-files.git",
            ],
        );

        let output = Command::new("git")
            .current_dir(&repo_path)
            .args([
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/master",
            ])
            .output()
            .expect("set origin head should run");
        assert!(
            output.status.success(),
            "git symbolic-ref failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        run_git_test(&repo_path, &["config", "user.name", "SkillDock Test"]);
        run_git_test(
            &repo_path,
            &["config", "user.email", "skilldock@example.com"],
        );
        run_git_test(&repo_path, &["add", "."]);
        run_git_test(&repo_path, &["commit", "-m", "init"]);

        let skill = SkillSummary {
            name: "planning-with-files-zh".into(),
            source_label: "GitHub".into(),
            source_type: "github".into(),
            source_url: "https://github.com/OthmanAdi/planning-with-files/tree/main/skills/planning-with-files-zh".into(),
            description: String::new(),
            local_path: skill_path.to_string_lossy().to_string(),
            branch: "master".into(),
            collab_status: "clean".into(),
            status_text: String::new(),
            remote_updated_at: String::new(),
            local_updated_at: String::new(),
            last_synced_at: String::new(),
            last_checked_at: String::new(),
            synced_tool_count: 0,
            last_editor: String::new(),
            commit_label: String::new(),
            git_linked: true,
            tools: vec![],
        };

        let normalized = normalize_installed_skill_source_url(&skill);
        assert_eq!(
            normalized.source_url,
            "https://github.com/OthmanAdi/planning-with-files/tree/main/skills/planning-with-files-zh"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn normalizes_missing_installed_skill_source_url_from_git_remote() {
        let temp_dir = temp_test_dir("normalize-missing-source-url");
        let repo_path = temp_dir.join("larksuite-cli");
        let skill_path = repo_path.join("skills/lark-doc");
        fs::create_dir_all(&skill_path).expect("create skill path");
        fs::write(skill_path.join("SKILL.md"), "# lark-doc").expect("write skill file");

        run_git_test(
            &temp_dir,
            &["init", "--quiet", repo_path.to_str().expect("repo path")],
        );
        run_git_test(&repo_path, &["checkout", "-b", "main"]);
        run_git_test(
            &repo_path,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/larksuite/cli.git",
            ],
        );
        run_git_test(&repo_path, &["config", "user.name", "SkillDock Test"]);
        run_git_test(
            &repo_path,
            &["config", "user.email", "skilldock@example.com"],
        );
        run_git_test(&repo_path, &["add", "."]);
        run_git_test(&repo_path, &["commit", "-m", "init"]);

        let skill = SkillSummary {
            name: "lark-doc".into(),
            source_label: "GitHub".into(),
            source_type: "github".into(),
            source_url: String::new(),
            description: String::new(),
            local_path: skill_path.to_string_lossy().to_string(),
            branch: "main".into(),
            collab_status: "clean".into(),
            status_text: String::new(),
            remote_updated_at: String::new(),
            local_updated_at: String::new(),
            last_synced_at: String::new(),
            last_checked_at: String::new(),
            synced_tool_count: 0,
            last_editor: String::new(),
            commit_label: String::new(),
            git_linked: true,
            tools: vec![],
        };

        let normalized = normalize_installed_skill_source_url(&skill);

        assert_eq!(
            normalized.source_url,
            "https://github.com/larksuite/cli/tree/main/skills/lark-doc"
        );
        assert_eq!(normalized.source_type, "github");
        assert_eq!(normalized.source_label, "GitHub");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn startup_installed_skills_persists_repaired_missing_source_url() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let original_home = env::var_os("HOME");
        let temp_home = temp_test_dir("startup-repair-source-home");
        let repo_path = temp_home.join(".skilldock/skills/larksuite-cli");
        let skill_path = repo_path.join("skills/lark-doc");
        fs::create_dir_all(&skill_path).expect("create skill path");
        fs::write(skill_path.join("SKILL.md"), "# lark-doc").expect("write skill file");

        run_git_test(
            &temp_home,
            &["init", "--quiet", repo_path.to_str().expect("repo path")],
        );
        run_git_test(&repo_path, &["checkout", "-b", "main"]);
        run_git_test(
            &repo_path,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/larksuite/cli.git",
            ],
        );
        run_git_test(&repo_path, &["config", "user.name", "SkillDock Test"]);
        run_git_test(
            &repo_path,
            &["config", "user.email", "skilldock@example.com"],
        );
        run_git_test(&repo_path, &["add", "."]);
        run_git_test(&repo_path, &["commit", "-m", "init"]);

        let state_file = temp_home.join(".skilldock/state.json");
        fs::create_dir_all(state_file.parent().expect("state parent exists"))
            .expect("create state parent");
        let persisted = WorkspacePersistence {
            installed_skills: vec![SkillSummary {
                name: "lark-doc".into(),
                source_label: "GitHub".into(),
                source_type: "github".into(),
                source_url: String::new(),
                description: String::new(),
                local_path: skill_path.to_string_lossy().to_string(),
                branch: "main".into(),
                collab_status: "clean".into(),
                status_text: String::new(),
                remote_updated_at: String::new(),
                local_updated_at: String::new(),
                last_synced_at: String::new(),
                last_checked_at: String::new(),
                synced_tool_count: 0,
                last_editor: String::new(),
                commit_label: String::new(),
                git_linked: true,
                tools: vec![],
            }],
        };
        fs::write(
            &state_file,
            serde_json::to_string_pretty(&persisted).expect("serialize state"),
        )
        .expect("write state file");

        // SAFETY: this test holds TEST_ENV_LOCK and restores HOME before returning.
        unsafe {
            env::set_var("HOME", &temp_home);
        }

        let loaded = resolve_startup_installed_skills();
        let rewritten: WorkspacePersistence =
            serde_json::from_str(&fs::read_to_string(&state_file).expect("read rewritten state"))
                .expect("deserialize rewritten state");

        restore_env_var("HOME", original_home);

        assert_eq!(
            loaded[0].source_url,
            "https://github.com/larksuite/cli/tree/main/skills/lark-doc"
        );
        assert_eq!(
            rewritten.installed_skills[0].source_url,
            "https://github.com/larksuite/cli/tree/main/skills/lark-doc"
        );

        let _ = fs::remove_dir_all(temp_home);
    }
}
