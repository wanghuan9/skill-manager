#[cfg(test)]
use std::cell::RefCell;
use std::collections::HashSet;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const APP_BRAND_NAME: &str = "SkillDock";
pub const WORKSPACE_DIR_NAME: &str = ".skilldock";
pub const REPOSITORIES_DIR_NAME: &str = "repositories";
pub const SKILL_LIBRARY_PROVIDER_SKILLDOCK: &str = "skilldock";
pub const SKILL_LIBRARY_PROVIDER_AGENT_SKILLS: &str = "agent-skills";
const SETTINGS_FILE_NAME: &str = "settings.json";
const LEGACY_WORKSPACE_DIR_NAME: &str = ".skillm";
const LEGACY_MACOS_APP_STORAGE_NAMES: [&str; 2] = ["com.wanghuan.skilldock", "skill-manager"];
const MACOS_APP_STORAGE_ROOTS: [&str; 3] = ["Library/Caches", "Library/WebKit", "Library/Logs"];
const WORKSPACE_LAYOUT_VERSION: u32 = 2;
const LAYOUT_FILE_PATH: &str = "data/layout.json";
const WORKSPACE_LAYOUT_DIRECTORIES: [&str; 11] = [
    "config",
    "data",
    "data/publishing",
    "credentials",
    "cache",
    REPOSITORIES_DIR_NAME,
    "skills",
    "plugins",
    "imports",
    "backup",
    "logs",
];
const WORKSPACE_MIGRATION_PARENT_DIRECTORIES: [&str; 5] =
    ["config", "data", "data/publishing", "credentials", "cache"];
const WORKSPACE_FILE_MOVES: [WorkspaceFileMove; 11] = [
    WorkspaceFileMove::new("settings.json", "config/settings.json"),
    WorkspaceFileMove::new("mcp-servers.json", "config/mcp-servers.json"),
    WorkspaceFileMove::new("state.json", "data/state.json"),
    WorkspaceFileMove::new("publish-state.json", "data/publishing/legacy-marketplace.json"),
    WorkspaceFileMove::new(
        "skillhub-publish-state.json",
        "data/publishing/skillhub.json",
    ),
    WorkspaceFileMove::new("cache/legacy-marketplace-session.json", "credentials/legacy-marketplace.json"),
    WorkspaceFileMove::new("skillhub-auth.json", "credentials/skillhub.json"),
    WorkspaceFileMove::new("github-credentials.json", "credentials/github.json"),
    WorkspaceFileMove::new("git-update-cache.json", "cache/git-update.json"),
    WorkspaceFileMove::new("plugin-list-cache.json", "cache/plugin-list.json"),
    WorkspaceFileMove::new("plugin-update-cache.json", "cache/plugin-update.json"),
];
static MIGRATED_WORKSPACE_ROOTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
#[cfg(test)]
pub static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy)]
struct WorkspaceFileMove {
    source: &'static str,
    target: &'static str,
}

