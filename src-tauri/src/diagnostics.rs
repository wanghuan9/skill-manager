use std::fs::{self, OpenOptions};
use std::io::Write;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::workspace;

const ERROR_LOG_FILE_NAME: &str = "errors.jsonl";
const ISSUE_REPOSITORY_URL: &str = "https://github.com/wanghuan9/skill-manager";
const RECENT_ERROR_LIMIT: usize = 12;
const MAX_LOG_ENTRY_BYTES: usize = 24 * 1024;
const MAX_ISSUE_BODY_CHARS: usize = 8_000;
const MAX_ISSUE_URL_CHARS: usize = 6_000;
const MAX_ISSUE_URL_BODY_CHARS: usize = 1_400;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureReportInput {
    pub operation: String,
    pub message: String,
    #[serde(default)]
    pub context: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackIssueDraft {
    pub title: String,
    pub body: String,
    pub issue_url: String,
    pub log_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FailureLogEntry {
    id: String,
    created_at: String,
    operation: String,
    message: String,
    app_version: String,
    os_version: String,
    context: Value,
}

#[tauri::command]
pub fn record_failure_feedback(input: FailureReportInput) -> Result<FeedbackIssueDraft, String> {
    let mut entry = FailureLogEntry {
        id: format!("err-{}", unix_millis()),
        created_at: current_time_label(),
        operation: normalize_text(&input.operation, "unknown-operation"),
        message: normalize_text(&input.message, "未知错误"),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os_version: macos_version_label(),
        context: sanitize_value(input.context),
    };

    let log_path = error_log_path()?;
    let parent = log_path
        .parent()
        .ok_or_else(|| "诊断日志目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建诊断日志目录失败: {error}"))?;

    let mut line =
        serde_json::to_string(&entry).map_err(|error| format!("序列化诊断日志失败: {error}"))?;
    if line.len() > MAX_LOG_ENTRY_BYTES {
        entry.context = Value::String("[TRUNCATED]".to_string());
        line = serde_json::to_string(&entry)
            .map_err(|error| format!("序列化诊断日志失败: {error}"))?;
    }
    line.push('\n');

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("打开诊断日志失败: {error}"))?;
    file.write_all(line.as_bytes())
        .map_err(|error| format!("写入诊断日志失败: {error}"))?;

    let recent_errors = recent_error_lines(&log_path);
    let title = format!(
        "[Bug] {} 失败: {}",
        entry.operation,
        compact_message(&entry.message)
    );
    let mut body = build_issue_body(&entry, &recent_errors, &log_path.to_string_lossy());
    if body.chars().count() > MAX_ISSUE_BODY_CHARS {
        body = body.chars().take(MAX_ISSUE_BODY_CHARS).collect::<String>();
        body.push_str("\n\n...内容过长，已截断。完整日志保存在本机诊断日志文件中。");
    }
    let issue_url_body = build_issue_url_body(&entry, &log_path.to_string_lossy());
    let issue_url = build_safe_issue_url(&title, &issue_url_body);

    Ok(FeedbackIssueDraft {
        title,
        body,
        issue_url,
        log_path: log_path.to_string_lossy().to_string(),
    })
}

fn build_safe_issue_url(title: &str, body: &str) -> String {
    let mut body_chars = body.chars().collect::<Vec<_>>();
    loop {
        let next_body = body_chars.iter().collect::<String>();
        let issue_url = format!(
            "{ISSUE_REPOSITORY_URL}/issues/new?title={}&body={}",
            urlencoding(title),
            urlencoding(&next_body),
        );
        if issue_url.len() <= MAX_ISSUE_URL_CHARS || body_chars.len() <= 400 {
            return issue_url;
        }

        let next_len = body_chars.len().saturating_sub(200).max(400);
        body_chars.truncate(next_len);
        let suffix = "\n\n...自动诊断摘要过长，已截断。";
        let suffix_chars = suffix.chars().collect::<Vec<_>>();
        if body_chars.len() > suffix_chars.len() {
            let start = body_chars.len() - suffix_chars.len();
            body_chars.splice(start.., suffix_chars);
        }
    }
}

fn build_issue_url_body(entry: &FailureLogEntry, log_path: &str) -> String {
    let compact_log = build_compact_failure_log(entry, log_path);
    let mut body = format!(
        r#"## 问题描述
请描述你刚才点击了什么、期望发生什么、实际发生了什么。

## 本次失败日志（自动过滤）
```text
{}
```

## 补充信息
以上是 SkillDock 自动提取的关键错误信息；完整诊断仅保存在用户本机日志文件中。
"#,
        compact_log,
    );
    if body.chars().count() > MAX_ISSUE_URL_BODY_CHARS {
        body = body
            .chars()
            .take(MAX_ISSUE_URL_BODY_CHARS)
            .collect::<String>();
        body.push_str("\n\n...摘要过长，已截断。");
    }
    body
}

