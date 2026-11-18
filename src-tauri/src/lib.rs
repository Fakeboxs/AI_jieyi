mod capture;
mod config;
mod providers;
mod store;

use capture::{Pending, PendingShot, ShotInfo};
use config::Config;
use std::path::PathBuf;
use std::sync::Mutex;
use store::{Entry, Store};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub struct AppState {
    config_dir: PathBuf,
    cfg: Mutex<Config>,
    store: Mutex<Store>,
    pending: Pending,
    client: reqwest::Client,
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> Config {
    state.cfg.lock().unwrap().clone()
}

#[tauri::command]
fn save_config(state: State<'_, AppState>, config: Config) -> Result<Config, String> {
    config.save(&state.config_dir)?;
    *state.cfg.lock().unwrap() = config.clone();
    Ok(config)
}

#[tauri::command]
fn list_entries(state: State<'_, AppState>) -> Result<Vec<Entry>, String> {
    state.store.lock().unwrap().list()
}

#[tauri::command]
fn delete_entry(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.store.lock().unwrap().delete(&id)
}

#[tauri::command]
fn update_tags(state: State<'_, AppState>, id: String, tags: Vec<String>) -> Result<(), String> {
    state.store.lock().unwrap().update_tags(&id, &tags)
}

#[tauri::command]
fn get_shot(state: State<'_, AppState>) -> Result<Option<ShotInfo>, String> {
    let guard = state.pending.0.lock().unwrap();
    let Some(shot) = guard.as_ref() else {
        return Ok(None);
    };
    Ok(Some(ShotInfo {
        data_url: capture::to_data_url(&shot.image)?,
        width: shot.image.width(),
        height: shot.image.height(),
        scale: shot.scale,
    }))
}

#[tauri::command]
async fn start_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let shot = capture::capture()?;
    let monitor = shot.monitor;
    let scale = shot.scale;
    *state.pending.0.lock().unwrap() = Some(shot);
    show_overlay(&app, monitor, scale)?;
    Ok(())
}

#[tauri::command]
fn cancel_overlay(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.pending.0.lock().unwrap().take();
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }
    Ok(())
}

