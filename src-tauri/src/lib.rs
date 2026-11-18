mod capture;
mod config;
mod providers;
mod store;

use capture::{Pending, PendingShot, ShotInfo};
use config::Config;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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
    /// flag of the currently running translation (created per run)
    cancel: Mutex<Arc<AtomicBool>>,
    last_region: Mutex<Option<[f64; 4]>>,
}

#[derive(serde::Deserialize, Clone, Copy)]
struct RectF {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

// ---------------------------------------------------------------- config / data

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
fn list_monitors() -> Result<Vec<capture::MonitorInfo>, String> {
    capture::list_monitors()
}

#[tauri::command]
fn export_markdown(state: State<'_, AppState>, id: String, path: String) -> Result<(), String> {
    let entry = state
        .store
        .lock()
        .unwrap()
        .get(&id)?
        .ok_or_else(|| "找不到这条记录".to_string())?;
    let mut body = entry.markdown.clone();
    if !entry.tags.is_empty() {
        body.push_str(&format!("\n\n---\n\n标签：{}\n", entry.tags.join("、")));
    }
    body.push_str(&format!(
        "\n_由截译导出 · {} · {}_\n",
        entry.timestamp, entry.model
    ));
    std::fs::write(&path, body).map_err(|e| format!("写入失败：{e}"))
}

// ---------------------------------------------------------------- capture flow

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
        last_region: *state.last_region.lock().unwrap(),
    }))
}

#[tauri::command]
async fn start_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let screen = state.cfg.lock().unwrap().capture_screen;
    let shot = capture::capture(screen)?;
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
fn cancel_translation(state: State<'_, AppState>) -> Result<(), String> {
    state.cancel.lock().unwrap().store(true, Ordering::Relaxed);
    Ok(())
}