impl WorkspaceFileMove {
    const fn new(source: &'static str, target: &'static str) -> Self {
        Self { source, target }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceLayout {
    layout_version: u32,
}

struct WorkspaceMigrationLock(File);

impl Drop for WorkspaceMigrationLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

#[cfg(test)]
thread_local! {
    static TEST_HOME_OVERRIDE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

pub fn home_dir() -> Result<PathBuf, String> {
    home_dir_option().ok_or_else(|| "无法读取用户主目录（HOME/USERPROFILE）".to_string())
}

pub fn home_dir_option() -> Option<PathBuf> {
    home_dir_from_env()
}

pub fn home_dir_from_env() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(path) = TEST_HOME_OVERRIDE.with(|value| value.borrow().clone()) {
        return Some(path);
    }
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

#[cfg(test)]
pub fn with_test_home<T>(path: &Path, run: impl FnOnce() -> T) -> T {
    struct OverrideGuard(Option<PathBuf>);

    impl Drop for OverrideGuard {
        fn drop(&mut self) {
            TEST_HOME_OVERRIDE.with(|value| {
                value.replace(self.0.take());
            });
        }
    }

    let previous = TEST_HOME_OVERRIDE.with(|value| value.replace(Some(path.to_path_buf())));
    let _guard = OverrideGuard(previous);
    run()
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

pub fn opencode_config_paths_in_dir(config_dir: &Path) -> [PathBuf; 3] {
    [
        config_dir.join("config.json"),
        config_dir.join("opencode.json"),
        config_dir.join("opencode.jsonc"),
    ]
}

pub fn opencode_config_paths_for_home(home_dir: &Path) -> [PathBuf; 3] {
    opencode_config_paths_in_dir(&home_dir.join(".config/opencode"))
}

pub fn opencode_config_path_for_home(home_dir: &Path) -> PathBuf {
    opencode_config_paths_for_home(home_dir)
        .into_iter()
        .rev()
        .find(|path| path.exists())
        .unwrap_or_else(|| home_dir.join(".config/opencode/opencode.json"))
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
    ensure_workspace_layout_directories(&workspace_root)?;
    fs::create_dir_all(managed_skill_library_root()?)
        .map_err(|error| format!("创建 Skill 托管目录失败: {error}"))?;

    ensure_workspace_file_with_default_content(
        &workspace_root.join(workspace_relative_file_path("state.json")),
        "{\n  \"installedSkills\": []\n}\n",
    )?;
    let default_settings = if is_new_workspace {
        "{\n  \"defaultOpenToolId\": \"\",\n  \"skillInstallActivation\": \"apply-all-tools\",\n  \"mcpInstallActivation\": \"apply-all-tools\",\n  \"skillSourceViewStyle\": \"select\",\n  \"skillLibraryProvider\": \"skilldock\",\n  \"agentSkillsCompatibilityEnabled\": true\n}\n"
    } else {
        "{\n  \"defaultOpenToolId\": \"\",\n  \"skillInstallActivation\": \"apply-all-tools\",\n  \"mcpInstallActivation\": \"apply-all-tools\",\n  \"skillSourceViewStyle\": \"select\",\n  \"skillLibraryProvider\": \"skilldock\"\n}\n"
    };
    ensure_workspace_file_with_default_content(
        &workspace_root.join(workspace_relative_file_path("settings.json")),
        default_settings,
    )?;
    ensure_workspace_file_with_default_content(
        &workspace_root.join(workspace_relative_file_path("mcp-servers.json")),
        "{\n  \"servers\": []\n}\n",
    )?;
    protect_credentials_directory(&workspace_root)?;
    write_layout_file_if_missing(&workspace_root)?;

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
    let settings_path = home_dir
        .join(WORKSPACE_DIR_NAME)
        .join(workspace_relative_file_path(SETTINGS_FILE_NAME));
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
    Ok(managed_workspace_root()?.join(workspace_relative_file_path(file_name)))
}

pub fn workspace_file_candidates(file_name: &str) -> Vec<PathBuf> {
    let Some(home_dir) = home_dir_option() else {
        return Vec::new();
    };
    let workspace_root = home_dir.join(WORKSPACE_DIR_NAME);
    let current = workspace_root.join(workspace_relative_file_path(file_name));
    let legacy_relative_path = legacy_relative_file_path(file_name);
    let flat = workspace_root.join(&legacy_relative_path);
    let oldest = home_dir
        .join(LEGACY_WORKSPACE_DIR_NAME)
        .join(legacy_relative_path);
    let mut candidates = Vec::with_capacity(3);
    for candidate in [current, flat, oldest] {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

pub fn remove_legacy_workspace_file(file_name: &str) {
    let Some(home_dir) = home_dir_option() else {
        return;
    };
    let legacy_file = home_dir
        .join(LEGACY_WORKSPACE_DIR_NAME)
        .join(legacy_relative_file_path(file_name));
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
    let current_root = home_dir.join(WORKSPACE_DIR_NAME);
    let migrated_roots = MIGRATED_WORKSPACE_ROOTS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut migrated_roots = migrated_roots
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if migrated_roots.contains(&current_root) {
        return Ok(());
    }

    let _migration_lock = acquire_workspace_migration_lock(home_dir)?;
    if read_layout_version(&current_root)? == Some(WORKSPACE_LAYOUT_VERSION) {
        migrated_roots.insert(current_root);
        return Ok(());
    }
    let legacy_root = home_dir.join(LEGACY_WORKSPACE_DIR_NAME);
    read_layout_version(&legacy_root)?;
    migrate_legacy_workspace_root(home_dir)?;
    migrate_workspace_layout(&current_root)?;
    migrated_roots.insert(current_root);
    Ok(())
}

fn acquire_workspace_migration_lock(home_dir: &Path) -> Result<WorkspaceMigrationLock, String> {
    let mut hasher = DefaultHasher::new();
    home_dir.hash(&mut hasher);
    let lock_path = env::temp_dir().join(format!(
        "skilldock-workspace-migration-{:016x}.lock",
        hasher.finish()
    ));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&lock_path)
        .map_err(|error| format!("打开工作区迁移锁失败（{}）: {error}", lock_path.display()))?;
    fs2::FileExt::lock_exclusive(&file)
        .map_err(|error| format!("获取工作区迁移锁失败（{}）: {error}", lock_path.display()))?;
    Ok(WorkspaceMigrationLock(file))
}

fn migrate_legacy_workspace_root(home_dir: &Path) -> Result<(), String> {
    let legacy_root = home_dir.join(LEGACY_WORKSPACE_DIR_NAME);
    if !path_exists(&legacy_root)? {
        return Ok(());
    }

    let current_root = home_dir.join(WORKSPACE_DIR_NAME);
    if !path_exists(&current_root)? {
        return move_path(&legacy_root, &current_root);
    }

    move_directory_contents(&legacy_root, &current_root)?;
    prune_legacy_workspace_root_if_empty(home_dir);
    Ok(())
}

fn migrate_workspace_layout(workspace_root: &Path) -> Result<(), String> {
    if !path_exists(workspace_root)? {
        return Ok(());
    }
    if read_layout_version(workspace_root)? == Some(WORKSPACE_LAYOUT_VERSION) {
        return Ok(());
    }

    ensure_workspace_migration_parent_directories(workspace_root)?;
    protect_credentials_directory(workspace_root)?;
    for entry in WORKSPACE_FILE_MOVES {
        move_path(
            &workspace_root.join(entry.source),
            &workspace_root.join(entry.target),
        )?;
        let target = workspace_root.join(entry.target);
        if Path::new(entry.target).starts_with("credentials") && path_exists(&target)? {
            protect_credential_file(&target)?;
        }
    }
    move_path(
        &workspace_root.join("repo-cache"),
        &workspace_root.join(REPOSITORIES_DIR_NAME),
    )?;
    ensure_workspace_layout_directories(workspace_root)?;
    verify_legacy_layout_is_absent(workspace_root)?;
    protect_credentials_directory(workspace_root)?;
    write_layout_file(workspace_root)?;
    log::info!("SkillDock workspace layout migrated to version {WORKSPACE_LAYOUT_VERSION}");
    Ok(())
}

fn ensure_workspace_layout_directories(workspace_root: &Path) -> Result<(), String> {
    for relative_path in WORKSPACE_LAYOUT_DIRECTORIES {
        let path = workspace_root.join(relative_path);
        fs::create_dir_all(&path)
            .map_err(|error| format!("创建工作区目录失败（{}）: {error}", path.display()))?;
    }
    Ok(())
}

fn ensure_workspace_migration_parent_directories(workspace_root: &Path) -> Result<(), String> {
    for relative_path in WORKSPACE_MIGRATION_PARENT_DIRECTORIES {
        let path = workspace_root.join(relative_path);
        fs::create_dir_all(&path)
            .map_err(|error| format!("创建迁移目标目录失败（{}）: {error}", path.display()))?;
    }
    Ok(())
}

fn move_directory_contents(source: &Path, target: &Path) -> Result<(), String> {
    if !path_exists(source)? {
        return if path_exists(target)? {
            Ok(())
        } else {
            Err(format!(
                "工作区迁移源和目标均不存在：{} -> {}",
                source.display(),
                target.display()
            ))
        };
    }
    if !path_exists(target)? {
        return move_path(source, target);
    }
    let source_metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("读取迁移源目录失败（{}）: {error}", source.display()))?;
    let target_metadata = fs::symlink_metadata(target)
        .map_err(|error| format!("读取迁移目标目录失败（{}）: {error}", target.display()))?;
    if !source_metadata.is_dir() || !target_metadata.is_dir() {
        return Err(format!(
            "工作区迁移目标冲突：{} -> {}",
            source.display(),
            target.display()
        ));
    }

    let entries = match fs::read_dir(source) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !path_exists(source)? => {
            return if path_exists(target)? {
                Ok(())
            } else {
                Err(format!(
                    "工作区迁移源和目标均不存在：{} -> {}",
                    source.display(),
                    target.display()
                ))
            };
        }
        Err(error) => return Err(format!("读取旧工作区目录失败: {error}")),
    };
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取旧工作区条目失败: {error}"))?;
        let source_path = entry.path();
        let file_name = entry.file_name();
        let target_path = target.join(&file_name);

        if !path_exists(&source_path)? {
            if path_exists(&target_path)? {
                continue;
            }
            return Err(format!(
                "工作区迁移条目在目标生成前消失：{} -> {}",
                source_path.display(),
                target_path.display()
            ));
        }

        if !path_exists(&target_path)? {
            move_path(&source_path, &target_path)?;
            continue;
        }

        let source_metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("读取源条目失败: {error}"))?;
        let target_metadata = fs::symlink_metadata(&target_path)
            .map_err(|error| format!("读取目标条目失败: {error}"))?;

        if source_metadata.is_dir() && target_metadata.is_dir() {
            move_directory_contents(&source_path, &target_path)?;
            continue;
        }
        return Err(format!(
            "工作区迁移目标冲突：{} -> {}",
            source_path.display(),
            target_path.display()
        ));
    }
    match fs::remove_dir(source) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "清理已移动的空目录失败（{}）: {error}",
                source.display()
            ))
        }
    }
    Ok(())
}

