export type Provider = "openai" | "anthropic" | "gemini" | "custom";

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
}

export interface TranslationStart {
  id: string;
  provider: string;
  model: string;
  stream: boolean;
}

export interface ShotReady {
  path: string;
  width: number;
  height: number;
  scale: number;
  monitor: { x: number; y: number; width: number; height: number };
}

export type Status = "idle" | "capturing" | "translating" | "error";
