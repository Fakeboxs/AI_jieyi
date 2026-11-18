//! OCR through the OCR engine bundled with Windows (`Windows.Media.Ocr`).
//! Nothing to download: it ships with the display language. Only used by the
//! lightweight offline engine, where OCR text is then translated by a small
//! local model.

use std::time::{Duration, Instant};
use windows_future::{AsyncStatus, IAsyncInfo, IAsyncOperation};
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Security::Cryptography::CryptographicBuffer;
use windows::Storage::Streams::IBuffer;

/// WinRT async without a Rust executor: IAsyncInfo carries the status, so a
/// blocking worker thread can simply poll it.
fn wait<T: windows::core::RuntimeType + 'static>(
    op: IAsyncOperation<T>,
) -> Result<T, String> {
    let info: IAsyncInfo = windows::core::Interface::cast(&op).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match info.Status() {
            Ok(AsyncStatus::Completed) => break,
            Ok(AsyncStatus::Error) => {
                let code = info.ErrorCode()
                    .map(|c| format!("{c:?}"))
                    .unwrap_or_default();
                return Err(format!("OCR 失败（{code}）"));
            }
            Ok(AsyncStatus::Canceled) => return Err("OCR 被取消".into()),
            Ok(_) => {
                if Instant::now() > deadline {
                    return Err("OCR 超时".into());
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(e) => return Err(format!("OCR 状态读取失败：{e}")),
        }
    }
    op.GetResults().map_err(|e| format!("OCR 结果读取失败：{e}"))
}

/// The OCR model that fits the source text best: English if Windows has it
/// (Chinese-locale machines often only ship zh-Hans, which butchers Latin
/// text), otherwise whatever the user profile offers.
fn pick_engine() -> Result<OcrEngine, String> {
    let mut tags = available_languages();
    if tags.is_empty() {
        return Err(
            "系统里没有可用的 OCR 语言包：设置 → 时间和语言 → 语言 → 添加语言 →「可选功能」里勾上 OCR"
                .into(),
        );
    }
    // stable partition: en-* first, keep the rest in order
    let (mut en, rest): (Vec<String>, Vec<String>) = tags
        .drain(..)
        .partition(|t| t.to_lowercase().starts_with("en"));
    en.extend(rest);
    let mut last_err = String::new();
    for tag in &en {
        let lang = windows::Globalization::Language::CreateLanguage(&windows::core::HSTRING::from(tag.as_str()))
            .map_err(|e| e.to_string())?;
        match OcrEngine::TryCreateFromLanguage(&lang) {
            Ok(engine) => return Ok(engine),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(format!("OCR 引擎创建失败：{last_err}"))
}

/// Recognise a PNG and return its text, one line per detected line.
pub fn recognize_png(png: &[u8]) -> Result<String, String> {
    let img = image::load_from_memory(png)
        .map_err(|e| format!("图片解码失败：{e}"))?
        .to_rgba8();
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return Err("空图片".into());
    }
    // OcrEngine wants BGRA8
    let mut bgra = Vec::with_capacity((w * h * 4) as usize);
    for p in img.pixels() {
        bgra.push(p[2]);
        bgra.push(p[1]);
        bgra.push(p[0]);
        bgra.push(255);
    }

    {
        let buffer: IBuffer = CryptographicBuffer::CreateFromByteArray(&bgra)
            .map_err(|e| format!("图像缓冲创建失败：{e}"))?;
        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w as i32, h as i32)
            .map_err(|e| format!("SoftwareBitmap 创建失败：{e}"))?;
        let engine = pick_engine()?;
        let result = wait(
            engine
                .RecognizeAsync(&bitmap)
                .map_err(|e| format!("OCR 调用失败：{e}"))?,
        )?;
        let lines = result.Lines().map_err(|e| format!("OCR 结果读取失败：{e}"))?;
        let count = lines.Size().map_err(|e| e.to_string())?;
        let mut out = String::new();
        for i in 0..count {
            let line = lines.GetAt(i).map_err(|e| e.to_string())?;
            let text = line.Text().map_err(|e| e.to_string())?;
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&text.to_string_lossy());
        }
        Ok(out)
    }
}

/// Names of the OCR languages Windows can handle, for the settings hint.
pub fn available_languages() -> Vec<String> {
    let mut out = Vec::new();
    {
        if let Ok(list) = OcrEngine::AvailableRecognizerLanguages() {
            if let Ok(n) = list.Size() {
                for i in 0..n {
                    if let Ok(l) = list.GetAt(i) {
                        if let Ok(tag) = l.LanguageTag() {
                            out.push(tag.to_string_lossy());
                        }
                    }
                }
            }
        }
    }
    out
}
