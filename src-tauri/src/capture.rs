use base64::Engine;
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug)]
pub struct PendingShot {
    pub image: RgbaImage,
    pub scale: f64,
    pub monitor: Rect,
}

pub struct Pending(pub Mutex<Option<PendingShot>>);

#[derive(Serialize, Clone)]
pub struct ShotInfo {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

fn cursor_pos() -> (i32, i32) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT { x: 0, y: 0 };
    // SAFETY: GetCursorPos only writes into the provided POINT.
    unsafe {
        if GetCursorPos(&mut p) != 0 {
            (p.x, p.y)
        } else {
            (0, 0)
        }
    }
}

/// Grab the monitor currently under the cursor.
pub fn capture() -> Result<PendingShot, String> {
    let (cx, cy) = cursor_pos();
    let monitor = xcap::Monitor::from_point(cx, cy).map_err(|e| format!("找不到显示器：{e}"))?;

    let scale = monitor.scale_factor().unwrap_or(1.0) as f64;
    let image = monitor.capture_image().map_err(|e| format!("抓屏失败：{e}"))?;
    let rect = Rect {
        x: monitor.x().unwrap_or(0),
        y: monitor.y().unwrap_or(0),
        width: image.width(),
        height: image.height(),
    };
    Ok(PendingShot {
        image,
        scale,
        monitor: rect,
    })
}

pub fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf: Vec<u8> = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut buf);
    image
        .write_with_encoder(encoder)
        .map_err(|e| format!("PNG 编码失败：{e}"))?;
    Ok(buf)
}

pub fn encode_png_b64(image: &RgbaImage) -> Result<String, String> {
    let buf = encode_png(image)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(buf))
}

pub fn to_data_url(image: &RgbaImage) -> Result<String, String> {
    Ok(format!("data:image/png;base64,{}", encode_png_b64(image)?))
}

/// Crop a CSS-pixel selection out of the pending shot (selection is in logical px).
pub fn crop(pending: &PendingShot, x: f64, y: f64, w: f64, h: f64) -> Result<RgbaImage, String> {
    if w < 2.0 || h < 2.0 {
        return Err("选区太小".into());
    }
    let scale = if pending.scale > 0.0 { pending.scale } else { 1.0 };
    let max_w = pending.image.width() as f64;
    let max_h = pending.image.height() as f64;
    let px = (x * scale).clamp(0.0, max_w - 1.0);
    let py = (y * scale).clamp(0.0, max_h - 1.0);
    let pw = (w * scale).clamp(1.0, max_w - px);
    let ph = (h * scale).clamp(1.0, max_h - py);
    Ok(image::imageops::crop_imm(
        &pending.image,
        px as u32,
        py as u32,
        pw as u32,
        ph as u32,
    )
    .to_image())
}
