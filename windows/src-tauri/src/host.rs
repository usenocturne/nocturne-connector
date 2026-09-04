use crate::bridge::BridgeServer;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use std::{fs, path::PathBuf};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as _;
use uuid::Uuid;

use crate::sidecar::{self, ChildSlot};

const TRAY_ICON: tauri::image::Image<'static> = tauri::include_image!("../assets/nocturne.ico");
static EARLY_OPEN_REQUESTED: AtomicBool = AtomicBool::new(false);

fn connector_window_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/?connector-platform=windows")
}

fn is_local_connector_url(url: &tauri::Url) -> bool {
    url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
}

fn should_open_in_default_browser(url: &tauri::Url) -> bool {
    !is_local_connector_url(url) && matches!(url.scheme(), "http" | "https")
}

fn open_in_default_browser(url: &tauri::Url) {
    if let Err(error) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        eprintln!("Unable to open external URL in the default browser: {error}");
    }
}

#[derive(Clone)]
pub struct HostState {
    bridge: BridgeServer,
    sidecar_port: Arc<Mutex<Option<u16>>>,
    sidecar_ready: Arc<AtomicBool>,
    shutting_down: Arc<AtomicBool>,
    child_slot: ChildSlot,
    window_requested: Arc<AtomicBool>,
    window_dispatch_running: Arc<AtomicBool>,
}

impl HostState {
    pub fn new(_app: AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let token = Uuid::new_v4().to_string();
        let pipe = BridgeServer::pipe_name();
        std::env::set_var("NOCTURNE_HOST_PIPE", &pipe);
        std::env::set_var("NOCTURNE_HOST_TOKEN", &token);
        Ok(Self {
            bridge: BridgeServer::new(token),
            sidecar_port: Arc::new(Mutex::new(None)),
            sidecar_ready: Arc::new(AtomicBool::new(false)),
            shutting_down: Arc::new(AtomicBool::new(false)),
            child_slot: Arc::new(Mutex::new(None)),
            window_requested: Arc::new(AtomicBool::new(false)),
            window_dispatch_running: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn enable_autostart(app: &AppHandle) {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nocturne")
            .join("Connector");
        let marker = base.join("autostart.initialized");
        match app.autolaunch().enable() {
            Ok(()) => {
                if let Err(error) =
                    fs::create_dir_all(&base).and_then(|_| fs::write(&marker, b"1\n"))
                {
                    eprintln!("Unable to persist the Nocturne autostart marker: {error}");
                }
            }
            Err(error) => eprintln!("Unable to enable Nocturne Connector login startup: {error}"),
        }
    }

    pub fn install_tray(&self, app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
        let open = MenuItem::with_id(app, "open", "Open Nocturne Connector", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &quit])?;
        let mut builder = TrayIconBuilder::new()
            .icon(TRAY_ICON)
            .menu(&menu)
            .show_menu_on_left_click(false)
            .tooltip("Nocturne Connector")
            .on_menu_event(|app, event| match event.id.as_ref() {
                "open" => {
                    Self::request_window(app);
                }
                "quit" => {
                    if let Some(state) = app.try_state::<HostState>() {
                        state.inner().shutdown();
                    }
                    app.exit(0);
                }
                _ => {}
            });

        builder = builder.on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { .. } = event {
                Self::request_window(tray.app_handle());
            }
        });
        builder.build(app)?;
        Ok(())
    }

    pub fn start_services(&self) {
        let bridge = self.bridge.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = bridge.serve().await {
                eprintln!("Nocturne host bridge stopped: {error}");
            }
        });

        let bridge = self.bridge.clone();
        let sidecar_bridge = bridge.clone();
        sidecar::supervise(
            sidecar_bridge,
            self.sidecar_port.clone(),
            self.sidecar_ready.clone(),
            self.shutting_down.clone(),
            self.child_slot.clone(),
        );
        tauri::async_runtime::spawn(async move {
            bridge.start_native().await;
        });
    }

    pub fn shutdown(&self) {
        sidecar::stop(&self.shutting_down, &self.child_slot);
    }

    pub fn shutting_down(&self) -> bool {
        self.shutting_down
            .load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn request_window(app: &AppHandle) {
        let Some(state) = app.try_state::<HostState>() else {
            EARLY_OPEN_REQUESTED.store(true, Ordering::Release);
            return;
        };
        state.window_requested.store(true, Ordering::Release);
        state.schedule_window_dispatch(app.clone());
    }

    pub fn take_early_window_request() -> bool {
        EARLY_OPEN_REQUESTED.swap(false, Ordering::AcqRel)
    }

    fn schedule_window_dispatch(&self, app: AppHandle) {
        if self.window_dispatch_running.swap(true, Ordering::AcqRel) {
            return;
        }
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            while !state.shutting_down() {
                if !state.window_requested.load(Ordering::Acquire) {
                    break;
                }
                if !state.sidecar_ready.load(Ordering::Acquire) {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }

                state.window_requested.store(false, Ordering::Release);
                let dispatch_app = app.clone();
                let (result_tx, result_rx) = tokio::sync::oneshot::channel();
                let dispatch = app.run_on_main_thread(move || {
                    let result = Self::show_window(&dispatch_app);
                    let _ = result_tx.send(result);
                });
                let result = match dispatch {
                    Ok(()) => result_rx
                        .await
                        .unwrap_or_else(|_| Err("Window dispatch ended unexpectedly".to_string())),
                    Err(error) => Err(error.to_string()),
                };
                if let Err(error) = result {
                    eprintln!("Unable to open Nocturne Connector: {error}");
                    state.window_requested.store(true, Ordering::Release);
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
            state
                .window_dispatch_running
                .store(false, Ordering::Release);
            if state.window_requested.load(Ordering::Acquire) && !state.shutting_down() {
                state.schedule_window_dispatch(app);
            }
        });
    }

    pub fn show_window(app: &AppHandle) -> Result<(), String> {
        if let Some(window) = app.get_webview_window("main") {
            window.show().map_err(|error| error.to_string())?;
            window.unminimize().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
            return Ok(());
        }

        let port = app
            .try_state::<HostState>()
            .and_then(|state| state.sidecar_port.lock().ok().and_then(|port| *port))
            .ok_or_else(|| "Connector server is still starting".to_string())?;
        let url = connector_window_url(port);
        WebviewWindowBuilder::new(
            app,
            "main",
            WebviewUrl::External(
                url.parse()
                    .map_err(|error| format!("invalid connector URL: {error}"))?,
            ),
        )
        .title("Nocturne Connector")
        .inner_size(1024.0, 768.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .on_navigation(|url| {
            if is_local_connector_url(url) {
                return true;
            }
            if should_open_in_default_browser(url) {
                open_in_default_browser(url);
                return false;
            }
            true
        })
        .on_new_window(|url, _features| {
            if should_open_in_default_browser(&url) {
                open_in_default_browser(&url);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
        .map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{connector_window_url, is_local_connector_url, should_open_in_default_browser};

    #[test]
    fn connector_window_url_marks_only_the_native_windows_ui() {
        assert_eq!(
            connector_window_url(52_225),
            "http://127.0.0.1:52225/?connector-platform=windows"
        );
    }

    #[test]
    fn external_http_links_open_in_the_default_browser() {
        let external = tauri::Url::parse("https://usenocturne.com/login").unwrap();
        let local = tauri::Url::parse("http://127.0.0.1:52225/").unwrap();

        assert!(should_open_in_default_browser(&external));
        assert!(!should_open_in_default_browser(&local));
        assert!(is_local_connector_url(&local));
    }
}
