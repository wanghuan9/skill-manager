use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};

const GITHUB_API_BASE: &str = "https://api.github.com";
const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_API_VERSION: &str = "2022-11-28";
const OAUTH_CLIENT_ID_ENV: &str = "SKILLDOCK_GITHUB_CLIENT_ID";

pub fn http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("SkillDock")
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

#[derive(Clone, Debug, Deserialize)]
struct GithubUserResponse {
    id: u64,
    login: String,
    avatar_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
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

pub fn oauth_client_id() -> Result<String, String> {
    std::env::var(OAUTH_CLIENT_ID_ENV)
        .ok()
        .or_else(|| option_env!("SKILLDOCK_GITHUB_CLIENT_ID").map(str::to_string))
        .map(|client_id| client_id.trim().to_string())
        .filter(|client_id| !client_id.is_empty())
        .ok_or_else(|| "未配置 SkillDock GitHub OAuth Client ID".to_string())
}

fn request(client: &Client, method: Method, url: &str, token: &str) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .bearer_auth(token.trim())
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
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

pub async fn start_device_flow(
    client: &Client,
    backup_scope: bool,
) -> Result<DeviceFlowStart, String> {
    let client_id = oauth_client_id()?;
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
    let client_id = oauth_client_id()?;
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
    use super::oauth_client_id;

    #[test]
    fn reports_missing_oauth_client_id() {
        if option_env!("SKILLDOCK_GITHUB_CLIENT_ID").is_none()
            && std::env::var_os("SKILLDOCK_GITHUB_CLIENT_ID").is_none()
        {
            assert_eq!(
                oauth_client_id(),
                Err("未配置 SkillDock GitHub OAuth Client ID".to_string())
            );
        }
    }
}
