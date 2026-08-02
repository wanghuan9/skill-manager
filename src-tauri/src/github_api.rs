use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};

const GITHUB_API_BASE: &str = "https://api.github.com";
const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_API_VERSION: &str = "2022-11-28";
const OAUTH_CLIENT_ID_ENV: &str = "SKILLDOCK_GITHUB_CLIENT_ID";
// OAuth Client IDs are public identifiers; GitHub Device Flow does not use a client secret.
const DEFAULT_OAUTH_CLIENT_ID: &str = "Ov23livYZ8NWkByWZMLz";
const GITHUB_READ_TIMEOUT: Duration = Duration::from_secs(15);
const GITHUB_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const GITHUB_READ_ATTEMPTS: usize = 3;

pub fn http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("SkillDock")
        .connect_timeout(GITHUB_CONNECT_TIMEOUT)
        .build()
        .map_err(|error| format!("创建 GitHub 请求客户端失败: {error}"))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubProfile {
    pub user_id: u64,
    pub username: String,
    pub avatar_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepository {
    pub owner: String,
    pub name: String,
    pub clone_url: String,
    pub html_url: String,
    pub created: bool,
}

#[derive(Clone, Debug)]
pub struct GithubRepositoryCommit {
    pub commit_id: String,
    pub created_at: String,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct GithubRepositoryFile {
    pub content: Vec<u8>,
    pub sha: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GithubUserResponse {
    id: u64,
    login: String,
    avatar_url: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GithubRepositoryResponse {
    name: String,
    clone_url: String,
    html_url: String,
    private: bool,
    owner: GithubRepositoryOwnerResponse,
}

#[derive(Clone, Debug, Deserialize)]
struct GithubRepositoryOwnerResponse {
    login: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GithubCommitResponse {
    sha: String,
    commit: GithubCommitDetailsResponse,
}

#[derive(Clone, Debug, Deserialize)]
struct GithubCommitDetailsResponse {
    committer: Option<GithubCommitSignatureResponse>,
    author: Option<GithubCommitSignatureResponse>,
    #[serde(default)]
    message: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GithubCommitSignatureResponse {
    date: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GithubContentResponse {
    content: String,
    encoding: String,
    sha: String,
}

fn repository_commit_from_response(response: GithubCommitResponse) -> GithubRepositoryCommit {
    let details = response.commit;
    let message = details.message;
    let created_at = details
        .committer
        .or(details.author)
        .map(|signature| signature.date)
        .unwrap_or_default();
    GithubRepositoryCommit {
        commit_id: response.sha,
        created_at,
        message,
    }
}

fn decode_repository_content(
    response: GithubContentResponse,
) -> Result<GithubRepositoryFile, String> {
    if response.encoding != "base64" {
        return Err(format!("不支持的 GitHub 文件编码: {}", response.encoding));
    }
    let encoded = response.content.replace(['\r', '\n'], "");
    let content = BASE64_STANDARD
        .decode(encoded)
        .map_err(|error| format!("解析 GitHub 文件内容失败: {error}"))?;
    Ok(GithubRepositoryFile {
        content,
        sha: response.sha,
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct DeviceFlowStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Clone, Debug)]
pub enum DevicePollOutcome {
    Pending,
    SlowDown,
    Authorized(String),
}

pub fn oauth_client_id() -> String {
    std::env::var(OAUTH_CLIENT_ID_ENV)
        .ok()
        .or_else(|| option_env!("SKILLDOCK_GITHUB_CLIENT_ID").map(str::to_string))
        .map(|client_id| client_id.trim().to_string())
        .filter(|client_id| !client_id.is_empty())
        .unwrap_or_else(|| DEFAULT_OAUTH_CLIENT_ID.to_string())
}

fn request(client: &Client, method: Method, url: &str, token: &str) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .bearer_auth(token.trim())
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
}

fn repository_api_url(owner: &str, repository: &str, segments: &[&str]) -> Result<Url, String> {
    let mut url = Url::parse(GITHUB_API_BASE)
        .map_err(|error| format!("创建 GitHub API 地址失败: {error}"))?;
    url.path_segments_mut()
        .map_err(|_| "创建 GitHub API 地址失败".to_string())?
        .extend(["repos", owner.trim(), repository.trim()])
        .extend(segments.iter().copied());
    Ok(url)
}

fn read_api_error(operation: &str, status: StatusCode, rate_limited: bool) -> String {
    if status == StatusCode::UNAUTHORIZED {
        return "GitHub 登录已失效，请重新连接 GitHub".to_string();
    }
    if status == StatusCode::FORBIDDEN && rate_limited {
        return "GitHub API 配额已用尽，请稍后重试或重新连接 GitHub".to_string();
    }
    format!("{operation}失败: HTTP {status}")
}

fn response_is_rate_limited(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|value| value.to_str().ok())
        == Some("0")
}

fn format_read_request_error(operation: &str, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return format!("{operation}失败: GitHub 请求超时，请检查网络后重试");
    }
    if error.is_connect() {
        return format!("{operation}失败: 无法连接 GitHub，请检查网络后重试");
    }
    format!("{operation}失败: {error}")
}

async fn send_read_request(
    request: reqwest::RequestBuilder,
    operation: &str,
) -> Result<reqwest::Response, String> {
    for attempt in 0..GITHUB_READ_ATTEMPTS {
        let Some(request) = request.try_clone() else {
            return Err(format!("{operation}失败: 无法重试 GitHub 请求"));
        };
        match request.send().await {
            Ok(response) => return Ok(response),
            Err(error)
                if attempt + 1 < GITHUB_READ_ATTEMPTS
                    && (error.is_timeout() || error.is_connect()) => {}
            Err(error) => return Err(format_read_request_error(operation, &error)),
        }
    }
    Err(format!("{operation}失败: GitHub 请求未完成"))
}

pub async fn list_repository_commits(
    client: &Client,
    token: &str,
    owner: &str,
    repository: &str,
    limit: usize,
) -> Result<Vec<GithubRepositoryCommit>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut url = repository_api_url(owner, repository, &["commits"])?;
    let per_page = limit.min(100).to_string();
    url.query_pairs_mut()
        .append_pair("sha", "main")
        .append_pair("per_page", &per_page);
    let response = send_read_request(
        request(client, Method::GET, url.as_str(), token).timeout(GITHUB_READ_TIMEOUT),
        "读取云端备份历史",
    )
    .await?;
    if matches!(
        response.status(),
        StatusCode::NOT_FOUND | StatusCode::CONFLICT
    ) {
        return Ok(Vec::new());
    }
    if response.status() != StatusCode::OK {
        let error = read_api_error(
            "读取云端备份历史",
            response.status(),
            response_is_rate_limited(&response),
        );
        return Err(error);
    }
    let commits = response
        .json::<Vec<GithubCommitResponse>>()
        .await
        .map_err(|error| format!("解析云端备份历史失败: {error}"))?;
    Ok(commits
        .into_iter()
        .map(repository_commit_from_response)
        .collect())
}

pub async fn fetch_repository_file_at_commit(
    client: &Client,
    token: &str,
    owner: &str,
    repository: &str,
    commit_id: &str,
    path: &str,
) -> Result<Option<Vec<u8>>, String> {
    let path_segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mut segments = vec!["contents"];
    segments.extend(path_segments);
    let mut url = repository_api_url(owner, repository, &segments)?;
    url.query_pairs_mut().append_pair("ref", commit_id);
    let response = send_read_request(
        request(client, Method::GET, url.as_str(), token)
            .header("Accept", "application/vnd.github.raw+json")
            .timeout(GITHUB_READ_TIMEOUT),
        "读取云端备份节点",
    )
    .await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if response.status() != StatusCode::OK {
        let error = read_api_error(
            "读取云端备份节点",
            response.status(),
            response_is_rate_limited(&response),
        );
        return Err(error);
    }
    response
        .bytes()
        .await
        .map(|bytes| Some(bytes.to_vec()))
        .map_err(|error| format!("读取云端备份节点失败: {error}"))
}

pub async fn fetch_repository_file(
    client: &Client,
    token: &str,
    owner: &str,
    repository: &str,
    reference: &str,
    path: &str,
) -> Result<Option<GithubRepositoryFile>, String> {
    let path_segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mut segments = vec!["contents"];
    segments.extend(path_segments);
    let mut url = repository_api_url(owner, repository, &segments)?;
    url.query_pairs_mut().append_pair("ref", reference);
    let response = send_read_request(
        request(client, Method::GET, url.as_str(), token).timeout(GITHUB_READ_TIMEOUT),
        "读取云端备份控制信息",
    )
    .await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if response.status() != StatusCode::OK {
        let error = read_api_error(
            "读取云端备份控制信息",
            response.status(),
            response_is_rate_limited(&response),
        );
        return Err(error);
    }
    let content = response
        .json::<GithubContentResponse>()
        .await
        .map_err(|error| format!("解析云端备份控制信息失败: {error}"))?;
    decode_repository_content(content).map(Some)
}

pub async fn update_repository_file(
    client: &Client,
    token: &str,
    owner: &str,
    repository: &str,
    path: &str,
    message: &str,
    content: &[u8],
    sha: Option<&str>,
) -> Result<bool, String> {
    let path_segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mut segments = vec!["contents"];
    segments.extend(path_segments);
    let url = repository_api_url(owner, repository, &segments)?;
    let mut payload = serde_json::json!({
        "message": message,
        "content": BASE64_STANDARD.encode(content),
        "branch": "main"
    });
    if let Some(sha) = sha.filter(|sha| !sha.trim().is_empty()) {
        payload["sha"] = serde_json::Value::String(sha.to_string());
    }
    let response = request(client, Method::PUT, url.as_str(), token)
        .timeout(GITHUB_READ_TIMEOUT)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("保存云端备份控制信息失败: {error}"))?;
    if response.status() == StatusCode::CONFLICT {
        return Ok(false);
    }
    if !matches!(response.status(), StatusCode::OK | StatusCode::CREATED) {
        let error = read_api_error(
            "保存云端备份控制信息",
            response.status(),
            response_is_rate_limited(&response),
        );
        return Err(error);
    }
    Ok(true)
}

pub async fn fetch_profile(client: &Client, token: &str) -> Result<GithubProfile, String> {
    let response = request(
        client,
        Method::GET,
        &format!("{GITHUB_API_BASE}/user"),
        token,
    )
    .send()
    .await
    .map_err(|error| format!("连接 GitHub 失败: {error}"))?;
    match response.status() {
        StatusCode::OK => {
            let user = response
                .json::<GithubUserResponse>()
                .await
                .map_err(|error| format!("解析 GitHub 账户失败: {error}"))?;
            Ok(GithubProfile {
                user_id: user.id,
                username: user.login,
                avatar_url: user.avatar_url,
            })
        }
        StatusCode::UNAUTHORIZED => Err("GitHub Token 无效或已失效".to_string()),
        StatusCode::FORBIDDEN => {
            Err("GitHub 拒绝了账户验证请求，请检查 Token 权限或限流状态".to_string())
        }
        status => Err(format!("GitHub 账户验证失败: HTTP {status}")),
    }
}

fn validate_repository_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 100
        || name == "."
        || name == ".."
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err("GitHub 备份仓库名称无效".to_string());
    }
    Ok(name)
}

fn repository_from_response(
    response: GithubRepositoryResponse,
    created: bool,
) -> Result<GithubRepository, String> {
    if !response.private {
        return Err("备份仓库必须是私有仓库".to_string());
    }
    Ok(GithubRepository {
        owner: response.owner.login,
        name: response.name,
        clone_url: response.clone_url,
        html_url: response.html_url,
        created,
    })
}

pub async fn ensure_private_backup_repository(
    client: &Client,
    token: &str,
    repository_name: &str,
) -> Result<GithubRepository, String> {
    let repository_name = validate_repository_name(repository_name)?;
    let profile = fetch_profile(client, token).await?;
    let repository_url = format!(
        "{GITHUB_API_BASE}/repos/{}/{}",
        profile.username, repository_name
    );
    let response = request(client, Method::GET, &repository_url, token)
        .send()
        .await
        .map_err(|error| format!("查询 GitHub 备份仓库失败: {error}"))?;
    if response.status() == StatusCode::OK {
        let repository = response
            .json::<GithubRepositoryResponse>()
            .await
            .map_err(|error| format!("解析 GitHub 备份仓库失败: {error}"))?;
        return repository_from_response(repository, false);
    }
    if response.status() != StatusCode::NOT_FOUND {
        return Err(format!(
            "查询 GitHub 备份仓库失败: HTTP {}",
            response.status()
        ));
    }

    let response = request(
        client,
        Method::POST,
        &format!("{GITHUB_API_BASE}/user/repos"),
        token,
    )
    .json(&serde_json::json!({
        "name": repository_name,
        "private": true,
        "auto_init": false,
        "description": "SkillDock multi-device backup"
    }))
    .send()
    .await
    .map_err(|error| format!("创建 GitHub 备份仓库失败: {error}"))?;
    if response.status() != StatusCode::CREATED {
        return Err(match response.status() {
            StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => {
                "GitHub Token 缺少创建私有仓库的权限".to_string()
            }
            status => format!("创建 GitHub 备份仓库失败: HTTP {status}"),
        });
    }
    let repository = response
        .json::<GithubRepositoryResponse>()
        .await
        .map_err(|error| format!("解析新建 GitHub 备份仓库失败: {error}"))?;
    repository_from_response(repository, true)
}

pub async fn start_device_flow(
    client: &Client,
    backup_scope: bool,
) -> Result<DeviceFlowStart, String> {
    let client_id = oauth_client_id();
    let scope = if backup_scope { "repo" } else { "" };
    let response = client
        .post(GITHUB_DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.as_str()), ("scope", scope)])
        .send()
        .await
        .map_err(|error| format!("启动 GitHub 登录失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("启动 GitHub 登录失败: HTTP {}", response.status()));
    }
    response
        .json::<DeviceFlowStart>()
        .await
        .map_err(|error| format!("解析 GitHub 登录信息失败: {error}"))
}