fn move_path(source: &Path, target: &Path) -> Result<(), String> {
    if !path_exists(source)? {
        return Ok(());
    }
    if path_exists(target)? {
        return Err(format!(
            "工作区迁移目标已存在：{} -> {}",
            source.display(),
            target.display()
        ));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建迁移父目录失败: {error}"))?;
    }

    match fs::rename(source, target) {
        Ok(_) => Ok(()),
        Err(error) => {
            let source_exists = path_exists(source)?;
            let target_exists = path_exists(target)?;
            if !source_exists && target_exists {
                Ok(())
            } else {
                Err(format!(
                    "移动工作区数据失败（{} -> {}）: {error}",
                    source.display(),
                    target.display()
                ))
            }
        }
    }
}

fn verify_legacy_layout_is_absent(workspace_root: &Path) -> Result<(), String> {
    for entry in WORKSPACE_FILE_MOVES {
        let source = workspace_root.join(entry.source);
        if path_exists(&source)? {
            return Err(format!("工作区旧文件仍然存在：{}", source.display()));
        }
    }
    let legacy_repositories = workspace_root.join("repo-cache");
    if path_exists(&legacy_repositories)? {
        return Err(format!(
            "工作区旧仓库目录仍然存在：{}",
            legacy_repositories.display()
        ));
    }
    Ok(())
}

