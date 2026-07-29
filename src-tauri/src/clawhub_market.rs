use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::{Client, StatusCode};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::library::sanitize_storage_name;
use crate::models::{
    GitChangeFile, MarketplaceSkill, MarketplaceSkillsPage, SkillFileBrowserSnapshot,
    SkillFileDocument, SkillFileEntry, SkillSummary, UpdatePreviewSnapshot,
};
use crate::workspace;

pub(crate) const SOURCE_SITE: &str = "clawhub";
pub(crate) const SOURCE_LABEL: &str = "ClawHub";
pub(crate) const UPDATE_DRIVER: &str = "clawhub";

const API_BASE_URL: &str = "https://clawhub.ai/api/v1";
const SITE_BASE_URL: &str = "https://clawhub.ai";
const DEFAULT_SORT: &str = "recommended";
const REQUEST_TIMEOUT_SECS: u64 = 20;
const PACKAGE_MAX_DOWNLOAD_BYTES: u64 = 50 * 1024 * 1024;
const PACKAGE_MAX_FILE_COUNT: usize = 1_000;
const PACKAGE_MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
const PACKAGE_MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;
const PREVIEW_FILE_MAX_BYTES: usize = 512 * 1024;
const PACKAGE_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const PACKAGE_CACHE_LIMIT: usize = 8;

type CatalogCursorCache = HashMap<String, BTreeMap<usize, Option<String>>>;

static CURSOR_CACHE: OnceLock<Mutex<CatalogCursorCache>> = OnceLock::new();
static PACKAGE_CACHE: OnceLock<Mutex<HashMap<String, CachedPackage>>> = OnceLock::new();
static TEMP_PATH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct CachedPackage {
    cached_at: Instant,
    package: Arc<SkillPackage>,
}

#[derive(Clone)]
struct SkillPackage {
    files: Vec<PackageFile>,
    content_hash: String,
}

