use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::{Deserialize, Serialize};

use crate::workspace::home_dir;

const CLI_COMMAND: &str = "skills";
const NPX_COMMAND: &str = "npx";

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

pub fn global_skill_root() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".agents/skills"))
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
    use super::{is_global_skill_path, parse_global_skill_list_json, CliSkillEntry};
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