fn read_layout_version(workspace_root: &Path) -> Result<Option<u32>, String> {
    let layout_path = workspace_root.join(LAYOUT_FILE_PATH);
    let content = match fs::read_to_string(&layout_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "读取工作区布局标记失败（{}）: {error}",
                layout_path.display()
            ))
        }
    };
    let layout = serde_json::from_str::<WorkspaceLayout>(&content).map_err(|error| {
        format!(
            "解析工作区布局标记失败（{}）: {error}",
            layout_path.display()
        )
    })?;
    if layout.layout_version != WORKSPACE_LAYOUT_VERSION {
        return Err(format!(
            "工作区布局版本 {} 不受当前版本支持（仅支持 {WORKSPACE_LAYOUT_VERSION}）",
            layout.layout_version
        ));
    }
    Ok(Some(layout.layout_version))
}

fn write_layout_file_if_missing(workspace_root: &Path) -> Result<(), String> {
    if read_layout_version(workspace_root)? == Some(WORKSPACE_LAYOUT_VERSION) {
        return Ok(());
    }
    write_layout_file(workspace_root)
}

fn write_layout_file(workspace_root: &Path) -> Result<(), String> {
    let layout_path = workspace_root.join(LAYOUT_FILE_PATH);
    let parent = layout_path
        .parent()
        .ok_or_else(|| "工作区布局标记父目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建布局标记目录失败: {error}"))?;
    let payload = serde_json::to_vec_pretty(&WorkspaceLayout {
        layout_version: WORKSPACE_LAYOUT_VERSION,
    })
    .map_err(|error| format!("序列化工作区布局标记失败: {error}"))?;
    let sequence = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = parent.join(format!(
        ".layout.json.tmp-{}-{sequence}",
        std::process::id()
    ));
    fs::write(&temporary, payload)
        .map_err(|error| format!("写入工作区布局临时标记失败: {error}"))?;
    match fs::rename(&temporary, &layout_path) {
        Ok(()) => Ok(()),
        Err(_) if read_layout_version(workspace_root)? == Some(WORKSPACE_LAYOUT_VERSION) => {
            let _ = fs::remove_file(temporary);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(temporary);
            Err(format!(
                "提交工作区布局标记失败（{}）: {error}",
                layout_path.display()
            ))
        }
    }
}

