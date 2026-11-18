//! Offline resource packs: what to download, where it lives, and how it is
//! fetched. Nothing here talks to a remote API — the app only needs the files
//! inside `%APPDATA%\app.jieyi.desktop\models` to work with no network at all.

use serde::Serialize;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// A single file inside a pack. `mirrors` are tried in order after `url`.
pub struct PackFile {
    pub name: &'static str,
    pub size: u64,
    pub url: &'static str,
    pub mirrors: &'static [&'static str],
}

pub struct Pack {
    pub id: &'static str,
    pub title: &'static str,
    pub desc: &'static str,
    /// unpack the archives into `<models>/<id>/` (only the runtime does this)
    pub archive: bool,
    pub files: &'static [PackFile],
}

pub const PACKS: &[Pack] = &[
    Pack {
        id: "runtime",
        title: "llama.cpp 运行时",
        desc: "本地推理引擎（Vulkan 版，NVIDIA / AMD / Intel 都能用，回落到 CPU），解压约 40 MB",
        archive: true,
        files: &[PackFile {
            name: "llama-b12500-bin-win-vulkan-x64.zip",
            size: 38_600_000,
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b12500/llama-b12500-bin-win-vulkan-x64.zip",
            mirrors: &[
                "https://gh-proxy.com/https://github.com/ggml-org/llama.cpp/releases/download/b12500/llama-b12500-bin-win-vulkan-x64.zip",
            ],
        }],
    },
    Pack {
        id: "vlm",
        title: "视觉翻译包（推荐）",
        desc: "Qwen2.5-VL-3B（Q4_K_M）+ 视觉投影层，约 2.8 GB；识图与翻译一步完成，保留公式与排版",
        archive: false,
        files: &[
            PackFile {
                name: "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
                size: 1_929_900_000,
                url: "https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
                mirrors: &["https://hf-mirror.com/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf"],
            },
            PackFile {
                name: "mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf",
                size: 844_800_000,
                url: "https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf",
                mirrors: &["https://hf-mirror.com/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf"],
            },
        ],
    },
    Pack {
        id: "ocr",
        title: "轻量翻译包",
        desc: "Qwen2.5-1.5B（Q4_K_M，约 1.1 GB）+ 系统自带 OCR；CPU 也能跑，速度快，公式会丢",
        archive: false,
        files: &[PackFile {
            name: "Qwen2.5-1.5B-Instruct-q4_k_m.gguf",
            size: 1_117_300_000,
            url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
            mirrors: &["https://hf-mirror.com/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"],
        }],
    },
];

pub fn pack(id: &str) -> Option<&'static Pack> {
    PACKS.iter().find(|p| p.id == id)
}

pub fn models_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("models")
}

pub fn pack_dir(config_dir: &Path, id: &str) -> PathBuf {
    models_dir(config_dir).join(id)
}

fn file_ok(path: &Path, want: u64) -> bool {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if !meta.is_file() || (meta.len() as f64) < want as f64 * 0.999 {
        return false; // truncated download: llama.cpp would fail with "corrupted"
    }
    // A GGUF file always starts with "GGUF"; anything else is a redirect page
    // or an error body saved as a model.
    if path.extension().and_then(|e| e.to_str()) == Some("gguf") {
        use std::io::Read;
        if let Ok(mut f) = File::open(path) {
            let mut magic = [0u8; 4];
            if f.read_exact(&mut magic).is_err() || &magic != b"GGUF" {
                return false;
            }
        }
    }
    true
}

#[derive(Clone, Serialize)]
pub struct PackInfo {
    pub id: String,
    pub title: String,
    pub desc: String,
    pub bytes: u64,
    pub installed: bool,
    /// how much of the pack is already on disk (for a progress baseline)
    pub present_bytes: u64,
    pub missing: Vec<String>,
}

pub fn status(config_dir: &Path) -> Vec<PackInfo> {
    PACKS
        .iter()
        .map(|p| {
            let mut present = 0u64;
            let mut missing = Vec::new();
            for f in p.files {
                let path = if p.archive {
                    pack_dir(config_dir, p.id).join(f.name)
                } else {
                    pack_dir(config_dir, p.id).join(f.name)
                };
                let done = if p.archive {
                    // archives are extracted, not kept
                    pack_dir(config_dir, p.id).join("llama-server.exe").exists()
                } else {
                    file_ok(&path, f.size)
                };
                if done {
                    present += f.size;
                } else {
                    missing.push(f.name.to_string());
                }
            }
            PackInfo {
                id: p.id.to_string(),
                title: p.title.to_string(),
                desc: p.desc.to_string(),
                bytes: p.files.iter().map(|f| f.size).sum(),
                installed: missing.is_empty(),
                present_bytes: present,
                missing,
            }
        })
        .collect()
}

