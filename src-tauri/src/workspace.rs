use std::env;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Mutex;
use std::time::SystemTime;

pub const APP_BRAND_NAME: &str = "SkillDock";
pub const WORKSPACE_DIR_NAME: &str = ".skilldock";
pub const SKILL_LIBRARY_PROVIDER_SKILLDOCK: &str = "skilldock";
pub const SKILL_LIBRARY_PROVIDER_AGENT_SKILLS: &str = "agent-skills";
#[allow(dead_code)]
const SETTINGS_FILE_NAME: &str = "settings.json";
const LEGACY_WORKSPACE_DIR_NAME: &str = ".skillm";
const LEGACY_MACOS_APP_STORAGE_NAMES: [&str; 2] = ["com.wanghuan.skilldock", "skill-manager"];
const MACOS_APP_STORAGE_ROOTS: [&str; 3] = ["Library/Caches", "Library/WebKit", "Library/Logs"];
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

/// Remove cache, WebKit, and log directories left by pre-SkillDock builds.
///
/// These directories are disposable and may contain the former bundle/user name. The
/// cleanup is intentionally limited to macOS storage roots and never touches the
/// SkillDock workspace or application data.
pub fn cleanup_legacy_macos_app_storage() {
    #[cfg(target_os = "macos")]
    if let Some(home_dir) = home_dir_option() {
        cleanup_legacy_macos_app_storage_for_home(&home_dir);
    }
}

fn cleanup_legacy_macos_app_storage_for_home(home_dir: &Path) {
    for root in MACOS_APP_STORAGE_ROOTS {
        for name in LEGACY_MACOS_APP_STORAGE_NAMES {
            let path = home_dir.join(root).join(name);
            if path.is_dir() {
                let _ = fs::remove_dir_all(path);
            }
        }
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
    // Existing workspaces predate this setting, so keep their visible Skill list unchanged.
    let is_new_workspace = !workspace_root.exists();
    fs::create_dir_all(workspace_root.join("skills"))
        .map_err(|error| format!("创建 skills 目录失败: {error}"))?;
    fs::create_dir_all(workspace_root.join("cache"))
        .map_err(|error| format!("创建 cache 目录失败: {error}"))?;
    fs::create_dir_all(workspace_root.join("repo-cache"))
        .map_err(|error| format!("创建 repo-cache 目录失败: {error}"))?;
    fs::create_dir_all(workspace_root.join("imports"))
        .map_err(|error| format!("创建 imports 目录失败: {error}"))?;
    fs::create_dir_all(managed_skill_library_root()?)
        .map_err(|error| format!("创建 Skill 托管目录失败: {error}"))?;

    ensure_workspace_file_with_default_content(
        &workspace_root.join("state.json"),
        "{\n  \"installedSkills\": []\n}\n",
    )?;
    let default_settings = if is_new_workspace {
        "{\n  \"defaultOpenToolId\": \"\",\n  \"skillInstallActivation\": \"apply-all-tools\",\n  \"mcpInstallActivation\": \"apply-all-tools\",\n  \"skillSourceViewStyle\": \"select\",\n  \"skillLibraryProvider\": \"skilldock\",\n  \"agentSkillsCompatibilityEnabled\": true\n}\n"
    } else {
        "{\n  \"defaultOpenToolId\": \"\",\n  \"skillInstallActivation\": \"apply-all-tools\",\n  \"mcpInstallActivation\": \"apply-all-tools\",\n  \"skillSourceViewStyle\": \"select\",\n  \"skillLibraryProvider\": \"skilldock\"\n}\n"
    };
    ensure_workspace_file_with_default_content(
        &workspace_root.join("settings.json"),
        default_settings,
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
    let home_dir = home_dir()?;
    Ok(home_dir.join(WORKSPACE_DIR_NAME).join("skills"))
}

pub fn skill_root_paths(include_agent_root: bool) -> Result<Vec<PathBuf>, String> {
    let home_dir = home_dir()?;
    let mut roots = vec![home_dir.join(WORKSPACE_DIR_NAME).join("skills")];
    if include_agent_root {
        roots.push(home_dir.join(".agents/skills"));
    }
    Ok(roots)
}

#[allow(dead_code)]
pub fn skill_library_root_for_provider(provider: &str, home_dir: &Path) -> Result<PathBuf, String> {
    match normalize_skill_library_provider(provider) {
        SKILL_LIBRARY_PROVIDER_AGENT_SKILLS => Ok(home_dir.join(".agents/skills")),
        SKILL_LIBRARY_PROVIDER_SKILLDOCK => Ok(home_dir.join(WORKSPACE_DIR_NAME).join("skills")),
        _ => Err("不支持的 Skill 托管方式".to_string()),
    }
}

pub fn normalize_skill_library_provider(value: &str) -> &'static str {
    match value.trim() {
        SKILL_LIBRARY_PROVIDER_AGENT_SKILLS => SKILL_LIBRARY_PROVIDER_AGENT_SKILLS,
        _ => SKILL_LIBRARY_PROVIDER_SKILLDOCK,
    }
}

#[allow(dead_code)]
pub fn link_skilldock_skills_into_agent_library() -> Result<usize, String> {
    let home_dir = home_dir()?;
    let source_root = home_dir.join(WORKSPACE_DIR_NAME).join("skills");
    let target_root = home_dir.join(".agents/skills");
    if !source_root.is_dir() {
        fs::create_dir_all(&target_root)
            .map_err(|error| format!("创建 Agent Skills 目录失败: {error}"))?;
        return Ok(0);
    }

    fs::create_dir_all(&target_root)
        .map_err(|error| format!("创建 Agent Skills 目录失败: {error}"))?;
    let mut pending_links = Vec::new();
    let entries = fs::read_dir(&source_root)
        .map_err(|error| format!("读取 SkillDock Skill 目录失败: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取 SkillDock Skill 失败: {error}"))?;
        let source_path = entry.path();
        if !source_path.is_dir() {
            continue;
        }
        let target_path = target_root.join(entry.file_name());
        if fs::symlink_metadata(&target_path).is_ok() {
            let source_canonical = source_path.canonicalize().ok();
            let target_canonical = target_path.canonicalize().ok();
            if source_canonical == target_canonical {
                continue;
            }
            // The Agent Skills CLI root can contain an independent skill with the same name.
            // Preserve that entry and let the user choose which instance to distribute.
            continue;
        }
        pending_links.push((source_path, target_path));
    }

    for (source_path, target_path) in &pending_links {
        create_directory_link(source_path, target_path)?;
    }
    Ok(pending_links.len())
}

