use std::env;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Mutex;
use std::time::SystemTime;

pub const APP_BRAND_NAME: &str = "SkillDock";
pub const WORKSPACE_DIR_NAME: &str = ".skilldock";
const LEGACY_WORKSPACE_DIR_NAME: &str = ".skillm";
const MIGRATION_DEFERRED_FILE_NAMES: [&str; 3] =
    ["state.json", "settings.json", "mcp-servers.json"];
const CONFLICT_SUFFIX: &str = ".migrated-from-skillm";
#[cfg(test)]
pub static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

pub fn home_dir() -> Result<PathBuf, String> {
    home_dir_option().ok_or_else(|| "无法读取用户主目录（HOME/USERPROFILE）".to_string())
}

pub fn home_dir_option() -> Option<PathBuf> {
    home_dir_from_env()
}

pub fn home_dir_from_env() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

#[allow(dead_code)]
pub fn config_home_dir() -> Result<PathBuf, String> {
    if cfg!(windows) {
        if let Some(appdata) = env::var_os("APPDATA").filter(|value| !value.is_empty()) {
            return Ok(PathBuf::from(appdata));
        }
    }
    home_dir()
}

pub fn application_support_dir_for_home(home_dir: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        env::var_os("APPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir.join("AppData/Roaming"))
    }

    #[cfg(target_os = "macos")]
    {
        home_dir.join("Library/Application Support")
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        env::var_os("XDG_CONFIG_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir.join(".config"))
    }
}

pub fn format_local_system_time(value: SystemTime) -> String {
    let datetime: chrono::DateTime<chrono::Local> = value.into();
    format!(
        "{}/{}/{} {}",
        datetime.format("%Y"),
        datetime.format("%m").to_string().trim_start_matches('0'),
        datetime.format("%d").to_string().trim_start_matches('0'),
        datetime.format("%H:%M:%S")
    )
}

pub fn managed_workspace_root() -> Result<PathBuf, String> {
    let home_dir = home_dir()?;
    ensure_workspace_migrated_for_home(&home_dir)?;
    Ok(home_dir.join(WORKSPACE_DIR_NAME))
}

pub fn ensure_workspace_initialized() -> Result<PathBuf, String> {
    let workspace_root = managed_workspace_root()?;
    fs::create_dir_all(workspace_root.join("skills"))
        .map_err(|error| format!("创建 skills 目录失败: {error}"))?;
    fs::create_dir_all(workspace_root.join("cache"))
        .map_err(|error| format!("创建 cache 目录失败: {error}"))?;
    fs::create_dir_all(workspace_root.join("repo-cache"))
        .map_err(|error| format!("创建 repo-cache 目录失败: {error}"))?;
    fs::create_dir_all(workspace_root.join("imports"))
        .map_err(|error| format!("创建 imports 目录失败: {error}"))?;

    ensure_workspace_file_with_default_content(
        &workspace_root.join("state.json"),
        "{\n  \"installedSkills\": []\n}\n",
    )?;
    ensure_workspace_file_with_default_content(
        &workspace_root.join("settings.json"),
        "{\n  \"defaultOpenToolId\": \"\",\n  \"skillInstallActivation\": \"apply-all-tools\",\n  \"mcpInstallActivation\": \"apply-all-tools\",\n  \"skillSourceViewStyle\": \"flat\"\n}\n",
    )?;
    ensure_workspace_file_with_default_content(
        &workspace_root.join("mcp-servers.json"),
        "{\n  \"servers\": []\n}\n",
    )?;

    Ok(workspace_root)
}

pub fn managed_workspace_root_option() -> Option<PathBuf> {
    managed_workspace_root().ok()
}

pub fn managed_skill_library_root() -> Result<PathBuf, String> {
    Ok(managed_workspace_root()?.join("skills"))
}

pub fn workspace_file_path(file_name: &str) -> Result<PathBuf, String> {
    Ok(managed_workspace_root()?.join(file_name))
}

pub fn workspace_file_candidates(file_name: &str) -> Vec<PathBuf> {
    let Some(home_dir) = home_dir_option() else {
        return Vec::new();
    };
    let current = home_dir.join(WORKSPACE_DIR_NAME).join(file_name);
    let legacy = home_dir.join(LEGACY_WORKSPACE_DIR_NAME).join(file_name);
    if current == legacy {
        return vec![current];
    }
    vec![current, legacy]
}

pub fn remove_legacy_workspace_file(file_name: &str) {
    let Some(home_dir) = home_dir_option() else {
        return;
    };
    let legacy_file = home_dir.join(LEGACY_WORKSPACE_DIR_NAME).join(file_name);
    if legacy_file.exists() {
        let _ = fs::remove_file(legacy_file);
    }
    prune_legacy_workspace_root_if_empty(&home_dir);
}

pub fn normalize_workspace_path(value: &str) -> String {
    value.replace(LEGACY_WORKSPACE_DIR_NAME, WORKSPACE_DIR_NAME)
}

/// Strip Windows verbatim/extended-length path prefixes before showing paths in the UI.
pub fn display_path_value(value: &str) -> String {
    strip_windows_verbatim_prefix(value.trim())
}

pub fn display_path_string(path: &Path) -> String {
    display_path_value(&path.to_string_lossy())
}

fn strip_windows_verbatim_prefix(value: &str) -> String {
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }

    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return rest.to_string();
    }

    value.to_string()
}