fn emit(app: &AppHandle, id: &str, got: u64, total: u64, phase: &str, message: &str) {
    let _ = app.emit(
        "offline:progress",
        serde_json::json!({
            "id": id, "got": got, "total": total, "phase": phase, "message": message,
        }),
    );
}

fn download_file(app: &AppHandle, pack_id: &str, f: &PackFile, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if file_ok(dest, f.size) {
        return Ok(());
    }
    let part = dest.with_extension("part");
    let mut urls: Vec<&str> = vec![f.url];
    urls.extend_from_slice(f.mirrors);
    let mut last_err = String::new();

    for url in urls {
        emit(app, pack_id, 0, f.size, "download", &format!("{} ← {url}", f.name));
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(3600))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = match client.get(url).send() {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("{url} 连接失败：{e}");
                continue;
            }
        };
        if !resp.status().is_success() {
            last_err = format!("{url} 返回 HTTP {}", resp.status());
            continue;
        }
        let total = resp.content_length().unwrap_or(f.size);
        let mut out = match File::create(&part) {
            Ok(f) => f,
            Err(e) => return Err(format!("写入 {} 失败：{e}", part.display())),
        };
        let mut got = 0u64;
        let mut reader = std::io::BufReader::with_capacity(1 << 20, resp);
        let mut buf = vec![0u8; 1 << 20];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                    got += n as u64;
                    // throttle UI updates to ~2 MB so the event queue stays sane
                    if got % (2 << 20) < (1 << 20) {
                        emit(app, pack_id, got, total, "download", &f.name);
                    }
                }
                Err(e) => {
                    last_err = format!("{url} 中途断开：{e}");
                    break;
                }
            }
        }
        let _ = out.flush();
        drop(out);
        if got > 0 && (total == 0 || got as f64 > total as f64 * 0.99) {
            std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
            emit(app, pack_id, got, total, "download", &format!("{} 完成", f.name));
            return Ok(());
        }
        let _ = std::fs::remove_file(&part);
    }
    Err(if last_err.is_empty() {
        format!("{} 下载失败", f.name)
    } else {
        last_err
    })
}

fn extract_zip(zip_path: &Path, out_dir: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip 解析失败：{e}"))?;
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry
            .enclosed_name()
            .ok_or_else(|| "zip 内路径非法".to_string())?
            .to_path_buf();
        let dest = out_dir.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = File::create(&dest).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Blocking: run it on a worker thread. Emits `offline:progress` as it goes.
pub fn download(app: &AppHandle, config_dir: &Path, pack_id: &str) -> Result<(), String> {
    let p = pack(pack_id).ok_or_else(|| format!("未知资源包：{pack_id}"))?;
    let dir = pack_dir(config_dir, p.id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for f in p.files {
        let dest = dir.join(f.name);
        download_file(app, p.id, f, &dest)?;
        if p.archive {
            emit(app, p.id, f.size, f.size, "extract", "正在解压…");
            extract_zip(&dest, &dir)?;
            let _ = std::fs::remove_file(&dest);
        }
    }
    emit(app, p.id, 0, 0, "done", "已就绪");
    Ok(())
}

pub fn delete(config_dir: &Path, pack_id: &str) -> Result<(), String> {
    let dir = pack_dir(config_dir, pack_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Path of the model files an engine needs, or an error telling the user what
/// to download. No network access happens here.
pub fn engine_files(config_dir: &Path, engine: &str) -> Result<(PathBuf, Option<PathBuf>), String> {
    let runtime = pack_dir(config_dir, "runtime").join("llama-server.exe");
    if !runtime.exists() {
        return Err("还没下载「llama.cpp 运行时」资源包（设置 → 离线模型）".into());
    }
    match engine {
        "vlm" => {
            let dir = pack_dir(config_dir, "vlm");
            let model = dir.join("Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf");
            let mmproj = dir.join("mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf");
            if !model.exists() || !mmproj.exists() {
                return Err("还没下载「视觉翻译包」（设置 → 离线模型，约 2.8 GB）".into());
            }
            Ok((model, Some(mmproj)))
        }
        "ocr" => {
            let model = pack_dir(config_dir, "ocr").join("Qwen2.5-1.5B-Instruct-q4_k_m.gguf");
            if !model.exists() {
                return Err("还没下载「轻量翻译包」（设置 → 离线模型，约 1.1 GB）".into());
            }
            Ok((model, None))
        }
        other => Err(format!("未知离线引擎：{other}")),
    }
}

#[allow(dead_code)]
pub fn human(bytes: u64) -> String {
    if bytes >= 1_000_000_000 {
        format!("{:.1} GB", bytes as f64 / 1e9)
    } else {
        format!("{:.0} MB", bytes as f64 / 1e6)
    }
}
