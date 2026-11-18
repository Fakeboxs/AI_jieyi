import { useEffect, useRef, useState, type ReactNode } from "react";
import { ClipboardPaste, Eraser, Languages, Square } from "lucide-react";
import { copyText, inTauri } from "../lib/bridge";
import { StreamingResult } from "./Reader";

/** Paste-and-translate tab: no screenshot involved. */
export function ManualTranslate({
  streaming,
  busy,
  onTranslate,
  onCancel,
  toast,
  result,
}: {
  streaming: { text: string; provider: string; model: string; progressive: boolean } | null;
  busy: boolean;
  onTranslate: (text: string) => void;
  onCancel: () => void;
  toast: (text: string, tone?: "default" | "error") => void;
  result?: ReactNode;
}) {
  const [text, setText] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  async function paste() {
    try {
      let clip = "";
      if (inTauri) {
        const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
        clip = (await readText()) ?? "";
      } else {
        clip = await navigator.clipboard.readText();
      }
      if (!clip.trim()) {
        toast("剪贴板里没有文字", "error");
        return;
      }
      setText((cur) => (cur.trim() ? `${cur}\n\n${clip}` : clip));
      areaRef.current?.focus();
    } catch {
      toast("读不到剪贴板，试试 Ctrl+V", "error");
    }
  }

  function submit() {
    const body = text.trim();
    if (!body) {
      toast("先粘贴或输入要翻译的文本", "error");
      return;
    }
    onTranslate(body);
  }

  const chars = text.trim().length;

  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <div className="card" style={{ padding: "var(--space-4)", display: "grid", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Languages size={15} />
          <strong style={{ fontSize: 13, color: "var(--fg-strong)" }}>粘贴文本翻译</strong>
          <span className="status" style={{ marginLeft: "auto" }}>
            {chars > 0 ? `${chars} 字符` : "支持多段、Markdown、公式"}
          </span>
        </div>
        <textarea
          ref={areaRef}
          className="textarea"
          style={{ minHeight: 180 }}
          value={text}
          placeholder="把要翻译的外文粘到这里，Ctrl+Enter 开始翻译…"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !chars}>
            <Languages size={14} />
            翻译
          </button>
          <button className="btn btn-soft" onClick={() => void paste()} disabled={busy}>
            <ClipboardPaste size={14} />
            粘贴
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setText("");
              areaRef.current?.focus();
            }}
            disabled={busy || !chars}
          >
            <Eraser size={14} />
            清空
          </button>
          {busy ? (
            <button className="btn btn-ghost" onClick={onCancel}>
              <Square size={12} />
              停止
            </button>
          ) : null}
          <span className="status" style={{ marginLeft: "auto" }}>
            Ctrl+Enter 翻译
          </span>
        </div>
      </div>

      {streaming ? (
        <StreamingResult
          text={streaming.text}
          provider={streaming.provider}
          model={streaming.model}
          progressive={streaming.progressive}
          onStop={onCancel}
          toast={toast}
        />
      ) : null}

      {!streaming && result ? result : null}

      {!streaming && !busy && chars ? (
        <p className="hint-strip">
          译文会显示在这里，并自动进「归档」（这条记录没有截图，只保留文本）。
        </p>
      ) : null}
    </div>
  );
}

/** Clipboard helper kept local so the component has no extra deps. */
export async function readClipboard(): Promise<string> {
  if (inTauri) {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return (await readText()) ?? "";
  }
  return navigator.clipboard.readText();
}

export { copyText };