#[tauri::command]
async fn translate_region(
    app: AppHandle,
    state: State<'_, AppState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let shot: PendingShot = state
        .pending
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "没有待处理的截图".to_string())?;
    let cropped = capture::crop(&shot, x, y, w, h)?;
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }
    let cfg = state.cfg.lock().unwrap().clone();
    let client = state.client.clone();
    let handle = app.clone();
    let id = uuid::Uuid::new_v4().to_string();
    tauri::async_runtime::spawn(async move {
        let png = match capture::encode_png(&cropped) {
            Ok(p) => p,
            Err(message) => {
                let _ = handle.emit("translation:error", serde_json::json!({ "message": message }));
                return;
            }
        };
        match execute(&handle, &client, &cfg, vec![png.clone()], &id).await {
            Ok(result) => {
                let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
                let stored = {
                    let state = handle.state::<AppState>();
                    let store = state.store.lock().unwrap();
                    store.insert(
                        &id,
                        &ts,
                        &cfg.prompt,
                        &result.text,
                        &cfg.provider,
                        &cfg.model(),
                        result.elapsed_ms,
                        &png,
                    )
                };
                match stored {
                    Ok(()) => {
                        let _ = handle.emit("translation:done", serde_json::json!({ "id": id }));
                        focus_main(&handle);
                    }
                    Err(message) => {
                        let _ = handle.emit("translation:error", serde_json::json!({ "message": message }));
                    }
                }
            }
            Err(message) => {
                let _ = handle.emit("translation:error", serde_json::json!({ "message": message }));
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn retranslate(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let entry = state
        .store
        .lock()
        .unwrap()
        .get(&id)?
        .ok_or_else(|| "找不到这条记录".to_string())?;
    let images_dir = state.store.lock().unwrap().images_dir().to_path_buf();
    let mut pngs: Vec<Vec<u8>> = Vec::new();
    for rel in &entry.images {
        let name = rel.trim_start_matches("images/");
        let path = images_dir.join(name);
        let bytes = std::fs::read(&path).map_err(|e| format!("读取截图失败：{e}"))?;
        pngs.push(bytes);
    }
    if pngs.is_empty() {
        return Err("这条记录没有可用的截图".into());
    }
    let cfg = state.cfg.lock().unwrap().clone();
    let client = state.client.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match execute(&handle, &client, &cfg, pngs, &id).await {
            Ok(result) => {
                let saved = {
                    let st = handle.state::<AppState>();
                    let outcome = st.store.lock().unwrap().update_markdown(&id, &result.text);
                    outcome
                };
                match saved {
                    Ok(()) => {
                        let _ = handle.emit("translation:done", serde_json::json!({ "id": id }));
                        focus_main(&handle);
                    }
                    Err(message) => {
                        let _ = handle.emit("translation:error", serde_json::json!({ "message": message }));
                    }
                }
            }
            Err(message) => {
                let _ = handle.emit("translation:error", serde_json::json!({ "message": message }));
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn test_connection(state: State<'_, AppState>, config: Config) -> Result<TestResult, String> {
    let client = state.client.clone();
    match providers::probe(&client, &config).await {
        Ok(message) => Ok(TestResult { ok: true, message }),
        Err(message) => Ok(TestResult { ok: false, message }),
    }
}

#[derive(serde::Serialize)]
struct TestResult {
    ok: bool,
    message: String,
}

// ---------------------------------------------------------------- helpers

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn focus_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn show_overlay(app: &AppHandle, monitor: capture::Rect, scale: f64) -> Result<(), String> {
    let s = if scale > 0.0 { scale } else { 1.0 };
    let x = monitor.x as f64 / s;
    let y = monitor.y as f64 / s;
    let w = monitor.width as f64 / s;
    let h = monitor.height as f64 / s;

    // Reuse the overlay after the first shot: closing is asynchronous in Tauri, so
    // recreating it immediately collides on the window label.
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
        let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("shot:refresh", ());
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(app, "overlay", tauri::WebviewUrl::App("overlay.html".into()))
        .title("选择翻译区域")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .position(x, y)
        .inner_size(w, h)
        .focused(true)
        .build()
        .map_err(|e| format!("打开选区窗口失败：{e}"))?;
    Ok(())
}

/// Run one translation: emits `translation:start`, then `translation:chunk` per
/// SSE delta when streaming is enabled, and returns the finished text.
async fn execute(
    app: &AppHandle,
    client: &reqwest::Client,
    cfg: &Config,
    pngs: Vec<Vec<u8>>,
    id: &str,
) -> Result<providers::Translation, String> {
    let b64s: Vec<String> = pngs.iter().map(|b| base64_encode(b)).collect();
    let _ = app.emit(
        "translation:start",
        serde_json::json!({
            "id": id,
            "provider": cfg.provider,
            "model": cfg.model(),
            "stream": cfg.stream,
        }),
    );

    // Bring the shell forward immediately, otherwise SSE text is generated
    // into a window the user cannot see.
    focus_main(app);

    if cfg.stream {
        let handle = app.clone();
        let stream_id = id.to_string();
        providers::translate_stream(client, cfg, &b64s, move |delta| {
            let _ = handle.emit(
                "translation:chunk",
                serde_json::json!({ "id": stream_id, "text": delta }),
            );
        })
        .await
    } else {
        providers::translate(client, cfg, &b64s).await
    }
}

fn trigger_capture(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        let shot = match capture::capture() {
            Ok(s) => s,
            Err(e) => {
                let _ = handle.emit("translation:error", serde_json::json!({ "message": e }));
                return;
            }
        };
        let (monitor, scale) = (shot.monitor, shot.scale);
        *state.pending.0.lock().unwrap() = Some(shot);
        if let Err(e) = show_overlay(&handle, monitor, scale) {
            let _ = handle.emit("translation:error", serde_json::json!({ "message": e }));
        }
    });
}

// ---------------------------------------------------------------- app

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        trigger_capture(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            let config_dir = handle
                .path()
                .app_config_dir()
                .map_err(|e| format!("config dir unavailable: {e}"))?;
            let data_dir = handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("data dir unavailable: {e}"))?;
            let cfg = Config::load(&config_dir);
            let store = Store::open(&data_dir).map_err(|e| format!("数据库打开失败：{e}"))?;
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .user_agent(concat!("jieyi/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;

            app.manage(AppState {
                config_dir,
                cfg: Mutex::new(cfg),
                store: Mutex::new(store),
                pending: Pending(Mutex::new(None)),
                client,
            });

            // global hotkey: Ctrl+Alt+S
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyS);
            if let Err(e) = app.global_shortcut().register(shortcut.clone()) {
                // A previous instance may still be releasing the hotkey during an upgrade;
                // retry briefly instead of silently losing the shortcut for the session.
                eprintln!("global shortcut registration failed ({e}); retrying");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    for _ in 0..6 {
                        std::thread::sleep(std::time::Duration::from_millis(700));
                        if handle.global_shortcut().register(shortcut.clone()).is_ok() {
                            eprintln!("global shortcut registered after retry");
                            return;
                        }
                    }
                    eprintln!("global shortcut still unavailable — use the tray menu to capture");
                });
            }

            // tray
            let shot_item = MenuItem::with_id(app, "shot", "截图翻译", true, Some("Ctrl+Alt+S"))?;
            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&shot_item, &show_item, &sep, &quit_item])?;

            let mut builder = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("截译 · Ctrl+Alt+S 截图")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "shot" => trigger_capture(app),
                    "show" => focus_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => trigger_capture(tray.app_handle()),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }
            builder.build(app)?;

            // The window is only a shell; the UI renders from the bundled frontend.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            list_entries,
            delete_entry,
            update_tags,
            get_shot,
            start_capture,
            cancel_overlay,
            translate_region,
            retranslate,
            test_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running jieyi");
}
