use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::Emitter;

use crate::state::load_github_backup_settings;

const CHANGE_DEBOUNCE_SECONDS: i64 = 120;
const STARTUP_DELAY_SECONDS: i64 = 10;
const FOCUS_SYNC_INTERVAL_SECONDS: i64 = 600;
const SELF_CHANGE_COOLDOWN_SECONDS: i64 = 10;
const FAILURE_NOTIFICATION_THRESHOLD: u32 = 3;
const MAX_BACKOFF_SECONDS: i64 = 3600;
const AUTO_BACKUP_FAILED_EVENT: &str = "backup-auto-sync-failed";

static SCHEDULER_STARTED: AtomicBool = AtomicBool::new(false);
static NEXT_SYNC_AT: AtomicI64 = AtomicI64::new(0);
static LAST_SYNC_FINISHED_AT: AtomicI64 = AtomicI64::new(0);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoBackupFailureEvent {
    message: String,
    consecutive_failures: u32,
}

fn now_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn schedule_at(timestamp: i64) {
    NEXT_SYNC_AT.store(timestamp, Ordering::SeqCst);
}

pub fn schedule_startup_sync() {
    schedule_at(now_timestamp() + STARTUP_DELAY_SECONDS);
}

pub fn schedule_library_change() {
    let now = now_timestamp();
    if crate::backup_repository::is_backup_syncing()
        || now.saturating_sub(LAST_SYNC_FINISHED_AT.load(Ordering::SeqCst))
            < SELF_CHANGE_COOLDOWN_SECONDS
    {
        return;
    }
    schedule_at(now + CHANGE_DEBOUNCE_SECONDS);
}

pub fn schedule_focus_sync() {
    let settings = load_github_backup_settings();
    if !settings.enabled || !settings.auto_backup {
        return;
    }
    let last_sync_at = DateTime::parse_from_rfc3339(&settings.last_sync_at)
        .map(|value| value.with_timezone(&Utc).timestamp())
        .unwrap_or_default();
    let now = now_timestamp();
    if now.saturating_sub(last_sync_at) >= FOCUS_SYNC_INTERVAL_SECONDS {
        schedule_at(now);
    }
}

pub fn start(app_handle: tauri::AppHandle) {
    if SCHEDULER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    if load_github_backup_settings().auto_backup {
        schedule_startup_sync();
    }
    thread::spawn(move || {
        let mut consecutive_failures = 0_u32;
        loop {
            thread::sleep(Duration::from_secs(1));
            let now = now_timestamp();
            let due_at = NEXT_SYNC_AT.load(Ordering::SeqCst);
            if due_at <= 0 || due_at > now {
                continue;
            }
            if NEXT_SYNC_AT
                .compare_exchange(due_at, 0, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                continue;
            }
            let settings = load_github_backup_settings();
            if !settings.enabled || !settings.auto_backup {
                continue;
            }
            match crate::backup_repository::run_scheduled_backup(app_handle.clone()) {
                Ok(_) => {
                    consecutive_failures = 0;
                    LAST_SYNC_FINISHED_AT.store(now_timestamp(), Ordering::SeqCst);
                }
                Err(error) => {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    let exponent = consecutive_failures.saturating_sub(1).min(6);
                    let backoff = (60_i64 * 2_i64.pow(exponent)).min(MAX_BACKOFF_SECONDS);
                    schedule_at(now_timestamp() + backoff);
                    if consecutive_failures >= FAILURE_NOTIFICATION_THRESHOLD {
                        let payload = AutoBackupFailureEvent {
                            message: error,
                            consecutive_failures,
                        };
                        let _ = app_handle.emit(AUTO_BACKUP_FAILED_EVENT, payload);
                    }
                }
            }
        }
    });
}