fn ensure_workspace_file_with_default_content(
    path: &Path,
    default_content: &str,
) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }

    fs::write(path, default_content)
        .map_err(|error| format!("初始化工作区文件失败（{}）: {error}", path.display()))
}

fn ensure_workspace_migrated_for_home(home_dir: &Path) -> Result<(), String> {
    let legacy_root = home_dir.join(LEGACY_WORKSPACE_DIR_NAME);
    if !legacy_root.exists() {
        return Ok(());
    }

    let current_root = home_dir.join(WORKSPACE_DIR_NAME);
    if !current_root.exists() {
        match fs::rename(&legacy_root, &current_root) {
            Ok(_) => return Ok(()),
            Err(_) => {
                copy_dir_recursive(&legacy_root, &current_root)?;
                fs::remove_dir_all(&legacy_root)
                    .map_err(|error| format!("清理旧工作区目录失败: {error}"))?;
                return Ok(());
            }
        }
    }

    merge_workspace_dirs(&legacy_root, &current_root, true)?;
    prune_empty_directories(&legacy_root)?;
    prune_legacy_workspace_root_if_empty(home_dir);
    Ok(())
}

fn merge_workspace_dirs(source: &Path, target: &Path, is_root: bool) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("创建迁移目标目录失败: {error}"))?;

    let entries = fs::read_dir(source).map_err(|error| format!("读取旧工作区目录失败: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取旧工作区条目失败: {error}"))?;
        let source_path = entry.path();
        let file_name = entry.file_name();
        let target_path = target.join(&file_name);

        if is_root
            && file_name
                .to_str()
                .is_some_and(|value| MIGRATION_DEFERRED_FILE_NAMES.contains(&value))
            && target_path.exists()
        {
            continue;
        }

        if !target_path.exists() {
            move_path(&source_path, &target_path)?;
            continue;
        }

        let source_metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("读取源条目失败: {error}"))?;
        let target_metadata = fs::symlink_metadata(&target_path)
            .map_err(|error| format!("读取目标条目失败: {error}"))?;

        if source_metadata.is_dir() && target_metadata.is_dir() {
            merge_workspace_dirs(&source_path, &target_path, false)?;
            continue;
        }

        if source_metadata.is_file()
            && target_metadata.is_file()
            && file_contents_equal(&source_path, &target_path)?
        {
            fs::remove_file(&source_path).map_err(|error| format!("清理重复文件失败: {error}"))?;
            continue;
        }

        let conflict_target = conflict_target_path(&target_path);
        move_path(&source_path, &conflict_target)?;
    }

    Ok(())
}

fn move_path(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建迁移父目录失败: {error}"))?;
    }

    match fs::rename(source, target) {
        Ok(_) => Ok(()),
        Err(_) => {
            if source.is_dir() {
                copy_dir_recursive(source, target)?;
                fs::remove_dir_all(source).map_err(|error| format!("清理已复制目录失败: {error}"))
            } else {
                fs::copy(source, target).map_err(|error| format!("复制文件失败: {error}"))?;
                fs::remove_file(source).map_err(|error| format!("清理已复制文件失败: {error}"))
            }
        }
    }
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("创建目录失败: {error}"))?;
    let entries = fs::read_dir(source).map_err(|error| format!("读取目录失败: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取目录条目失败: {error}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("创建文件父目录失败: {error}"))?;
            }
            fs::copy(&source_path, &target_path)
                .map_err(|error| format!("复制文件失败: {error}"))?;
        }
    }
    Ok(())
}

fn file_contents_equal(left: &Path, right: &Path) -> Result<bool, String> {
    let left_bytes = fs::read(left).map_err(|error| format!("读取文件失败: {error}"))?;
    let right_bytes = fs::read(right).map_err(|error| format!("读取文件失败: {error}"))?;
    Ok(left_bytes == right_bytes)
}