/// Crop every selected region and translate them together.
#[tauri::command]
async fn translate_regions(
    app: AppHandle,
    state: State<'_, AppState>,
    rects: Vec<RectF>,
) -> Result<(), String> {
    if rects.is_empty() {
        return Err("没有选区".into());
    }
    let shot: PendingShot = state
        .pending
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "没有待处理的截图".to_string())?;

    let mut pngs: Vec<Vec<u8>> = Vec::new();
    for r in &rects {
        let img = capture::crop(&shot, r.x, r.y, r.w, r.h)?;
        pngs.push(capture::encode_png(&img)?);
    }
    if let Some(first) = rects.first() {
        if state.cfg.lock().unwrap().remember_region {
            *state.last_region.lock().unwrap() = Some([first.x, first.y, first.w, first.h]);
            let _ = save_last_region(&state.config_dir, Some([first.x, first.y, first.w, first.h]));
        }
    }

    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }

    let cfg = state.cfg.lock().unwrap().clone();
    let client = state.client.clone();
    let handle = app.clone();
    let id = uuid::Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    *state.cancel.lock().unwrap() = cancel.clone();

    tauri::async_runtime::spawn(async move {
        match execute(&handle, &client, &cfg, pngs.clone(), &id, cancel).await {
            Ok(result) => {
                let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
                let stored = {
                    let st = handle.state::<AppState>();
                    let store = st.store.lock().unwrap();
                    store.insert(
                        &id,
                        &ts,
                        &cfg.prompt,
                        &result.text,
                        &cfg.provider,
                        &cfg.model(),
                        result.elapsed_ms,
                        &pngs,
                    )
                };
                match stored {
                    Ok(()) => {
                        let _ = handle.emit(
                            "translation:done",
                            serde_json::json!({ "id": id, "cancelled": result.cancelled }),
                        );
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
    let cancel = Arc::new(AtomicBool::new(false));
    *state.cancel.lock().unwrap() = cancel.clone();

    tauri::async_runtime::spawn(async move {
        match execute(&handle, &client, &cfg, pngs, &id, cancel).await {
            Ok(result) => {
                let saved = {
                    let st = handle.state::<AppState>();
                    let outcome = st.store.lock().unwrap().update_markdown(&id, &result.text);
                    outcome
                };
                match saved {
                    Ok(()) => {
                        let _ = handle.emit(
                            "translation:done",
                            serde_json::json!({ "id": id, "cancelled": result.cancelled }),
                        );
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

fn last_region_file(dir: &std::path::Path) -> PathBuf {
    dir.join("last_region.json")
}

fn save_last_region(dir: &std::path::Path, region: Option<[f64; 4]>) -> Result<(), String> {
    let path = last_region_file(dir);
    match region {
        Some(r) => {
            let json = serde_json::json!({ "x": r[0], "y": r[1], "w": r[2], "h": r[3] });
            std::fs::write(path, json.to_string()).map_err(|e| e.to_string())
        }
        None => {
            let _ = std::fs::remove_file(path);
            Ok(())
        }
    }
}

fn load_last_region(dir: &std::path::Path) -> Option<[f64; 4]> {
    let raw = std::fs::read_to_string(last_region_file(dir)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some([
        v.get("x")?.as_f64()?,
        v.get("y")?.as_f64()?,
        v.get("w")?.as_f64()?,
        v.get("h")?.as_f64()?,
    ])
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
    cancel: Arc<AtomicBool>,
) -> Result<providers::Translation, String> {
    let b64s: Vec<String> = pngs.iter().map(|b| base64_encode(b)).collect();
    let _ = app.emit(
        "translation:start",
        serde_json::json!({
            "id": id,
            "provider": cfg.provider,
            "model": cfg.model(),
            "stream": cfg.stream,
            "image_count": pngs.len(),
        }),
    );

    // Bring the shell forward immediately, otherwise SSE text is generated
    // into a window the user cannot see.
    focus_main(app);

    if cfg.stream {
        let handle = app.clone();
        let stream_id = id.to_string();
        providers::translate_stream(client, cfg, &b64s, cancel, move |delta| {
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
        let screen = state.cfg.lock().unwrap().capture_screen;
        let shot = match capture::capture(screen) {
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

/// Ctrl+Alt+D: reuse the last rectangle without showing the overlay.
fn trigger_repeat(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        let region = *state.last_region.lock().unwrap();
        let Some([x, y, w, h]) = region else {
            trigger_capture(&handle);
            return;
        };
        let screen = state.cfg.lock().unwrap().capture_screen;
        let shot = match capture::capture(screen) {
            Ok(s) => s,
            Err(e) => {
                let _ = handle.emit("translation:error", serde_json::json!({ "message": e }));
                return;
            }
        };
        drop(state);
        let cropped = match capture::crop(&shot, x, y, w, h) {
            Ok(img) => img,
            Err(e) => {
                let _ = handle.emit("translation:error", serde_json::json!({ "message": e }));
                return;
            }
        };
        let png = match capture::encode_png(&cropped) {
            Ok(p) => p,
            Err(e) => {
                let _ = handle.emit("translation:error", serde_json::json!({ "message": e }));
                return;
            }
        };
        let st = handle.state::<AppState>();
        let cfg = st.cfg.lock().unwrap().clone();
        let client = st.client.clone();
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        *st.cancel.lock().unwrap() = cancel.clone();

        match execute(&handle, &client, &cfg, vec![png.clone()], &id, cancel).await {
            Ok(result) => {
                let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
                let stored = {
                    let st2 = handle.state::<AppState>();
                    let outcome = st2.store.lock().unwrap().insert(
                        &id,
                        &ts,
                        &cfg.prompt,
                        &result.text,
                        &cfg.provider,
                        &cfg.model(),
                        result.elapsed_ms,
                        &[png],
                    );
                    outcome
                };
                match stored {
                    Ok(()) => {
                        let _ = handle.emit(
                            "translation:done",
                            serde_json::json!({ "id": id, "cancelled": result.cancelled }),
                        );
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
}

// ---------------------------------------------------------------- app

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut.key == Code::KeyD {
                        trigger_repeat(app);
                    } else {
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
            let last_region = load_last_region(&config_dir);

            app.manage(AppState {
                config_dir,
                cfg: Mutex::new(cfg),
                store: Mutex::new(store),
                pending: Pending(Mutex::new(None)),
                client,
                cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
                last_region: Mutex::new(last_region),
            });

            // global hotkeys: Ctrl+Alt+S 截图, Ctrl+Alt+D 重复上次区域
            let capture_key = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyS);
            let repeat_key = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyD);
            for key in [capture_key, repeat_key] {
                if let Err(e) = app.global_shortcut().register(key.clone()) {
                    // A previous instance may still be releasing the hotkey during an upgrade;
                    // retry briefly instead of silently losing the shortcut for the session.
                    eprintln!("global shortcut registration failed ({e}); retrying");
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        for _ in 0..6 {
                            std::thread::sleep(std::time::Duration::from_millis(700));
                            if handle.global_shortcut().register(key.clone()).is_ok() {
                                eprintln!("global shortcut registered after retry");
                                return;
                            }
                        }
                        eprintln!("global shortcut still unavailable — use the tray menu to capture");
                    });
                }
            }

            // tray
            let shot_item = MenuItem::with_id(app, "shot", "截图翻译", true, Some("Ctrl+Alt+S"))?;
            let repeat_item = MenuItem::with_id(app, "repeat", "重复上次区域", true, Some("Ctrl+Alt+D"))?;
            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&shot_item, &repeat_item, &show_item, &sep, &quit_item],
            )?;

            let mut builder = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("截译 · Ctrl+Alt+S 截图")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "shot" => trigger_capture(app),
                    "repeat" => trigger_repeat(app),
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
            list_monitors,
            export_markdown,
            get_shot,
            start_capture,
            cancel_overlay,
            cancel_translation,
            translate_regions,
            retranslate,
            test_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running jieyi");
}
