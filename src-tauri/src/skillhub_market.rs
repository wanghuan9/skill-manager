use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::Deserialize;

use crate::commands::{
    apply_skill_install_activation, default_installed_skills, normalize_skill_tools,
    now_timestamp_label, persist_skill_timestamps, read_skill_description,
};
use crate::library::skill_directory;
use crate::marketplace_package;
use crate::models::{
    MarketplaceSkill, SkillFileBrowserSnapshot, SkillFileDocument, SkillInstanceMetadata,
    SkillSummary, ToolSyncStatus, UpdatePreviewSnapshot,
};
use crate::state::{load_installed_skills, save_installed_skills};

pub(crate) const SOURCE: &str = "skillhub";
const SOURCE_LABEL: &str = "SkillHub";
const API_BASE_URL: &str = "https://api.skillhub.cn";
const WEBSITE_BASE_URL: &str = "https://skillhub.cn";
const UPDATE_AVAILABLE_TEXT: &str = "SkillHub 检测到可更新版本。";

#[derive(Debug, Deserialize)]
struct SkillHubListResponse {
    data: SkillHubListData,
}

#[derive(Debug, Deserialize)]
struct SkillHubListData {
    #[serde(default)]
    skills: Vec<SkillHubListItem>,
}

#[derive(Clone, Debug, Deserialize)]
struct SkillHubListItem {
    slug: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    description_zh: String,
    #[serde(default)]
    category: String,
    #[serde(default, rename = "subCategories")]
    sub_categories: Vec<SkillHubSubCategory>,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    version: String,
    #[serde(default)]
    updated_at: i64,
    #[serde(default, rename = "iconUrl")]
    icon_url: Option<String>,
    namespace: Option<SkillHubNamespace>,
    publisher: Option<SkillHubPublisher>,
}

#[derive(Clone, Debug, Deserialize)]
struct SkillHubNamespace {
    #[serde(default, rename = "displayName")]
    display_name: String,
    #[serde(default)]
    handle: String,
}

#[derive(Clone, Debug, Deserialize)]
struct SkillHubPublisher {
    #[serde(default)]
    name: String,
}

#[derive(Clone, Debug, Deserialize)]
struct SkillHubSubCategory {
    #[serde(default)]
    name: String,
}

#[derive(Clone, Debug, Deserialize)]
struct SkillHubVersion {
    #[serde(default)]
    version: String,
}

#[derive(Clone, Debug, Deserialize)]
struct SkillHubDetailResponse {
    #[serde(default)]
    slug: String,
    skill: Option<SkillHubDetail>,
    #[serde(default, rename = "latestVersion")]
    latest_version: Option<SkillHubVersion>,
}

#[derive(Clone, Debug, Deserialize)]
struct SkillHubDetail {
    #[serde(default)]
    slug: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    summary_zh: String,
    #[serde(default, rename = "updatedAt")]
    updated_at: i64,
}

#[derive(Debug, Deserialize)]
struct SkillHubFilesResponse {
    #[serde(default)]
    files: Vec<SkillHubFile>,
}

#[derive(Debug, Deserialize)]
struct SkillHubFile {
    path: String,
}

#[derive(Debug, Deserialize)]
struct SkillHubBatchResponse {
    #[serde(default)]
    items: Vec<SkillHubDetailResponse>,
}

