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

pub fn global_skill_lock_entries() -> BTreeMap<String, GlobalSkillLockEntry> {
    let Ok(lock_path) = home_dir().map(|home| home.join(".agents/.skill-lock.json")) else {
        return BTreeMap::new();
    };
    let Ok(contents) = fs::read_to_string(lock_path) else {
        return BTreeMap::new();
    };
    parse_global_skill_lock(&contents)
        .map(|lock| lock.skills)
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
    let mut check = detect_cli_managed_updates(&lock_contents, &lock).unwrap_or_else(|error| {
        log::warn!("Agent Skills CLI update check failed: {error}");
        AgentSkillUpdateCheck::default()
    });
    check
        .checked_names
        .retain(|name| skill_paths.contains_key(name));
    check
        .updated_names
        .retain(|name| skill_paths.contains_key(name));
    Ok(check)
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
    run_explicit_cli(&["remove", name, "-g", "-y"])?;
    verify_global_skill_removed(name)
}

fn verify_global_skill_removed(name: &str) -> Result<(), String> {
    let entry_path = global_skill_root()?.join(name);
    if fs::symlink_metadata(&entry_path).is_ok() {
        return Err(format!(
            "Agent Skills CLI 未删除全局 Skill 入口：{}",
            entry_path.to_string_lossy()
        ));
    }

    let lock_path = home_dir()?.join(".agents/.skill-lock.json");
    let lock_contents = match fs::read_to_string(&lock_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取 Agent Skills CLI 锁文件失败: {error}")),
    };
    let lock = parse_global_skill_lock(&lock_contents)?;
    if lock.skills.contains_key(name) {
        return Err(format!("Agent Skills CLI 未删除 {name} 的锁文件记录"));
    }
    Ok(())
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
        parse_global_skill_list_json, parse_global_skill_lock, remove_global_skill,
        resolve_skill_entry_path, CliSkillEntry,
    };
    use std::collections::BTreeMap;
    use std::env;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::thread;

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
    fn does_not_check_well_known_skills_for_updates() {
        let _guard = crate::workspace::TEST_ENV_LOCK.lock().expect("env lock");
        let original_home = env::var_os("HOME");
        let temp_home = env::temp_dir().join(format!(
            "skilldock-well-known-update-test-{}",
            std::process::id()
        ));
        let skill_dir = temp_home.join(".agents/skills/lark-okr");
        fs::create_dir_all(&skill_dir).expect("create well-known skill path");
        fs::write(skill_dir.join("SKILL.md"), "local contents")
            .expect("write local skill contents");

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        listener
            .set_nonblocking(true)
            .expect("configure test server");
        let source_url = format!(
            "http://{}/.well-known/skills/lark-okr/SKILL.md",
            listener.local_addr().expect("read test server address")
        );
        let (request_tx, request_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let server = thread::spawn(move || loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut request = [0_u8; 1024];
                    let _ = stream.read(&mut request);
                    let _ = request_tx.send(());
                    let body = "remote contents";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream
                        .write_all(response.as_bytes())
                        .expect("serve remote skill contents");
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::yield_now();
                }
                Err(error) => panic!("accept test request: {error}"),
            }
        });

        fs::write(
            temp_home.join(".agents/.skill-lock.json"),
            format!(
                r#"{{"version":3,"skills":{{"lark-okr":{{"sourceType":"well-known","sourceUrl":"{source_url}","skillFolderHash":"","skillPath":null}}}}}}"#
            ),
        )
        .expect("write well-known lock");
        unsafe {
            env::set_var("HOME", &temp_home);
        }

        let check = detect_global_updates(&BTreeMap::from([("lark-okr".to_string(), skill_dir)]));

        let _ = stop_tx.send(());
        server.join().expect("stop test server");
        match original_home {
            Some(value) => unsafe { env::set_var("HOME", value) },
            None => unsafe { env::remove_var("HOME") },
        }
        let _ = fs::remove_dir_all(temp_home);

        assert!(request_rx.try_recv().is_err());
        assert_eq!(check, Ok(Default::default()));
    }

    #[cfg(unix)]
    #[test]
    fn remove_global_skill_verifies_cli_cleanup() {
        let _guard = crate::workspace::TEST_ENV_LOCK.lock().expect("env lock");
        let temp_home = env::temp_dir().join(format!(
            "skilldock-agent-remove-test-{}",
            std::process::id()
        ));
        let fake_bin = temp_home.join("bin");
        let skill_dir = temp_home.join(".agents/skills/demo");
        fs::create_dir_all(&fake_bin).expect("create fake executable path");
        let fake_skills = fake_bin.join("skills");
        fs::write(
            &fake_skills,
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
if [ "$1" = "remove" ]; then
  if [ "$SKILL_TEST_KEEP" != "1" ]; then
    rm -rf "$HOME/.agents/skills/$2"
    printf '%s' '{"version":3,"skills":{}}' > "$HOME/.agents/.skill-lock.json"
  fi
  exit 0
fi
exit 1
"#,
        )
        .expect("write fake skills executable");
        fs::set_permissions(&fake_skills, fs::Permissions::from_mode(0o755))
            .expect("make fake skills executable");

        let original_home = env::var_os("HOME");
        let original_path = env::var_os("PATH");
        let original_keep = env::var_os("SKILL_TEST_KEEP");
        let next_path = original_path
            .as_ref()
            .map(|path| {
                let mut paths = env::split_paths(path).collect::<Vec<_>>();
                paths.insert(0, fake_bin);
                env::join_paths(paths).expect("join fake executable path")
            })
            .unwrap_or_else(|| temp_home.join("bin").into_os_string());
        unsafe {
            env::set_var("HOME", &temp_home);
            env::set_var("PATH", next_path);
            env::remove_var("SKILL_TEST_KEEP");
        }

        let create_locked_skill = || {
            fs::create_dir_all(&skill_dir).expect("create Agent CLI skill");
            fs::write(skill_dir.join("SKILL.md"), "# demo\n").expect("write Agent CLI skill");
            fs::write(
                temp_home.join(".agents/.skill-lock.json"),
                r#"{"version":3,"skills":{"demo":{"sourceType":"github","skillPath":"skills/demo/SKILL.md","skillFolderHash":"hash"}}}"#,
            )
            .expect("write Agent CLI lock");
        };

        create_locked_skill();
        let removed = remove_global_skill("demo");
        create_locked_skill();
        unsafe {
            env::set_var("SKILL_TEST_KEEP", "1");
        }
        let incomplete = remove_global_skill("demo");

        match original_home {
            Some(value) => unsafe { env::set_var("HOME", value) },
            None => unsafe { env::remove_var("HOME") },
        }
        match original_path {
            Some(value) => unsafe { env::set_var("PATH", value) },
            None => unsafe { env::remove_var("PATH") },
        }
        match original_keep {
            Some(value) => unsafe { env::set_var("SKILL_TEST_KEEP", value) },
            None => unsafe { env::remove_var("SKILL_TEST_KEEP") },
        }
        let _ = fs::remove_dir_all(temp_home);

        removed.expect("remove Agent CLI skill through CLI");
        assert!(incomplete.is_err());
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
