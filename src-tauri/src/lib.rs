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
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Everything the popup needs to repaint itself if it mounts mid-run.
#[derive(Clone, serde::Serialize, Default)]
pub struct RunSnapshot {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub stream: bool,
    pub image_count: usize,
    pub target: String,
    pub kind: String,
    pub text: String,
    pub done: bool,
    pub started_ms: u64,
}

pub struct AppState {
    config_dir: PathBuf,
    cfg: Mutex<Config>,
    store: Mutex<Store>,
    pending: Pending,
    client: reqwest::Client,
    /// flag of the currently running translation (created per run)
    cancel: Mutex<Arc<AtomicBool>>,
    last_region: Mutex<Option<[f64; 4]>>,
    run: Mutex<RunSnapshot>,
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
fn save_config(app: AppHandle, state: State<'_, AppState>, config: Config) -> Result<Config, String> {
    let previous = state.cfg.lock().unwrap().clone();
    // Register the new hotkeys before touching disk: a conflict must not leave
    // the app with no working shortcut.
    apply_hotkeys(&app, &config)?;
    if let Err(e) = config.save(&state.config_dir) {
        let _ = apply_hotkeys(&app, &previous);
        return Err(e);
    }
    *state.cfg.lock().unwrap() = config.clone();
    refresh_tray_menu(&app, &config);
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
fn delete_entries(state: State<'_, AppState>, ids: Vec<String>) -> Result<usize, String> {
    state.store.lock().unwrap().delete_many(&ids)
}

#[tauri::command]
fn clear_entries(state: State<'_, AppState>) -> Result<usize, String> {
    state.store.lock().unwrap().clear()
}

/// Popup calls this right after mounting: it may have missed start/chunks.
#[tauri::command]
fn run_snapshot(state: State<'_, AppState>) -> RunSnapshot {
    state.run.lock().unwrap().clone()
}

#[tauri::command]
fn hide_popup(app: AppHandle) {
    if let Some(win) = app.get_webview_window("popup") {
        let _ = win.hide();
    }
}

/// From the popup: reveal the same entry in the main window.
#[tauri::command]
fn open_in_main(app: AppHandle, id: String) {
    if let Some(win) = app.get_webview_window("popup") {
        let _ = win.hide();
    }
    focus_main(&app);
    let _ = app.emit("entry:open", serde_json::json!({ "id": id }));
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

    let cfg_now = state.cfg.lock().unwrap().clone();
    let mut pngs: Vec<Vec<u8>> = Vec::new();
    let mut send: Vec<capture::Encoded> = Vec::new();
    for r in &rects {
        let img = capture::crop(&shot, r.x, r.y, r.w, r.h)?;
        pngs.push(capture::encode_png(&img)?);
        send.push(capture::encode_for_model(&img, cfg_now.image_max_edge, cfg_now.image_quality)?);
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
    let target = result_target(&cfg);

    // Screen-space geometry for the popup: monitor origin (logical) + selection.
    if target == "popup" {
        let s = if shot.scale > 0.0 { shot.scale } else { 1.0 };
        let mon = [
            shot.monitor.x as f64 / s,
            shot.monitor.y as f64 / s,
            shot.monitor.width as f64 / s,
            shot.monitor.height as f64 / s,
        ];
        if let Some(first) = rects.first() {
            let anchor = [mon[0] + first.x, mon[1] + first.y, first.w, first.h];
            if let Err(e) = show_popup(&app, anchor, mon) {
                let _ = app.emit("translation:error", serde_json::json!({ "message": e }));
            }
        }
    }

    let client = state.client.clone();
    let handle = app.clone();
    let id = uuid::Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    *state.cancel.lock().unwrap() = cancel.clone();

    tauri::async_runtime::spawn(async move {
        match execute(&handle, &client, &cfg, send, None, &id, cancel, target).await {
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
                            serde_json::json!({
                                "id": id,
                                "cancelled": result.cancelled,
                                "target": target,
                                "ttft_ms": result.ttft_ms,
                                "elapsed_ms": result.elapsed_ms,
                            }),
                        );
                        if target != "popup" {
                            focus_main(&handle);
                        }
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
    let cfg = state.cfg.lock().unwrap().clone();
    let mut send: Vec<capture::Encoded> = Vec::new();
    for rel in &entry.images {
        let name = rel.trim_start_matches("images/");
        let path = images_dir.join(name);
        let bytes = std::fs::read(&path).map_err(|e| format!("读取截图失败：{e}"))?;
        let img = image::load_from_memory(&bytes)
            .map_err(|e| format!("截图解码失败：{e}"))?
            .to_rgba8();
        send.push(capture::encode_for_model(&img, cfg.image_max_edge, cfg.image_quality)?);
    }
    if send.is_empty() {
        return Err("这条记录没有可用的截图".into());
    }
    let client = state.client.clone();
    let handle = app.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    *state.cancel.lock().unwrap() = cancel.clone();

    tauri::async_runtime::spawn(async move {
        match execute(&handle, &client, &cfg, send, None, &id, cancel, "main").await {
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

/// Manual translation: the user pastes text instead of taking a screenshot.
#[tauri::command]
async fn translate_text(app: AppHandle, state: State<'_, AppState>, text: String) -> Result<(), String> {
    let body = text.trim().to_string();
    if body.is_empty() {
        return Err("先粘贴或输入要翻译的文本".into());
    }
    if body.chars().count() > 20_000 {
        return Err("文本太长了（上限约 2 万字符），分段翻译更快".into());
    }
    let cfg = state.cfg.lock().unwrap().clone();
    let client = state.client.clone();
    let handle = app.clone();
    let id = uuid::Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    *state.cancel.lock().unwrap() = cancel.clone();

    tauri::async_runtime::spawn(async move {
        match execute(&handle, &client, &cfg, Vec::new(), Some(body), &id, cancel, "main").await {
            Ok(result) => {
                let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
                let stored = {
                    let st = handle.state::<AppState>();
                    let outcome = st.store.lock().unwrap().insert(
                        &id,
                        &ts,
                        &cfg.prompt,
                        &result.text,
                        &cfg.provider,
                        &cfg.model(),
                        result.elapsed_ms,
                        &[] as &[Vec<u8>],
                    );
                    outcome
                };
                match stored {
                    Ok(()) => {
                        let _ = handle.emit(
                            "translation:done",
                            serde_json::json!({
                                "id": id,
                                "cancelled": result.cancelled,
                                "target": "main",
                                "kind": "text",
                                "ttft_ms": result.ttft_ms,
                                "elapsed_ms": result.elapsed_ms,
                            }),
                        );
                    }
                    Err(m) => {
                        let _ = handle.emit("translation:error", serde_json::json!({ "message": m }));
                    }
                }
            }
            Err(m) => {
                let _ = handle.emit("translation:error", serde_json::json!({ "message": m }));
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

/// Closing the window must not kill the shell: hide it instead, so the hotkey
/// still has somewhere to put the translation.
fn attach_close_to_tray(win: &tauri::WebviewWindow) {
    let handle = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = handle.hide();
        }
    });
}

fn parse_hotkeys(cfg: &Config) -> Result<(Shortcut, Shortcut), String> {
    let cap = cfg.hotkey_capture.trim();
    let rep = cfg.hotkey_repeat.trim();
    let cap_key: Shortcut = cap
        .parse()
        .map_err(|_| format!("截图快捷键「{cap}」无法识别（示例：Ctrl+Alt+S）"))?;
    let rep_key: Shortcut = rep
        .parse()
        .map_err(|_| format!("重复区域快捷键「{rep}」无法识别（示例：Ctrl+Alt+D）"))?;
    if cap_key == rep_key {
        return Err("两个功能不能绑定同一个快捷键".into());
    }
    Ok((cap_key, rep_key))
}

/// (Re)register both global hotkeys. Any conflict is reported to the caller so
/// the settings dialog can show it instead of silently losing the shortcut.
fn apply_hotkeys(app: &AppHandle, cfg: &Config) -> Result<(), String> {
    let (cap, rep) = parse_hotkeys(cfg)?;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.register(cap).map_err(|e| {
        format!(
            "「{}」注册失败：可能已被其它程序占用（{e}）",
            cfg.hotkey_capture
        )
    })?;
    gs.register(rep).map_err(|e| {
        let _ = gs.unregister(cap);
        format!(
            "「{}」注册失败：可能已被其它程序占用（{e}）",
            cfg.hotkey_repeat
        )
    })?;
    Ok(())
}

fn build_tray_menu(app: &AppHandle, cfg: &Config) -> tauri::Result<Menu<tauri::Wry>> {
    let shot_item = MenuItem::with_id(app, "shot", "截图翻译", true, Some(cfg.hotkey_capture.as_str()))?;
    let repeat_item = MenuItem::with_id(app, "repeat", "重复上次区域", true, Some(cfg.hotkey_repeat.as_str()))?;
    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&shot_item, &repeat_item, &show_item, &sep, &quit_item])
}

fn refresh_tray_menu(app: &AppHandle, cfg: &Config) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(menu) = build_tray_menu(app, cfg) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn focus_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    // No window at all (older builds destroyed it): rebuild it rather than
    // silently swallowing the event.
    match tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
        .title("截译")
        .inner_size(1120.0, 780.0)
        .min_inner_size(940.0, 620.0)
        .center()
        .build()
    {
        Ok(win) => {
            attach_close_to_tray(&win);
            let _ = win.set_focus();
        }
        Err(e) => eprintln!("rebuild main window failed: {e}"),
    }
}

fn result_target(cfg: &Config) -> &'static str {
    if cfg.result_window == "main" {
        "main"
    } else {
        "popup"
    }
}

/// Narrow always-on-top window that sits next to the selection, so a hotkey
/// translation never has to pull the whole main window in front of the user.
fn show_popup(app: &AppHandle, anchor: [f64; 4], bounds: [f64; 4]) -> Result<(), String> {
    const W: f64 = 460.0;
    let h = (anchor[3] + 150.0).clamp(300.0, 620.0);

    let mut x = anchor[0] + anchor[2] + 14.0;
    if x + W > bounds[0] + bounds[2] {
        x = anchor[0] - W - 14.0;
    }
    let max_x = (bounds[0] + bounds[2] - W - 8.0).max(bounds[0] + 8.0);
    x = x.clamp(bounds[0] + 8.0, max_x);

    let mut y = anchor[1];
    if y + h > bounds[1] + bounds[3] - 8.0 {
        y = bounds[1] + bounds[3] - h - 8.0;
    }
    y = y.max(bounds[1] + 8.0);

    if let Some(win) = app.get_webview_window("popup") {
        let _ = win.set_size(tauri::LogicalSize::new(W, h));
        let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("popup:reset", ());
        return Ok(());
    }

    let win = tauri::WebviewWindowBuilder::new(app, "popup", tauri::WebviewUrl::App("popup.html".into()))
        .title("截译 · 译文")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .min_inner_size(360.0, 240.0)
        .inner_size(W, h)
        .position(x, y)
        .focused(true)
        .transparent(true)
        .shadow(false)
        .build()
        .map_err(|e| format!("打开译文窗口失败：{e}"))?;

    let handle = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = handle.hide();
        }
    });
    Ok(())
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
        let _ = win.unminimize();
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
    images: Vec<capture::Encoded>,
    user_text: Option<String>,
    id: &str,
    cancel: Arc<AtomicBool>,
    target: &'static str,
) -> Result<providers::Translation, String> {
    let mime = images.first().map(|e| e.mime).unwrap_or("image/png");
    let kind = if user_text.is_some() { "text" } else { "image" };
    let b64s: Vec<String> = images.iter().map(|e| base64_encode(&e.bytes)).collect();
    let started_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    {
        // The popup window is created before this runs, so it can mount late:
        // keep a snapshot it can pull instead of losing the first chunks.
        let st = app.state::<AppState>();
        let mut run = st.run.lock().unwrap();
        *run = RunSnapshot {
            id: id.to_string(),
            provider: cfg.provider.clone(),
            model: cfg.model(),
            stream: cfg.stream,
            image_count: images.len(),
            target: target.to_string(),
            text: String::new(),
            kind: kind.to_string(),
            done: false,
            started_ms,
        };
    }
    let _ = app.emit(
        "translation:start",
        serde_json::json!({
            "id": id,
            "provider": cfg.provider,
            "model": cfg.model(),
            "stream": cfg.stream,
            "image_count": images.len(),
            "target": target,
            "kind": kind,
        }),
    );

    if cfg.stream {
        let handle = app.clone();
        let stream_id = id.to_string();
        let thought_handle = handle.clone();
        let thought_id = id.to_string();
        let result = providers::translate_stream(
            client,
            cfg,
            &b64s,
            mime,
            user_text.as_deref(),
            cancel,
            move |delta| {
                {
                    let st = handle.state::<AppState>();
                    let mut run = st.run.lock().unwrap();
                    run.text.push_str(delta);
                }
                let _ = handle.emit(
                    "translation:chunk",
                    serde_json::json!({ "id": stream_id, "text": delta }),
                );
            },
            move |chars| {
                // reasoning tokens: tell the UI we are still working
                let _ = thought_handle.emit(
                    "translation:thinking",
                    serde_json::json!({ "id": thought_id, "chars": chars }),
                );
            },
        )
        .await;
        finish_run(app, &result);
        result
    } else {
        let result = providers::translate(client, cfg, &b64s, mime, user_text.as_deref()).await;
        finish_run(app, &result);
        result
    }
}

/// Mark the snapshot finished with the authoritative final text.
fn finish_run(app: &AppHandle, result: &Result<providers::Translation, String>) {
    let st = app.state::<AppState>();
    let mut run = st.run.lock().unwrap();
    run.done = true;
    if let Ok(t) = result {
        if !t.text.is_empty() {
            run.text = t.text.clone();
        }
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
        let cfg_for_send = handle.state::<AppState>().cfg.lock().unwrap().clone();
        let send = match capture::encode_for_model(&cropped, cfg_for_send.image_max_edge, cfg_for_send.image_quality) {
            Ok(s) => s,
            Err(e) => {
                let _ = handle.emit("translation:error", serde_json::json!({ "message": e }));
                return;
            }
        };
        let st = handle.state::<AppState>();
        let cfg = st.cfg.lock().unwrap().clone();
        let target = result_target(&cfg);
        if target == "popup" {
            let s = if shot.scale > 0.0 { shot.scale } else { 1.0 };
            let mon = [
                shot.monitor.x as f64 / s,
                shot.monitor.y as f64 / s,
                shot.monitor.width as f64 / s,
                shot.monitor.height as f64 / s,
            ];
            let _ = show_popup(&handle, [mon[0] + x, mon[1] + y, w, h], mon);
        }
        let client = st.client.clone();
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        *st.cancel.lock().unwrap() = cancel.clone();

        match execute(&handle, &client, &cfg, vec![send], None, &id, cancel, target).await {
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
        // A second launch should surface the running copy instead of starting a
        // rival process that cannot register the global hotkeys.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let cfg = app.state::<AppState>().cfg.lock().unwrap().clone();
                    let is_repeat = parse_hotkeys(&cfg)
                        .map(|(_, repeat)| *shortcut == repeat)
                        .unwrap_or(false);
                    if is_repeat {
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
                run: Mutex::new(RunSnapshot::default()),
            });

            // Warm DNS/TLS so the first screenshot does not pay the handshake.
            {
                let warm_client = app.state::<AppState>().client.clone();
                let warm_cfg = app.state::<AppState>().cfg.lock().unwrap().clone();
                tauri::async_runtime::spawn(async move {
                    if warm_cfg.api_key.trim().is_empty() || warm_cfg.base_url.trim().is_empty() {
                        return;
                    }
                    let url = format!("{}/models", warm_cfg.trimmed_base());
                    let _ = warm_client
                        .get(url)
                        .header("authorization", format!("Bearer {}", warm_cfg.api_key.trim()))
                        .timeout(std::time::Duration::from_secs(6))
                        .send()
                        .await;
                });
            }

            // global hotkeys come from the config; a conflict here is retried
            // (an upgraded instance may still be holding the old registration).
            {
                let cfg_now = app.state::<AppState>().cfg.lock().unwrap().clone();
                if let Err(e) = apply_hotkeys(app.handle(), &cfg_now) {
                    eprintln!("hotkey registration: {e}; retrying");
                    let handle = app.handle().clone();
                    let retry_cfg = cfg_now.clone();
                    std::thread::spawn(move || {
                        for _ in 0..6 {
                            std::thread::sleep(std::time::Duration::from_millis(700));
                            if apply_hotkeys(&handle, &retry_cfg).is_ok() {
                                eprintln!("hotkeys registered after retry");
                                return;
                            }
                        }
                        eprintln!("hotkeys still unavailable — use the tray menu");
                    });
                }
            }

            // tray
            let cfg_tray = app.state::<AppState>().cfg.lock().unwrap().clone();
            let menu = build_tray_menu(app.handle(), &cfg_tray)?;

            let mut builder = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip(format!("截译 · {} 截图", cfg_tray.hotkey_capture))
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
                attach_close_to_tray(&win);
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
            delete_entries,
            clear_entries,
            hide_popup,
            open_in_main,
            run_snapshot,
            export_markdown,
            get_shot,
            start_capture,
            cancel_overlay,
            cancel_translation,
            translate_regions,
            translate_text,
            retranslate,
            test_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running jieyi");
}