fn create_directory_link(source_path: &Path, target_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source_path, target_path)
            .map_err(|error| format!("创建 Agent Skills 兼容链接失败: {error}"))?;
    }

    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(source_path, target_path)
            .map_err(|error| format!("创建 Agent Skills 兼容链接失败: {error}"))?;
    }

    Ok(())
}

#[allow(dead_code)]
pub fn compatibility_enabled_for_home(home_dir: &Path) -> bool {
    let settings_path = home_dir.join(WORKSPACE_DIR_NAME).join(SETTINGS_FILE_NAME);
    let Ok(contents) = fs::read_to_string(settings_path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return false;
    };
    value
        .get("agentSkillsCompatibilityEnabled")
        .and_then(serde_json::Value::as_bool)
        .or_else(|| {
            value
                .get("skillLibraryProvider")
                .and_then(serde_json::Value::as_str)
                .map(|provider| {
                    normalize_skill_library_provider(provider)
                        == SKILL_LIBRARY_PROVIDER_AGENT_SKILLS
                })
        })
        .unwrap_or(false)
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
        cleanup_legacy_macos_app_storage_for_home, compatibility_enabled_for_home,
        ensure_workspace_initialized, link_skilldock_skills_into_agent_library,
        managed_skill_library_root, managed_workspace_root, normalize_skill_library_provider,
        normalize_workspace_path, skill_library_root_for_provider, workspace_file_candidates,
        SKILL_LIBRARY_PROVIDER_AGENT_SKILLS, SKILL_LIBRARY_PROVIDER_SKILLDOCK, TEST_ENV_LOCK,
        WORKSPACE_DIR_NAME,
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
    fn removes_legacy_macos_app_storage_without_touching_skilldock_data() {
        run_with_temp_home("legacy-app-storage", |temp_home| {
            for root in super::MACOS_APP_STORAGE_ROOTS {
                for name in super::LEGACY_MACOS_APP_STORAGE_NAMES {
                    let path = temp_home.join(root).join(name);
                    fs::create_dir_all(&path).expect("create legacy app storage");
                    fs::write(path.join("entry"), "legacy").expect("write legacy app storage");
                }
            }
            let current_data = temp_home.join("Library/Caches/skilldock");
            fs::create_dir_all(&current_data).expect("create current app storage");
            fs::write(current_data.join("entry"), "current").expect("write current app storage");
            let workspace = temp_home.join(WORKSPACE_DIR_NAME);
            fs::create_dir_all(&workspace).expect("create workspace");

            cleanup_legacy_macos_app_storage_for_home(&temp_home);

            for root in super::MACOS_APP_STORAGE_ROOTS {
                for name in super::LEGACY_MACOS_APP_STORAGE_NAMES {
                    assert!(!temp_home.join(root).join(name).exists());
                }
            }
            assert!(current_data.join("entry").exists());
            assert!(workspace.exists());
        });
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
            assert!(settings_content.contains("\"skillSourceViewStyle\": \"select\""));
            assert!(settings_content.contains("\"skillLibraryProvider\": \"skilldock\""));
            assert!(settings_content.contains("\"agentSkillsCompatibilityEnabled\": true"));
            assert!(compatibility_enabled_for_home(&temp_home));
        });
    }

    #[test]
    fn keeps_agent_skills_compatibility_disabled_when_existing_workspace_has_no_settings() {
        run_with_temp_home("bootstrap-existing-workspace", |temp_home| {
            let workspace_root = temp_home.join(WORKSPACE_DIR_NAME);
            fs::create_dir_all(workspace_root.join("skills")).expect("create existing workspace");

            ensure_workspace_initialized().expect("workspace should initialize");

            let settings_content =
                fs::read_to_string(workspace_root.join("settings.json")).expect("read settings");
            assert!(!settings_content.contains("agentSkillsCompatibilityEnabled"));
            assert!(!compatibility_enabled_for_home(&temp_home));
        });
    }

    #[test]
    fn resolves_skill_library_root_for_each_provider() {
        run_with_temp_home("skill-library-providers", |temp_home| {
            assert_eq!(
                skill_library_root_for_provider(SKILL_LIBRARY_PROVIDER_SKILLDOCK, &temp_home)
                    .expect("resolve SkillDock root"),
                temp_home.join(".skilldock/skills")
            );
            assert_eq!(
                skill_library_root_for_provider(SKILL_LIBRARY_PROVIDER_AGENT_SKILLS, &temp_home)
                    .expect("resolve Agent Skills root"),
                temp_home.join(".agents/skills")
            );
        });
    }

    #[test]
    fn keeps_skilldock_root_when_legacy_agent_provider_is_enabled() {
        run_with_temp_home("active-agent-skills", |temp_home| {
            let workspace_root = temp_home.join(WORKSPACE_DIR_NAME);
            fs::create_dir_all(&workspace_root).expect("create workspace");
            fs::write(
                workspace_root.join("settings.json"),
                "{\"skillLibraryProvider\":\"agent-skills\"}",
            )
            .expect("write settings");

            assert_eq!(
                managed_skill_library_root().expect("resolve active Skill root"),
                temp_home.join(".skilldock/skills")
            );
            assert!(compatibility_enabled_for_home(&temp_home));
        });
    }

    #[test]
    fn normalizes_unknown_skill_library_provider_to_skilldock() {
        assert_eq!(
            normalize_skill_library_provider("agent-skills"),
            SKILL_LIBRARY_PROVIDER_AGENT_SKILLS
        );
        assert_eq!(
            normalize_skill_library_provider("unknown"),
            SKILL_LIBRARY_PROVIDER_SKILLDOCK
        );
    }

    #[cfg(unix)]
    #[test]
    fn links_skilldock_skills_into_agent_library() {
        run_with_temp_home("link-agent-skills", |temp_home| {
            let source_path = temp_home.join(".skilldock/skills/demo");
            fs::create_dir_all(&source_path).expect("create source Skill");
            fs::write(source_path.join("SKILL.md"), "# demo").expect("write Skill");

            let linked_count = link_skilldock_skills_into_agent_library().expect("link Skills");
            let target_path = temp_home.join(".agents/skills/demo");

            assert_eq!(linked_count, 1);
            assert_eq!(
                target_path.canonicalize().expect("resolve target"),
                source_path.canonicalize().expect("resolve source")
            );
        });
    }

    #[test]
    fn preserves_same_name_agent_skill_conflicts_when_linking() {
        run_with_temp_home("agent-skill-conflict", |temp_home| {
            let source_path = temp_home.join(".skilldock/skills/demo");
            let target_path = temp_home.join(".agents/skills/demo");
            fs::create_dir_all(&source_path).expect("create source Skill");
            fs::create_dir_all(&target_path).expect("create conflicting Skill");

            let linked_count = link_skilldock_skills_into_agent_library()
                .expect("same-name conflict should be preserved");

            assert_eq!(linked_count, 0);
            assert!(target_path.is_dir());
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
            assert!(!compatibility_enabled_for_home(&temp_home));
            assert_eq!(
                fs::read_to_string(workspace_root.join("mcp-servers.json")).expect("read mcp"),
                "{\n  \"servers\": [{\"id\": \"kept\"}]\n}\n"
            );
        });
    }
}