#[derive(Clone)]
struct PackageFile {
    path: String,
    content: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawhubListResponse {
    #[serde(default)]
    items: Vec<ClawhubListItem>,
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawhubListItem {
    slug: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    summary: String,
    description: Option<String>,
    #[serde(default)]
    updated_at: i64,
    #[serde(default)]
    topics: Vec<String>,
    latest_version: Option<ClawhubVersion>,
    stats: Option<ClawhubStats>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawhubVersion {
    #[serde(default)]
    version: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawhubStats {
    #[serde(default)]
    downloads: u64,
}

#[derive(Debug, Deserialize)]
struct ClawhubSearchResponse {
    #[serde(default)]
    results: Vec<ClawhubSearchItem>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawhubSearchItem {
    #[serde(default)]
    slug: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    updated_at: i64,
    version: Option<String>,
    owner: Option<ClawhubOwner>,
    #[serde(default)]
    owner_handle: String,
    #[serde(default)]
    canonical_url: String,
    install: Option<ClawhubInstall>,
    links: Option<ClawhubLinks>,
    native: Option<ClawhubNative>,
}

#[derive(Clone, Debug, Deserialize)]
struct ClawhubNative {
    skill: Option<ClawhubNativeSkill>,
}

#[derive(Clone, Debug, Deserialize)]
struct ClawhubNativeSkill {
    #[serde(default)]
    topics: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawhubInstall {
    source_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct ClawhubLinks {
    source: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawhubOwner {
    #[serde(default)]
    handle: String,
    #[serde(default)]
    display_name: String,
    image: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawhubDetailResponse {
    skill: ClawhubDetailSkill,
    latest_version: Option<ClawhubVersion>,
    owner: Option<ClawhubOwner>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawhubDetailSkill {
    slug: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    summary: String,
    description: Option<String>,
    #[serde(default)]
    updated_at: i64,
    stats: Option<ClawhubStats>,
}

pub(crate) async fn list_page(
    page: usize,
    limit: usize,
    query: Option<&str>,
    refresh: bool,
) -> Result<MarketplaceSkillsPage, String> {
    let normalized_query = query.map(str::trim).filter(|value| !value.is_empty());
    if let Some(query) = normalized_query {
        return search_page(query, page, limit).await;
    }

    list_catalog_page(page, limit, refresh).await
}

async fn list_catalog_page(
    page: usize,
    limit: usize,
    refresh: bool,
) -> Result<MarketplaceSkillsPage, String> {
    let safe_page = page.max(1);
    let safe_limit = limit.clamp(1, 100);
    if refresh && safe_page == 1 {
        reset_catalog_cursors();
    }
    let cursor = resolve_catalog_cursor(safe_page, safe_limit).await?;
    let response = fetch_catalog_page(safe_limit, cursor.as_deref()).await?;
    record_catalog_cursor(safe_limit, safe_page + 1, response.next_cursor.clone());
    let skills = response.items.into_iter().map(map_list_item).collect();

    Ok(MarketplaceSkillsPage {
        skills,
        has_more: response.next_cursor.is_some(),
    })
}

async fn search_page(
    query: &str,
    page: usize,
    limit: usize,
) -> Result<MarketplaceSkillsPage, String> {
    let results = search_skills(query).await?;
    let safe_page = page.max(1);
    let safe_limit = limit.max(1);
    let start = safe_page.saturating_sub(1).saturating_mul(safe_limit);
    let total = results.len();
    let skills = results
        .into_iter()
        .skip(start)
        .take(safe_limit)
        .map(map_search_item)
        .collect();

    Ok(MarketplaceSkillsPage {
        skills,
        has_more: start.saturating_add(safe_limit) < total,
    })
}

async fn resolve_catalog_cursor(page: usize, limit: usize) -> Result<Option<String>, String> {
    if page == 1 {
        record_catalog_cursor(limit, 1, None);
        return Ok(None);
    }
    if let Some(cursor) = cached_catalog_cursor(limit, page) {
        let cursor = cursor.ok_or_else(|| "ClawHub 已没有更多 Skill".to_string())?;
        return Ok(Some(cursor));
    }

    let (mut current_page, mut cursor) = nearest_catalog_cursor(limit, page);
    while current_page < page {
        let response = fetch_catalog_page(limit, cursor.as_deref()).await?;
        current_page += 1;
        cursor = response.next_cursor;
        record_catalog_cursor(limit, current_page, cursor.clone());
        if cursor.is_none() && current_page < page {
            return Err("ClawHub 已没有更多 Skill".to_string());
        }
    }
    let cursor = cursor.ok_or_else(|| "ClawHub 已没有更多 Skill".to_string())?;
    Ok(Some(cursor))
}

async fn fetch_catalog_page(
    limit: usize,
    cursor: Option<&str>,
) -> Result<ClawhubListResponse, String> {
    let client = http_client()?;
    let request = build_catalog_request(&client, limit, cursor);
    send_json(request, "加载 ClawHub Skill").await
}

fn build_catalog_request(
    client: &Client,
    limit: usize,
    cursor: Option<&str>,
) -> reqwest::RequestBuilder {
    let mut request = client.get(format!("{API_BASE_URL}/skills")).query(&[
        ("limit", limit.to_string()),
        ("sort", DEFAULT_SORT.to_string()),
        ("nonSuspiciousOnly", "true".to_string()),
    ]);
    if let Some(cursor) = cursor {
        request = request.query(&[("cursor", cursor)]);
    }
    request
}

async fn search_skills(query: &str) -> Result<Vec<ClawhubSearchItem>, String> {
    let client = http_client()?;
    let request = build_search_request(&client, query);
    let response: ClawhubSearchResponse = send_json(request, "搜索 ClawHub Skill").await?;
    Ok(response.results)
}

fn build_search_request(client: &Client, query: &str) -> reqwest::RequestBuilder {
    client
        .get(format!("{API_BASE_URL}/search"))
        .query(&[("q", query), ("nonSuspiciousOnly", "true")])
}

fn map_list_item(item: ClawhubListItem) -> MarketplaceSkill {
    let slug = item.slug.trim().to_string();
    let version = item
        .latest_version
        .map(|value| value.version)
        .unwrap_or_default();
    let name = non_empty(item.display_name, &slug);
    let description = non_empty(
        item.summary,
        item.description.as_deref().unwrap_or_default(),
    );
    let updated_at = format_remote_time(item.updated_at);
    let popularity_label = compact_number(item.stats.map(|stats| stats.downloads).unwrap_or(0));
    let topic_label = first_topic(&item.topics);
    let marketplace_url = format!("{SITE_BASE_URL}/skills/{slug}");

    MarketplaceSkill {
        id: format!("clawhub-{slug}"),
        name,
        source_type: "well-known".to_string(),
        source_site: SOURCE_SITE.to_string(),
        description,
        maintainer: String::new(),
        updated_at,
        install_label: version_label(&version),
        source_url: marketplace_url.clone(),
        popularity_label,
        topic_label,
        avatar_url: None,
        skill_path: String::new(),
        marketplace_url,
        owner: String::new(),
        slug,
        version,
        install_driver: UPDATE_DRIVER.to_string(),
    }
}

fn map_search_item(item: ClawhubSearchItem) -> MarketplaceSkill {
    let topic_label = item
        .native
        .as_ref()
        .and_then(|native| native.skill.as_ref())
        .map(|skill| first_topic(&skill.topics))
        .unwrap_or_default();
    let owner = item
        .owner
        .as_ref()
        .map(|value| value.handle.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(item.owner_handle.trim())
        .to_string();
    let slug = item.slug.trim().to_string();
    let canonical_path = if item.canonical_url.trim().is_empty() {
        canonical_skill_path(&owner, &slug)
    } else {
        item.canonical_url.trim().to_string()
    };
    let marketplace_url = absolute_clawhub_url(&canonical_path);
    let git_source = search_item_git_source(&item);
    let install_driver = if git_source.is_some() {
        "git"
    } else {
        UPDATE_DRIVER
    };
    let source_url = git_source.unwrap_or_else(|| marketplace_url.clone());
    let maintainer = item
        .owner
        .as_ref()
        .map(|value| non_empty(value.display_name.clone(), &owner))
        .unwrap_or_else(|| non_empty(owner.clone(), SOURCE_LABEL));
    let avatar_url = item.owner.and_then(|value| value.image);
    let name = non_empty(item.display_name, &slug);

    MarketplaceSkill {
        id: format!("clawhub-{owner}-{slug}"),
        name,
        source_type: source_type_for_url(&source_url).to_string(),
        source_site: SOURCE_SITE.to_string(),
        description: item.summary.trim().to_string(),
        maintainer,
        updated_at: format_remote_time(item.updated_at),
        install_label: version_label(item.version.as_deref().unwrap_or_default()),
        source_url,
        popularity_label: compact_number(item.downloads),
        topic_label,
        avatar_url,
        skill_path: String::new(),
        marketplace_url,
        owner,
        slug,
        version: item.version.unwrap_or_default(),
        install_driver: install_driver.to_string(),
    }
}

fn first_topic(topics: &[String]) -> String {
    topics
        .iter()
        .map(|topic| topic.trim())
        .find(|topic| !topic.is_empty())
        .unwrap_or_default()
        .to_string()
}

pub(crate) async fn hydrate_skill(mut skill: MarketplaceSkill) -> Result<MarketplaceSkill, String> {
    let slug = resolve_slug(&skill)?;
    let search_match = find_exact_search_match(&slug, &skill.owner).await?;
    let resolved_owner = search_match
        .as_ref()
        .map(search_item_owner)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| skill.owner.trim().to_string());
    let detail = fetch_detail(&slug, optional_text(&resolved_owner)).await?;
    let owner = detail
        .owner
        .as_ref()
        .map(|value| value.handle.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(resolved_owner.as_str())
        .to_string();
    let version = detail
        .latest_version
        .as_ref()
        .map(|value| value.version.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(skill.version.trim())
        .to_string();
    if version.is_empty() {
        return Err(format!("ClawHub Skill {slug} 未返回可安装版本"));
    }

    let git_source = search_match.as_ref().and_then(search_item_git_source);
    let marketplace_url = search_match
        .as_ref()
        .map(|item| absolute_clawhub_url(&item.canonical_url))
        .filter(|value| value != SITE_BASE_URL)
        .unwrap_or_else(|| absolute_clawhub_url(&canonical_skill_path(&owner, &slug)));
    let install_driver = if git_source.is_some() {
        "git"
    } else {
        UPDATE_DRIVER
    };
    let source_url = git_source.unwrap_or_else(|| marketplace_url.clone());
    let detail_name = non_empty(detail.skill.display_name, &slug);
    let detail_description = non_empty(
        detail.skill.summary,
        detail.skill.description.as_deref().unwrap_or_default(),
    );

    skill.id = format!("clawhub-{owner}-{slug}");
    skill.name = non_empty(detail_name, &skill.name);
    skill.description = non_empty(detail_description, &skill.description);
    skill.maintainer = detail
        .owner
        .as_ref()
        .map(|value| non_empty(value.display_name.clone(), &owner))
        .unwrap_or_else(|| non_empty(owner.clone(), SOURCE_LABEL));
    skill.avatar_url = detail.owner.as_ref().and_then(|value| value.image.clone());
    skill.updated_at = format_remote_time(detail.skill.updated_at);
    skill.popularity_label = compact_number(
        detail
            .skill
            .stats
            .as_ref()
            .map(|stats| stats.downloads)
            .unwrap_or(0),
    );
    skill.install_label = version_label(&version);
    skill.source_type = source_type_for_url(&source_url).to_string();
    skill.source_url = source_url;
    skill.marketplace_url = marketplace_url;
    skill.owner = owner;
    skill.slug = detail.skill.slug;
    skill.version = version;
    skill.install_driver = install_driver.to_string();
    Ok(skill)
}

pub(crate) async fn hydrate_skill_metadata(
    mut skill: MarketplaceSkill,
) -> Result<MarketplaceSkill, String> {
    let slug = resolve_slug(&skill)?;
    let detail = fetch_detail(&slug, optional_text(&skill.owner)).await?;
    let owner = detail
        .owner
        .as_ref()
        .map(|value| value.handle.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("ClawHub Skill {slug} 未返回作者"))?
        .to_string();
    let version = detail
        .latest_version
        .as_ref()
        .map(|value| value.version.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(skill.version.trim())
        .to_string();

    skill.id = format!("clawhub-{owner}-{slug}");
    skill.name = non_empty(detail.skill.display_name, &skill.name);
    skill.description = non_empty(detail.skill.summary, &skill.description);
    skill.maintainer = detail
        .owner
        .as_ref()
        .map(|value| non_empty(value.display_name.clone(), &owner))
        .unwrap_or_else(|| owner.clone());
    skill.avatar_url = detail.owner.and_then(|value| value.image);
    skill.marketplace_url = absolute_clawhub_url(&canonical_skill_path(&owner, &slug));
    skill.owner = owner;
    skill.slug = detail.skill.slug;
    skill.version = version;
    Ok(skill)
}

async fn find_exact_search_match(
    slug: &str,
    owner: &str,
) -> Result<Option<ClawhubSearchItem>, String> {
    let results = search_skills(slug).await?;
    Ok(resolve_preferred_slug_match(results, slug, owner))
}

async fn fetch_detail(slug: &str, owner: Option<&str>) -> Result<ClawhubDetailResponse, String> {
    let client = http_client()?;
    let mut request = client.get(format!("{API_BASE_URL}/skills/{slug}"));
    if let Some(owner) = owner {
        request = request.query(&[("owner", owner)]);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("加载 ClawHub Skill 详情失败: {error}"))?;
    if response.status() == StatusCode::CONFLICT && owner.is_none() {
        let matched = resolve_preferred_slug_match(search_skills(slug).await?, slug, "")
            .ok_or_else(|| format!("ClawHub Skill {slug} 未返回可确认作者的搜索结果"))?;
        let resolved_owner = search_item_owner(&matched);
        if resolved_owner.is_empty() {
            return Err(format!("ClawHub Skill {slug} 存在同名条目，无法确认作者"));
        }
        return Box::pin(fetch_detail(slug, Some(&resolved_owner))).await;
    }
    parse_json_response(response, "加载 ClawHub Skill 详情").await
}

fn resolve_preferred_slug_match(
    results: Vec<ClawhubSearchItem>,
    slug: &str,
    owner: &str,
) -> Option<ClawhubSearchItem> {
    let matches = results
        .into_iter()
        .filter(|item| item.slug.trim() == slug)
        .collect::<Vec<_>>();
    if !owner.trim().is_empty() {
        return matches
            .into_iter()
            .find(|item| search_item_owner(item) == owner.trim());
    }
    matches.into_iter().max_by_key(|item| item.downloads)
}

pub(crate) async fn get_file_browser(
    owner: &str,
    slug: &str,
    version: &str,
    skill_name: &str,
) -> Result<SkillFileBrowserSnapshot, String> {
    let coordinates = resolve_coordinates(owner, slug, version).await?;
    let package = load_package(&coordinates.0, &coordinates.1, &coordinates.2).await?;
    let mut directories = BTreeSet::new();
    let mut entries = vec![SkillFileEntry {
        path: String::new(),
        name: skill_name.to_string(),
        entry_type: "directory".to_string(),
        depth: 0,
    }];
    for file in &package.files {
        let segments = file.path.split('/').collect::<Vec<_>>();
        for end in 1..segments.len() {
            directories.insert(segments[..end].join("/"));
        }
    }
    entries.extend(directories.into_iter().map(|path| SkillFileEntry {
        name: path.rsplit('/').next().unwrap_or(&path).to_string(),
        depth: path.split('/').count(),
        path,
        entry_type: "directory".to_string(),
    }));
    entries.extend(package.files.iter().map(|file| {
        SkillFileEntry {
            name: file
                .path
                .rsplit('/')
                .next()
                .unwrap_or(&file.path)
                .to_string(),
            depth: file.path.split('/').count(),
            path: file.path.clone(),
            entry_type: "file".to_string(),
        }
    }));
    entries[1..].sort_by(|left, right| {
        left.path
            .to_lowercase()
            .cmp(&right.path.to_lowercase())
            .then_with(|| left.entry_type.cmp(&right.entry_type))
    });
    let initial_file_path = entries
        .iter()
        .find(|entry| entry.path.eq_ignore_ascii_case("SKILL.md"))
        .or_else(|| entries.iter().find(|entry| entry.entry_type == "file"))
        .map(|entry| entry.path.clone());

    Ok(SkillFileBrowserSnapshot {
        skill_name: skill_name.to_string(),
        root_name: skill_name.to_string(),
        entries,
        initial_file_path,
    })
}

pub(crate) async fn get_file_content(
    owner: &str,
    slug: &str,
    version: &str,
    relative_path: &str,
) -> Result<SkillFileDocument, String> {
    let relative_path = normalize_relative_path(relative_path)?;
    let coordinates = resolve_coordinates(owner, slug, version).await?;
    let package = load_package(&coordinates.0, &coordinates.1, &coordinates.2).await?;
    let file = package
        .files
        .iter()
        .find(|file| file.path == relative_path)
        .ok_or_else(|| "ClawHub Skill 文件不存在或路径无效".to_string())?;
    if file.content.len() > PREVIEW_FILE_MAX_BYTES {
        return Err("文件超过 512 KB，暂不支持在线预览".to_string());
    }
    let content = String::from_utf8(file.content.clone())
        .map_err(|_| "该文件不是可预览的文本文件".to_string())?;
    Ok(SkillFileDocument {
        path: relative_path,
        content,
    })
}

pub(crate) async fn install_skill(skill: MarketplaceSkill) -> Result<SkillSummary, String> {
    if skill.install_driver == "git" {
        return Err("ClawHub Skill 已解析为 Git 来源，应使用 Git 安装流程".to_string());
    }
    let package = load_package(&skill.owner, &skill.slug, &skill.version).await?;
    let target = workspace::managed_skill_library_root()?.join(sanitize_storage_name(&skill.name));
    if fs::symlink_metadata(&target).is_ok() {
        return Err("本地已存在同名 Skill，请先确认来源或重命名".to_string());
    }
    install_package_at(&target, package.as_ref())?;

    Ok(build_installed_skill(
        &skill,
        &target,
        &package.content_hash,
    ))
}

pub(crate) async fn preview_installed_skill_update(
    skill: SkillSummary,
) -> Result<UpdatePreviewSnapshot, String> {
    let (owner, slug) = installed_coordinates(&skill)?;
    let detail = fetch_detail(&slug, optional_text(&owner)).await?;
    let version = detail
        .latest_version
        .map(|value| value.version)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("ClawHub Skill {slug} 未返回最新版本"))?;
    let resolved_owner = detail
        .owner
        .map(|value| value.handle)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(owner);
    let package = load_package(&resolved_owner, &slug, &version).await?;
    let local_path = PathBuf::from(&skill.local_path);
    let local_files = collect_local_files(&local_path)?;
    let changed_files = build_update_changes(&local_files, &package.files);
    let local_hash = hash_package_files(&local_files);

    Ok(UpdatePreviewSnapshot {
        current_branch: skill.commit_label,
        remote_branch: format!("clawhub/{resolved_owner}/{slug}@{version}"),
        commits_to_pull: 0,
        changed_files,
        has_local_changes: !skill.instance.marketplace_content_hash.trim().is_empty()
            && local_hash != skill.instance.marketplace_content_hash,
    })
}

pub(crate) async fn update_installed_skill(
    mut skill: SkillSummary,
) -> Result<SkillSummary, String> {
    let (owner, slug) = installed_coordinates(&skill)?;
    let detail = fetch_detail(&slug, optional_text(&owner)).await?;
    let version = detail
        .latest_version
        .as_ref()
        .map(|value| value.version.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("ClawHub Skill {slug} 未返回最新版本"))?
        .to_string();
    let resolved_owner = detail
        .owner
        .as_ref()
        .map(|value| value.handle.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(owner.as_str())
        .to_string();
    let package = load_package(&resolved_owner, &slug, &version).await?;
    let target = PathBuf::from(&skill.local_path);
    replace_package_at(&target, package.as_ref())?;
    let now = now_timestamp_label();

    skill.description = non_empty(detail.skill.summary, &skill.description);
    skill.source_label = SOURCE_LABEL.to_string();
    skill.source_type = "well-known".to_string();
    skill.source_url = absolute_clawhub_url(&canonical_skill_path(&resolved_owner, &slug));
    skill.remote_updated_at = format_remote_time(detail.skill.updated_at);
    skill.local_updated_at = now.clone();
    skill.last_synced_at = now;
    skill.last_checked_at = "刚刚检查".to_string();
    skill.last_editor = detail
        .owner
        .as_ref()
        .map(|value| non_empty(value.display_name.clone(), &resolved_owner))
        .unwrap_or_else(|| non_empty(resolved_owner.clone(), SOURCE_LABEL));
    skill.commit_label = version.clone();
    skill.collab_status = "clean".to_string();
    skill.status_text = "已更新到 ClawHub 最新版本，建议同步到常用工具。".to_string();
    skill.git_linked = false;
    skill.instance.update_driver = UPDATE_DRIVER.to_string();
    skill.instance.marketplace_owner = resolved_owner;
    skill.instance.marketplace_slug = slug;
    skill.instance.marketplace_version = version;
    skill.instance.marketplace_content_hash = package.content_hash.clone();
    Ok(skill)
}

pub(crate) async fn refresh_installed_skill_update_states(
    mut skills: Vec<SkillSummary>,
) -> Vec<SkillSummary> {
    for skill in &mut skills {
        if skill.instance.update_driver != UPDATE_DRIVER {
            continue;
        }
        let (owner, slug) = match installed_coordinates(skill) {
            Ok(value) => value,
            Err(error) => {
                log::warn!("ClawHub update check skipped for {}: {error}", skill.name);
                continue;
            }
        };
        let detail = match fetch_detail(&slug, optional_text(&owner)).await {
            Ok(value) => value,
            Err(error) => {
                log::warn!("ClawHub update check failed for {}: {error}", skill.name);
                continue;
            }
        };
        let Some(remote_version) = detail
            .latest_version
            .map(|value| value.version)
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        skill.last_checked_at = "刚刚检查".to_string();
        if remote_version.trim() != skill.commit_label.trim() {
            skill.collab_status = "update-available".to_string();
            skill.status_text = format!("ClawHub 发现新版本 {remote_version}。");
        } else if skill.collab_status == "update-available" {
            skill.collab_status = "clean".to_string();
            skill.status_text = "ClawHub Skill 已是最新版本。".to_string();
        }
    }
    skills
}

pub(crate) fn is_installed_skill(skill: &SkillSummary) -> bool {
    skill.instance.update_driver == UPDATE_DRIVER
}

fn build_installed_skill(
    skill: &MarketplaceSkill,
    target: &Path,
    content_hash: &str,
) -> SkillSummary {
    let now = now_timestamp_label();
    SkillSummary {
        name: skill.name.clone(),
        source_label: SOURCE_LABEL.to_string(),
        source_type: "well-known".to_string(),
        source_url: skill.marketplace_url.clone(),
        description: skill.description.clone(),
        local_path: target.to_string_lossy().to_string(),
        branch: "clawhub".to_string(),
        collab_status: "clean".to_string(),
        status_text: "刚安装完成，建议同步到常用工具。".to_string(),
        remote_updated_at: skill.updated_at.clone(),
        local_updated_at: now.clone(),
        last_synced_at: now,
        last_checked_at: "刚刚".to_string(),
        synced_tool_count: 0,
        last_editor: skill.maintainer.clone(),
        commit_label: skill.version.clone(),
        git_linked: false,
        local_change_count: 0,
        lifecycle_source: String::new(),
        owner_plugin_id: String::new(),
        owner_plugin_name: String::new(),
        instance: crate::models::SkillInstanceMetadata {
            entry_path: target.to_string_lossy().to_string(),
            canonical_path: target.to_string_lossy().to_string(),
            management_owner: "skilldock".to_string(),
            update_driver: UPDATE_DRIVER.to_string(),
            skill_entries: vec![target.to_string_lossy().to_string()],
            path_error: String::new(),
            marketplace_owner: skill.owner.clone(),
            marketplace_slug: skill.slug.clone(),
            marketplace_version: skill.version.clone(),
            marketplace_content_hash: content_hash.to_string(),
        },
        tools: Vec::new(),
    }
}

async fn resolve_coordinates(
    owner: &str,
    slug: &str,
    version: &str,
) -> Result<(String, String, String), String> {
    if slug.trim().is_empty() {
        return Err("ClawHub Skill 缺少 slug".to_string());
    }
    if !version.trim().is_empty() {
        return Ok((
            owner.trim().to_string(),
            slug.trim().to_string(),
            version.trim().to_string(),
        ));
    }
    let detail = fetch_detail(slug.trim(), optional_text(owner)).await?;
    let resolved_owner = detail
        .owner
        .map(|value| value.handle)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("ClawHub Skill {} 未返回作者", slug.trim()))?;
    let resolved_version = detail
        .latest_version
        .map(|value| value.version)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("ClawHub Skill {} 未返回版本", slug.trim()))?;
    Ok((resolved_owner, slug.trim().to_string(), resolved_version))
}

async fn load_package(owner: &str, slug: &str, version: &str) -> Result<Arc<SkillPackage>, String> {
    let cache_key = format!("{owner}/{slug}@{version}");
    if let Some(package) = cached_package(&cache_key) {
        return Ok(package);
    }
    let bytes = download_package(owner, slug, version).await?;
    let package = Arc::new(parse_package(&bytes)?);
    cache_package(cache_key, package.clone());
    Ok(package)
}

async fn download_package(owner: &str, slug: &str, version: &str) -> Result<Vec<u8>, String> {
    let client = http_client()?;
    let mut request = client
        .get(format!("{API_BASE_URL}/download"))
        .query(&[("slug", slug), ("version", version)]);
    if !owner.trim().is_empty() {
        request = request.query(&[("ownerHandle", owner)]);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("下载 ClawHub Skill 失败: {error}"))?;
    if response.status() == StatusCode::CONFLICT && owner.trim().is_empty() {
        let matched = resolve_preferred_slug_match(search_skills(slug).await?, slug, "")
            .ok_or_else(|| format!("ClawHub Skill {slug} 未返回可确认作者的搜索结果"))?;
        let resolved_owner = search_item_owner(&matched);
        if resolved_owner.is_empty() {
            return Err(format!("ClawHub Skill {slug} 存在同名条目，无法确认作者"));
        }
        return Box::pin(download_package(&resolved_owner, slug, version)).await;
    }
    let mut response = ensure_success(response, "下载 ClawHub Skill").await?;
    if response
        .content_length()
        .is_some_and(|length| length > PACKAGE_MAX_DOWNLOAD_BYTES)
    {
        return Err("ClawHub Skill 压缩包超过下载大小限制".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取 ClawHub Skill 压缩包失败: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) as u64 > PACKAGE_MAX_DOWNLOAD_BYTES {
            return Err("ClawHub Skill 压缩包超过下载大小限制".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn parse_package(bytes: &[u8]) -> Result<SkillPackage, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("解析 ClawHub Skill 压缩包失败: {error}"))?;
    if archive.is_empty() || archive.len() > PACKAGE_MAX_FILE_COUNT {
        return Err("ClawHub Skill 压缩包文件数量超出限制".to_string());
    }

    let mut files = Vec::new();
    let mut total_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 ClawHub Skill 压缩包失败: {error}"))?;
        validate_archive_entry(&entry)?;
        if entry.is_dir() {
            continue;
        }
        if entry.size() > PACKAGE_MAX_FILE_BYTES {
            return Err(format!("ClawHub Skill 文件过大：{}", entry.name()));
        }
        let path = normalize_archive_path(entry.name(), entry.enclosed_name())?;
        let mut content = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut content)
            .map_err(|error| format!("读取 ClawHub Skill 文件失败: {error}"))?;
        total_bytes = total_bytes.saturating_add(content.len() as u64);
        if content.len() as u64 > PACKAGE_MAX_FILE_BYTES || total_bytes > PACKAGE_MAX_TOTAL_BYTES {
            return Err("ClawHub Skill 解压后大小超出限制".to_string());
        }
        files.push(PackageFile { path, content });
    }

    normalize_package_root(&mut files);
    files.retain(|file| !is_clawhub_metadata_file(&file.path));
    files.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    if !files
        .iter()
        .any(|file| file.path.eq_ignore_ascii_case("SKILL.md"))
    {
        return Err("ClawHub Skill 压缩包根目录缺少 SKILL.md".to_string());
    }
    let content_hash = hash_package_files(&files);
    Ok(SkillPackage {
        files,
        content_hash,
    })
}

fn validate_archive_entry(entry: &zip::read::ZipFile<'_>) -> Result<(), String> {
    let file_type = entry.unix_mode().map(|mode| mode & 0o170000).unwrap_or(0);
    let allowed =
        file_type == 0 || file_type == 0o100000 || (entry.is_dir() && file_type == 0o040000);
    if !allowed {
        return Err(format!(
            "ClawHub Skill 压缩包不允许链接或特殊文件：{}",
            entry.name()
        ));
    }
    Ok(())
}

fn normalize_archive_path(
    file_name: &str,
    enclosed_path: Option<PathBuf>,
) -> Result<String, String> {
    let path = enclosed_path.ok_or_else(|| format!("ClawHub Skill 包含不安全路径：{file_name}"))?;
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("ClawHub Skill 包含不安全路径：{file_name}"));
    }
    let normalized = path.to_string_lossy().replace('\\', "/");
    if normalized.trim().is_empty() || normalized.contains(':') {
        return Err(format!("ClawHub Skill 包含不安全路径：{file_name}"));
    }
    Ok(normalized)
}

fn normalize_package_root(files: &mut [PackageFile]) {
    let first_segment = files
        .first()
        .and_then(|file| file.path.split('/').next())
        .unwrap_or_default()
        .to_string();
    if first_segment.is_empty()
        || files.iter().any(|file| !file.path.contains('/'))
        || files
            .iter()
            .any(|file| file.path.split('/').next().unwrap_or_default() != first_segment.as_str())
    {
        return;
    }
    let prefix = format!("{first_segment}/");
    if !files
        .iter()
        .any(|file| file.path[prefix.len()..].eq_ignore_ascii_case("SKILL.md"))
    {
        return;
    }
    for file in files {
        file.path = file.path[prefix.len()..].to_string();
    }
}

fn install_package_at(target: &Path, package: &SkillPackage) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "无法定位 ClawHub Skill 托管目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建 Skill 托管目录失败: {error}"))?;
    let temporary = temporary_sibling_path(parent, "install");
    write_package_directory(&temporary, package)?;
    if let Err(error) = fs::rename(&temporary, target) {
        let _ = remove_package_path(&temporary);
        return Err(format!("安装 ClawHub Skill 失败: {error}"));
    }
    Ok(())
}

fn replace_package_at(target: &Path, package: &SkillPackage) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "无法定位 ClawHub Skill 托管目录".to_string())?;
    let temporary = temporary_sibling_path(parent, "update");
    let backup = temporary_sibling_path(parent, "backup");
    write_package_directory(&temporary, package)?;
    let had_existing = fs::symlink_metadata(target).is_ok();
    if had_existing {
        fs::rename(target, &backup).map_err(|error| format!("备份旧 Skill 失败: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, target) {
        if had_existing {
            let _ = fs::rename(&backup, target);
        }
        let _ = remove_package_path(&temporary);
        return Err(format!("替换 ClawHub Skill 目录失败: {error}"));
    }
    if had_existing {
        let _ = remove_package_path(&backup);
    }
    Ok(())
}

fn write_package_directory(target: &Path, package: &SkillPackage) -> Result<(), String> {
    if fs::symlink_metadata(target).is_ok() {
        remove_package_path(target)?;
    }
    fs::create_dir_all(target).map_err(|error| format!("创建 Skill 临时目录失败: {error}"))?;
    for file in &package.files {
        let relative_path = Path::new(&file.path);
        let output_path = target.join(relative_path);
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建 Skill 目录失败: {error}"))?;
        }
        let mut output = fs::File::create(&output_path)
            .map_err(|error| format!("创建 Skill 文件失败: {error}"))?;
        output
            .write_all(&file.content)
            .map_err(|error| format!("写入 Skill 文件失败: {error}"))?;
    }
    if !target.join("SKILL.md").is_file() {
        let _ = remove_package_path(target);
        return Err("ClawHub Skill 根目录缺少 SKILL.md".to_string());
    }
    Ok(())
}

fn collect_local_files(root: &Path) -> Result<Vec<PackageFile>, String> {
    let mut files = Vec::new();
    collect_local_files_from(root, root, &mut files)?;
    files.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    Ok(files)
}

fn collect_local_files_from(
    root: &Path,
    current: &Path,
    files: &mut Vec<PackageFile>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(current)
        .map_err(|error| format!("读取本地 Skill 目录失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取本地 Skill 文件失败: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("读取本地 Skill 文件失败: {error}"))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_local_files_from(root, &path, files)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let relative_path = path
            .strip_prefix(root)
            .map_err(|error| format!("解析本地 Skill 路径失败: {error}"))?
            .to_string_lossy()
            .replace('\\', "/");
        let content =
            fs::read(&path).map_err(|error| format!("读取本地 Skill 文件失败: {error}"))?;
        files.push(PackageFile {
            path: relative_path,
            content,
        });
    }
    Ok(())
}

fn build_update_changes(
    local_files: &[PackageFile],
    remote_files: &[PackageFile],
) -> Vec<GitChangeFile> {
    let local_by_path = local_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let remote_by_path = remote_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let paths = local_by_path
        .keys()
        .chain(remote_by_path.keys())
        .copied()
        .collect::<BTreeSet<_>>();

    paths
        .into_iter()
        .filter_map(|path| {
            let local = local_by_path.get(path).copied();
            let remote = remote_by_path.get(path).copied();
            if local.map(|file| file.content.as_slice())
                == remote.map(|file| file.content.as_slice())
            {
                return None;
            }
            let status = match (local, remote) {
                (None, Some(_)) => "A",
                (Some(_), None) => "D",
                _ => "M",
            };
            Some(GitChangeFile {
                path: path.to_string(),
                status: status.to_string(),
                diff: String::new(),
                staged_diff: String::new(),
                unstaged_diff: String::new(),
                original_content: local.and_then(|file| preview_text(&file.content)),
                current_content: remote.and_then(|file| preview_text(&file.content)),
            })
        })
        .collect()
}

fn hash_package_files(files: &[PackageFile]) -> String {
    let mut digest = Sha256::new();
    for file in files {
        digest.update((file.path.len() as u64).to_be_bytes());
        digest.update(file.path.as_bytes());
        digest.update((file.content.len() as u64).to_be_bytes());
        digest.update(&file.content);
    }
    format!("{:x}", digest.finalize())
}

fn installed_coordinates(skill: &SkillSummary) -> Result<(String, String), String> {
    let owner = skill.instance.marketplace_owner.trim();
    let slug = skill.instance.marketplace_slug.trim();
    if !slug.is_empty() {
        return Ok((owner.to_string(), slug.to_string()));
    }
    parse_coordinates_from_url(&skill.source_url)
        .ok_or_else(|| "ClawHub Skill 缺少 owner/slug 元数据，请重新安装".to_string())
}

fn parse_coordinates_from_url(source_url: &str) -> Option<(String, String)> {
    let parsed = url::Url::parse(source_url.trim()).ok()?;
    if parsed.host_str()? != "clawhub.ai" {
        return None;
    }
    let segments = parsed
        .path_segments()?
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if segments.len() >= 3 && segments[1] == "skills" {
        return Some((segments[0].to_string(), segments[2].to_string()));
    }
    if segments.len() >= 2 && segments[0] == "skills" {
        return Some((String::new(), segments[1].to_string()));
    }
    None
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("SkillDock/1.0 ClawHub marketplace")
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("创建 ClawHub 网络客户端失败: {error}"))
}

async fn send_json<T: DeserializeOwned>(
    request: reqwest::RequestBuilder,
    operation: &str,
) -> Result<T, String> {
    let response = request
        .send()
        .await
        .map_err(|error| format!("{operation}失败: {error}"))?;
    parse_json_response(response, operation).await
}

async fn parse_json_response<T: DeserializeOwned>(
    response: reqwest::Response,
    operation: &str,
) -> Result<T, String> {
    let response = ensure_success(response, operation).await?;
    response
        .json::<T>()
        .await
        .map_err(|error| format!("解析 ClawHub 响应失败: {error}"))
}

async fn ensure_success(
    response: reqwest::Response,
    operation: &str,
) -> Result<reqwest::Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response.text().await.unwrap_or_default();
    let detail = body.chars().take(240).collect::<String>();
    if status == StatusCode::TOO_MANY_REQUESTS {
        let retry_hint = retry_after
            .map(|value| format!("，请在 {value} 秒后重试"))
            .unwrap_or_default();
        return Err(format!("{operation}触发 ClawHub 限流{retry_hint}"));
    }
    if detail.trim().is_empty() {
        Err(format!("{operation}失败: HTTP {status}"))
    } else {
        Err(format!("{operation}失败: HTTP {status}，{detail}"))
    }
}

fn search_item_git_source(item: &ClawhubSearchItem) -> Option<String> {
    let source_url = item
        .install
        .as_ref()
        .and_then(|install| install.source_url.as_deref())
        .or_else(|| {
            item.links
                .as_ref()
                .and_then(|links| links.source.as_deref())
        })?;
    is_supported_git_url(source_url).then(|| source_url.trim().to_string())
}

fn is_supported_git_url(source_url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(source_url.trim()) else {
        return false;
    };
    matches!(
        parsed.host_str().unwrap_or_default(),
        "github.com" | "gitlab.com" | "gitee.com"
    ) && parsed
        .path_segments()
        .is_some_and(|segments| segments.count() >= 2)
}

fn source_type_for_url(source_url: &str) -> &'static str {
    let host = url::Url::parse(source_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_default();
    match host.as_str() {
        "github.com" => "github",
        "gitlab.com" => "gitlab",
        "gitee.com" => "gitee",
        _ => "well-known",
    }
}

fn search_item_owner(item: &ClawhubSearchItem) -> String {
    item.owner
        .as_ref()
        .map(|owner| owner.handle.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(item.owner_handle.trim())
        .to_string()
}

fn resolve_slug(skill: &MarketplaceSkill) -> Result<String, String> {
    if !skill.slug.trim().is_empty() {
        return Ok(skill.slug.trim().to_string());
    }
    parse_coordinates_from_url(&skill.marketplace_url)
        .or_else(|| parse_coordinates_from_url(&skill.source_url))
        .map(|(_, slug)| slug)
        .ok_or_else(|| "ClawHub Skill 缺少 slug".to_string())
}

fn canonical_skill_path(owner: &str, slug: &str) -> String {
    if owner.trim().is_empty() {
        format!("/skills/{slug}")
    } else {
        format!("/{owner}/skills/{slug}")
    }
}

fn absolute_clawhub_url(path: &str) -> String {
    if path.trim().starts_with("http://") || path.trim().starts_with("https://") {
        return path.trim().to_string();
    }
    if path.trim().is_empty() {
        SITE_BASE_URL.to_string()
    } else {
        format!("{SITE_BASE_URL}/{}", path.trim().trim_start_matches('/'))
    }
}

fn normalize_relative_path(path: &str) -> Result<String, String> {
    let normalized = path.trim().replace('\\', "/");
    let relative = Path::new(&normalized);
    if normalized.is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("ClawHub Skill 文件路径无效".to_string());
    }
    Ok(normalized)
}

fn is_clawhub_metadata_file(path: &str) -> bool {
    matches!(path, "_meta.json" | "skill-card.md")
}

fn preview_text(content: &[u8]) -> Option<String> {
    if content.len() > PREVIEW_FILE_MAX_BYTES {
        return None;
    }
    String::from_utf8(content.to_vec()).ok()
}

fn temporary_sibling_path(parent: &Path, purpose: &str) -> PathBuf {
    let sequence = TEMP_PATH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(
        ".skilldock-clawhub-{purpose}-{}-{sequence}",
        std::process::id()
    ))
}

fn remove_package_path(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取临时 Skill 路径失败: {error}")),
    };
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path).map_err(|error| format!("清理临时 Skill 目录失败: {error}"))
    } else {
        fs::remove_file(path).map_err(|error| format!("清理临时 Skill 文件失败: {error}"))
    }
}

