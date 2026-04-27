mod commands;
mod git_state;
mod library;
mod models;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_workspace_snapshot,
            commands::list_installed_skills,
            commands::list_marketplace_skills,
            commands::get_marketplace_skill_description,
            commands::list_local_skill_candidates,
            commands::list_tool_configs,
            commands::get_git_account_summary,
            commands::install_skill_from_market,
            commands::install_skill_from_repo,
            commands::discover_repo_skills,
            commands::install_selected_repo_skills,
            commands::import_local_skill,
            commands::get_push_target_snapshot,
            commands::get_push_preview_snapshot,
            commands::get_update_preview_snapshot,
            commands::open_skill_repository,
            commands::open_external_link,
            commands::open_skill_in_editor,
            commands::update_skill,
            commands::get_skill_file_browser,
            commands::get_skill_file_content,
            commands::save_skill_file_content,
            commands::delete_skill,
            commands::toggle_skill_tool_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
