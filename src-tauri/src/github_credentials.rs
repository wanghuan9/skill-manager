use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

const CREDENTIAL_FILE_NAME: &str = "github-credentials.json";

static CREDENTIAL_CACHE: OnceLock<Mutex<CredentialCache>> = OnceLock::new();

#[cfg(test)]
static TEST_CREDENTIAL_PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

#[derive(Default)]
struct CredentialCache {
    initialized: bool,
    credential: Option<GithubCredential>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCredential {
    pub token: String,
    pub auth_method: String,
}

fn credential_cache() -> &'static Mutex<CredentialCache> {
    CREDENTIAL_CACHE.get_or_init(|| Mutex::new(CredentialCache::default()))
}

fn credential_file_path() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(path) = TEST_CREDENTIAL_PATH
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|path| path.clone())
    {
        return Ok(path);
    }

    crate::workspace::managed_workspace_root_option()
        .map(|root| root.join(CREDENTIAL_FILE_NAME))
        .ok_or_else(|| "无法定位 GitHub 凭据文件".to_string())
}

pub fn store_credential(token: &str, auth_method: &str) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("GitHub 凭据为空".to_string());
    }

    let credential = GithubCredential {
        token: token.to_string(),
        auth_method: auth_method.trim().to_string(),
    };
    let payload = serde_json::to_string_pretty(&credential)
        .map_err(|error| format!("序列化 GitHub 凭据失败: {error}"))?;
    let path = credential_file_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "GitHub 凭据文件目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建 GitHub 凭据目录失败: {error}"))?;
    fs::write(&path, payload).map_err(|error| format!("保存 GitHub 凭据失败: {error}"))?;

    let mut cache = credential_cache()
        .lock()
        .map_err(|_| "GitHub 会话凭据锁不可用".to_string())?;
    cache.initialized = true;
    cache.credential = Some(credential);

    Ok(())
}

pub fn load_credential() -> Option<GithubCredential> {
    let mut cache = credential_cache().lock().ok()?;
    if cache.initialized {
        return cache.credential.clone();
    }

    cache.initialized = true;
    let credential = credential_file_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|payload| serde_json::from_str::<GithubCredential>(&payload).ok())
        .filter(|credential| !credential.token.trim().is_empty());
    cache.credential = credential.clone();
    credential
}

pub fn load_active_credential() -> Option<GithubCredential> {
    let connection = crate::state::load_github_connection_metadata();
    if connection.username.trim().is_empty() {
        return None;
    }
    load_credential()
}

pub fn active_token() -> Option<String> {
    load_active_credential()
        .map(|credential| credential.token.trim().to_string())
        .filter(|token| !token.is_empty())
        .or_else(|| {
            std::env::var("GITHUB_TOKEN")
                .ok()
                .map(|token| token.trim().to_string())
                .filter(|token| !token.is_empty())
        })
}

pub fn delete_credential() -> Result<(), String> {
    if let Ok(mut cache) = credential_cache().lock() {
        cache.initialized = true;
        cache.credential = None;
    }
    let path = credential_file_path()?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除 GitHub 凭据失败: {error}")),
    }
}

#[cfg(test)]
fn set_test_credential_path(path: Option<PathBuf>) {
    if let Ok(mut test_path) = TEST_CREDENTIAL_PATH.get_or_init(|| Mutex::new(None)).lock() {
        *test_path = path;
    }
}

#[cfg(test)]
fn clear_session_credential() {
    if let Ok(mut cache) = credential_cache().lock() {
        cache.initialized = false;
        cache.credential = None;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        active_token, clear_session_credential, delete_credential, load_active_credential,
        load_credential, set_test_credential_path, store_credential,
    };
    use crate::models::GithubConnectionMetadata;
    use crate::state::save_github_connection_metadata;
    use crate::workspace::with_test_home;
    use std::fs;

    #[test]
    fn stores_and_loads_credential_from_local_file() {
        let temp_root = std::env::temp_dir().join(format!(
            "skilldock-github-credential-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let credential_path = temp_root.join("github-credentials.json");
        set_test_credential_path(Some(credential_path.clone()));
        clear_session_credential();

        with_test_home(&temp_root, || {
            store_credential("  github_pat_example  ", "pat").expect("store credential");
            save_github_connection_metadata(
                GithubConnectionMetadata {
                    auth_method: "pat".into(),
                    user_id: Some(42),
                    username: "octocat".into(),
                    avatar_url: String::new(),
                    credential_persisted: true,
                },
                true,
            )
            .expect("save connected metadata");
            assert!(credential_path.is_file());
            clear_session_credential();

            let credential = load_credential().expect("load credential");
            assert_eq!(credential.token, "github_pat_example");
            assert_eq!(credential.auth_method, "pat");
            assert_eq!(active_token().as_deref(), Some("github_pat_example"));

            save_github_connection_metadata(GithubConnectionMetadata::default(), true)
                .expect("save disconnected metadata");
            assert!(load_credential().is_some());
            assert!(load_active_credential().is_none());

            delete_credential().expect("delete credential");
            clear_session_credential();
            assert!(load_credential().is_none());
        });
        set_test_credential_path(None);
        let _ = fs::remove_dir_all(temp_root);
    }
}
