use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

const KEYRING_SERVICE: &str = "com.skilldock.github";
const KEYRING_ACCOUNT: &str = "active";

static CREDENTIAL_CACHE: OnceLock<Mutex<CredentialCache>> = OnceLock::new();
static KEYRING_ENTRY: OnceLock<keyring::Entry> = OnceLock::new();

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
    #[serde(skip)]
    pub persisted: bool,
}

#[derive(Clone, Debug)]
pub struct StoreCredentialResult {
    pub persisted: bool,
    pub warning: Option<String>,
}

fn credential_cache() -> &'static Mutex<CredentialCache> {
    CREDENTIAL_CACHE.get_or_init(|| Mutex::new(CredentialCache::default()))
}

fn keyring_entry() -> Result<&'static keyring::Entry, String> {
    if let Some(entry) = KEYRING_ENTRY.get() {
        return Ok(entry);
    }
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|error| format!("无法访问系统凭据存储: {error}"))?;
    let _ = KEYRING_ENTRY.set(entry);
    KEYRING_ENTRY
        .get()
        .ok_or_else(|| "无法初始化系统凭据存储".to_string())
}

pub fn store_credential(token: &str, auth_method: &str) -> Result<StoreCredentialResult, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("GitHub 凭据为空".to_string());
    }

    let credential = GithubCredential {
        token: token.to_string(),
        auth_method: auth_method.trim().to_string(),
        persisted: false,
    };
    let payload = serde_json::to_string(&credential)
        .map_err(|error| format!("序列化 GitHub 凭据失败: {error}"))?;

    let persistence_result = keyring_entry().and_then(|entry| {
        entry
            .set_password(&payload)
            .map_err(|error| format!("保存 GitHub 凭据失败: {error}"))
    });
    let warning = persistence_result.err();
    let persisted = warning.is_none();
    let mut cache = credential_cache()
        .lock()
        .map_err(|_| "GitHub 会话凭据锁不可用".to_string())?;
    cache.initialized = true;
    cache.credential = Some(GithubCredential {
        persisted,
        ..credential
    });

    Ok(StoreCredentialResult { persisted, warning })
}

pub fn load_credential() -> Option<GithubCredential> {
    let mut cache = credential_cache().lock().ok()?;
    if cache.initialized {
        return cache.credential.clone();
    }

    cache.initialized = true;
    let credential = keyring_entry()
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|payload| serde_json::from_str::<GithubCredential>(&payload).ok())
        .map(|mut credential| {
            credential.persisted = true;
            credential
        });
    cache.credential = credential.clone();
    credential
}

pub fn active_token() -> Option<String> {
    load_credential()
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
    let entry = keyring_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除 GitHub 凭据失败: {error}")),
    }
}

#[cfg(test)]
pub fn use_mock_keyring() {
    static MOCK_KEYRING: std::sync::Once = std::sync::Once::new();
    MOCK_KEYRING.call_once(|| {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    });
}

#[cfg(test)]
pub fn clear_session_credential() {
    if let Ok(mut cache) = credential_cache().lock() {
        cache.initialized = false;
        cache.credential = None;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        active_token, clear_session_credential, delete_credential, load_credential,
        store_credential, use_mock_keyring,
    };

    #[test]
    fn stores_and_loads_credential_without_exposing_it_in_settings() {
        use_mock_keyring();
        let _ = delete_credential();

        let result = store_credential("  github_pat_example  ", "pat").expect("store credential");
        assert!(result.persisted);
        assert!(result.warning.is_none());
        clear_session_credential();

        let credential = load_credential().expect("load credential");
        assert_eq!(credential.token, "github_pat_example");
        assert_eq!(credential.auth_method, "pat");
        assert_eq!(active_token().as_deref(), Some("github_pat_example"));

        delete_credential().expect("delete credential");
        clear_session_credential();
        assert!(load_credential().is_none());
    }
}
