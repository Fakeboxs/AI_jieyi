//! Local inference sidecar: start `llama-server` from the downloaded resource
//! pack, wait until it answers /health, and hand back an OpenAI-compatible base
//! URL. Nothing here needs the internet.

use crate::models;
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub struct LocalServer {
    pub child: Child,
    pub port: u16,
    pub engine: String,
    /// Windows job object holding the sidecar: if this process dies for any
    /// reason (including Task Manager "End task"), the job handle is closed by
    /// the kernel and the sidecar is killed with it. No orphaned 2.4 GB.
    #[cfg(windows)]
    job: Option<isize>,
}

#[cfg(windows)]
fn attach_kill_on_close(child: &Child) -> Option<isize> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            CloseHandle(job);
            return None;
        }
        // Fails harmlessly when the process is already inside another job.
        AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
        Some(job as isize)
    }
}

impl LocalServer {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        #[cfg(windows)]
        if let Some(job) = self.job.take() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(job as *mut core::ffi::c_void);
            }
        }
    }
}

fn free_port() -> u16 {
    for _ in 0..20 {
        if let Ok(l) = TcpListener::bind("127.0.0.1:0") {
            if let Ok(addr) = l.local_addr() {
                let p = addr.port();
                drop(l);
                return p;
            }
        }
    }
    8123
}

fn healthy(port: u16) -> bool {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
        .ok();
    match client {
        Some(c) => c
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .map(|r| r.status().is_success())
            .unwrap_or(false),
        None => false,
    }
}

/// Start (or restart) the sidecar for `engine` ("vlm" | "ocr").
/// Emits `offline:engine` so the UI can show "正在加载本地模型…".
pub fn start(app: &AppHandle, config_dir: &Path, engine: &str) -> Result<LocalServer, String> {
    let (model, mmproj) = models::engine_files(config_dir, engine)?;
    let runtime = models::pack_dir(config_dir, "runtime").join("llama-server.exe");
    if !runtime.exists() {
        return Err("运行时缺失：llama-server.exe（设置 → 离线模型）".into());
    }

    // Keep llama-server's own diagnostics: when it refuses to load a model the
    // reason (corrupt file, VRAM) is only in there.
    let log_path = models::pack_dir(config_dir, "runtime").join("llama-server.log");
    let log_file = std::fs::File::create(&log_path).map_err(|e| format!("无法写日志：{e}"))?;

    let port = free_port();
    let mut cmd = Command::new(&runtime);
    cmd.arg("-m")
        .arg(&model)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("-c")
        .arg("8192")
        .arg("-ngl")
        .arg("99")
        .arg("--alias")
        .arg("local")
        .arg("--jinja")
        .arg("-np")
        .arg("1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log_file));
    if let Some(mp) = &mmproj {
        cmd.arg("--mmproj").arg(mp);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let _ = app.emit(
        "offline:engine",
        serde_json::json!({ "state": "loading", "engine": engine }),
    );
    let child = cmd
        .spawn()
        .map_err(|e| format!("启动本地模型失败：{e}（路径 {}）", runtime.display()))?;
    #[cfg(windows)]
    let job = attach_kill_on_close(&child);
    let mut server = LocalServer {
        child,
        port,
        engine: engine.to_string(),
        #[cfg(windows)]
        job,
    };

    // 3B + mmproj on a cold page cache can take a while; be patient but bounded.
    let deadline = Instant::now() + Duration::from_secs(240);
    loop {
        if healthy(port) {
            let _ = app.emit(
                "offline:engine",
                serde_json::json!({ "state": "ready", "engine": engine, "port": port }),
            );
            return Ok(server);
        }
        if let Ok(Some(status)) = server.child.try_wait() {
            let _ = app.emit(
                "offline:engine",
                serde_json::json!({ "state": "error", "engine": engine, "message": status.to_string() }),
            );
            let tail = std::fs::read_to_string(&log_path)
                .map(|s| {
                    let mut lines: Vec<&str> = s.lines().filter(|l| l.contains(" E ") || l.contains("error")).collect();
                    if lines.is_empty() {
                        lines = s.lines().rev().take(3).collect();
                        lines.reverse();
                    }
                    lines.join("\n")
                })
                .unwrap_or_default();
            return Err(format!(
                "本地模型启动失败（{status}）。日志：{}\n{}",
                log_path.display(),
                tail.chars().take(600).collect::<String>()
            ));
        }
        if Instant::now() > deadline {
            server.stop();
            let _ = app.emit(
                "offline:engine",
                serde_json::json!({ "state": "error", "engine": engine, "message": "启动超时" }),
            );
            return Err("本地模型 240 秒内没启动起来（显存不足？可改用轻量包）".into());
        }
        std::thread::sleep(Duration::from_millis(700));
    }
}
