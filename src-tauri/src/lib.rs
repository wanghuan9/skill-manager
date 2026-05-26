mod commands;
mod diagnostics;
mod git_state;
mod library;
mod mcp_manager;
mod models;
mod state;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            workspace::ensure_workspace_initialized()?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let _ = library::migrate_legacy_skill_symlinks_from_all_tools();
            let _ = library::remove_reserved_workspace_symlinks_from_all_tools();
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_workspace_snapshot,
            commands::list_startup_installed_skills,
            commands::list_installed_skills,
            commands::list_marketplace_skills,
            commands::get_marketplace_skill_description,
            commands::list_local_skill_candidates,
            commands::list_tool_configs,
            commands::get_git_account_summary,
            commands::get_app_settings,
            commands::update_app_settings,
            commands::detect_preferred_app_language,
            commands::install_skill_from_market,
            commands::install_skill_from_repo,
            commands::discover_repo_skills,
            commands::install_selected_repo_skills,
            commands::discover_local_install_skills,
            commands::install_selected_local_skills,
            commands::install_local_skill,
            commands::import_local_skill,
            commands::get_push_target_snapshot,
            commands::get_push_preview_snapshot,
            commands::push_skill_to_current_branch,
            commands::get_update_preview_snapshot,
            commands::open_skill_repository,
            commands::open_external_link,
            diagnostics::record_failure_feedback,
            commands::open_tool_skills_folder,
            commands::open_path_in_finder,
            commands::open_tool_mcp_config,
            commands::open_skill_in_editor,
            commands::update_skill,
            commands::get_skill_file_browser,
            commands::get_skill_file_content,
            commands::save_skill_file_content,
            commands::delete_skill,
            commands::toggle_skill_tool_status,
            commands::set_tool_skill_statuses,
            commands::set_skill_all_tool_statuses,
            commands::refresh_git_states,
            commands::refresh_local_git_states,
            commands::refresh_local_git_state,
            commands::get_local_git_state_signatures,
            mcp_manager::list_mcp_workspace,
            mcp_manager::list_mcp_marketplace_servers,
            mcp_manager::resolve_mcp_marketplace_source_link,
            mcp_manager::get_mcp_marketplace_server_config,
            mcp_manager::install_mcp_server_from_marketplace,
            mcp_manager::import_mcp_servers_from_apps,
            mcp_manager::upsert_mcp_server,
            mcp_manager::delete_mcp_server,
            mcp_manager::toggle_mcp_server_app,
            mcp_manager::toggle_mcp_server_tool,
            mcp_manager::refresh_mcp_server_tools,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