fn protect_credentials_directory(workspace_root: &Path) -> Result<(), String> {
    let credentials_dir = workspace_root.join("credentials");
    fs::create_dir_all(&credentials_dir).map_err(|error| format!("创建凭证目录失败: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(&credentials_dir, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("设置凭证目录权限失败: {error}"))?;
        for file_name in ["legacy-marketplace.json", "skillhub.json", "github.json"] {
            let path = credentials_dir.join(file_name);
            if path_exists(&path)? {
                protect_credential_file(&path)?;
            }
        }
    }
    Ok(())
}

fn protect_credential_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("设置凭证文件权限失败（{}）: {error}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn prune_legacy_workspace_root_if_empty(home_dir: &Path) {
    let legacy_root = home_dir.join(LEGACY_WORKSPACE_DIR_NAME);
    if legacy_root.is_dir()
        && fs::read_dir(&legacy_root)
            .ok()
            .is_some_and(|mut entries| entries.next().is_none())
    {
        let _ = fs::remove_dir(legacy_root);
    }
}

fn workspace_relative_file_path(file_name: &str) -> PathBuf {
    workspace_file_move(file_name)
        .map(|entry| PathBuf::from(entry.target))
        .unwrap_or_else(|| PathBuf::from(file_name))
}

fn legacy_relative_file_path(file_name: &str) -> PathBuf {
    workspace_file_move(file_name)
        .map(|entry| entry.source)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(file_name))
}

fn workspace_file_move(file_name: &str) -> Option<&'static WorkspaceFileMove> {
    WORKSPACE_FILE_MOVES.iter().find(|entry| {
        Path::new(entry.source)
            .file_name()
            .is_some_and(|source_name| source_name == file_name)
    })
}

