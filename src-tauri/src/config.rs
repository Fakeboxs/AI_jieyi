use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_PROMPT: &str = "# 角色\n你是专业的学术翻译，擅长中英互译，并能精确处理数学、物理等领域的 LaTeX 公式。\n\n# 任务\n把图片中的英文内容翻译为中文。\n\n# 要求\n1. 只输出译文，不要开场白、解释或结束语。\n2. 数学变量、常数、公式必须使用 LaTeX（$x$ 或 $$E=mc^2$$）。\n3. 术语严谨，保持原文段落结构。\n4. Markdown 可用于标题、列表与表格。";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HeaderKV {
    pub key: String,
    pub value: String,
}

/// Fully user-defined HTTP call: endpoint / headers / body are templates with
/// `{{model}}`, `{{prompt_json}}`, `{{images}}` … placeholders.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Advanced {
    pub endpoint: String,
    pub headers: Vec<HeaderKV>,
    pub body: String,
    /// Optional JSON pointer into the response, e.g. `/data/0/content`.
    pub response_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub prompt: String,
    pub max_tokens: u32,
    pub temperature: f32,
    pub theme: String,
    /// true = SSE 流式增量返回；false = 等模型一次性返回（直出）
    pub stream: bool,
    /// -1 = 鼠标所在显示器；0..n = 指定显示器序号
    pub capture_screen: i32,
    /// 再次截图时预选上次的框选区域
    pub remember_region: bool,
    /// "popup" = 在选区旁边弹一个窄的独立小窗；"main" = 回到主窗口
    pub result_window: String,
    /// 上传给模型前把长边缩到这个像素以内（0 = 不缩放）。越小越快。
    pub image_max_edge: u32,
    /// 需要压成 JPEG 时的质量（50–95）
    pub image_quality: u8,
    /// 思考模式：off = 显式关闭（DeepSeek 默认开启，翻译会白等几秒）；
    /// default = 不干预；on = 显式开启
    pub thinking: String,
    pub advanced: Advanced,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            provider: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            api_key: String::new(),
            model: "gpt-4o-mini".into(),
            prompt: DEFAULT_PROMPT.into(),
            max_tokens: 2048,
            temperature: 0.2,
            theme: "system".into(),
            stream: true,
            capture_screen: -1,
            remember_region: true,
            result_window: "popup".into(),
            image_max_edge: 1440,
            image_quality: 86,
            thinking: "off".into(),
            advanced: Advanced::default(),
        }
    }
}

impl Config {
    pub fn path(dir: &Path) -> PathBuf {
        dir.join("config.json")
    }

    pub fn load(dir: &Path) -> Self {
        let path = Self::path(dir);
        match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => {
                let cfg = Self::default();
                let _ = cfg.save(dir);
                cfg
            }
        }
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let raw = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(Self::path(dir), raw).map_err(|e| e.to_string())
    }

    pub fn trimmed_base(&self) -> String {
        self.base_url.trim_end_matches('/').to_string()
    }

    pub fn model(&self) -> String {
        if self.model.trim().is_empty() {
            match self.provider.as_str() {
                "anthropic" => "claude-sonnet-4-5".to_string(),
                "gemini" => "gemini-2.5-flash".to_string(),
                _ => "gpt-4o-mini".to_string(),
            }
        } else {
            self.model.trim().to_string()
        }
    }
}
