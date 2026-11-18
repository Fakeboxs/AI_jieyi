export type Provider = "openai" | "anthropic" | "gemini" | "custom" | "advanced";

export interface Entry {
  id: string;
  timestamp: string;
  markdown: string;
  prompt: string;
  tags: string[];
  images: string[];
  provider: string;
  model: string;
  elapsed_ms: number;
  image_count: number;
}

export interface HeaderKV {
  key: string;
  value: string;
}

export interface AdvancedConfig {
  endpoint: string;
  headers: HeaderKV[];
  body: string;
  response_path: string;
}

export interface Config {
  provider: Provider;
  base_url: string;
  api_key: string;
  model: string;
  prompt: string;
  max_tokens: number;
  temperature: number;
  theme: "light" | "dark" | "system";
  /** true = SSE 流式；false = 一次性直出 */
  stream: boolean;
  /** -1 = 鼠标所在显示器；0..n = 指定显示器 */
  capture_screen: number;
  /** 再次截图时预选上次的框选区域 */
  remember_region: boolean;
  /** "popup" = 选区旁的独立小窗；"main" = 回到主窗口 */
  result_window: "popup" | "main";
  /** 上传前把长边缩到多少像素（0 = 不缩放） */
  image_max_edge: number;
  /** 需要压成 JPEG 时的质量 50–95 */
  image_quality: number;
  /** "off" = 显式关闭思考（DeepSeek 默认开启）；"default" = 不干预；"on" = 开启 */
  thinking: "off" | "default" | "on";
  /** 全局截图快捷键，如 "Ctrl+Alt+S" */
  hotkey_capture: string;
  /** 重复上次区域快捷键，如 "Ctrl+Alt+D" */
  hotkey_repeat: string;
  advanced: AdvancedConfig;
}

export interface TranslationStart {
  id: string;
  provider: string;
  model: string;
  stream: boolean;
  image_count: number;
  /** 这次结果该显示在哪里 */
  target?: "popup" | "main";
  /** image = 截图翻译；text = 手动粘贴的文本 */
  kind?: "image" | "text";
}

export interface ShotReady {
  path: string;
  width: number;
  height: number;
  scale: number;
  monitor: { x: number; y: number; width: number; height: number };
}

export type Status = "idle" | "capturing" | "translating" | "error";

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
  primary: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