pub(crate) async fn list_skills(
    client: &Client,
    page: usize,
    limit: usize,
    query: Option<&str>,
) -> Result<Vec<MarketplaceSkill>, String> {
    let mut request = client.get(format!("{API_BASE_URL}/api/skills")).query(&[
        ("page", page.max(1).to_string()),
        ("pageSize", limit.max(1).to_string()),
        ("sortBy", "score".to_string()),
    ]);
    if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
        request = request.query(&[("keyword", query)]);
    }
    let payload = request
        .send()
        .await
        .map_err(|error| format!("请求 SkillHub 失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("SkillHub 返回异常状态: {error}"))?
        .json::<SkillHubListResponse>()
        .await
        .map_err(|error| format!("解析 SkillHub 技能列表失败: {error}"))?;
    let installed_skills = load_installed_skills(&default_installed_skills());
    Ok(map_list_items(payload.data.skills, &installed_skills))
}

pub(crate) async fn get_description(client: &Client, slug: &str, fallback: String) -> String {
    let Some(slug) = normalize_slug(slug) else {
        return fallback;
    };
    match fetch_detail(client, &slug).await {
        Ok(detail) => detail
            .skill
            .map(|skill| preferred_text(&skill.summary_zh, &skill.summary))
            .filter(|description| !description.is_empty())
            .unwrap_or(fallback),
        Err(_) => fallback,
    }
}

pub(crate) async fn get_file_browser(
    client: &Client,
    slug: &str,
    skill_name: &str,
    version: Option<&str>,
) -> Result<SkillFileBrowserSnapshot, String> {
    let slug = normalize_slug(slug).ok_or_else(|| "SkillHub Skill 标识无效".to_string())?;
    let files = fetch_files(client, &slug, version).await?;
    marketplace_package::file_browser_from_paths(
        skill_name,
        files.files.into_iter().map(|file| file.path),
    )
}

pub(crate) async fn get_file_content(
    client: &Client,
    slug: &str,
    relative_path: &str,
    version: Option<&str>,
) -> Result<SkillFileDocument, String> {
    let slug = normalize_slug(slug).ok_or_else(|| "SkillHub Skill 标识无效".to_string())?;
    let mut request = client
        .get(format!("{API_BASE_URL}/api/v1/skills/{slug}/file"))
        .query(&[("path", relative_path)]);
    if let Some(version) = normalized_version(version) {
        request = request.query(&[("version", version)]);
    }
    let content = request
        .send()
        .await
        .map_err(|error| format!("读取 SkillHub 文件失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("SkillHub 文件返回异常状态: {error}"))?
        .text()
        .await
        .map_err(|error| format!("解析 SkillHub 文件失败: {error}"))?;
    Ok(SkillFileDocument {
        path: relative_path.to_string(),
        content,
    })
}

pub(crate) async fn install_skill(skill: MarketplaceSkill) -> Result<SkillSummary, String> {
    let slug = slug_from_marketplace_skill(&skill)
        .ok_or_else(|| "SkillHub Skill 标识无效，请刷新后重试".to_string())?;
    let client = crate::commands::marketplace_http_client()?;
    let detail = fetch_detail(&client, &slug).await?;
    let version = detail_version(&detail)
        .or_else(|| normalized_version(Some(&skill.current_version)).map(str::to_string))
        .ok_or_else(|| "SkillHub 未返回可安装版本".to_string())?;
    let package = download_package(&client, &slug, &version).await?;
    tauri::async_runtime::spawn_blocking(move || {
        install_skill_package(skill, &slug, &version, package)
    })
    .await
    .map_err(|error| format!("后台安装 SkillHub Skill 失败: {error}"))?
}

pub(crate) async fn refresh_installed_skill_update_states(
    mut skills: Vec<SkillSummary>,
) -> Vec<SkillSummary> {
    let slug_indexes = skills
        .iter()
        .enumerate()
        .filter_map(|(index, skill)| slug_from_installed_skill(skill).map(|slug| (slug, index)))
        .collect::<Vec<_>>();
    if slug_indexes.is_empty() {
        return skills;
    }
    let client = match crate::commands::marketplace_http_client() {
        Ok(client) => client,
        Err(_) => return skills,
    };
    for batch in slug_indexes.chunks(100) {
        let slugs = batch
            .iter()
            .map(|(slug, _)| slug.clone())
            .collect::<Vec<_>>();
        let details = match fetch_batch_details(&client, &slugs).await {
            Ok(details) => details,
            Err(error) => {
                log::warn!("SkillHub update check skipped: {error}");
                continue;
            }
        };
        for (slug, index) in batch {
            let Some(detail) = details.get(slug) else {
                continue;
            };
            let Some(remote_version) = detail_version(detail) else {
                continue;
            };
            let skill = &mut skills[*index];
            skill.last_checked_at = "刚刚检查".into();
            if is_remote_version_newer(&skill.commit_label, &remote_version) {
                skill.collab_status = "update-available".into();
                skill.status_text = UPDATE_AVAILABLE_TEXT.into();
            } else if skill.collab_status == "update-available" {
                skill.collab_status = "clean".into();
                skill.status_text = "SkillHub Skill 已是最新版本。".into();
            }
            if let Some(updated_at) = detail
                .skill
                .as_ref()
                .and_then(|item| format_timestamp(item.updated_at))
            {
                skill.remote_updated_at = updated_at;
            }
        }
    }
    skills
}

pub(crate) async fn preview_installed_skill_update(
    skill: SkillSummary,
) -> Result<UpdatePreviewSnapshot, String> {
    let slug = slug_from_installed_skill(&skill)
        .ok_or_else(|| "SkillHub Skill 地址无效，请重新安装后再更新".to_string())?;
    let client = crate::commands::marketplace_http_client()?;
    let detail = fetch_detail(&client, &slug).await?;
    let version = detail_version(&detail).ok_or_else(|| "SkillHub 未返回最新版本".to_string())?;
    let package = download_package(&client, &slug, &version).await?;
    let local_path = PathBuf::from(&skill.local_path);
    let current_version = skill.commit_label.clone();
    let installed_content_hash = skill.instance.content_hash.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target_files = marketplace_package::files_from_zip(&package)?;
        let changed_files = marketplace_package::build_update_changes(&local_path, target_files)?;
        let current_content_hash = marketplace_package::directory_content_hash(&local_path)?;
        Ok(UpdatePreviewSnapshot {
            current_branch: current_version,
            remote_branch: format!("skillhub/{slug}@v{version}"),
            commits_to_pull: 0,
            changed_files,
            has_local_changes: !installed_content_hash.trim().is_empty()
                && current_content_hash != installed_content_hash,
        })
    })
    .await
    .map_err(|error| format!("后台生成 SkillHub 更新预览失败: {error}"))?
}

pub(crate) async fn update_installed_skill(skill: SkillSummary) -> Result<SkillSummary, String> {
    let slug = slug_from_installed_skill(&skill)
        .ok_or_else(|| "SkillHub Skill 地址无效，请重新安装后再更新".to_string())?;
    let client = crate::commands::marketplace_http_client()?;
    let detail = fetch_detail(&client, &slug).await?;
    let version = detail_version(&detail).ok_or_else(|| "SkillHub 未返回最新版本".to_string())?;
    if !is_remote_version_newer(&skill.commit_label, &version) {
        return Err("当前已是 SkillHub 最新版本。".into());
    }
    let package = download_package(&client, &slug, &version).await?;
    let remote_updated_at = detail
        .skill
        .as_ref()
        .and_then(|item| format_timestamp(item.updated_at));
    tauri::async_runtime::spawn_blocking(move || {
        update_skill_package(skill, &version, remote_updated_at, package)
    })
    .await
    .map_err(|error| format!("后台更新 SkillHub Skill 失败: {error}"))?
}

pub(crate) fn is_installed_skillhub_skill(skill: &SkillSummary) -> bool {
    skill.source_label == SOURCE_LABEL || slug_from_source_url(&skill.source_url).is_some()
}

fn map_list_items(
    items: Vec<SkillHubListItem>,
    installed_skills: &[SkillSummary],
) -> Vec<MarketplaceSkill> {
    let installed_by_slug = installed_skills
        .iter()
        .filter_map(|skill| slug_from_installed_skill(skill).map(|slug| (slug, skill)))
        .collect::<HashMap<_, _>>();
    items
        .into_iter()
        .filter(|item| normalize_slug(&item.slug).is_some() && !item.name.trim().is_empty())
        .map(|item| {
            let installed = installed_by_slug.get(item.slug.trim()).copied();
            let maintainer = item
                .publisher
                .as_ref()
                .map(|publisher| publisher.name.trim())
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    item.namespace.as_ref().and_then(|namespace| {
                        let name = preferred_text(&namespace.display_name, &namespace.handle);
                        (!name.is_empty()).then_some(name)
                    })
                })
                .unwrap_or_else(|| SOURCE_LABEL.into());
            let source_url = format!("{WEBSITE_BASE_URL}/skills/{}", item.slug);
            MarketplaceSkill {
                id: format!("{SOURCE}-{}", item.slug),
                name: item.name,
                source_type: "marketplace".into(),
                source_site: SOURCE.into(),
                description: preferred_text(&item.description_zh, &item.description),
                maintainer,
                updated_at: format_timestamp(item.updated_at).unwrap_or_default(),
                install_label: format!("v{}", item.version.trim_start_matches('v')),
                source_url: source_url.clone(),
                popularity_label: format_compact_number(item.downloads),
                topic_label: String::new(),
                avatar_url: item.icon_url.filter(|url| !url.trim().is_empty()),
                skill_path: item.slug.clone(),
                installed: installed.is_some(),
                update_available: installed.is_some_and(|skill| {
                    is_remote_version_newer(&skill.commit_label, &item.version)
                }),
                current_version: item.version.clone(),
                category_label: item
                    .sub_categories
                    .iter()
                    .find_map(|category| {
                        let name = category.name.trim();
                        (!name.is_empty()).then(|| name.to_string())
                    })
                    .unwrap_or_else(|| item.category.trim().to_string()),
                marketplace_url: source_url,
                owner: String::new(),
                slug: item.slug,
                version: item.version,
                install_driver: String::new(),
            }
        })
        .collect()
}

