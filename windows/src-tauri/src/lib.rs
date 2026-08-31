#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod host;
mod native;
mod sidecar;

use host::HostState;
use std::ffi::OsStr;
use tauri::{Manager, RunEvent};

#[tauri::command]
fn open_connector(app: tauri::AppHandle) -> Result<(), String> {
    HostState::request_window(&app);
    Ok(())
}

#[tauri::command]
fn quit_connector(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<HostState>() {
        state.inner().shutdown();
    }
    app.exit(0);
}

pub fn run() {
    let open_initial_window = requests_window(std::env::args_os());
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            HostState::request_window(app);
        }))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Nocturne Connector")
                .args(["--background"])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_connector, quit_connector])
        .setup(move |app| {
            let state = HostState::new(app.handle().clone())?;
            app.manage(state.clone());
            HostState::enable_autostart(app.handle());
            state.install_tray(app)?;
            state.start_services();
            if open_initial_window || HostState::take_early_window_request() {
                HostState::request_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.destroy();
            }
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building Nocturne Connector");
    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            let should_keep_tray_alive = code.is_none()
                && app
                    .try_state::<HostState>()
                    .is_some_and(|state| !state.shutting_down());
            if should_keep_tray_alive {
                api.prevent_exit();
            }
        }
    });
}

fn requests_window<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    !args
        .into_iter()
        .any(|argument| argument.as_ref() == OsStr::new("--background"))
}

#[cfg(test)]
mod tests {
    use super::requests_window;

    #[test]
    fn normal_launch_requests_a_window() {
        assert!(requests_window(["Nocturne.Connector.exe"]));
        assert!(requests_window(["Nocturne.Connector.exe", "--verbose"]));
        assert!(requests_window([
            "Nocturne.Connector.exe",
            "--background=true"
        ]));
    }

    #[test]
    fn login_launch_stays_in_the_notification_area() {
        assert!(!requests_window(["Nocturne.Connector.exe", "--background"]));
    }
}