fn cursor_cache() -> &'static Mutex<CatalogCursorCache> {
    CURSOR_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn catalog_cursor_key(limit: usize) -> String {
    format!("{DEFAULT_SORT}:safe:{limit}")
}

fn reset_catalog_cursors() {
    if let Ok(mut cache) = cursor_cache().lock() {
        cache.clear();
    }
}

fn record_catalog_cursor(limit: usize, page: usize, cursor: Option<String>) {
    if let Ok(mut cache) = cursor_cache().lock() {
        cache
            .entry(catalog_cursor_key(limit))
            .or_default()
            .insert(page, cursor);
    }
}

fn cached_catalog_cursor(limit: usize, page: usize) -> Option<Option<String>> {
    cursor_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&catalog_cursor_key(limit)).cloned())
        .and_then(|cursors| cursors.get(&page).cloned())
}

fn nearest_catalog_cursor(limit: usize, target_page: usize) -> (usize, Option<String>) {
    let cached = cursor_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&catalog_cursor_key(limit)).cloned())
        .unwrap_or_default();
    cached
        .into_iter()
        .filter(|(page, cursor)| *page < target_page && cursor.is_some())
        .max_by_key(|(page, _)| *page)
        .unwrap_or((1, None))
}

fn package_cache() -> &'static Mutex<HashMap<String, CachedPackage>> {
    PACKAGE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_package(key: &str) -> Option<Arc<SkillPackage>> {
    let mut cache = package_cache().lock().ok()?;
    cache.retain(|_, entry| entry.cached_at.elapsed() < PACKAGE_CACHE_TTL);
    cache.get(key).map(|entry| entry.package.clone())
}