fn install_skill_package(
    skill: MarketplaceSkill,
    slug: &str,
    version: &str,
    package: Vec<u8>,
) -> Result<SkillSummary, String> {
    let skill_name = normalized_skill_name(&skill.name)?;
    let skill_dir = skill_directory(&skill_name)?;
    if fs_path_exists(&skill_dir) {
        return Err("同名 Skill 已存在，请先移除现有 Skill 后再安装。".into());
    }
    marketplace_package::replace_directory_from_zip(&package, &skill_dir)?;
    let installed_at = now_timestamp_label();
    let mut installed_skills = load_installed_skills(&default_installed_skills());
    let local_path = skill_dir.to_string_lossy().to_string();
    let mut installed_skill = SkillSummary {
        name: skill_name,
        source_label: SOURCE_LABEL.into(),
        source_type: "marketplace".into(),
        source_url: format!("{WEBSITE_BASE_URL}/skills/{slug}"),
        description: skill.description,
        local_path: local_path.clone(),
        branch: "stable".into(),
        collab_status: "clean".into(),
        status_text: "刚从 SkillHub 安装完成，建议同步到常用工具。".into(),
        remote_updated_at: skill.updated_at,
        local_updated_at: installed_at.clone(),
        last_synced_at: installed_at.clone(),
        last_checked_at: "刚刚".into(),
        synced_tool_count: 0,
        last_editor: skill.maintainer,
        commit_label: format!("v{}", version.trim_start_matches('v')),
        git_linked: false,
        local_change_count: 0,
        lifecycle_source: String::new(),
        owner_plugin_id: String::new(),
        owner_plugin_name: String::new(),
        instance: SkillInstanceMetadata {
            backup_id: String::new(),
            entry_path: local_path.clone(),
            canonical_path: local_path.clone(),
            management_owner: "skilldock".into(),
            update_driver: "none".into(),
            skill_entries: vec![local_path],
            path_error: String::new(),
            content_hash: marketplace_package::directory_content_hash(&skill_dir)?,
            marketplace_owner: String::new(),
            marketplace_slug: slug.to_string(),
            marketplace_version: version.to_string(),
            marketplace_content_hash: String::new(),
        },
        tools: vec![ToolSyncStatus {
            name: "Codex".into(),
            status_label: "待同步".into(),
        }],
    };
    let description = read_skill_description(&skill_dir.join("SKILL.md"));
    if !description.trim().is_empty() {
        installed_skill.description = description;
    }
    installed_skill =
        apply_skill_install_activation(normalize_skill_tools(&installed_skill), &installed_skills)?;
    persist_skill_timestamps(&installed_skill);
    installed_skills.insert(0, installed_skill.clone());
    save_installed_skills(&installed_skills)?;
    Ok(installed_skill)
}

