use serde::Serialize;
use tauri::Emitter;

use crate::github_api::{self, DevicePollOutcome, GithubProfile};
use crate::github_credentials;
use crate::models::{GithubConnection, GithubConnectionMetadata};
use crate::state::{
    load_github_connection_metadata, load_legacy_github_token, save_github_connection_metadata,
};

const AUTH_METHOD_OAUTH: &str = "oauth";
const AUTH_METHOD_PAT: &str = "pat";
const DEVICE_STATUS_PENDING: &str = "pending";
const DEVICE_STATUS_SLOW_DOWN: &str = "slowDown";
const DEVICE_STATUS_AUTHORIZED: &str = "authorized";
const GITHUB_CONNECTION_CHANGED_EVENT: &str = "github-connection-changed";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDevicePollResult {
    pub status: String,
    pub connection: Option<GithubConnection>,
}

fn disconnected_connection(warning: impl Into<String>) -> GithubConnection {
    GithubConnection {
        connected: false,
        auth_method: String::new(),
        user_id: None,
        username: String::new(),
        avatar_url: String::new(),
        credential_persisted: false,
        warning: warning.into(),
    }
}

fn connected_connection(
    metadata: GithubConnectionMetadata,
    credential_persisted: bool,
    warning: impl Into<String>,
) -> GithubConnection {
    GithubConnection {
        connected: true,
        auth_method: metadata.auth_method,
        user_id: metadata.user_id,
        username: metadata.username,
        avatar_url: metadata.avatar_url,
        credential_persisted,
        warning: warning.into(),
    }
}

fn metadata_from_profile(
    profile: GithubProfile,
    auth_method: &str,
    credential_persisted: bool,
) -> GithubConnectionMetadata {
    GithubConnectionMetadata {
        auth_method: auth_method.to_string(),
        user_id: Some(profile.user_id),
        username: profile.username,
        avatar_url: profile.avatar_url,
        credential_persisted,
    }
}

async fn connect_with_token(token: &str, auth_method: &str) -> Result<GithubConnection, String> {
    let client = github_api::http_client()?;
    let profile = github_api::fetch_profile(&client, token).await?;
    github_credentials::store_credential(token, auth_method)?;
    let metadata = metadata_from_profile(profile, auth_method, true);
    save_github_connection_metadata(metadata.clone(), true)?;
    if let Some(user_id) = metadata.user_id {
        crate::backup_repository::reconcile_backup_preference_after_login(
            user_id,
            &metadata.username,
        )?;
    }
    Ok(connected_connection(metadata, true, ""))
}

async fn migrate_legacy_token() -> Result<Option<GithubConnection>, String> {
    let legacy_token = load_legacy_github_token();
    if legacy_token.is_empty() {
        return Ok(None);
    }
    let client = github_api::http_client()?;
    let profile = github_api::fetch_profile(&client, &legacy_token).await?;
    github_credentials::store_credential(&legacy_token, AUTH_METHOD_PAT)?;
    let metadata = metadata_from_profile(profile, AUTH_METHOD_PAT, true);
    save_github_connection_metadata(metadata.clone(), true)?;
    if let Some(user_id) = metadata.user_id {
        crate::backup_repository::reconcile_backup_preference_after_login(
            user_id,
            &metadata.username,
        )?;
    }
    Ok(Some(connected_connection(metadata, true, "")))
}

pub async fn migrate_legacy_token_on_startup(app_handle: tauri::AppHandle) {
    match migrate_legacy_token().await {
        Ok(Some(connection)) => {
            let _ = app_handle.emit(GITHUB_CONNECTION_CHANGED_EVENT, connection);
        }
        Ok(None) => {}
        Err(error) => {
            log::warn!("GitHub credential migration failed: {error}");
        }
    }
}

#[tauri::command]
pub async fn get_github_connection() -> Result<GithubConnection, String> {
    let metadata = load_github_connection_metadata();
    if metadata.username.trim().is_empty() || github_credentials::load_credential().is_none() {
        return Ok(disconnected_connection(""));
    }
    let credential_persisted = metadata.credential_persisted;
    Ok(connected_connection(metadata, credential_persisted, ""))
}

#[tauri::command]
pub async fn start_github_device_flow(
    backup_scope: Option<bool>,
) -> Result<github_api::DeviceFlowStart, String> {
    let client = github_api::http_client()?;
    github_api::start_device_flow(&client, backup_scope.unwrap_or(false)).await
}

#[tauri::command]
pub async fn poll_github_device_flow(
    app_handle: tauri::AppHandle,
    device_code: String,
) -> Result<GithubDevicePollResult, String> {
    let client = github_api::http_client()?;
    match github_api::poll_device_flow(&client, &device_code).await? {
        DevicePollOutcome::Pending => Ok(GithubDevicePollResult {
            status: DEVICE_STATUS_PENDING.to_string(),
            connection: None,
        }),
        DevicePollOutcome::SlowDown => Ok(GithubDevicePollResult {
            status: DEVICE_STATUS_SLOW_DOWN.to_string(),
            connection: None,
        }),
        DevicePollOutcome::Authorized(token) => {
            let connection = connect_with_token(&token, AUTH_METHOD_OAUTH).await?;
            let _ = app_handle.emit(GITHUB_CONNECTION_CHANGED_EVENT, connection.clone());
            Ok(GithubDevicePollResult {
                status: DEVICE_STATUS_AUTHORIZED.to_string(),
                connection: Some(connection),
            })
        }
    }
}

#[tauri::command]
pub async fn connect_github_token(
    app_handle: tauri::AppHandle,
    token: String,
) -> Result<GithubConnection, String> {
    let connection = connect_with_token(&token, AUTH_METHOD_PAT).await?;
    let _ = app_handle.emit(GITHUB_CONNECTION_CHANGED_EVENT, connection.clone());
    Ok(connection)
}

#[tauri::command]
pub fn disconnect_github(app_handle: tauri::AppHandle) -> Result<GithubConnection, String> {
    save_github_connection_metadata(GithubConnectionMetadata::default(), true)?;
    let credential_cleanup = github_credentials::delete_credential();
    let connection = disconnected_connection("");
    let _ = app_handle.emit(GITHUB_CONNECTION_CHANGED_EVENT, connection.clone());
    credential_cleanup?;
    Ok(connection)
}
