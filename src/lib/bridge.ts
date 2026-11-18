import type { Config, Entry, MonitorInfo, Rect, ShotReady, TranslationStart } from "../types";
import { MOCK_CONFIG, MOCK_ENTRIES, mockDelay, mockTranslate } from "./mock";

export const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function loadConfig(): Promise<Config> {
  if (!inTauri) return structuredClone(MOCK_CONFIG);
  return call<Config>("get_config");
}

export async function saveConfig(config: Config): Promise<Config> {
  if (!inTauri) {
    Object.assign(MOCK_CONFIG, config);
    return structuredClone(MOCK_CONFIG);
  }
  return call<Config>("save_config", { config });
}

export async function listEntries(): Promise<Entry[]> {
  if (!inTauri) {
    await mockDelay(120);
    return structuredClone(MOCK_ENTRIES);
  }
  return call<Entry[]>("list_entries");
}

export async function deleteEntry(id: string): Promise<void> {
  if (!inTauri) {
    const i = MOCK_ENTRIES.findIndex((e) => e.id === id);
    if (i >= 0) MOCK_ENTRIES.splice(i, 1);
    return;
  }
  await call<void>("delete_entry", { id });
}

export async function updateTags(id: string, tags: string[]): Promise<void> {
  if (!inTauri) {
    const e = MOCK_ENTRIES.find((x) => x.id === id);
    if (e) e.tags = tags;
    return;
  }
  await call<void>("update_tags", { id, tags });
}

export async function startCapture(): Promise<void> {
  if (!inTauri) {
    await mockDelay(400);
    await mockTranslate();
    return;
  }
  await call<void>("start_capture");
}

export async function retranslate(id: string): Promise<void> {
  if (!inTauri) {
    await mockTranslate();
    return;
  }
  await call<void>("retranslate", { id });
}

export async function testConnection(config: Config): Promise<{ ok: boolean; message: string }> {
  if (!inTauri) {
    await mockDelay(700);
    if (!config.api_key.trim()) return { ok: false, message: "还没有填写 API Key" };
    return { ok: true, message: `连接正常 · ${config.model || "未指定模型"}` };
  }
  return call<{ ok: boolean; message: string }>("test_connection", { config });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (inTauri) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      return true;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export async function onTranslationDone(
  cb: (entryId: string, cancelled: boolean) => void,
): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<{ id: string; cancelled?: boolean }>("translation:done", (e) =>
    cb(e.payload.id, Boolean(e.payload.cancelled)),
  );
  return un;
}

export async function onTranslationStart(cb: (payload: TranslationStart) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<TranslationStart>("translation:start", (e) => cb(e.payload));
  return un;
}

export async function onTranslationChunk(cb: (text: string) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<{ id: string; text: string }>("translation:chunk", (e) => cb(e.payload.text));
  return un;
}

export async function onTranslationError(cb: (message: string) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<{ message: string }>("translation:error", (e) => cb(e.payload.message));
  return un;
}

export interface ShotInfo {
  data_url: string;
  width: number;
  height: number;
  scale: number;
  last_region: [number, number, number, number] | null;
}

/** Overlay pulls the frozen screenshot once it mounts (no event race). */
export async function getShot(): Promise<ShotInfo | null> {
  if (!inTauri) return null;
  return call<ShotInfo | null>("get_shot");
}

export async function onShotReady(cb: (shot: ShotReady) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<ShotReady>("shot:ready", (e) => cb(e.payload));
  return un;
}

/** Overlay → backend: translate one or more selected regions together. */
export async function translateRegions(rects: Rect[]) {
  if (!inTauri) return;
  await call<void>("translate_regions", { rects });
}

/** Stop the running stream; whatever already arrived is kept. */
export async function cancelTranslation() {
  if (!inTauri) return;
  await call<void>("cancel_translation");
}

export async function listMonitors(): Promise<MonitorInfo[]> {
  if (!inTauri) {
    return [{ index: 0, name: "显示器 1（预览）", width: 1920, height: 1080, x: 0, y: 0, scale: 1, primary: true }];
  }
  return call<MonitorInfo[]>("list_monitors");
}

/** Ask for a path, then let Rust write the markdown. Returns the saved path. */
export async function exportMarkdown(
  id: string,
  suggestedName: string,
  markdown: string,
): Promise<string | null> {
  if (!inTauri) {
    const { downloadText } = await import("./download");
    downloadText(suggestedName, markdown);
    return null;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: suggestedName,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!path) return null;
  await call<void>("export_markdown", { id, path });
  return path;
}

export async function cancelOverlay() {
  if (!inTauri) return;
  await call<void>("cancel_overlay");
}

export async function toAssetUrl(path: string): Promise<string> {
  if (!inTauri) return path;
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path);
}