fn cache_package(key: String, package: Arc<SkillPackage>) {
    let Ok(mut cache) = package_cache().lock() else {
        return;
    };
    cache.retain(|_, entry| entry.cached_at.elapsed() < PACKAGE_CACHE_TTL);
    if cache.len() >= PACKAGE_CACHE_LIMIT && !cache.contains_key(&key) {
        if let Some(oldest_key) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.cached_at)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest_key);
        }
    }
    cache.insert(
        key,
        CachedPackage {
            cached_at: Instant::now(),
            package,
        },
    );
}

fn optional_text(value: &str) -> Option<&str> {
    (!value.trim().is_empty()).then_some(value.trim())
}

fn non_empty(value: String, fallback: &str) -> String {
    if value.trim().is_empty() {
        fallback.to_string()
    } else {
        value.trim().to_string()
    }
}

fn version_label(version: &str) -> String {
    if version.trim().is_empty() {
        "ClawHub 托管安装".to_string()
    } else {
        format!("ClawHub {}", version.trim())
    }
}

fn compact_number(value: u64) -> String {
    if value >= 1_000_000 {
        format!("{:.1}M", value as f64 / 1_000_000.0)
    } else if value >= 1_000 {
        format!("{:.1}K", value as f64 / 1_000.0)
    } else {
        value.to_string()
    }
}