fn update_skill_package(
    mut skill: SkillSummary,
    version: &str,
    remote_updated_at: Option<String>,
    package: Vec<u8>,
) -> Result<SkillSummary, String> {
    let skill_dir = PathBuf::from(&skill.local_path);
    let local_content_hash = marketplace_package::directory_content_hash(&skill_dir)?;
    if !skill.instance.content_hash.trim().is_empty()
        && local_content_hash != skill.instance.content_hash
    {
        return Err("本地 Skill 文件已修改，请先查看更新差异并备份本地改动。".into());
    }
    marketplace_package::replace_directory_from_zip(&package, &skill_dir)?;
    let updated_at = now_timestamp_label();
    let description = read_skill_description(&skill_dir.join("SKILL.md"));
    if !description.trim().is_empty() {
        skill.description = description;
    }
    skill.commit_label = format!("v{}", version.trim_start_matches('v'));
    skill.collab_status = "clean".into();
    skill.status_text = "已更新到 SkillHub 最新版本，建议同步到常用工具。".into();
    skill.local_updated_at = updated_at.clone();
    skill.last_synced_at = updated_at;
    skill.last_checked_at = "刚刚".into();
    skill.git_linked = false;
    skill.instance.content_hash = marketplace_package::directory_content_hash(&skill_dir)?;
    if let Some(remote_updated_at) = remote_updated_at {
        skill.remote_updated_at = remote_updated_at;
    }

    let mut installed_skills = load_installed_skills(&default_installed_skills());
    let index = installed_skills
        .iter()
        .position(|item| item.name == skill.name && item.local_path == skill.local_path)
        .ok_or_else(|| "未找到已安装的 SkillHub Skill".to_string())?;
    installed_skills[index] = skill.clone();
    save_installed_skills(&installed_skills)?;
    Ok(skill)
}

