use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Utc;
use reqwest::multipart::{Form, Part};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::models::{GitChangeFile, SkillSummary, UpdatePreviewSnapshot};
use crate::workspace;

const API_BASE_URL: &str = "https://api.skillhub.cn";
const AUTH_ME_PATH: &str = "/api/v1/auth/me";
const DASHBOARD_SKILLS_PATH: &str = "/api/v1/dashboard/skills";
const PUBLISH_SKILL_PATH: &str = "/api/v1/community/skills/publish";
const MARKET_SKILL_URL_PREFIX: &str = "/skills/";
const CREDENTIAL_FILE_NAME: &str = "skillhub-auth.json";
const PUBLISH_STATE_FILE_NAME: &str = "skillhub-publish-state.json";
const CREDENTIAL_SCHEMA_VERSION: u8 = 1;
const INITIAL_VERSION: &str = "1.0.0";
const PACKAGE_MAX_FILE_COUNT: usize = 500;
const PACKAGE_MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const PACKAGE_MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024;
const DASHBOARD_SKILLS_PAGE_SIZE: usize = 100;
const REMOTE_PACKAGE_CONCURRENCY: usize = 4;

static REMOTE_PACKAGE_CACHE: OnceLock<
    Mutex<HashMap<RemotePackageCacheKey, Vec<(String, Vec<u8>)>>>,