fn format_remote_time(timestamp_millis: i64) -> String {
    chrono::DateTime::from_timestamp_millis(timestamp_millis)
        .map(|value| {
            value
                .with_timezone(&chrono::Local)
                .format("%Y/%-m/%-d %H:%M")
                .to_string()
        })
        .unwrap_or_default()
}

fn now_timestamp_label() -> String {
    chrono::Local::now()
        .format("%Y/%-m/%-d %H:%M:%S")
        .to_string()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{Cursor, Write};

    use reqwest::Client;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    use super::{
        build_catalog_request, build_search_request, build_update_changes, cached_catalog_cursor,
        map_list_item, map_search_item, parse_package, record_catalog_cursor, replace_package_at,
        reset_catalog_cursors, resolve_preferred_slug_match, ClawhubListResponse,
        ClawhubSearchItem, PackageFile, SkillPackage,
    };

    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (path, content) in entries {
            writer
                .start_file(path, SimpleFileOptions::default())
                .expect("start zip file");
            writer.write_all(content).expect("write zip file");
        }
        writer.finish().expect("finish zip").into_inner()
    }

    fn request_query(request: reqwest::RequestBuilder) -> Vec<(String, String)> {
        request
            .build()
            .expect("build request")
            .url()
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect()
    }

    fn parse_package_error(bytes: &[u8]) -> String {
        match parse_package(bytes) {
            Ok(_) => panic!("package should be rejected"),
            Err(error) => error,
        }
    }

    #[test]
    fn marketplace_requests_always_enable_non_suspicious_filter() {
        let client = Client::new();

        let catalog_query = request_query(build_catalog_request(&client, 18, Some("next-page")));
        let search_query = request_query(build_search_request(&client, "browser"));

        assert!(catalog_query.contains(&("nonSuspiciousOnly".to_string(), "true".to_string())));
        assert!(catalog_query.contains(&("cursor".to_string(), "next-page".to_string())));
        assert!(search_query.contains(&("nonSuspiciousOnly".to_string(), "true".to_string())));
        assert!(search_query.contains(&("q".to_string(), "browser".to_string())));
    }

    #[test]
    fn catalog_response_accepts_null_description() {
        let response: ClawhubListResponse = serde_json::from_str(
            r#"{
                "items": [{
                    "slug": "self-improving-agent",
                    "displayName": "self-improving agent",
                    "summary": "Captures learnings and corrections.",
                    "description": null,
                    "updatedAt": 1783258083853,
                    "latestVersion": { "version": "4.0.1" },
                    "stats": { "downloads": 471126 }
                }],
                "nextCursor": null
            }"#,
        )
        .expect("parse nullable description");

        assert_eq!(response.items.len(), 1);
        assert!(response.items[0].description.is_none());
    }

    #[test]
    fn catalog_item_does_not_resolve_author_during_browse() {
        let mut response: ClawhubListResponse = serde_json::from_value(serde_json::json!({
            "items": [{
                "slug": "proactive-agent",
                "displayName": "Proactive Agent",
                "summary": "Transform AI agents",
                "description": null,
                "updatedAt": 1785297000000_i64,
                "topics": ["Productivity", "Agents"],
                "latestVersion": { "version": "1.0.0" },
                "stats": { "downloads": 172880 }
            }],
            "nextCursor": null
        }))
        .expect("parse catalog response");
        let item = response.items.pop().expect("catalog item");
        let skill = map_list_item(item);

        assert!(skill.maintainer.is_empty());
        assert!(skill.owner.is_empty());
        assert_eq!(skill.topic_label, "Productivity");
        assert_eq!(skill.id, "clawhub-proactive-agent");
        assert_eq!(
            skill.marketplace_url,
            "https://clawhub.ai/skills/proactive-agent"
        );
    }

    #[test]
    fn catalog_cursors_are_isolated_by_page_size_and_can_be_reset() {
        reset_catalog_cursors();
        record_catalog_cursor(18, 2, Some("cursor-18".to_string()));
        record_catalog_cursor(36, 2, Some("cursor-36".to_string()));

        assert_eq!(
            cached_catalog_cursor(18, 2),
            Some(Some("cursor-18".to_string()))
        );
        assert_eq!(
            cached_catalog_cursor(36, 2),
            Some(Some("cursor-36".to_string()))
        );

        reset_catalog_cursors();
        assert_eq!(cached_catalog_cursor(18, 2), None);
        assert_eq!(cached_catalog_cursor(36, 2), None);
    }

    #[test]
    fn maps_current_clawhub_search_response_and_selects_git_driver() {
        let item = serde_json::from_value(serde_json::json!({
            "slug": "repo-guardian",
            "displayName": "Repo Guardian",
            "summary": "Checks repositories",
            "downloads": 1250,
            "updatedAt": 1785297000000_i64,
            "version": "1.2.0",
            "native": {
                "skill": {
                    "topics": ["Repository", "Security"]
                }
            },
            "owner": {
                "handle": "collab-team",
                "displayName": "Collab Team",
                "image": "https://example.com/avatar.png"
            },
            "canonicalUrl": "/collab-team/skills/repo-guardian",
            "install": {
                "sourceUrl": "https://github.com/collab-team/repo-guardian"
            },
            "links": {
                "source": "https://github.com/collab-team/repo-guardian"
            }
        }))
        .expect("parse search response");

        let skill = map_search_item(item);

        assert_eq!(skill.owner, "collab-team");
        assert_eq!(skill.slug, "repo-guardian");
        assert_eq!(skill.version, "1.2.0");
        assert_eq!(skill.topic_label, "Repository");
        assert_eq!(skill.install_driver, "git");
        assert_eq!(
            skill.source_url,
            "https://github.com/collab-team/repo-guardian"
        );
        assert_eq!(
            skill.marketplace_url,
            "https://clawhub.ai/collab-team/skills/repo-guardian"
        );
    }

    #[test]
    fn prefers_most_downloaded_owner_for_ambiguous_slug() {
        let item = |owner: &str, downloads: u64| -> ClawhubSearchItem {
            serde_json::from_value(serde_json::json!({
                "slug": "shared-skill",
                "downloads": downloads,
                "owner": {
                    "handle": owner
                }
            }))
            .expect("parse search item")
        };

        let result = resolve_preferred_slug_match(
            vec![item("wuzhuhai", 97), item("halthelobster", 172_880)],
            "shared-skill",
            "",
        )
        .expect("select most downloaded skill");

        assert_eq!(
            result.owner.expect("selected owner").handle,
            "halthelobster"
        );
    }

    #[test]
    fn parses_safe_package_and_removes_clawhub_metadata() {
        let bytes = zip_bytes(&[
            ("demo/SKILL.md", b"---\nname: demo\n---\n"),
            ("demo/scripts/run.sh", b"echo ok\n"),
            ("demo/_meta.json", b"{}"),
        ]);

        let package = parse_package(&bytes).expect("parse package");

        assert_eq!(package.files.len(), 2);
        assert_eq!(package.files[0].path, "SKILL.md");
        assert_eq!(package.files[1].path, "scripts/run.sh");
    }

    #[test]
    fn rejects_package_without_skill_manifest() {
        let bytes = zip_bytes(&[("README.md", b"missing manifest")]);

        let error = parse_package_error(&bytes);

        assert!(error.contains("SKILL.md"));
    }

    #[test]
    fn rejects_archive_path_traversal() {
        let bytes = zip_bytes(&[("../SKILL.md", b"unsafe")]);

        let error = parse_package_error(&bytes);

        assert!(error.contains("不安全路径"));
    }

    #[test]
    fn rejects_archive_symlinks() {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .add_symlink("SKILL.md", "target", SimpleFileOptions::default())
            .expect("add symlink entry");
        let bytes = writer.finish().expect("finish zip").into_inner();

        let error = parse_package_error(&bytes);

        assert!(error.contains("链接或特殊文件"));
    }

    #[test]
    fn invalid_update_package_preserves_existing_skill() {
        let sequence = super::TEMP_PATH_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "skilldock-clawhub-update-test-{}-{sequence}",
            std::process::id()
        ));
        let target = directory.join("demo");
        fs::create_dir_all(&target).expect("create target");
        fs::write(target.join("SKILL.md"), "old content").expect("write old skill");
        let invalid_package = SkillPackage {
            files: vec![PackageFile {
                path: "SKILL.md/nested.md".to_string(),
                content: b"invalid root".to_vec(),
            }],
            content_hash: "invalid".to_string(),
        };

        let error = match replace_package_at(&target, &invalid_package) {
            Ok(()) => panic!("invalid update should be rejected"),
            Err(error) => error,
        };

        assert!(error.contains("根目录缺少 SKILL.md"));
        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).expect("read old skill"),
            "old content"
        );
        fs::remove_dir_all(directory).expect("remove temp dir");
    }

    #[test]
    fn builds_added_modified_and_deleted_update_changes() {
        let local = vec![
            PackageFile {
                path: "SKILL.md".to_string(),
                content: b"before".to_vec(),
            },
            PackageFile {
                path: "removed.md".to_string(),
                content: b"removed".to_vec(),
            },
        ];
        let remote = vec![
            PackageFile {
                path: "SKILL.md".to_string(),
                content: b"after".to_vec(),
            },
            PackageFile {
                path: "added.md".to_string(),
                content: b"added".to_vec(),
            },
        ];

        let changes = build_update_changes(&local, &remote);
        let statuses = changes
            .iter()
            .map(|change| (change.path.as_str(), change.status.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(
            statuses,
            vec![("SKILL.md", "M"), ("added.md", "A"), ("removed.md", "D")]
        );
    }
}