pub async fn poll_device_flow(
    client: &Client,
    device_code: &str,
) -> Result<DevicePollOutcome, String> {
    let client_id = oauth_client_id();
    let response = client
        .post(GITHUB_ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("device_code", device_code.trim()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|error| format!("查询 GitHub 登录状态失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "查询 GitHub 登录状态失败: HTTP {}",
            response.status()
        ));
    }
    let payload = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("解析 GitHub 登录状态失败: {error}"))?;
    if let Some(error) = payload.get("error").and_then(serde_json::Value::as_str) {
        return match error {
            "authorization_pending" => Ok(DevicePollOutcome::Pending),
            "slow_down" => Ok(DevicePollOutcome::SlowDown),
            "expired_token" => Err("GitHub 登录验证码已过期，请重新登录".to_string()),
            "access_denied" => Err("已在 GitHub 取消授权".to_string()),
            _ => Err(format!("GitHub 登录失败: {error}")),
        };
    }
    let token = payload
        .get("access_token")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "GitHub 登录响应缺少访问凭据".to_string())?;
    Ok(DevicePollOutcome::Authorized(token.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        decode_repository_content, oauth_client_id, repository_api_url,
        repository_commit_from_response, DeviceFlowStart, GithubCommitResponse,
        GithubContentResponse, DEFAULT_OAUTH_CLIENT_ID,
    };

    #[test]
    fn uses_default_oauth_client_id() {
        if option_env!("SKILLDOCK_GITHUB_CLIENT_ID").is_none()
            && std::env::var_os("SKILLDOCK_GITHUB_CLIENT_ID").is_none()
        {
            assert_eq!(oauth_client_id(), DEFAULT_OAUTH_CLIENT_ID);
        }
    }

    #[test]
    fn parses_github_device_flow_and_serializes_for_frontend() {
        let payload = r#"{
            "device_code": "device-code",
            "user_code": "user-code",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 900,
            "interval": 5
        }"#;

        let device_flow =
            serde_json::from_str::<DeviceFlowStart>(payload).expect("parse device flow");
        let frontend_payload = serde_json::to_value(device_flow).expect("serialize device flow");

        assert_eq!(frontend_payload["deviceCode"], "device-code");
        assert_eq!(
            frontend_payload["verificationUri"],
            "https://github.com/login/device"
        );
    }

    #[test]
    fn builds_repository_api_url() {
        let url = repository_api_url(
            "wh1024k",
            "skilldock-backup",
            &["contents", ".skilldock", "snapshot.json"],
        )
        .expect("build repository API URL");

        assert_eq!(
            url.as_str(),
            "https://api.github.com/repos/example-user/skilldock-backup/contents/.skilldock/snapshot.json"
        );
    }

    #[test]
    fn maps_repository_commit_with_author_date_fallback() {
        let payload = r#"{
            "sha": "0123456789012345678901234567890123456789",
            "commit": {
                "message": "SkillDock backup",
                "committer": null,
                "author": { "date": "2026-07-31T12:00:00Z" }
            }
        }"#;
        let response =
            serde_json::from_str::<GithubCommitResponse>(payload).expect("parse commit response");

        let commit = repository_commit_from_response(response);

        assert_eq!(commit.commit_id, "0123456789012345678901234567890123456789");
        assert_eq!(commit.created_at, "2026-07-31T12:00:00Z");
        assert_eq!(commit.message, "SkillDock backup");
    }

    #[test]
    fn decodes_repository_file_content() {
        let file = decode_repository_content(GithubContentResponse {
            content: "aGVs\nbG8=".to_string(),
            encoding: "base64".to_string(),
            sha: "blob-sha".to_string(),
        })
        .expect("decode repository content");

        assert_eq!(file.content, b"hello");
        assert_eq!(file.sha, "blob-sha");
    }
}