> = OnceLock::new();

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct RemotePackageCacheKey {
    slug: String,
    version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillHubAuthStatus {
    connected: bool,
    handle: String,
    user_id: u64,
    verified_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillHubCredential {
    schema_version: u8,
    host: String,
    token: String,
    user_id: u64,
    handle: String,
    verified_at: String,
}

#[derive(Debug, Deserialize)]
struct SkillHubAuthMeResponse {
    user: SkillHubUser,
}

#[derive(Debug, Deserialize)]
struct SkillHubUser {
    id: u64,
    #[serde(default)]
    handle: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillHubPublishableSkill {
    name: String,
    description: String,
    local_path: String,
    management_owner: String,
    source_label: String,
    source_type: String,
    source_url: String,
    remote_updated_at: String,
    local_updated_at: String,
    last_editor: String,
    git_linked: bool,
    local_change_count: usize,
    update_file_count: usize,
    local_content_hash: String,
    file_count: usize,
    package_size: u64,
    remote_skill_id: String,
    remote_version: String,
    last_published_at: String,
    publish_status: String,
    failure_reason: String,
    market_url: String,
    target_version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillHubPublishableSkillsSnapshot {
    skills: Vec<SkillHubPublishableSkill>,
    authorization_required: bool,
    status_sync_error: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillHubPublishInput {
    skill_name: String,
    #[serde(default)]
    local_path: String,
    #[serde(default)]
    remote_skill_id: String,
    #[serde(default)]
    expected_remote_version: String,
    changelog: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillHubPublishResult {
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillHubPublishPayload {
    slug: String,
    version: String,
    display_name: String,
    summary: String,
    description: String,
    tags: Vec<String>,
    license: String,
    homepage: String,
    changelog: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillHubPublishState {
    #[serde(default)]
    skills: HashMap<String, PublishedSkillState>,
    #[serde(default)]
    pending_skills: HashMap<String, PendingSkillState>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishedSkillState {
    slug: String,
    version: String,
    content_hash: String,
    last_published_at: String,
    #[serde(default)]
    market_url: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingSkillState {
    slug: String,
    version: String,
    content_hash: String,
    requested_at: String,
}

#[derive(Clone, Debug, Default)]
struct RemoteSkillHubSkill {
    slug: String,
    current_version: String,
    last_published_at: String,
    status: String,
    review_status: String,
    failure_reason: String,
    market_url: String,
}

enum RemoteSkillHubFetchError {
    AuthorizationRequired,
    Request(String),
}

#[tauri::command]
pub(crate) fn get_skillhub_auth_status() -> Result<SkillHubAuthStatus, String> {
    let credential = load_credential()?;
    Ok(credential
        .map(status_from_credential)
        .unwrap_or_else(disconnected_status))
}

#[tauri::command]
pub(crate) async fn save_skillhub_auth_token(token: String) -> Result<SkillHubAuthStatus, String> {
    let token = token.trim().to_string();
    if !token.starts_with("skh_") {
        return Err("SkillHub Token 必须以 skh_ 开头。".to_string());
    }

    let client = crate::commands::marketplace_http_client()?;
    let response = client
        .get(format!("{API_BASE_URL}{AUTH_ME_PATH}"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|error| format!("验证 SkillHub Token 失败: {error}"))?
        .error_for_status()
        .map_err(|_| "SkillHub Token 无效或已失效，请重新创建。".to_string())?
        .json::<SkillHubAuthMeResponse>()
        .await
        .map_err(|error| format!("解析 SkillHub 登录信息失败: {error}"))?;
    let credential = SkillHubCredential {
        schema_version: CREDENTIAL_SCHEMA_VERSION,
        host: API_BASE_URL.to_string(),
        token,
        user_id: response.user.id,
        handle: response.user.handle,
        verified_at: Utc::now().to_rfc3339(),
    };
    save_credential(&credential)?;
    Ok(status_from_credential(credential))
}

#[tauri::command]
pub(crate) fn clear_skillhub_auth_token() -> Result<(), String> {
    let path = credential_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("清除 SkillHub Token 失败: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_skillhub_publishable_skills(
    _force_refresh: Option<bool>,
) -> Result<SkillHubPublishableSkillsSnapshot, String> {
    build_skillhub_publishable_skills_snapshot(false, false).await
}

#[tauri::command]
pub(crate) async fn reconcile_skillhub_publishable_skills(
    force_refresh: Option<bool>,
) -> Result<SkillHubPublishableSkillsSnapshot, String> {
    build_skillhub_publishable_skills_snapshot(true, force_refresh.unwrap_or_default()).await
}

async fn build_skillhub_publishable_skills_snapshot(
    should_reconcile_files: bool,
    force_refresh: bool,
) -> Result<SkillHubPublishableSkillsSnapshot, String> {
    let Some(credential) = load_credential()? else {
        return Ok(SkillHubPublishableSkillsSnapshot {
            skills: build_publishable_skills(&[])?,
            authorization_required: true,
            status_sync_error: String::new(),
        });
    };

    match fetch_remote_published_skills(&credential).await {
        Ok(remote_skills) => {
            let mut skills = build_publishable_skills(&remote_skills)?;
            let status_sync_error = if should_reconcile_files {
                enrich_remote_skill_file_diffs(&mut skills, &credential, force_refresh).await
            } else {
                String::new()
            };
            Ok(SkillHubPublishableSkillsSnapshot {
                skills,
                authorization_required: false,
                status_sync_error,
            })
        }
        Err(RemoteSkillHubFetchError::AuthorizationRequired) => {
            Ok(SkillHubPublishableSkillsSnapshot {
                skills: build_publishable_skills(&[])?,
                authorization_required: true,
                status_sync_error: String::new(),
            })
        }
        Err(RemoteSkillHubFetchError::Request(error)) => Ok(SkillHubPublishableSkillsSnapshot {
            skills: build_publishable_skills(&[])?,
            authorization_required: false,
            status_sync_error: error,
        }),
    }
}

#[tauri::command]
pub(crate) async fn get_skillhub_publish_update_preview(
    skill_name: String,
    local_path: String,
    remote_skill_id: String,
    remote_version: String,
) -> Result<UpdatePreviewSnapshot, String> {
    let credential = load_credential()?.ok_or_else(|| "请先登录 SkillHub。".to_string())?;
    let skill_path = resolve_requested_publishable_skill_path(&skill_name, &local_path)?;
    let remote_files = load_remote_skill_files(
        &credential,
        remote_skill_id.trim(),
        remote_version.trim(),
        false,
    )
    .await?;
    let changed_files = build_skillhub_publish_update_changes(&skill_path, remote_files)?;
    Ok(UpdatePreviewSnapshot {
        current_branch: String::new(),
        remote_branch: format!("skillhub/{}", remote_skill_id.trim()),
        commits_to_pull: 0,
        changed_files,
        has_local_changes: false,
    })
}

#[tauri::command]
pub(crate) async fn revert_skillhub_publish_update_hunk(
    skill_name: String,
    local_path: String,
    remote_skill_id: String,
    remote_version: String,
    relative_path: String,
    expected_content: String,
    content: String,
) -> Result<UpdatePreviewSnapshot, String> {
    let credential = load_credential()?.ok_or_else(|| "请先登录 SkillHub。".to_string())?;
    let skill_path = resolve_requested_publishable_skill_path(&skill_name, &local_path)?;
    validate_publish_relative_path(&relative_path)?;
    let remote_files = load_remote_skill_files(
        &credential,
        remote_skill_id.trim(),
        remote_version.trim(),
        false,
    )
    .await?;
    let change = build_skillhub_publish_update_changes(&skill_path, remote_files.clone())?
        .into_iter()
        .find(|change| change.path == relative_path)
        .ok_or_else(|| "该文件已没有可回退的发布变更。".to_string())?;
    let current_content = change
        .current_content
        .ok_or_else(|| "二进制文件不支持变更块回退。".to_string())?;
    if current_content != expected_content {
        return Err("文件内容已变化，请刷新后重试。".to_string());
    }

    write_publish_update_content(&skill_path, &relative_path, &expected_content, &content)?;
    let changed_files = build_skillhub_publish_update_changes(&skill_path, remote_files)?;
    Ok(UpdatePreviewSnapshot {
        current_branch: String::new(),
        remote_branch: format!("skillhub/{}", remote_skill_id.trim()),
        commits_to_pull: 0,
        changed_files,
        has_local_changes: false,
    })
}

#[tauri::command]
pub(crate) async fn publish_skillhub_skill(
    input: SkillHubPublishInput,
) -> Result<SkillHubPublishResult, String> {
    validate_publish_input(&input)?;
    let credential = load_credential()?.ok_or_else(|| "请先登录 SkillHub。".to_string())?;
    let (skill, skill_path) = resolve_publishable_skill_path(&input.skill_name, &input.local_path)?;
    let files = collect_skill_files(&skill_path)?;
    let content_hash = crate::marketplace_package::directory_content_hash(&skill_path)?;
    let mut publish_state = load_publish_state();
    let local_path = skill_path.to_string_lossy().to_string();
    let previous = publish_state.skills.get(&local_path).cloned();
    let pending = publish_state.pending_skills.get(&local_path).cloned();
    let source_remote = resolve_skillhub_market_source_remote(
        &skill,
        &local_path,
        previous.as_ref(),
        pending.as_ref(),
        &credential,
    )
    .await?;
    let dashboard_remote = resolve_dashboard_publish_remote(
        &input,
        previous.as_ref(),
        pending.as_ref(),
        source_remote.as_ref(),
        &credential,
    )
    .await?;
    let (expected_slug, expected_version) = resolve_publish_baseline(
        &input.skill_name,
        pending.as_ref(),
        previous.as_ref(),
        source_remote.as_ref(),
        dashboard_remote.as_ref(),
    );
    if !input.remote_skill_id.trim().is_empty() && input.remote_skill_id.trim() != expected_slug {
        return Err("SkillHub 发布目标已变化，请刷新后重试。".to_string());
    }
    if !input.expected_remote_version.trim().is_empty()
        && input.expected_remote_version.trim() != expected_version
    {
        return Err("SkillHub 发布版本已变化，请刷新后重试。".to_string());
    }
    let slug = expected_slug;
    let version = if expected_version.is_empty() {
        INITIAL_VERSION.to_string()
    } else {
        next_patch_version(&expected_version)
    };
    let description = skill_description_for_publish(&skill_path, &input.skill_name)?;
    let payload = SkillHubPublishPayload {
        slug: slug.clone(),
        version: version.clone(),
        display_name: input.skill_name.trim().to_string(),
        summary: description.clone(),
        description,
        tags: Vec::new(),
        license: String::new(),
        homepage: String::new(),
        changelog: input.changelog.trim().to_string(),
    };
    let payload =
        serde_json::to_string(&payload).map_err(|error| format!("序列化发布信息失败: {error}"))?;
    let mut form = Form::new().text("payload", payload);
    for (relative_path, content) in files {
        let part = Part::bytes(content)
            .file_name(relative_path)
            .mime_str("application/octet-stream")
            .map_err(|error| format!("构建 Skill 文件上传失败: {error}"))?;
        form = form.part("files", part);
    }

    let response = crate::commands::marketplace_http_client()?
        .post(format!("{API_BASE_URL}{PUBLISH_SKILL_PATH}"))
        .bearer_auth(&credential.token)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("发布到 SkillHub 失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("SkillHub 发布失败（HTTP {}）。", response.status()));
    }
    publish_state.pending_skills.insert(
        local_path,
        PendingSkillState {
            slug: slug.clone(),
            version: version.clone(),
            content_hash,
            requested_at: Utc::now().to_rfc3339(),
        },
    );
    save_publish_state(&publish_state)?;
    invalidate_remote_package_cache(&slug);
    Ok(SkillHubPublishResult {
        message: format!(
            "{} v{} 已提交到 SkillHub，正在等待商店确认。",
            input.skill_name.trim(),
            version
        ),
    })
}

fn disconnected_status() -> SkillHubAuthStatus {
    SkillHubAuthStatus {
        connected: false,
        handle: String::new(),
        user_id: 0,
        verified_at: String::new(),
    }
}

fn status_from_credential(credential: SkillHubCredential) -> SkillHubAuthStatus {
    SkillHubAuthStatus {
        connected: true,
        handle: credential.handle,
        user_id: credential.user_id,
        verified_at: credential.verified_at,
    }
}

fn credential_path() -> Result<PathBuf, String> {
    workspace::workspace_file_path(CREDENTIAL_FILE_NAME)
}

fn load_credential() -> Result<Option<SkillHubCredential>, String> {
    let path = credential_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(&path).map_err(|error| format!("读取 SkillHub Token 失败: {error}"))?;
    let credential = serde_json::from_str::<SkillHubCredential>(&content)
        .map_err(|_| "SkillHub 登录信息已损坏，请重新登录。".to_string())?;
    if credential.schema_version != CREDENTIAL_SCHEMA_VERSION
        || !credential.token.starts_with("skh_")
    {
        return Err("SkillHub 登录信息无效，请重新登录。".to_string());
    }
    Ok(Some(credential))
}

fn save_credential(credential: &SkillHubCredential) -> Result<(), String> {
    let path = credential_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "SkillHub 凭证目录无效。".to_string())?;
    let payload = serde_json::to_string_pretty(credential)
        .map_err(|error| format!("序列化 SkillHub Token 失败: {error}"))?;
    let sequence = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("生成凭证文件名失败: {error}"))?
        .as_nanos();
    let temporary = parent.join(format!(
        ".{CREDENTIAL_FILE_NAME}.tmp-{}-{sequence}",
        std::process::id()
    ));
    fs::write(&temporary, payload).map_err(|error| format!("写入 SkillHub Token 失败: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("保护 SkillHub Token 失败: {error}"))?;
    }
    fs::rename(&temporary, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("保存 SkillHub Token 失败: {error}")
    })?;
    Ok(())
}

fn resolve_publishable_skill_path(
    skill_name: &str,
    requested_local_path: &str,
) -> Result<(SkillSummary, PathBuf), String> {
    let skill_name = skill_name.trim();
    if skill_name.is_empty() {
        return Err("请选择要发布的 Skill。".to_string());
    }
    let skill = crate::state::load_installed_skills(&crate::commands::default_installed_skills())
        .into_iter()
        .find(|skill| skill.name == skill_name && local_path_matches(skill, requested_local_path))
        .ok_or_else(|| "未找到可发布的托管 Skill，请刷新后重试。".to_string())?;
    let skill_path = managed_skill_path(&skill)?;
    Ok((skill, skill_path))
}

fn resolve_requested_publishable_skill_path(
    skill_name: &str,
    local_path: &str,
) -> Result<PathBuf, String> {
    let (_, skill_path) = resolve_publishable_skill_path(skill_name, local_path)?;
    Ok(skill_path)
}

fn local_path_matches(skill: &SkillSummary, requested_local_path: &str) -> bool {
    if requested_local_path.trim().is_empty() {
        return true;
    }
    let Ok(requested_path) = Path::new(requested_local_path).canonicalize() else {
        return false;
    };
    let Ok(skill_path) = Path::new(&skill.local_path).canonicalize() else {
        return false;
    };
    skill_path == requested_path
}

fn managed_skill_path(skill: &SkillSummary) -> Result<PathBuf, String> {
    if !crate::publishing_rules::supports_publishing_management_owner(
        &skill.instance.management_owner,
    ) {
        return Err("只能发布由 SkillDock 或 Agent Skills CLI 托管的 Skill。".to_string());
    }
    let path = Path::new(&skill.local_path)
        .canonicalize()
        .map_err(|_| "本地 Skill 目录不可用。".to_string())?;
    if !path.join("SKILL.md").is_file() {
        return Err("只能发布包含 SKILL.md 的托管 Skill。".to_string());
    }
    Ok(path)
}

fn validate_publish_input(input: &SkillHubPublishInput) -> Result<(), String> {
    if input.skill_name.trim().is_empty() {
        return Err("请选择要发布的 Skill。".to_string());
    }
    if input.local_path.trim().is_empty() {
        return Err("本地 Skill 路径缺失，请刷新后重试。".to_string());
    }
    Ok(())
}

async fn resolve_skillhub_market_source_remote(
    skill: &SkillSummary,
    local_path: &str,
    published: Option<&PublishedSkillState>,
    pending: Option<&PendingSkillState>,
    credential: &SkillHubCredential,
) -> Result<Option<RemoteSkillHubSkill>, String> {
    let installed_from_skillhub = crate::skillhub_market::is_installed_skillhub_skill(skill);
    if !installed_from_skillhub {
        return Ok(None);
    }
    let has_local_publish_binding = published.is_some() || pending.is_some();
    let source_slug = crate::skillhub_market::installed_skillhub_slug(skill);
    let remote_skills = match fetch_remote_published_skills(credential).await {
        Ok(remote_skills) => remote_skills,
        Err(_) if has_local_publish_binding => Vec::new(),
        Err(RemoteSkillHubFetchError::AuthorizationRequired) => {
            return Err("请重新登录 SkillHub。".to_string());
        }
        Err(RemoteSkillHubFetchError::Request(message)) => return Err(message),
    };
    let source_remote = source_slug.and_then(|slug| {
        remote_skills
            .into_iter()
            .find(|remote| remote.slug.eq_ignore_ascii_case(&slug))
    });
    let has_remote_ownership = source_remote.is_some();
    if !crate::publishing_rules::can_publish_managed_skill(
        &skill.instance.management_owner,
        true,
        has_remote_ownership,
        has_local_publish_binding,
    ) {
        return Err(format!(
            "从 SkillHub 安装的 Skill 仅允许原作者发布：{}。",
            local_path
        ));
    }
    Ok(source_remote)
}

async fn resolve_dashboard_publish_remote(
    input: &SkillHubPublishInput,
    published: Option<&PublishedSkillState>,
    pending: Option<&PendingSkillState>,
    source_remote: Option<&RemoteSkillHubSkill>,
    credential: &SkillHubCredential,
) -> Result<Option<RemoteSkillHubSkill>, String> {
    if published.is_some() || pending.is_some() || source_remote.is_some() {
        return Ok(None);
    }
    let requested_slug = input.remote_skill_id.trim();
    if requested_slug.is_empty() || requested_slug != normalize_slug(&input.skill_name) {
        return Ok(None);
    }
    let remote_skills =
        fetch_remote_published_skills(credential)
            .await
            .map_err(|error| match error {
                RemoteSkillHubFetchError::AuthorizationRequired => {
                    "请重新登录 SkillHub。".to_string()
                }
                RemoteSkillHubFetchError::Request(message) => message,
            })?;
    let remote = remote_skills
        .into_iter()
        .find(|skill| skill.slug.eq_ignore_ascii_case(requested_slug));
    if remote.is_none() {
        return Err("SkillHub 发布目标已变化，请刷新后重试。".to_string());
    }
    Ok(remote)
}

fn resolve_publish_baseline(
    skill_name: &str,
    pending: Option<&PendingSkillState>,
    published: Option<&PublishedSkillState>,
    source_remote: Option<&RemoteSkillHubSkill>,
    dashboard_remote: Option<&RemoteSkillHubSkill>,
) -> (String, String) {
    let remote = source_remote.or(dashboard_remote);
    let slug = pending
        .map(|state| state.slug.clone())
        .or_else(|| published.map(|state| state.slug.clone()))
        .or_else(|| remote.map(|state| state.slug.clone()))
        .unwrap_or_else(|| normalize_slug(skill_name));
    let version = pending
        .map(|state| state.version.clone())
        .or_else(|| published.map(|state| state.version.clone()))
        .or_else(|| remote.map(|state| state.current_version.clone()))
        .unwrap_or_default();
    (slug, version)
}

fn is_skillhub_publishable_skill(
    skill: &SkillSummary,
    local_path: &str,
    remote_by_slug: &HashMap<String, RemoteSkillHubSkill>,
    publish_state: &SkillHubPublishState,
) -> bool {
    let installed_from_skillhub = crate::skillhub_market::is_installed_skillhub_skill(skill);
    let has_remote_ownership = crate::skillhub_market::installed_skillhub_slug(skill)
        .is_some_and(|slug| remote_by_slug.contains_key(&slug.to_lowercase()));
    let has_local_publish_binding = publish_state.skills.contains_key(local_path)
        || publish_state.pending_skills.contains_key(local_path);
    crate::publishing_rules::can_publish_managed_skill(
        &skill.instance.management_owner,
        installed_from_skillhub,
        has_remote_ownership,
        has_local_publish_binding,
    )
}

fn build_publishable_skills(
    remote_skills: &[RemoteSkillHubSkill],
) -> Result<Vec<SkillHubPublishableSkill>, String> {
    let mut publish_state = load_publish_state();
    let remote_by_slug = remote_skills
        .iter()
        .filter(|skill| !skill.slug.trim().is_empty())
        .map(|skill| (skill.slug.trim().to_lowercase(), skill.clone()))
        .collect::<HashMap<_, _>>();
    let skills = crate::state::load_installed_skills(&crate::commands::default_installed_skills());
    let mut publishable_skills = Vec::new();
    let mut did_reconcile_state = false;
    for skill in skills {
        let path = match managed_skill_path(&skill) {
            Ok(path) => path,
            Err(_) => continue,
        };
        let files = match collect_skill_files(&path) {
            Ok(files) => files,
            Err(_) => continue,
        };
        let package_size = files.iter().map(|(_, content)| content.len() as u64).sum();
        let content_hash = crate::marketplace_package::directory_content_hash(&path)?;
        let local_path = path.to_string_lossy().to_string();
        let published = publish_state.skills.get(&local_path).cloned();
        let pending = publish_state.pending_skills.get(&local_path).cloned();
        if !is_skillhub_publishable_skill(&skill, &local_path, &remote_by_slug, &publish_state) {
            continue;
        }
        let owned_marketplace_slug = crate::skillhub_market::installed_skillhub_slug(&skill)
            .filter(|slug| remote_by_slug.contains_key(&slug.to_lowercase()));
        let slug = pending
            .as_ref()
            .map(|state| state.slug.clone())
            .or_else(|| published.as_ref().map(|state| state.slug.clone()))
            .or(owned_marketplace_slug)
            .unwrap_or_else(|| normalize_slug(&skill.name));
        let remote = remote_by_slug.get(&slug.to_lowercase()).cloned();

        if let (Some(pending), Some(remote)) = (pending.as_ref(), remote.as_ref()) {
            if remote_skill_is_published(remote)
                && remote_version_matches(&remote.current_version, &pending.version)
            {
                publish_state.skills.insert(
                    local_path.clone(),
                    PublishedSkillState {
                        slug: pending.slug.clone(),
                        version: remote.current_version.clone(),
                        content_hash: pending.content_hash.clone(),
                        last_published_at: if remote.last_published_at.trim().is_empty() {
                            pending.requested_at.clone()
                        } else {
                            remote.last_published_at.clone()
                        },
                        market_url: market_url_for_remote_skill(remote),
                    },
                );
                publish_state.pending_skills.remove(&local_path);
                did_reconcile_state = true;
            }
        }

        let published = publish_state.skills.get(&local_path).cloned();
        let pending = publish_state.pending_skills.get(&local_path).cloned();
        let publish_status = resolve_publish_status(
            remote.as_ref(),
            pending.as_ref(),
            published.as_ref(),
            &content_hash,
        );
        let remote_version = remote
            .as_ref()
            .map(|state| state.current_version.clone())
            .filter(|version| !version.trim().is_empty())
            .or_else(|| published.as_ref().map(|state| state.version.clone()))
            .unwrap_or_default();
        let target_version = if publish_status == "update-available" {
            next_patch_version(&remote_version)
        } else if publish_status == "publishing" || publish_status == "reviewing" {
            pending
                .as_ref()
                .map(|state| state.version.clone())
                .unwrap_or_else(|| remote_version.clone())
        } else if remote_version.is_empty() {
            INITIAL_VERSION.to_string()
        } else {
            remote_version.clone()
        };
        publishable_skills.push(SkillHubPublishableSkill {
            name: skill.name,
            description: skill.description,
            local_path,
            management_owner: skill.instance.management_owner,
            source_label: skill.source_label,
            source_type: skill.source_type,
            source_url: skill.source_url,
            remote_updated_at: skill.remote_updated_at,
            local_updated_at: skill.local_updated_at,
            last_editor: skill.last_editor,
            git_linked: skill.git_linked,
            local_change_count: skill.local_change_count,
            update_file_count: 0,
            local_content_hash: content_hash,
            file_count: files.len(),
            package_size,
            remote_skill_id: remote
                .as_ref()
                .map(|state| state.slug.clone())
                .or_else(|| published.as_ref().map(|state| state.slug.clone()))
                .or_else(|| pending.as_ref().map(|state| state.slug.clone()))
                .unwrap_or_default(),
            remote_version,
            last_published_at: published
                .as_ref()
                .map(|state| state.last_published_at.clone())
                .or_else(|| remote.as_ref().map(|state| state.last_published_at.clone()))
                .unwrap_or_default(),
            publish_status,
            failure_reason: remote
                .as_ref()
                .filter(|state| remote_skill_is_failed(state))
                .map(|state| state.failure_reason.clone())
                .unwrap_or_default(),
            market_url: remote
                .as_ref()
                .filter(|state| remote_skill_is_published(state))
                .map(market_url_for_remote_skill)
                .or_else(|| published.as_ref().map(|state| state.market_url.clone()))
                .unwrap_or_default(),
            target_version,
        });
    }
    if did_reconcile_state {
        save_publish_state(&publish_state)?;
    }
    publishable_skills.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(publishable_skills)
}

fn publish_state_path() -> Result<PathBuf, String> {
    workspace::workspace_file_path(PUBLISH_STATE_FILE_NAME)
}

fn load_publish_state() -> SkillHubPublishState {
    let Ok(path) = publish_state_path() else {
        return SkillHubPublishState::default();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return SkillHubPublishState::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_publish_state(state: &SkillHubPublishState) -> Result<(), String> {
    let path = publish_state_path()?;
    let payload = serde_json::to_string_pretty(state)
        .map_err(|error| format!("序列化 SkillHub 发布状态失败: {error}"))?;
    fs::write(path, payload).map_err(|error| format!("保存 SkillHub 发布状态失败: {error}"))
}

async fn fetch_remote_published_skills(
    credential: &SkillHubCredential,
) -> Result<Vec<RemoteSkillHubSkill>, RemoteSkillHubFetchError> {
    let client =
        crate::commands::marketplace_http_client().map_err(RemoteSkillHubFetchError::Request)?;
    let response = client
        .get(format!(
            "{API_BASE_URL}{DASHBOARD_SKILLS_PATH}?page=1&pageSize={DASHBOARD_SKILLS_PAGE_SIZE}"
        ))
        .bearer_auth(&credential.token)
        .send()
        .await
        .map_err(|error| {
            RemoteSkillHubFetchError::Request(format!("读取 SkillHub 发布列表失败: {error}"))
        })?;
    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        return Err(RemoteSkillHubFetchError::AuthorizationRequired);
    }
    let status = response.status();
    let body = response.text().await.map_err(|error| {
        RemoteSkillHubFetchError::Request(format!("读取 SkillHub 发布列表响应失败: {error}"))
    })?;
    if !status.is_success() {
        let reason = extract_remote_error_message(&body);
        let message = if reason.is_empty() {
            format!("读取 SkillHub 发布列表失败（HTTP {status}）。")
        } else {
            reason
        };
        return Err(RemoteSkillHubFetchError::Request(message));
    }
    let payload = serde_json::from_str::<serde_json::Value>(&body).map_err(|error| {
        RemoteSkillHubFetchError::Request(format!("解析 SkillHub 发布列表失败: {error}"))
    })?;
    Ok(collect_remote_skills(&payload))
}

async fn enrich_remote_skill_file_diffs(
    skills: &mut [SkillHubPublishableSkill],
    credential: &SkillHubCredential,
    force_refresh: bool,
) -> String {
    let candidates = skills
        .iter()
        .enumerate()
        .filter_map(|(index, skill)| {
            if !matches!(
                skill.publish_status.as_str(),
                "published" | "update-available"
            ) || skill.remote_skill_id.trim().is_empty()
                || skill.remote_version.trim().is_empty()
            {
                return None;
            }
            Some((
                index,
                skill.local_path.clone(),
                skill.remote_skill_id.clone(),
                skill.remote_version.clone(),
            ))
        })
        .collect::<Vec<_>>();
    let mut errors = Vec::new();
    for batch in candidates.chunks(REMOTE_PACKAGE_CONCURRENCY) {
        let tasks = batch
            .iter()
            .map(|(index, local_path, slug, version)| {
                let credential = credential.clone();
                let local_path = local_path.clone();
                let slug = slug.clone();
                let version = version.clone();
                let index = *index;
                tauri::async_runtime::spawn(async move {
                    let remote_files =
                        load_remote_skill_files(&credential, &slug, &version, force_refresh)
                            .await?;
                    let changes = build_skillhub_publish_update_changes(
                        Path::new(&local_path),
                        remote_files,
                    )?;
                    Ok::<_, String>((index, changes.len()))
                })
            })
            .collect::<Vec<_>>();
        for task in tasks {
            match task.await {
                Ok(Ok((index, update_file_count))) => {
                    let Some(skill) = skills.get_mut(index) else {
                        continue;
                    };
                    skill.update_file_count = update_file_count;
                    if update_file_count > 0 {
                        skill.publish_status = "update-available".to_string();
                        skill.target_version = next_patch_version(&skill.remote_version);
                    } else if skill.publish_status == "update-available" {
                        skill.publish_status = "published".to_string();
                        skill.target_version = skill.remote_version.clone();
                    }
                }
                Ok(Err(error)) => errors.push(error),
                Err(error) => errors.push(format!("计算 SkillHub 发布更新失败: {error}")),
            }
        }
    }
    errors.into_iter().next().unwrap_or_default()
}

async fn load_remote_skill_files(
    credential: &SkillHubCredential,
    slug: &str,
    version: &str,
    force_refresh: bool,
) -> Result<Vec<(String, Vec<u8>)>, String> {
    let key = RemotePackageCacheKey {
        slug: slug.trim().to_string(),
        version: version.trim().to_string(),
    };
    if key.slug.is_empty() || key.version.is_empty() {
        return Err("缺少 SkillHub 商店版本，无法比较发布更新。".to_string());
    }
    if force_refresh {
        invalidate_remote_package_cache(&key.slug);
    } else if let Some(files) = cached_remote_skill_files(&key) {
        return Ok(files);
    }

    let client = crate::commands::marketplace_http_client()?;
    let files_url = skillhub_api_url(
        &format!("/api/v1/skills/{}/files", key.slug),
        &[("version", &key.version)],
    )?;
    let response = client
        .get(files_url)
        .bearer_auth(&credential.token)
        .send()
        .await
        .map_err(|error| format!("读取 SkillHub 商店文件列表失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("读取 SkillHub 商店文件列表失败: {error}"))?;
    let payload = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("解析 SkillHub 商店文件列表失败: {error}"))?;
    let paths = collect_remote_file_paths(&payload);
    if paths.is_empty() || !paths.iter().any(|path| path == "SKILL.md") {
        return Err("SkillHub 商店版本未返回有效文件列表。".to_string());
    }

    let mut files = Vec::new();
    for path in paths {
        let file_url = skillhub_api_url(
            &format!("/api/v1/skills/{}/file", key.slug),
            &[("path", path.as_str()), ("version", key.version.as_str())],
        )?;
        let content = client
            .get(file_url)
            .bearer_auth(&credential.token)
            .send()
            .await
            .map_err(|error| format!("读取 SkillHub 商店文件失败: {error}"))?
            .error_for_status()
            .map_err(|error| format!("读取 SkillHub 商店文件失败: {error}"))?
            .bytes()
            .await
            .map_err(|error| format!("读取 SkillHub 商店文件内容失败: {error}"))?
            .to_vec();
        files.push((path, content));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    cache_remote_skill_files(key, files.clone());
    Ok(files)
}

fn skillhub_api_url(path: &str, query: &[(&str, &str)]) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(&format!("{API_BASE_URL}{path}"))
        .map_err(|error| format!("构建 SkillHub 请求地址失败: {error}"))?;
    url.query_pairs_mut().extend_pairs(query.iter().copied());
    Ok(url)
}

fn collect_remote_file_paths(payload: &serde_json::Value) -> Vec<String> {
    let Some(files) = payload.get("files").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut paths = files
        .iter()
        .filter_map(|file| {
            file.as_str().map(str::to_string).or_else(|| {
                file.get("path")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
        })
        .filter(|path| is_safe_remote_file_path(path))
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    paths
}

fn is_safe_remote_file_path(path: &str) -> bool {
    !path.trim().is_empty()
        && !path.starts_with('/')
        && !path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
}

fn build_skillhub_publish_update_changes(
    local_path: &Path,
    remote_files: Vec<(String, Vec<u8>)>,
) -> Result<Vec<GitChangeFile>, String> {
    let local_files = collect_skill_files(local_path)?
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    let remote_files = remote_files.into_iter().collect::<BTreeMap<_, _>>();
    let paths = local_files
        .keys()
        .chain(remote_files.keys())
        .cloned()
        .collect::<BTreeSet<_>>();

    Ok(paths
        .into_iter()
        .filter_map(|path| {
            let local = local_files.get(&path);
            let remote = remote_files.get(&path);
            if local == remote {
                return None;
            }
            let status = match (remote, local) {
                (None, Some(_)) => "A",
                (Some(_), None) => "D",
                (Some(_), Some(_)) => "M",
                (None, None) => return None,
            };
            Some(GitChangeFile {
                path,
                status: status.to_string(),
                diff: String::new(),
                staged_diff: String::new(),
                unstaged_diff: String::new(),
                original_content: remote.and_then(preview_text_content),
                current_content: local.and_then(preview_text_content),
            })
        })
        .collect())
}

fn preview_text_content(content: &Vec<u8>) -> Option<String> {
    if content.contains(&0) {
        return None;
    }
    String::from_utf8(content.clone()).ok()
}

fn validate_publish_relative_path(relative_path: &str) -> Result<(), String> {
    let path = Path::new(relative_path);
    let has_only_normal_components = path
        .components()
        .all(|component| matches!(component, std::path::Component::Normal(_)));
    if relative_path.trim().is_empty() || path.is_absolute() || !has_only_normal_components {
        return Err("待回退文件路径无效。".to_string());
    }
    Ok(())
}

fn write_publish_update_content(
    skill_root: &Path,
    relative_path: &str,
    expected_content: &str,
    content: &str,
) -> Result<(), String> {
    let canonical_root = skill_root
        .canonicalize()
        .map_err(|error| format!("解析本地 Skill 目录失败: {error}"))?;
    let target = canonical_root.join(relative_path);
    validate_publish_target(&canonical_root, &target)?;
    let current_content = if target.exists() {
        fs::read_to_string(&target).map_err(|error| format!("读取待回退文件失败: {error}"))?
    } else {
        String::new()
    };
    if current_content != expected_content {
        return Err("文件内容已变化，请刷新后重试。".to_string());
    }

    let parent = target
        .parent()
        .ok_or_else(|| "待回退文件缺少父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建待回退文件目录失败: {error}"))?;
    validate_publish_target(&canonical_root, &target)?;
    fs::write(&target, content).map_err(|error| format!("回退发布变更块失败: {error}"))
}

fn validate_publish_target(canonical_root: &Path, target: &Path) -> Result<(), String> {
    let mut existing = target;
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| "待回退文件路径超出 Skill 目录。".to_string())?;
    }
    let canonical_existing = existing
        .canonicalize()
        .map_err(|error| format!("解析待回退文件路径失败: {error}"))?;
    if !canonical_existing.starts_with(canonical_root) {
        return Err("待回退文件路径超出 Skill 目录。".to_string());
    }
    if target.exists() {
        let metadata = fs::symlink_metadata(target)
            .map_err(|error| format!("读取待回退文件属性失败: {error}"))?;
        if metadata.file_type().is_symlink() || metadata.is_dir() {
            return Err("仅支持回退普通文件。".to_string());
        }
    }
    Ok(())
}

fn cached_remote_skill_files(key: &RemotePackageCacheKey) -> Option<Vec<(String, Vec<u8>)>> {
    REMOTE_PACKAGE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?
        .get(key)
        .cloned()
}

fn cache_remote_skill_files(key: RemotePackageCacheKey, files: Vec<(String, Vec<u8>)>) {
    if let Ok(mut cache) = REMOTE_PACKAGE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        cache.insert(key, files);
    }
}

fn invalidate_remote_package_cache(slug: &str) {
    if let Some(cache) = REMOTE_PACKAGE_CACHE.get() {
        if let Ok(mut cache) = cache.lock() {
            cache.retain(|key, _| key.slug != slug.trim());
        }
    }
}

fn collect_remote_skills(payload: &serde_json::Value) -> Vec<RemoteSkillHubSkill> {
    for key in ["skills", "items", "list"] {
        if let Some(items) = payload.get(key).and_then(serde_json::Value::as_array) {
            return items.iter().filter_map(remote_skill_from_value).collect();
        }
    }
    if let Some(data) = payload.get("data") {
        let skills = collect_remote_skills(data);
        if !skills.is_empty() {
            return skills;
        }
    }
    payload
        .get("skill")
        .and_then(remote_skill_from_value)
        .into_iter()
        .collect()
}

fn remote_skill_from_value(value: &serde_json::Value) -> Option<RemoteSkillHubSkill> {
    let slug = value_string(value, &["slug", "id"]);
    if slug.is_empty() {
        return None;
    }
    Some(RemoteSkillHubSkill {
        slug,
        current_version: value_string(
            value,
            &["currentVersion", "latestApprovedVersion", "version"],
        ),
        last_published_at: value_string(
            value,
            &["publishedAt", "lastPublishedAt", "updatedAt", "createdAt"],
        ),
        status: value_string(value, &["status"]),
        review_status: value_string(value, &["reviewStatus", "publishStatus"]),
        failure_reason: value_string(value, &["failureReason", "reviewNote", "errorMessage"]),
        market_url: value_string(value, &["marketUrl", "market_url", "url", "detailUrl"]),
    })
}

fn value_string(value: &serde_json::Value, keys: &[&str]) -> String {
    for key in keys {
        let Some(candidate) = value.get(key) else {
            continue;
        };
        if let Some(text) = candidate.as_str() {
            return text.trim().to_string();
        }
        if let Some(number) = candidate.as_number() {
            return number.to_string();
        }
        if let Some(version) = candidate.get("version").and_then(serde_json::Value::as_str) {
            return version.trim().to_string();
        }
    }
    String::new()
}

fn extract_remote_error_message(body: &str) -> String {
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(body) else {
        return body.trim().to_string();
    };
    ["message", "error", "errorMessage"]
        .into_iter()
        .find_map(|key| payload.get(key).and_then(serde_json::Value::as_str))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn resolve_publish_status(
    remote: Option<&RemoteSkillHubSkill>,
    pending: Option<&PendingSkillState>,
    published: Option<&PublishedSkillState>,
    local_content_hash: &str,
) -> String {
    if let Some(remote) = remote {
        if remote_skill_is_failed(remote) {
            return "failed".to_string();
        }
        if remote_skill_is_pending(remote) {
            return "reviewing".to_string();
        }
        if let Some(pending) = pending {
            if !remote_version_matches(&remote.current_version, &pending.version) {
                return "publishing".to_string();
            }
        }
        if published.is_some_and(|state| state.content_hash != local_content_hash) {
            return "update-available".to_string();
        }
        return "published".to_string();
    }
    if pending.is_some() {
        return "publishing".to_string();
    }
    match published {
        Some(state) if state.content_hash == local_content_hash => "published".to_string(),
        Some(_) => "update-available".to_string(),
        None => "unpublished".to_string(),
    }
}

fn remote_skill_is_published(remote: &RemoteSkillHubSkill) -> bool {
    !remote_skill_is_failed(remote) && !remote_skill_is_pending(remote)
}

fn remote_skill_is_pending(remote: &RemoteSkillHubSkill) -> bool {
    matches!(
        remote.review_status.trim().to_lowercase().as_str(),
        "pending" | "security_review" | "admin_review" | "platform_review" | "reviewing"
    ) || matches!(
        remote.status.trim().to_lowercase().as_str(),
        "draft" | "parsing" | "parsed" | "processing" | "publishing"
    )
}

fn remote_skill_is_failed(remote: &RemoteSkillHubSkill) -> bool {
    matches!(
        remote.review_status.trim().to_lowercase().as_str(),
        "rejected" | "security_rejected" | "admin_rejected" | "platform_rejected"
    ) || matches!(
        remote.status.trim().to_lowercase().as_str(),
        "failed" | "rejected" | "error"
    )
}

fn remote_version_matches(left: &str, right: &str) -> bool {
    left.trim().trim_start_matches(['v', 'V']) == right.trim().trim_start_matches(['v', 'V'])
}

fn market_url_for_remote_skill(remote: &RemoteSkillHubSkill) -> String {
    let market_url = remote.market_url.trim();
    if market_url.starts_with('/') {
        return format!("https://skillhub.cn{market_url}");
    }
    if !market_url.is_empty() {
        return market_url.to_string();
    }
    format!(
        "https://skillhub.cn{MARKET_SKILL_URL_PREFIX}{}",
        remote.slug
    )
}

fn skill_description_for_publish(path: &Path, skill_name: &str) -> Result<String, String> {
    let content = fs::read_to_string(path.join("SKILL.md"))
        .map_err(|error| format!("读取 Skill 描述失败: {error}"))?;
    let description = content.lines().find_map(|line| {
        line.strip_prefix("description:").map(|value| {
            value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string()
        })
    });
    Ok(description.unwrap_or_else(|| format!("{skill_name} Skill")))
}

fn normalize_slug(value: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;
    for character in value.trim().chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            slug.push(character);
            previous_dash = false;
        } else if character.is_ascii_uppercase() {
            slug.push(character.to_ascii_lowercase());
            previous_dash = false;
        } else if !slug.is_empty() && !previous_dash {
            slug.push('-');
            previous_dash = true;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "skill".to_string()
    } else {
        slug
    }
}

fn next_patch_version(version: &str) -> String {
    let mut parts = version.split('.').map(str::parse::<u64>);
    let major = parts.next().and_then(Result::ok).unwrap_or(1);
    let minor = parts.next().and_then(Result::ok).unwrap_or(0);
    let patch = parts
        .next()
        .and_then(Result::ok)
        .unwrap_or(0)
        .saturating_add(1);
    format!("{major}.{minor}.{patch}")
}

fn collect_skill_files(root: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut files = Vec::new();
    let mut total_bytes = 0_u64;
    collect_skill_files_into(root, root, &mut files, &mut total_bytes)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    if !files.iter().any(|(path, _)| path == "SKILL.md") {
        return Err("Skill 根目录缺少 SKILL.md。".to_string());
    }
    Ok(files)
}

fn collect_skill_files_into(
    root: &Path,
    current: &Path,
    files: &mut Vec<(String, Vec<u8>)>,
    total_bytes: &mut u64,
) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| format!("读取 Skill 目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取 Skill 文件失败: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("读取 Skill 元数据失败: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("Skill 不允许包含符号链接：{}", path.display()));
        }
        if metadata.is_dir() {
            collect_skill_files_into(root, &path, files, total_bytes)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if files.len() >= PACKAGE_MAX_FILE_COUNT || metadata.len() > PACKAGE_MAX_FILE_BYTES {
            return Err("Skill 文件数量或单个文件大小超出限制。".to_string());
        }
        *total_bytes = total_bytes.saturating_add(metadata.len());
        if *total_bytes > PACKAGE_MAX_TOTAL_BYTES {
            return Err("Skill 总文件大小超出限制。".to_string());
        }
        let relative_path = path
            .strip_prefix(root)
            .map_err(|_| "Skill 文件路径无效。".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        files.push((
            relative_path,
            fs::read(&path).map_err(|error| format!("读取 Skill 文件失败: {error}"))?,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        build_skillhub_publish_update_changes, disconnected_status, next_patch_version,
        normalize_slug, remote_skill_from_value, resolve_publish_baseline, resolve_publish_status,
        write_publish_update_content, PendingSkillState, PublishedSkillState, RemoteSkillHubSkill,
    };

    fn test_directory(name: &str) -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("skillhub-publishing-{name}-{suffix}"))
    }

    #[test]
    fn disconnected_status_never_contains_a_token() {
        let status = disconnected_status();
        let serialized = serde_json::to_string(&status).expect("serialize status");
        assert!(!serialized.contains("token"));
    }

    #[test]
    fn publish_version_and_slug_are_normalized() {
        assert_eq!(normalize_slug("Skill Creator"), "skill-creator");
        assert_eq!(next_patch_version("1.2.9"), "1.2.10");
    }

    #[test]
    fn uses_dashboard_version_when_the_local_publish_binding_is_missing() {
        let remote = RemoteSkillHubSkill {
            slug: "xhs-wechat-plugin-promo".to_string(),
            current_version: "1.0.1".to_string(),
            ..RemoteSkillHubSkill::default()
        };

        let (slug, version) =
            resolve_publish_baseline("xhs-wechat-plugin-promo", None, None, None, Some(&remote));

        assert_eq!(slug, "xhs-wechat-plugin-promo");
        assert_eq!(version, "1.0.1");
    }

    #[test]
    fn keeps_a_submission_publishing_until_the_matching_remote_version_is_approved() {
        let remote = RemoteSkillHubSkill {
            slug: "skill-creator".to_string(),
            current_version: "1.0.0".to_string(),
            ..RemoteSkillHubSkill::default()
        };
        let pending = PendingSkillState {
            slug: "skill-creator".to_string(),
            version: "1.0.1".to_string(),
            content_hash: "local-hash".to_string(),
            requested_at: "2026-08-01T00:00:00Z".to_string(),
        };

        assert_eq!(
            resolve_publish_status(Some(&remote), Some(&pending), None, "local-hash"),
            "publishing"
        );
    }

    #[test]
    fn marks_a_confirmed_remote_version_as_published_only_when_local_content_matches() {
        let remote = RemoteSkillHubSkill {
            slug: "skill-creator".to_string(),
            current_version: "1.0.1".to_string(),
            review_status: "approved".to_string(),
            ..RemoteSkillHubSkill::default()
        };
        let published = PublishedSkillState {
            slug: "skill-creator".to_string(),
            version: "1.0.1".to_string(),
            content_hash: "published-hash".to_string(),
            last_published_at: "2026-08-01T00:00:00Z".to_string(),
            market_url: "https://skillhub.cn/skills/skill-creator".to_string(),
        };

        assert_eq!(
            resolve_publish_status(Some(&remote), None, Some(&published), "published-hash"),
            "published"
        );
        assert_eq!(
            resolve_publish_status(Some(&remote), None, Some(&published), "changed-hash"),
            "update-available"
        );
    }

    #[test]
    fn keeps_numeric_dashboard_updated_at_as_the_last_published_time() {
        let remote = remote_skill_from_value(&serde_json::json!({
            "slug": "skill-creator",
            "latestApprovedVersion": "1.0.1",
            "updatedAt": 1785636715572_u64,
        }))
        .expect("dashboard skill should be parsed");

        assert_eq!(remote.last_published_at, "1785636715572");
    }

    #[test]
    fn builds_publish_update_diffs_from_store_baseline_to_local_content() {
        let root = test_directory("update-diff");
        fs::create_dir_all(&root).expect("create skill directory");
        fs::write(root.join("SKILL.md"), "local change\n").expect("write local skill");

        let changes = build_skillhub_publish_update_changes(
            &root,
            vec![("SKILL.md".to_string(), b"published content\n".to_vec())],
        )
        .expect("build publish update diff");

        assert_eq!(changes.len(), 1);
        assert_eq!(
            changes[0].original_content.as_deref(),
            Some("published content\n")
        );
        assert_eq!(
            changes[0].current_content.as_deref(),
            Some("local change\n")
        );
        fs::remove_dir_all(root).expect("remove skill directory");
    }

    #[test]
    fn reverts_publish_update_hunk_only_when_local_content_is_current() {
        let root = test_directory("revert-hunk");
        fs::create_dir_all(&root).expect("create skill directory");
        let file = root.join("SKILL.md");
        fs::write(&file, "local change\nsecond line\n").expect("write local skill");

        write_publish_update_content(
            &root,
            "SKILL.md",
            "local change\nsecond line\n",
            "published content\nsecond line\n",
        )
        .expect("revert publish update hunk");
        assert_eq!(
            fs::read_to_string(&file).expect("read reverted skill"),
            "published content\nsecond line\n"
        );

        let error = write_publish_update_content(
            &root,
            "SKILL.md",
            "local change\nsecond line\n",
            "stale content\n",
        )
        .expect_err("reject stale update hunk");
        assert_eq!(error, "文件内容已变化，请刷新后重试。");
        fs::remove_dir_all(root).expect("remove skill directory");
    }
}
