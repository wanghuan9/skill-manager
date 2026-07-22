use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::workspace::home_dir;

const CLI_COMMAND: &str = "skills";
const NPX_COMMAND: &str = "npx";
const WELL_KNOWN_SOURCE_TYPE: &str = "well-known";
const UPDATE_CHECK_CONCURRENCY: usize = 6;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSkillLockEntry {
    #[serde(default)]
    pub source_type: String,
    #[serde(default)]
    pub source_url: String,
    #[serde(default)]
    pub skill_path: Option<String>,
    #[serde(default)]
    pub skill_folder_hash: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct GlobalSkillLock {
    #[serde(default)]
    pub skills: BTreeMap<String, GlobalSkillLockEntry>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentSkillUpdateCheck {
    pub checked_names: BTreeSet<String>,
    pub updated_names: BTreeSet<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliSkillEntry {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub agents: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillsCliStatus {
    pub available: bool,
    pub global_path: String,
    pub entries: Vec<CliSkillEntry>,
    pub error: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillEntryPath {
    pub entry_path: PathBuf,
    pub canonical_path: Option<PathBuf>,
    pub path_error: String,
}

pub fn global_skill_root() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".agents/skills"))
}

pub fn resolve_skill_entry_path(entry: &Path) -> SkillEntryPath {
    match entry.canonicalize() {
        Ok(canonical_path) => SkillEntryPath {
            entry_path: entry.to_path_buf(),
            canonical_path: Some(canonical_path),
            path_error: String::new(),
        },
        Err(error) => SkillEntryPath {
            entry_path: entry.to_path_buf(),
            canonical_path: None,
            path_error: format!("无法解析 Skill 入口: {error}"),
        },
    }
}

pub fn locked_global_skill_names() -> BTreeSet<String> {
    let Ok(lock_path) = home_dir().map(|home| home.join(".agents/.skill-lock.json")) else {
        return BTreeSet::new();
    };
    let Ok(contents) = fs::read_to_string(lock_path) else {
        return BTreeSet::new();
    };
    parse_locked_global_skill_names(&contents)
}

pub fn parse_locked_global_skill_names(contents: &str) -> BTreeSet<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(contents) else {
        return BTreeSet::new();
    };
    value
        .get("skills")
        .and_then(serde_json::Value::as_object)
        .map(|skills| skills.keys().cloned().collect())
        .unwrap_or_default()
}

pub fn parse_global_skill_lock(contents: &str) -> Result<GlobalSkillLock, String> {
    serde_json::from_str(contents)
        .map_err(|error| format!("解析 Agent Skills CLI 锁文件失败: {error}"))
}

pub fn changed_global_skill_names(
    before: &GlobalSkillLock,
    after: &GlobalSkillLock,
) -> BTreeSet<String> {
    before
        .skills
        .iter()
        .filter_map(|(name, before_entry)| {
            let after_entry = after.skills.get(name)?;
            (before_entry.skill_folder_hash != after_entry.skill_folder_hash).then(|| name.clone())
        })
        .collect()
}

pub fn detect_global_updates(
    skill_paths: &BTreeMap<String, PathBuf>,
) -> Result<AgentSkillUpdateCheck, String> {
    if skill_paths.is_empty() {
        return Ok(AgentSkillUpdateCheck::default());
    }
    let lock_path = home_dir()?.join(".agents/.skill-lock.json");
    let lock_contents = fs::read_to_string(&lock_path)
        .map_err(|error| format!("读取 Agent Skills CLI 锁文件失败: {error}"))?;
    let lock = parse_global_skill_lock(&lock_contents)?;
    let mut check = detect_well_known_updates(&lock, skill_paths);
    match detect_cli_managed_updates(&lock_contents, &lock) {
        Ok(cli_check) => {
            check.checked_names.extend(cli_check.checked_names);
            check.updated_names.extend(cli_check.updated_names);
        }
        Err(error) => log::warn!("Agent Skills CLI update check failed: {error}"),
    }
    check
        .checked_names
        .retain(|name| skill_paths.contains_key(name));
    check
        .updated_names
        .retain(|name| skill_paths.contains_key(name));
    Ok(check)
}

fn detect_well_known_updates(
    lock: &GlobalSkillLock,
    skill_paths: &BTreeMap<String, PathBuf>,
) -> AgentSkillUpdateCheck {
    let candidates = lock
        .skills
        .iter()
        .filter_map(|(name, entry)| {
            if entry.source_type != WELL_KNOWN_SOURCE_TYPE || entry.source_url.is_empty() {
                return None;
            }
            let local_path = skill_paths.get(name)?.join("SKILL.md");
            Some((name.clone(), entry.source_url.clone(), local_path))
        })
        .collect::<Vec<_>>();
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("SkillDock Agent Skills CLI compatibility")
        .build()
    {
        Ok(client) => client,
        Err(_) => return AgentSkillUpdateCheck::default(),
    };
    let mut check = AgentSkillUpdateCheck::default();
    for chunk in candidates.chunks(UPDATE_CHECK_CONCURRENCY) {
        let chunk_results = std::thread::scope(|scope| {
            chunk
                .iter()
                .map(|(name, source_url, local_path)| {
                    let client = &client;
                    scope.spawn(move || {
                        is_well_known_skill_updated(client, source_url, local_path)
                            .map(|updated| (name.clone(), updated))
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .filter_map(|handle| handle.join().ok().flatten())
                .collect::<Vec<_>>()
        });
        for (name, updated) in chunk_results {
            check.checked_names.insert(name.clone());
            if updated {
                check.updated_names.insert(name);
            }
        }
    }
    check
}

fn is_well_known_skill_updated(
    client: &reqwest::blocking::Client,
    source_url: &str,
    local_path: &Path,
) -> Option<bool> {
    let Ok(url) = url::Url::parse(source_url) else {
        return None;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let Ok(local_contents) = fs::read(local_path) else {
        return None;
    };
    let Ok(response) = client
        .get(url)
        .send()
        .and_then(|response| response.error_for_status())
    else {
        return None;
    };
    response
        .bytes()
        .ok()
        .map(|remote| remote.as_ref() != local_contents)
}

fn detect_cli_managed_updates(
    lock_contents: &str,
    original_lock: &GlobalSkillLock,
) -> Result<AgentSkillUpdateCheck, String> {
    let checked_names = original_lock
        .skills
        .iter()
        .filter_map(|(name, entry)| {
            (entry.source_type != WELL_KNOWN_SOURCE_TYPE
                && entry
                    .skill_path
                    .as_deref()
                    .is_some_and(|path| !path.is_empty())
                && !entry.skill_folder_hash.is_empty())
            .then(|| name.clone())
        })
        .collect::<BTreeSet<_>>();
    if checked_names.is_empty() {
        return Ok(AgentSkillUpdateCheck::default());
    }
    let temp_home = create_update_check_home(lock_contents)?;
    let result = run_update_check_in_home(&temp_home).and_then(|_| {
        let refreshed_contents = fs::read_to_string(temp_home.join(".agents/.skill-lock.json"))
            .map_err(|error| format!("读取临时 Agent Skills CLI 锁文件失败: {error}"))?;
        let refreshed_lock = parse_global_skill_lock(&refreshed_contents)?;
        Ok(AgentSkillUpdateCheck {
            checked_names,
            updated_names: changed_global_skill_names(original_lock, &refreshed_lock),
        })
    });
    let _ = fs::remove_dir_all(&temp_home);
    result
}

fn create_update_check_home(lock_contents: &str) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("生成更新检查临时目录失败: {error}"))?
        .as_nanos();
    let temp_home = std::env::temp_dir().join(format!(
        "skilldock-agent-update-check-{}-{timestamp}",
        std::process::id()
    ));
    let agents_dir = temp_home.join(".agents");
    fs::create_dir_all(&agents_dir)
        .map_err(|error| format!("创建更新检查临时目录失败: {error}"))?;
    fs::write(agents_dir.join(".skill-lock.json"), lock_contents)
        .map_err(|error| format!("写入临时 Agent Skills CLI 锁文件失败: {error}"))?;
    Ok(temp_home)
}

fn run_update_check_in_home(temp_home: &Path) -> Result<(), String> {
    let program = find_cli_program_for_operation()
        .ok_or_else(|| "未检测到 skills 命令，无法检查 Agent CLI Skill 更新。".to_string())?;
    let output = run_with_program_in_home(&program, &["update", "-g", "-y"], temp_home)?;
    if output.status.success() {
        return Ok(());
    }
    Err(command_error(&output))
}

pub fn global_status() -> AgentSkillsCliStatus {
    let global_path = global_skill_root()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let Some(program) = find_local_cli_program() else {
        return AgentSkillsCliStatus {
            available: false,
            global_path,
            entries: Vec::new(),
            error: "未检测到 skills 命令；仍可扫描 ~/.agents/skills 中的文件。".into(),
        };
    };

    match run_with_program(&program, &["ls", "-g", "--json"]) {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            match parse_global_skill_list_json(&stdout) {
                Ok(entries) => AgentSkillsCliStatus {
                    available: true,
                    global_path,
                    entries,
                    error: String::new(),
                },
                Err(error) => AgentSkillsCliStatus {
                    available: true,
                    global_path,
                    entries: Vec::new(),
                    error,
                },
            }
        }
        Ok(output) => AgentSkillsCliStatus {
            available: true,
            global_path,
            entries: Vec::new(),
            error: command_error(&output),
        },
        Err(error) => AgentSkillsCliStatus {
            available: true,
            global_path,
            entries: Vec::new(),
            error,
        },
    }
}

pub fn parse_global_skill_list_json(output: &str) -> Result<Vec<CliSkillEntry>, String> {
    serde_json::from_str(output).map_err(|error| format!("解析 skills 列表失败: {error}"))
}

pub fn update_global_skill(name: &str) -> Result<(), String> {
    let lock_path = home_dir()?.join(".agents/.skill-lock.json");
    let lock_contents = fs::read_to_string(lock_path)
        .map_err(|error| format!("读取 Agent Skills CLI 锁文件失败: {error}"))?;
    let lock = parse_global_skill_lock(&lock_contents)?;
    if let Some(entry) = lock.skills.get(name) {
        if entry.source_type == WELL_KNOWN_SOURCE_TYPE && !entry.source_url.is_empty() {
            return run_explicit_cli(&["add", &entry.source_url, "-g", "-y"]);
        }
    }
    run_explicit_cli(&["update", name, "-g", "-y"])
}

pub fn remove_global_skill(name: &str) -> Result<(), String> {
    run_explicit_cli(&["remove", name, "-g", "-y"])
}

fn run_explicit_cli(args: &[&str]) -> Result<(), String> {
    let program = find_cli_program_for_operation()
        .ok_or_else(|| "未检测到 skills 命令，无法执行 Agent Skills CLI 操作。".to_string())?;
    let output = run_with_program(&program, args)?;
    if output.status.success() {
        return Ok(());
    }

    Err(command_error(&output))
}

fn find_local_cli_program() -> Option<CliProgram> {
    let program = CliProgram::direct();
    let output = run_with_program(&program, &["--version"]).ok()?;
    output.status.success().then_some(program)
}

fn find_cli_program_for_operation() -> Option<CliProgram> {
    find_local_cli_program().or_else(|| {
        let program = CliProgram::npx();
        run_with_program(&program, &["--version"])
            .ok()
            .filter(|output| output.status.success())
            .map(|_| program)
    })
}

fn run_with_program(program: &CliProgram, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new(&program.program);
    command.args(&program.prefix_args).args(args);
    command
        .output()
        .map_err(|error| format!("执行 skills 命令失败: {error}"))
}

fn run_with_program_in_home(
    program: &CliProgram,
    args: &[&str],
    task_home: &Path,
) -> Result<Output, String> {
    let mut command = Command::new(&program.program);
    command.args(&program.prefix_args).args(args);
    command.env("HOME", task_home).env("USERPROFILE", task_home);
    command
        .output()
        .map_err(|error| format!("执行 skills 命令失败: {error}"))
}

fn command_error(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("skills 命令执行失败，退出码 {:?}", output.status.code())
    } else {
        format!("skills 命令执行失败: {stderr}")
    }
}

#[derive(Clone, Debug)]
struct CliProgram {
    program: String,
    prefix_args: Vec<String>,
}

impl CliProgram {
    fn direct() -> Self {
        Self {
            program: CLI_COMMAND.into(),
            prefix_args: Vec::new(),
        }
    }

    fn npx() -> Self {
        Self {
            program: NPX_COMMAND.into(),
            prefix_args: vec!["--yes".into(), CLI_COMMAND.into()],
        }
    }
}

#[allow(dead_code)]
pub fn is_global_skill_path(path: &Path) -> bool {
    let Ok(root) = global_skill_root() else {
        return false;
    };
    let lexical_path = path.to_path_buf();
    if lexical_path.starts_with(&root) {
        return true;
    }

    root.canonicalize().ok().is_some_and(|canonical_root| {
        path.canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .starts_with(canonical_root)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        changed_global_skill_names, detect_global_updates, is_global_skill_path,
        parse_global_skill_list_json, parse_global_skill_lock, parse_locked_global_skill_names,
        resolve_skill_entry_path, CliSkillEntry,
    };
    use std::collections::BTreeMap;
    use std::env;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn parses_global_skill_list_json() {
        let entries = parse_global_skill_list_json(
            r#"[{"name":"demo","path":"/tmp/.agents/skills/demo","scope":"global","agents":["Codex"]}]"#,
        )
        .expect("parse CLI JSON");

        assert_eq!(
            entries,
            vec![CliSkillEntry {
                name: "demo".into(),
                path: "/tmp/.agents/skills/demo".into(),
                scope: "global".into(),
                agents: vec!["Codex".into()],
            }]
        );
    }

    #[test]
    fn rejects_malformed_global_skill_list_json() {
        assert!(parse_global_skill_list_json("not-json").is_err());
    }

    #[test]
    fn parses_skill_names_from_v3_lock_file() {
        let names = parse_locked_global_skill_names(
            r#"{"version":3,"skills":{"demo":{"source":"example"},"other":{}}}"#,
        );

        assert_eq!(names.into_iter().collect::<Vec<_>>(), vec!["demo", "other"]);
        assert!(parse_locked_global_skill_names("not-json").is_empty());
    }

    #[test]
    fn detects_changed_global_skill_hashes() {
        let before = parse_global_skill_lock(
            r#"{"version":3,"skills":{"changed":{"skillFolderHash":"old"},"same":{"skillFolderHash":"same"}}}"#,
        )
        .expect("parse original lock");
        let after = parse_global_skill_lock(
            r#"{"version":3,"skills":{"changed":{"skillFolderHash":"new"},"same":{"skillFolderHash":"same"}}}"#,
        )
        .expect("parse refreshed lock");

        assert_eq!(
            changed_global_skill_names(&before, &after),
            ["changed".to_string()].into_iter().collect()
        );
    }

    #[test]
    fn parses_well_known_lock_entry_with_null_skill_path() {
        let lock = parse_global_skill_lock(
            r#"{"version":3,"skills":{"lark-attendance":{"sourceType":"well-known","sourceUrl":"https://open.feishu.cn/.well-known/skills/lark-attendance/SKILL.md","skillFolderHash":"","skillPath":null}}}"#,
        )
        .expect("parse well-known lock");

        let entry = lock.skills.get("lark-attendance").expect("find lock entry");
        assert_eq!(entry.skill_path, None);
    }

    #[test]
    fn skips_global_update_detection_without_agent_skills() {
        assert_eq!(
            detect_global_updates(&BTreeMap::new()),
            Ok(Default::default())
        );
    }

    #[test]
    fn resolves_real_and_broken_skill_entries() {
        let temp_dir = env::temp_dir().join("skilldock-entry-path-test");
        let skill_dir = temp_dir.join("demo");
        fs::create_dir_all(&skill_dir).expect("create skill path");

        let resolved = resolve_skill_entry_path(&skill_dir);
        assert_eq!(resolved.canonical_path, skill_dir.canonicalize().ok());
        assert!(resolved.path_error.is_empty());

        let broken = resolve_skill_entry_path(&temp_dir.join("missing"));
        assert!(broken.canonical_path.is_none());
        assert!(!broken.path_error.is_empty());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn recognizes_path_inside_global_skill_root() {
        let _guard = crate::workspace::TEST_ENV_LOCK.lock().expect("env lock");
        let original_home = env::var_os("HOME");
        let temp_home = env::temp_dir().join("skilldock-cli-path-test");
        let skill_path = temp_home.join(".agents/skills/demo");
        fs::create_dir_all(&skill_path).expect("create skill path");
        unsafe {
            env::set_var("HOME", &temp_home);
        }

        assert!(is_global_skill_path(&skill_path));
        assert!(!is_global_skill_path(&PathBuf::from("/tmp/other-skill")));

        match original_home {
            Some(value) => unsafe { env::set_var("HOME", value) },
            None => unsafe { env::remove_var("HOME") },
        }
        let _ = fs::remove_dir_all(temp_home);
    }
}