fn conflict_target_path(target: &Path) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new(""));
    let stem = target
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("migrated");
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    let mut index = 1usize;
    loop {
        let suffix = if index == 1 {
            CONFLICT_SUFFIX.to_string()
        } else {
            format!("{CONFLICT_SUFFIX}-{index}")
        };
        let file_name = if extension.is_empty() {
            format!("{stem}{suffix}")
        } else {
            format!("{stem}{suffix}.{extension}")
        };
        let candidate = parent.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
}

fn prune_empty_directories(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(true);
    }
    if !path.is_dir() {
        return Ok(false);
    }

    let entries = fs::read_dir(path).map_err(|error| format!("读取目录失败: {error}"))?;
    let child_paths = entries
        .map(|entry| entry.map(|value| value.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取目录条目失败: {error}"))?;

    let mut is_empty = true;
    for child_path in child_paths {
        if child_path.is_dir() {
            if !prune_empty_directories(&child_path)? {
                is_empty = false;
            }
            continue;
        }
        is_empty = false;
    }

    if is_empty {
        fs::remove_dir(path).map_err(|error| format!("删除空目录失败: {error}"))?;
        return Ok(true);
    }

    Ok(false)
}

fn prune_legacy_workspace_root_if_empty(home_dir: &Path) {
    let legacy_root = home_dir.join(LEGACY_WORKSPACE_DIR_NAME);
    if legacy_root.is_dir() {
        let _ = prune_empty_directories(&legacy_root);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_workspace_initialized, managed_workspace_root, normalize_workspace_path,
        workspace_file_candidates, TEST_ENV_LOCK, WORKSPACE_DIR_NAME,
    };
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_home(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        env::temp_dir().join(format!(
            "skilldock-workspace-test-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

    fn run_with_temp_home<T>(label: &str, callback: impl FnOnce(PathBuf) -> T) -> T {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_home = unique_temp_home(label);
        let original_home = env::var_os("HOME");
        let original_userprofile = env::var_os("USERPROFILE");
        unsafe {
            env::set_var("HOME", &temp_home);
            env::remove_var("USERPROFILE");
        }
        let result = callback(temp_home.clone());
        match original_home {
            Some(value) => unsafe {
                env::set_var("HOME", value);
            },
            None => unsafe {
                env::remove_var("HOME");
            },
        }
        match original_userprofile {
            Some(value) => unsafe {
                env::set_var("USERPROFILE", value);
            },
            None => unsafe {
                env::remove_var("USERPROFILE");
            },
        }
        let _ = fs::remove_dir_all(&temp_home);
        result
    }

    #[test]
    fn home_dir_uses_home_when_available() {
        run_with_temp_home("home-priority", |temp_home| {
            assert_eq!(super::home_dir().expect("home dir"), temp_home);
        });
    }

    #[test]
    fn home_dir_falls_back_to_userprofile_when_home_missing() {
        let _guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp_home = unique_temp_home("userprofile");
        let original_home = env::var_os("HOME");
        let original_userprofile = env::var_os("USERPROFILE");

        unsafe {
            env::remove_var("HOME");
            env::set_var("USERPROFILE", &temp_home);
        }

        assert_eq!(super::home_dir().expect("home dir"), temp_home);

        match original_home {
            Some(value) => unsafe {
                env::set_var("HOME", value);
            },
            None => unsafe {
                env::remove_var("HOME");
            },
        }
        match original_userprofile {
            Some(value) => unsafe {
                env::set_var("USERPROFILE", value);
            },
            None => unsafe {
                env::remove_var("USERPROFILE");
            },
        }
        let _ = fs::remove_dir_all(temp_home);
    }

    #[test]
    fn migrates_existing_skill_content_into_skilldock_workspace() {
        run_with_temp_home("migrate", |temp_home| {
            let legacy_skill_dir = temp_home.join(".skillm/skills/demo-skill");
            fs::create_dir_all(&legacy_skill_dir).expect("create legacy skill dir");
            fs::write(legacy_skill_dir.join("SKILL.md"), "# demo").expect("write skill file");

            let workspace_root = managed_workspace_root().expect("managed root should resolve");

            assert_eq!(workspace_root, temp_home.join(WORKSPACE_DIR_NAME));
            assert!(workspace_root.join("skills/demo-skill/SKILL.md").exists());
            assert!(!temp_home
                .join(".skillm/skills/demo-skill/SKILL.md")
                .exists());
        });
    }

    #[test]
    fn normalizes_legacy_workspace_path() {
        assert_eq!(
            normalize_workspace_path("/Users/demo/.skillm/skills/demo"),
            "/Users/demo/.skilldock/skills/demo"
        );
    }

    #[test]
    fn display_path_value_strips_windows_verbatim_prefix() {
        assert_eq!(
            super::display_path_value(r"\\?\C:\Users\demo\.cache\codex-runtimes"),
            r"C:\Users\demo\.cache\codex-runtimes"
        );
        assert_eq!(
            super::display_path_value(r"\\?\UNC\server\share\plugins"),
            r"\\server\share\plugins"
        );
    }

    #[test]
    fn application_support_dir_uses_platform_location() {
        let home_dir = PathBuf::from(if cfg!(windows) {
            r"C:\Users\demo"
        } else {
            "/Users/demo"
        });
        let path = super::application_support_dir_for_home(&home_dir);

        if cfg!(windows) {
            let expected = env::var_os("APPDATA")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home_dir.join("AppData/Roaming"));
            assert_eq!(path, expected);
        } else if cfg!(target_os = "macos") {
            assert_eq!(path, home_dir.join("Library/Application Support"));
        }
    }

    #[test]
    fn format_local_system_time_uses_local_timezone() {
        let value = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let expected: chrono::DateTime<chrono::Local> = value.into();

        assert_eq!(
            super::format_local_system_time(value),
            format!(
                "{}/{}/{} {}",
                expected.format("%Y"),
                expected.format("%m").to_string().trim_start_matches('0'),
                expected.format("%d").to_string().trim_start_matches('0'),
                expected.format("%H:%M:%S")
            )
        );
    }

    #[test]
    fn returns_current_then_legacy_workspace_file_candidates() {
        run_with_temp_home("candidates", |temp_home| {
            assert_eq!(
                workspace_file_candidates("state.json"),
                vec![
                    temp_home.join(".skilldock/state.json"),
                    temp_home.join(".skillm/state.json"),
                ]
            );
        });
    }

    #[test]
    fn initializes_workspace_directories_and_files_when_missing() {
        run_with_temp_home("bootstrap", |temp_home| {
            let workspace_root =
                ensure_workspace_initialized().expect("workspace should initialize");

            assert_eq!(workspace_root, temp_home.join(WORKSPACE_DIR_NAME));
            assert!(workspace_root.join("skills").is_dir());
            assert!(workspace_root.join("cache").is_dir());
            assert!(workspace_root.join("repo-cache").is_dir());
            assert!(workspace_root.join("imports").is_dir());
            assert_eq!(
                fs::read_to_string(workspace_root.join("state.json")).expect("read state"),
                "{\n  \"installedSkills\": []\n}\n"
            );
            assert_eq!(
                fs::read_to_string(workspace_root.join("mcp-servers.json")).expect("read mcp"),
                "{\n  \"servers\": []\n}\n"
            );
            let settings_content =
                fs::read_to_string(workspace_root.join("settings.json")).expect("read settings");
            assert!(settings_content.contains("\"defaultOpenToolId\": \"\""));
            assert!(settings_content.contains("\"skillInstallActivation\": \"apply-all-tools\""));
            assert!(settings_content.contains("\"mcpInstallActivation\": \"apply-all-tools\""));
            assert!(settings_content.contains("\"skillSourceViewStyle\": \"flat\""));
        });
    }

    #[test]
    fn does_not_overwrite_existing_workspace_files() {
        run_with_temp_home("bootstrap-preserve", |temp_home| {
            let workspace_root = temp_home.join(WORKSPACE_DIR_NAME);
            fs::create_dir_all(workspace_root.join("skills")).expect("create skills dir");
            fs::write(
                workspace_root.join("state.json"),
                "{\n  \"installedSkills\": [{\"name\": \"kept\"}]\n}\n",
            )
            .expect("write custom state");
            fs::write(
                workspace_root.join("settings.json"),
                "{\n  \"defaultOpenToolId\": \"cursor\"\n}\n",
            )
            .expect("write custom settings");
            fs::write(
                workspace_root.join("mcp-servers.json"),
                "{\n  \"servers\": [{\"id\": \"kept\"}]\n}\n",
            )
            .expect("write custom mcp state");

            let initialized_root =
                ensure_workspace_initialized().expect("workspace should initialize");

            assert_eq!(initialized_root, workspace_root);
            assert_eq!(
                fs::read_to_string(workspace_root.join("state.json")).expect("read state"),
                "{\n  \"installedSkills\": [{\"name\": \"kept\"}]\n}\n"
            );
            assert_eq!(
                fs::read_to_string(workspace_root.join("settings.json")).expect("read settings"),
                "{\n  \"defaultOpenToolId\": \"cursor\"\n}\n"
            );
            assert_eq!(
                fs::read_to_string(workspace_root.join("mcp-servers.json")).expect("read mcp"),
                "{\n  \"servers\": [{\"id\": \"kept\"}]\n}\n"
            );
        });
    }
}