fn path_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("检查工作区路径失败（{}）: {error}", path.display())),
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
                    temp_home.join(".skilldock/data/state.json"),
                    temp_home.join(".skilldock/state.json"),
                    temp_home.join(".skillm/state.json"),
                ]
            );
            assert_eq!(
                workspace_file_candidates("legacy-marketplace-session.json"),
                vec![
                    temp_home.join(".skilldock/credentials/legacy-marketplace.json"),
                    temp_home.join(".skilldock/cache/legacy-marketplace-session.json"),
                    temp_home.join(".skillm/cache/legacy-marketplace-session.json"),
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
            assert!(workspace_root.join("repositories").is_dir());
            assert!(workspace_root.join("imports").is_dir());
            assert_eq!(
                fs::read_to_string(workspace_root.join("data/state.json")).expect("read state"),
                "{\n  \"installedSkills\": []\n}\n"
            );
            assert_eq!(
                fs::read_to_string(workspace_root.join("config/mcp-servers.json"))
                    .expect("read mcp"),
                "{\n  \"servers\": []\n}\n"
            );
            let settings_content = fs::read_to_string(workspace_root.join("config/settings.json"))
                .expect("read settings");
            assert!(settings_content.contains("\"defaultOpenToolId\": \"\""));
            assert!(settings_content.contains("\"skillInstallActivation\": \"apply-all-tools\""));
            assert!(settings_content.contains("\"mcpInstallActivation\": \"apply-all-tools\""));
            assert!(settings_content.contains("\"skillSourceViewStyle\": \"select\""));
            assert!(settings_content.contains("\"skillLibraryProvider\": \"skilldock\""));
            assert!(settings_content.contains("\"agentSkillsCompatibilityEnabled\": true"));
            assert!(compatibility_enabled_for_home(&temp_home));
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(
                    &fs::read_to_string(workspace_root.join("data/layout.json"))
                        .expect("read layout")
                )
                .expect("parse layout")["layoutVersion"],
                2
            );
        });
    }

    #[test]
    fn keeps_agent_skills_compatibility_disabled_when_existing_workspace_has_no_settings() {
        run_with_temp_home("bootstrap-existing-workspace", |temp_home| {
            let workspace_root = temp_home.join(WORKSPACE_DIR_NAME);
            fs::create_dir_all(workspace_root.join("skills")).expect("create existing workspace");

            ensure_workspace_initialized().expect("workspace should initialize");

            let settings_content = fs::read_to_string(workspace_root.join("config/settings.json"))
                .expect("read settings");
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
            fs::create_dir_all(workspace_root.join("config")).expect("create workspace");
            fs::write(
                workspace_root.join("config/settings.json"),
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
                fs::read_to_string(workspace_root.join("data/state.json")).expect("read state"),
                "{\n  \"installedSkills\": [{\"name\": \"kept\"}]\n}\n"
            );
            assert_eq!(
                fs::read_to_string(workspace_root.join("config/settings.json"))
                    .expect("read settings"),
                "{\n  \"defaultOpenToolId\": \"cursor\"\n}\n"
            );
            assert!(!compatibility_enabled_for_home(&temp_home));
            assert_eq!(
                fs::read_to_string(workspace_root.join("config/mcp-servers.json"))
                    .expect("read mcp"),
                "{\n  \"servers\": [{\"id\": \"kept\"}]\n}\n"
            );
        });
    }

    #[test]
    fn migrates_flat_workspace_layout_by_moving_every_entry() {
        run_with_temp_home("layout-v2", |temp_home| {
            let workspace_root = temp_home.join(WORKSPACE_DIR_NAME);
            fs::create_dir_all(workspace_root.join("cache")).expect("create cache");
            fs::create_dir_all(workspace_root.join("repo-cache/仓库/子目录"))
                .expect("create repository");
            let files = [
                ("settings.json", "{\"theme\":\"dark\"}"),
                ("mcp-servers.json", "{\"servers\":[]}"),
                ("state.json", "{\"installedSkills\":[]}"),
                ("publish-state.json", "{\"skills\":{}}"),
                ("skillhub-publish-state.json", "{\"skills\":{}}"),
                ("cache/legacy-marketplace-session.json", "{\"accessToken\":\"secret\"}"),
                ("skillhub-auth.json", "{\"token\":\"secret\"}"),
                ("github-credentials.json", "{\"token\":\"secret\"}"),
                ("git-update-cache.json", "{\"entries\":[]}"),
                ("plugin-list-cache.json", "[]"),
                ("plugin-update-cache.json", "{\"entries\":[]}"),
            ];
            for (relative_path, content) in files {
                fs::write(workspace_root.join(relative_path), content).expect("write legacy file");
            }
            fs::write(
                workspace_root.join("repo-cache/仓库/子目录/README.md"),
                "仓库内容",
            )
            .expect("write repository content");

            ensure_workspace_initialized().expect("migrate workspace");

            let moved_files = [
                ("config/settings.json", "{\"theme\":\"dark\"}"),
                ("config/mcp-servers.json", "{\"servers\":[]}"),
                ("data/state.json", "{\"installedSkills\":[]}"),
                ("data/publishing/legacy-marketplace.json", "{\"skills\":{}}"),
                ("data/publishing/skillhub.json", "{\"skills\":{}}"),
                ("credentials/legacy-marketplace.json", "{\"accessToken\":\"secret\"}"),
                ("credentials/skillhub.json", "{\"token\":\"secret\"}"),
                ("credentials/github.json", "{\"token\":\"secret\"}"),
                ("cache/git-update.json", "{\"entries\":[]}"),
                ("cache/plugin-list.json", "[]"),
                ("cache/plugin-update.json", "{\"entries\":[]}"),
            ];
            for (relative_path, expected) in moved_files {
                assert_eq!(
                    fs::read_to_string(workspace_root.join(relative_path))
                        .expect("read moved file"),
                    expected
                );
            }
            for (relative_path, _) in files {
                assert!(!super::path_exists(&workspace_root.join(relative_path))
                    .expect("check legacy path"));
            }
            assert_eq!(
                fs::read_to_string(workspace_root.join("repositories/仓库/子目录/README.md"))
                    .expect("read moved repository"),
                "仓库内容"
            );
            assert!(!super::path_exists(&workspace_root.join("repo-cache"))
                .expect("check legacy repositories"));
            assert_eq!(
                super::read_layout_version(&workspace_root).expect("read layout"),
                Some(super::WORKSPACE_LAYOUT_VERSION)
            );

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;

                assert_eq!(
                    fs::metadata(workspace_root.join("credentials"))
                        .expect("credential directory metadata")
                        .permissions()
                        .mode()
                        & 0o777,
                    0o700
                );
                assert_eq!(
                    fs::metadata(workspace_root.join("credentials/github.json"))
                        .expect("credential file metadata")
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
        });
    }

    #[test]
    fn resumes_partially_moved_workspace_without_overwriting_targets() {
        run_with_temp_home("layout-resume", |temp_home| {
            let workspace_root = temp_home.join(WORKSPACE_DIR_NAME);
            fs::create_dir_all(workspace_root.join("config")).expect("create target directory");
            fs::write(
                workspace_root.join("config/settings.json"),
                "{\"theme\":\"dark\"}",
            )
            .expect("write already moved settings");
            fs::write(
                workspace_root.join("state.json"),
                "{\"installedSkills\":[]}",
            )
            .expect("write pending state");

            ensure_workspace_initialized().expect("resume migration");

            assert_eq!(
                fs::read_to_string(workspace_root.join("config/settings.json"))
                    .expect("read settings"),
                "{\"theme\":\"dark\"}"
            );
            assert!(workspace_root.join("data/state.json").is_file());
            assert!(!workspace_root.join("state.json").exists());
            assert_eq!(
                super::read_layout_version(&workspace_root).expect("read layout"),
                Some(super::WORKSPACE_LAYOUT_VERSION)
            );
        });
    }

    #[test]
    fn rejects_layout_conflicts_without_removing_either_file_or_writing_marker() {
        run_with_temp_home("layout-conflict", |temp_home| {
            let workspace_root = temp_home.join(WORKSPACE_DIR_NAME);
            fs::create_dir_all(workspace_root.join("config")).expect("create target directory");
            fs::write(workspace_root.join("settings.json"), "legacy")
                .expect("write legacy settings");
            fs::write(workspace_root.join("config/settings.json"), "current")
                .expect("write current settings");

            let error = ensure_workspace_initialized().expect_err("conflict should fail migration");

            assert!(error.contains("迁移目标已存在"));
            assert_eq!(
                fs::read_to_string(workspace_root.join("settings.json")).expect("read legacy"),
                "legacy"
            );
            assert_eq!(
                fs::read_to_string(workspace_root.join("config/settings.json"))
                    .expect("read current"),
                "current"
            );
            assert!(!workspace_root.join("data/layout.json").exists());
        });
    }

    #[cfg(unix)]
    #[test]
    fn permission_errors_abort_migration_without_writing_marker() {
        use std::os::unix::fs::PermissionsExt;

        run_with_temp_home("layout-permission-error", |temp_home| {
            let workspace_root = temp_home.join(WORKSPACE_DIR_NAME);
            let legacy_cache = workspace_root.join("cache");
            fs::create_dir_all(&legacy_cache).expect("create legacy cache");
            fs::write(legacy_cache.join("legacy-marketplace-session.json"), "secret")
                .expect("write legacy credential");
            fs::set_permissions(&legacy_cache, fs::Permissions::from_mode(0o000))
                .expect("remove cache permissions");

            let result = ensure_workspace_initialized();

            fs::set_permissions(&legacy_cache, fs::Permissions::from_mode(0o700))
                .expect("restore cache permissions");
            assert!(result.is_err());
            assert!(legacy_cache.join("legacy-marketplace-session.json").is_file());
            assert!(!workspace_root.join("data/layout.json").exists());
        });
    }

    #[cfg(unix)]
    #[test]
    fn credentials_are_protected_even_when_a_later_move_conflicts() {
        use std::os::unix::fs::PermissionsExt;

        run_with_temp_home("layout-credential-partial-failure", |temp_home| {
            let workspace_root = temp_home.join(WORKSPACE_DIR_NAME);
            fs::create_dir_all(workspace_root.join("cache")).expect("create cache");
            fs::write(workspace_root.join("github-credentials.json"), "secret")
                .expect("write legacy credential");
            fs::write(workspace_root.join("git-update-cache.json"), "legacy")
                .expect("write legacy cache");
            fs::write(workspace_root.join("cache/git-update.json"), "current")
                .expect("write current cache");

            assert!(ensure_workspace_initialized().is_err());

            let credential_path = workspace_root.join("credentials/github.json");
            assert_eq!(
                fs::metadata(workspace_root.join("credentials"))
                    .expect("credential directory metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&credential_path)
                    .expect("credential metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert!(!workspace_root.join("github-credentials.json").exists());
            assert!(!workspace_root.join("data/layout.json").exists());
        });
    }

    #[test]
    fn directory_merge_accepts_source_removed_after_target_was_created() {
        let temp_root = unique_temp_home("directory-merge-race");
        let source = temp_root.join("legacy");
        let target = temp_root.join("current");
        fs::create_dir_all(&target).expect("create migration target");

        super::move_directory_contents(&source, &target)
            .expect("missing source with existing target is complete");

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn rejects_future_or_damaged_layout_markers_without_touching_workspace_data() {
        for (label, marker) in [
            ("older-layout", "{\"layoutVersion\":1}"),
            ("future-layout", "{\"layoutVersion\":3}"),
            ("damaged-layout", "not-json"),
        ] {
            run_with_temp_home(label, |temp_home| {
                let workspace_root = temp_home.join(WORKSPACE_DIR_NAME);
                fs::create_dir_all(workspace_root.join("data")).expect("create data directory");
                fs::write(workspace_root.join("data/layout.json"), marker).expect("write marker");
                fs::write(workspace_root.join("settings.json"), "legacy")
                    .expect("write legacy settings");

                assert!(ensure_workspace_initialized().is_err());
                assert_eq!(
                    fs::read_to_string(workspace_root.join("settings.json")).expect("read legacy"),
                    "legacy"
                );
                assert_eq!(
                    fs::read_to_string(workspace_root.join("data/layout.json"))
                        .expect("read marker"),
                    marker
                );
            });
        }
    }

    #[test]
    fn validates_layout_markers_before_moving_legacy_workspace_data() {
        for (label, marker_root) in [
            ("current-marker-before-legacy", ".skilldock"),
            ("legacy-marker-before-legacy", ".skillm"),
        ] {
            run_with_temp_home(label, |temp_home| {
                let legacy_skill = temp_home.join(".skillm/skills/demo/SKILL.md");
                fs::create_dir_all(legacy_skill.parent().expect("legacy skill parent"))
                    .expect("create legacy skill");
                fs::write(&legacy_skill, "# demo").expect("write legacy skill");
                let marker_path = temp_home.join(marker_root).join("data/layout.json");
                fs::create_dir_all(marker_path.parent().expect("marker parent"))
                    .expect("create marker directory");
                fs::write(&marker_path, "{\"layoutVersion\":1}").expect("write old marker");

                assert!(ensure_workspace_initialized().is_err());

                assert!(legacy_skill.is_file());
                assert_eq!(
                    fs::read_to_string(marker_path).expect("read unchanged marker"),
                    "{\"layoutVersion\":1}"
                );
            });
        }
    }

    #[test]
    fn completed_layout_initialization_is_idempotent() {
        run_with_temp_home("layout-idempotent", |temp_home| {
            let workspace_root = temp_home.join(WORKSPACE_DIR_NAME);
            fs::create_dir_all(&workspace_root).expect("create workspace");
            fs::write(
                workspace_root.join("state.json"),
                "{\"installedSkills\":[]}",
            )
            .expect("write state");

            ensure_workspace_initialized().expect("first initialization");
            let state = fs::read(workspace_root.join("data/state.json")).expect("read state");
            let layout = fs::read(workspace_root.join("data/layout.json")).expect("read layout");

            ensure_workspace_initialized().expect("second initialization");

            assert_eq!(
                fs::read(workspace_root.join("data/state.json")).expect("read state again"),
                state
            );
            assert_eq!(
                fs::read(workspace_root.join("data/layout.json")).expect("read layout again"),
                layout
            );
        });
    }

    #[test]
    fn serializes_concurrent_layout_migration_for_the_same_workspace() {
        let temp_home = unique_temp_home("layout-concurrent");
        let workspace_root = temp_home.join(WORKSPACE_DIR_NAME);
        fs::create_dir_all(&workspace_root).expect("create workspace");
        fs::write(
            workspace_root.join("state.json"),
            "{\"installedSkills\":[]}",
        )
        .expect("write state");

        let first_home = temp_home.clone();
        let second_home = temp_home.clone();
        let first =
            std::thread::spawn(move || super::ensure_workspace_migrated_for_home(&first_home));
        let second =
            std::thread::spawn(move || super::ensure_workspace_migrated_for_home(&second_home));

        first
            .join()
            .expect("join first migration")
            .expect("first migration");
        second
            .join()
            .expect("join second migration")
            .expect("second migration");
        assert!(workspace_root.join("data/state.json").is_file());
        assert!(!workspace_root.join("state.json").exists());
        assert_eq!(
            super::read_layout_version(&workspace_root).expect("read layout"),
            Some(super::WORKSPACE_LAYOUT_VERSION)
        );

        let _ = fs::remove_dir_all(temp_home);
    }
}