async fn fetch_detail(client: &Client, slug: &str) -> Result<SkillHubDetailResponse, String> {
    client
        .get(format!("{API_BASE_URL}/api/v1/skills/{slug}"))
        .send()
        .await
        .map_err(|error| format!("请求 SkillHub 详情失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("SkillHub 详情返回异常状态: {error}"))?
        .json::<SkillHubDetailResponse>()
        .await
        .map_err(|error| format!("解析 SkillHub 详情失败: {error}"))
}

async fn fetch_files(
    client: &Client,
    slug: &str,
    version: Option<&str>,
) -> Result<SkillHubFilesResponse, String> {
    let mut request = client.get(format!("{API_BASE_URL}/api/v1/skills/{slug}/files"));
    if let Some(version) = normalized_version(version) {
        request = request.query(&[("version", version)]);
    }
    request
        .send()
        .await
        .map_err(|error| format!("读取 SkillHub 文件列表失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("SkillHub 文件列表返回异常状态: {error}"))?
        .json::<SkillHubFilesResponse>()
        .await
        .map_err(|error| format!("解析 SkillHub 文件列表失败: {error}"))
}

async fn fetch_batch_details(
    client: &Client,
    slugs: &[String],
) -> Result<HashMap<String, SkillHubDetailResponse>, String> {
    let payload = client
        .post(format!("{API_BASE_URL}/api/v1/skills/batch"))
        .json(&serde_json::json!({ "slugs": slugs }))
        .send()
        .await
        .map_err(|error| format!("批量检查 SkillHub 版本失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("SkillHub 批量版本返回异常状态: {error}"))?
        .json::<SkillHubBatchResponse>()
        .await
        .map_err(|error| format!("解析 SkillHub 批量版本失败: {error}"))?;
    Ok(payload
        .items
        .into_iter()
        .filter_map(|detail| detail_slug(&detail).map(|slug| (slug, detail)))
        .collect())
}

async fn download_package(client: &Client, slug: &str, version: &str) -> Result<Vec<u8>, String> {
    let bytes = client
        .get(format!("{API_BASE_URL}/api/v1/download"))
        .query(&[("slug", slug), ("version", version)])
        .send()
        .await
        .map_err(|error| format!("下载 SkillHub Skill 失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("SkillHub 下载返回异常状态: {error}"))?
        .bytes()
        .await
        .map_err(|error| format!("读取 SkillHub Skill 包失败: {error}"))?;
    if bytes.len() < 2 || &bytes[..2] != b"PK" {
        return Err("SkillHub 返回的 Skill 包格式无效".into());
    }
    Ok(bytes.to_vec())
}

fn slug_from_marketplace_skill(skill: &MarketplaceSkill) -> Option<String> {
    skill
        .id
        .trim()
        .strip_prefix(&format!("{SOURCE}-"))
        .and_then(normalize_slug)
        .or_else(|| slug_from_source_url(&skill.source_url))
}

fn slug_from_installed_skill(skill: &SkillSummary) -> Option<String> {
    if skill.source_label != SOURCE_LABEL && skill.source_type != "marketplace" {
        return None;
    }
    slug_from_source_url(&skill.source_url)
}

fn slug_from_source_url(source_url: &str) -> Option<String> {
    let parsed = url::Url::parse(source_url.trim()).ok()?;
    if parsed.host_str()? != "skillhub.cn" {
        return None;
    }
    let segments = parsed
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let index = segments.iter().position(|segment| *segment == "skills")?;
    segments
        .get(index + 1)
        .and_then(|slug| normalize_slug(slug))
}

fn detail_slug(detail: &SkillHubDetailResponse) -> Option<String> {
    (!detail.slug.trim().is_empty())
        .then_some(detail.slug.as_str())
        .and_then(normalize_slug)
        .or_else(|| {
            detail
                .skill
                .as_ref()
                .and_then(|skill| normalize_slug(&skill.slug))
        })
}

fn normalize_slug(slug: &str) -> Option<String> {
    let slug = slug.trim();
    (!slug.is_empty()
        && slug
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_')))
    .then(|| slug.to_string())
}

fn normalized_skill_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let path = Path::new(name);
    if name.is_empty()
        || name.contains(['/', '\\'])
        || path.components().count() != 1
        || !matches!(
            path.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err("SkillHub Skill 名称无效，请联系市场维护者".into());
    }
    Ok(name.to_string())
}

fn detail_version(detail: &SkillHubDetailResponse) -> Option<String> {
    detail
        .latest_version
        .as_ref()
        .map(|version| version.version.trim().trim_start_matches('v').to_string())
        .filter(|version| !version.is_empty())
}

fn normalized_version(version: Option<&str>) -> Option<&str> {
    version
        .map(str::trim)
        .map(|value| value.strip_prefix('v').unwrap_or(value))
        .filter(|value| !value.is_empty())
}

fn preferred_text(primary: &str, fallback: &str) -> String {
    let primary = primary.trim();
    if primary.is_empty() {
        fallback.trim().to_string()
    } else {
        primary.to_string()
    }
}

fn format_timestamp(timestamp: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(timestamp).map(|value| value.to_rfc3339())
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

fn is_remote_version_newer(local: &str, remote: &str) -> bool {
    let local = parse_version(local);
    let remote = parse_version(remote);
    remote > local
}

fn parse_version(version: &str) -> (Vec<u64>, bool, Vec<(bool, u64, String)>) {
    let normalized = version
        .trim()
        .trim_start_matches('v')
        .split('+')
        .next()
        .unwrap_or_default();
    let (core, prerelease) = normalized.split_once('-').unwrap_or((normalized, ""));
    let mut numeric = core
        .split('.')
        .map(|segment| segment.parse::<u64>().unwrap_or_default())
        .collect::<Vec<_>>();
    while numeric.len() < 3 {
        numeric.push(0);
    }
    while numeric.len() > 3 && numeric.last() == Some(&0) {
        numeric.pop();
    }
    let prerelease = prerelease
        .split('.')
        .filter(|identifier| !identifier.is_empty())
        .map(|identifier| match identifier.parse::<u64>() {
            Ok(value) => (false, value, String::new()),
            Err(_) => (true, 0, identifier.to_string()),
        })
        .collect::<Vec<_>>();
    (numeric, prerelease.is_empty(), prerelease)
}

fn fs_path_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        is_remote_version_newer, map_list_items, normalize_slug, normalized_skill_name,
        SkillHubListItem,
    };

    #[test]
    fn maps_skillhub_list_payload() {
        let item: SkillHubListItem = serde_json::from_value(json!({
            "slug": "tencent-docs",
            "name": "腾讯文档",
            "description_zh": "在线文档",
            "category": "productivity",
            "subCategories": [{ "key": "online-docs", "name": "在线文档" }],
            "downloads": 176706,
            "version": "1.0.41",
            "updated_at": 1785292997583_i64,
            "iconUrl": "https://example.com/icon.png",
            "namespace": { "displayName": "tencent-adm", "handle": "tencent-adm" },
            "publisher": { "name": "腾讯文档团队" }
        }))
        .expect("parse item");

        let skills = map_list_items(vec![item], &[]);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "skillhub-tencent-docs");
        assert_eq!(skills[0].source_type, "marketplace");
        assert_eq!(skills[0].source_site, "skillhub");
        assert_eq!(skills[0].maintainer, "腾讯文档团队");
        assert_eq!(skills[0].current_version, "1.0.41");
        assert_eq!(skills[0].category_label, "在线文档");
        assert_eq!(skills[0].popularity_label, "176.7K");
    }

    #[test]
    fn accepts_skillhub_items_without_an_icon() {
        let item: SkillHubListItem = serde_json::from_value(json!({
            "slug": "without-icon",
            "name": "Without Icon",
            "iconUrl": null
        }))
        .expect("parse item without icon");

        let skills = map_list_items(vec![item], &[]);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "skillhub-without-icon");
        assert_eq!(skills[0].avatar_url, None);
    }

    #[test]
    fn compares_semantic_versions() {
        assert!(is_remote_version_newer("v1.2.9", "1.3.0"));
        assert!(is_remote_version_newer("1.3.0-beta.1", "1.3.0"));
        assert!(is_remote_version_newer("1.3.0-beta.2", "1.3.0-beta.10"));
        assert!(!is_remote_version_newer("v2.0.0", "1.9.9"));
        assert!(!is_remote_version_newer("1.0.2", "v1.0.2"));
        assert!(!is_remote_version_newer("1.0", "1.0.0"));
        assert!(!is_remote_version_newer("1.0.0+local", "1.0.0+remote"));
    }

    #[test]
    fn rejects_unsafe_marketplace_identifiers() {
        assert_eq!(
            normalize_slug("web-tools-guide").as_deref(),
            Some("web-tools-guide")
        );
        assert!(normalize_slug("../outside").is_none());
        assert_eq!(
            normalized_skill_name("Web Tools").as_deref(),
            Ok("Web Tools")
        );
        assert!(normalized_skill_name("../outside").is_err());
    }
}