fn build_compact_failure_log(entry: &FailureLogEntry, log_path: &str) -> String {
    let mut lines = vec![
        format!("operation: {}", entry.operation),
        format!("error: {}", entry.message),
        format!("diagnosticId: {}", entry.id),
    ];

    if let Some(failed_app) = extract_labeled_value(&entry.message, "导入 ", " MCP ") {
        lines.push(format!("failedApp: {}", failed_app));
    }
    if let Some(server_id) = extract_quoted_value(&entry.message) {
        lines.push(format!("serverId: {}", server_id));
    }
    if let Some(config_path) = extract_labeled_value(&entry.message, "（配置：", "）") {
        lines.push(format!("config: {}", redact_home_path(&config_path)));
    }
    if let Some(route) = entry.context.get("route").and_then(Value::as_str) {
        lines.push(format!("route: {}", route));
    }
    lines.push(format!(
        "environment: SkillDock {}, {}",
        entry.app_version, entry.os_version
    ));
    lines.push(format!("localLog: {}", redact_home_path(log_path)));

    lines.join("\n")
}

fn extract_labeled_value(value: &str, start_marker: &str, end_marker: &str) -> Option<String> {
    let start = value.find(start_marker)? + start_marker.len();
    let rest = &value[start..];
    let end = rest.find(end_marker)?;
    let extracted = rest[..end].trim();
    if extracted.is_empty() {
        None
    } else {
        Some(extracted.to_string())
    }
}

fn extract_quoted_value(value: &str) -> Option<String> {
    let start = value.find('"')? + 1;
    let rest = &value[start..];
    let end = rest.find('"')?;
    let extracted = rest[..end].trim();
    if extracted.is_empty() {
        None
    } else {
        Some(extracted.to_string())
    }
}

fn redact_home_path(value: &str) -> String {
    let Some(home_dir) = workspace::home_dir_option() else {
        return value.to_string();
    };
    let home = home_dir.to_string_lossy();
    value.replace(home.as_ref(), "~")
}

fn error_log_path() -> Result<std::path::PathBuf, String> {
    Ok(workspace::managed_workspace_root()?
        .join("logs")
        .join(ERROR_LOG_FILE_NAME))
}

fn build_issue_body(entry: &FailureLogEntry, recent_errors: &[String], log_path: &str) -> String {
    let context_json =
        serde_json::to_string_pretty(&entry.context).unwrap_or_else(|_| "{}".to_string());
    let recent_log_text = if recent_errors.is_empty() {
        "暂无".to_string()
    } else {
        recent_errors.join("")
    };

    format!(
        r#"## 问题描述
请描述你刚才点击了什么、期望发生什么、实际发生了什么。

## 自动诊断
- 操作：{}
- 错误：{}
- 时间：{}
- SkillDock：{}
- 系统：{}
- 本机日志：{}

## 上下文（已自动脱敏）
```json
{}
```

## 最近错误日志（已自动脱敏）
```jsonl
{}
```
"#,
        entry.operation,
        entry.message,
        entry.created_at,
        entry.app_version,
        entry.os_version,
        log_path,
        context_json,
        recent_log_text.trim_end(),
    )
}

fn recent_error_lines(path: &std::path::Path) -> Vec<String> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut lines = content
        .lines()
        .rev()
        .take(RECENT_ERROR_LIMIT)
        .map(|line| format!("{line}\n"))
        .collect::<Vec<_>>();
    lines.reverse();
    lines
}

fn normalize_text(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(500).collect()
    }
}

fn compact_message(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    normalized.chars().take(48).collect()
}

fn sanitize_value(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut sanitized = Map::new();
            for (key, value) in object {
                if is_sensitive_key(&key) {
                    sanitized.insert(key, Value::String("[REDACTED]".to_string()));
                } else {
                    sanitized.insert(key, sanitize_value(value));
                }
            }
            Value::Object(sanitized)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sanitize_value).collect()),
        Value::String(value) => Value::String(sanitize_text_value(&value)),
        other => other,
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
    normalized.contains("token")
        || normalized.contains("apikey")
        || normalized.contains("authorization")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("privatekey")
        || normalized == "env"
        || normalized == "headers"
}

fn sanitize_text_value(value: &str) -> String {
    if looks_sensitive_text(value) {
        "[REDACTED]".to_string()
    } else {
        value.chars().take(1_000).collect()
    }
}

fn looks_sensitive_text(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.len() < 24 {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("bearer ")
        || lower.starts_with("sk-")
        || lower.contains("token=")
        || lower.contains("api_key=")
        || lower.contains("apikey=")
        || lower.contains("authorization:")
}

fn current_time_label() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    seconds.to_string()
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn macos_version_label() -> String {
    let Ok(output) = Command::new("sw_vers").arg("-productVersion").output() else {
        return std::env::consts::OS.to_string();
    };
    if !output.status.success() {
        return std::env::consts::OS.to_string();
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        std::env::consts::OS.to_string()
    } else {
        format!("macOS {version}")
    }
}

fn urlencoding(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}
