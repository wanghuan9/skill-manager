#[cfg(windows)]
use std::fs;
#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
fn main() {
    if let Err(error) = run_probe() {
        eprintln!("Windows directory junction probe failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
fn run_probe() -> Result<(), String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let temp_root = std::env::temp_dir().join(format!(
        "skilldock windows junction probe-{}-{timestamp}",
        std::process::id()
    ));
    let target = temp_root.join("source skill");
    let junction = PathBuf::from(
        temp_root
            .join("tool skills/research")
            .to_string_lossy()
            .replace('\\', "/"),
    );
    let command_dir = temp_root.join("command tools");

    let result = (|| {
        fs::create_dir_all(&target).map_err(|error| error.to_string())?;
        fs::write(target.join("SKILL.md"), "# research").map_err(|error| error.to_string())?;
        skill_manager_lib::create_windows_directory_junction(&target, &junction)?;
        if !junction.join("SKILL.md").is_file() {
            return Err("junction target file is not readable".to_string());
        }
        skill_manager_lib::remove_skill_symlink(
            junction
                .parent()
                .ok_or_else(|| "junction parent is missing".to_string())?
                .to_string_lossy()
                .as_ref(),
            "research",
        )?;
        if fs::symlink_metadata(&junction).is_ok() {
            return Err("junction still exists after production removal".to_string());
        }
        if !target.join("SKILL.md").is_file() {
            return Err("junction removal deleted the target skill".to_string());
        }

        fs::create_dir_all(&command_dir).map_err(|error| error.to_string())?;
        let command_path = command_dir.join("skilldock-probe.cmd");
        fs::write(&command_path, "@echo off\r\necho %1\r\n").map_err(|error| error.to_string())?;
        let resolved = skill_manager_lib::resolve_command_path(
            "skilldock-probe",
            std::slice::from_ref(&command_dir),
        )
        .ok_or_else(|| "Windows .cmd executable was not resolved".to_string())?;
        if resolved != command_path {
            return Err(format!(
                "Windows command resolved to unexpected path: {}",
                resolved.display()
            ));
        }
        let output = skill_manager_lib::command_for_executable(&resolved)
            .arg("probe-value")
            .output()
            .map_err(|error| format!("failed to run Windows .cmd probe: {error}"))?;
        if !output.status.success()
            || String::from_utf8_lossy(&output.stdout).trim() != "probe-value"
        {
            return Err("Windows .cmd executable probe returned unexpected output".to_string());
        }

        if let (Some(home), Some(appdata)) =
            (std::env::var_os("USERPROFILE"), std::env::var_os("APPDATA"))
        {
            let resolved_appdata =
                skill_manager_lib::application_support_dir_for_home(&PathBuf::from(home));
            if resolved_appdata != PathBuf::from(appdata) {
                return Err("Windows application support directory did not use APPDATA".to_string());
            }
        }
        Ok(())
    })();

    if junction.exists() {
        let _ = fs::remove_dir(&junction);
    }
    let _ = fs::remove_dir_all(&temp_root);
    result
}
