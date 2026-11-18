import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Check, Copy, ExternalLink, Square, X } from "lucide-react";
import { cancelTranslation, copyText, hidePopup, inTauri, openInMain, runSnapshot } from "./lib/bridge";
import { Markdown } from "./components/Reader";
// the popup is a separate page: it needs KaTeX's stylesheet on its own
import "katex/dist/katex.min.css";
import { toPlainText } from "./lib/markdown";
import type { TranslationStart } from "./types";
import "./styles/app.css";

/** Narrow, always-on-top result window used by the screenshot hotkey. */
export default function Popup() {
  const [text, setText] = useState("");
  const [meta, setMeta] = useState<TranslationStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [entryId, setEntryId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [ttft, setTtft] = useState(0);
  const [thinking, setThinking] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const offs: Array<() => void> = [];

    const reset = () => {
      setText("");
      setThinking(0);
      setError("");
      setBusy(true);
      setCopied(false);
      setEntryId(null);
      startedAt.current = Date.now();
    };

    if (!inTauri) {
      reset();
      setMeta({
        id: "demo",
        provider: "openai",
        model: "Qwen/Qwen2.5-VL-72B-Instruct",
        stream: true,
        image_count: 1,
      });
      const demo =
        "## 鞍点法近似\n\n在最后一步我们应用了鞍点法 [50, 51]。构型熵 $\\Sigma$ 表示总状态数的对数。\n\n$$Z \\approx \\frac{e^{S(f^{*})}}{\\sqrt{2\\pi\\,\\det(-H)}}$$\n\n**关键条件**是 $f^{*}$ 为极大值点且 $\\det(-H) > 0$。";
      let i = 0;
      const timer = window.setInterval(() => {
        i += 14;
        setText(demo.slice(0, i));
        if (i >= demo.length) {
          window.clearInterval(timer);
          setBusy(false);
        }
      }, 45);
      return () => window.clearInterval(timer);
    }

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const reg = async (p: Promise<() => void>) => {
        const un = await p;
        if (cancelled) un();
        else offs.push(un);
      };
      await reg(
        listen<TranslationStart>("translation:start", (e) => {
          if (e.payload.target && e.payload.target !== "popup") return;
          reset();
          setMeta(e.payload);
        }),
      );
      await reg(
        listen<{ text: string }>("translation:chunk", (e) => {
          setText((cur) => cur + e.payload.text);
        }),
      );
      await reg(
        listen<{ id: string; cancelled?: boolean; ttft_ms?: number; elapsed_ms?: number }>(
          "translation:done",
          (e) => {
            setBusy(false);
            setEntryId(e.payload.id);
            setTtft(e.payload.ttft_ms ?? 0);
            setElapsed(
              e.payload.elapsed_ms
                ? Math.round(e.payload.elapsed_ms / 100) / 10
                : Math.max(0.1, Math.round((Date.now() - startedAt.current) / 100) / 10),
            );
          },
        ),
      );
      await reg(
        listen<{ chars: number }>("translation:thinking", (e) => {
          setThinking(e.payload.chars);
        }),
      );
      await reg(
        listen<{ message: string }>("translation:error", (e) => {
          setBusy(false);
          setError(e.payload.message);
        }),
      );
      await reg(listen("popup:reset", () => reset()));

      // The window is created right before the request starts, so the first
      // events can fire before React mounts: catch up from the backend snapshot.
      const snap = await runSnapshot();
      if (snap && snap.id && snap.target === "popup") {
        startedAt.current = snap.started_ms;
        setMeta({
          id: snap.id,
          provider: snap.provider,
          model: snap.model,
          stream: snap.stream,
          image_count: snap.image_count,
        });
        setText(snap.text);
        setBusy(!snap.done);
        if (snap.done) {
          setEntryId(snap.id);
          setElapsed(Math.max(0, Math.round((Date.now() - snap.started_ms) / 100) / 10));
        }
      }
    })();

    return () => {
      cancelled = true;
      offs.forEach((off) => off());
    };
  }, []);

  // keep the "waiting" counter moving so the delay does not feel frozen
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => forceTick((v) => v + 1), 200);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void hidePopup();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
        e.preventDefault();
        void doCopy();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function doCopy() {
    if (!text.trim()) return;
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }

  const label = meta ? (meta.provider === "openai" ? "OpenAI 兼容" : meta.provider) : "";

  return (
    <div className="popup-root" data-busy={busy ? "true" : "false"}>
      <header className="popup-bar" data-tauri-drag-region>
        <span className="popup-dot" data-tauri-drag-region />
        <span className="popup-title" data-tauri-drag-region>
          {label}
          {meta?.model ? ` · ${meta.model}` : ""}
        </span>
        {busy ? (
          <>
            <span className="spinner" />
            <span className="popup-meta">{`${((Date.now() - startedAt.current) / 1000).toFixed(1)}s`}</span>
          </>
        ) : null}
        {!busy && elapsed ? (
          <span className="popup-meta" title="首字到达 / 全部完成">
            {ttft ? `首字 ${(ttft / 1000).toFixed(1)}s · ` : ""}
            {`共 ${elapsed}s`}
          </span>
        ) : null}
        <div className="popup-tools">
          <button className="popup-tool" title="关闭 (Esc)" aria-label="关闭" onClick={() => void hidePopup()}>
            <X size={12} />
          </button>
        </div>
      </header>

      <>
          <div className="popup-body">
            {error ? (
              <p className="popup-error">{error}</p>
            ) : text.trim() ? (
              <Markdown markdown={text} streaming={busy} />
            ) : busy ? (
              <div className="popup-skeleton">
                <span className="spinner" />
                {thinking > 0 ? `模型正在思考（已 ${thinking} 字）…` : "正在识别并翻译…"}
              </div>
            ) : (
              <p style={{ color: "var(--muted-fg)" }}>还没有内容。</p>
            )}
          </div>

          <footer className="popup-foot">
            <button className="btn btn-primary popup-action" onClick={doCopy} disabled={!text.trim()}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? "已复制" : "复制译文"}
            </button>
            {busy ? (
              <button className="btn btn-ghost popup-action" onClick={() => void cancelTranslation()}>
                <Square size={12} />
                停止
              </button>
            ) : null}
            {entryId ? (
              <button className="btn btn-ghost popup-action" onClick={() => void openInMain(entryId)}>
                <ExternalLink size={13} />
                在主窗口打开
              </button>
            ) : null}
            <span className="popup-hint">{toPlainText(text).length} 字 · Esc 关闭</span>
          </footer>
      </>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
