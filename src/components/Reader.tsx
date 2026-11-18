import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, RefreshCw, Trash2 } from "lucide-react";
import type { Entry } from "../types";
import { copyText } from "../lib/bridge";
import { renderMarkdown, toPlainText, trimIncompleteMath } from "../lib/markdown";
import { relative } from "../lib/time";
import { CopyButton } from "./ui";

export function Markdown({ markdown, streaming }: { markdown: string; streaming?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    renderMarkdown(streaming ? trimIncompleteMath(markdown) : markdown, ref.current);
  }, [markdown, streaming]);
  return <div className={streaming ? "md is-streaming" : "md"} ref={ref} />;
}

function formatElapsed(ms: number) {
  if (!ms) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI 兼容",
  anthropic: "Anthropic",
  gemini: "Gemini",
  custom: "自定义",
};

export function ResultCard({
  entry,
  onRetranslate,
  onDelete,
  toast,
  busy,
}: {
  entry: Entry;
  onRetranslate: (id: string) => void;
  onDelete: (id: string) => void;
  toast: (text: string, tone?: "default" | "error") => void;
  busy?: boolean;
}) {
  const plain = useMemo(() => toPlainText(entry.markdown), [entry.markdown]);

  async function copyPlain() {
    const ok = await copyText(plain);
    toast(ok ? "已复制纯文本" : "复制失败", ok ? "default" : "error");
  }

  return (
    <article className="card" aria-label="翻译结果">
      <header className="result-head">
        <div className="result-meta">
          <span className="chip" data-active="true">
            {PROVIDER_LABEL[entry.provider] ?? entry.provider}
          </span>
          <span className="model-name" style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
            {entry.model}
          </span>
          <i className="dot" />
          <span>{relative(entry.timestamp)}</span>
          {entry.image_count > 1 ? (
            <span className="opt" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <i className="dot" />
              <span>{entry.image_count} 张截图</span>
            </span>
          ) : null}
          {entry.elapsed_ms ? (
            <span className="opt" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <i className="dot" />
              <span>{formatElapsed(entry.elapsed_ms)}</span>
            </span>
          ) : null}
        </div>
        <div className="result-actions">
          <CopyButton
            text={entry.markdown}
            label="复制译文"
            disabled={!entry.markdown}
            onDone={(ok) => toast(ok ? "已复制 Markdown 译文" : "复制失败", ok ? "default" : "error")}
          />
          <button className="btn btn-ghost btn-icon" onClick={copyPlain} title="复制为纯文本" aria-label="复制为纯文本">
            <FileText size={15} />
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => onRetranslate(entry.id)}
            title="重新翻译"
            aria-label="重新翻译"
            disabled={busy}
          >
            <RefreshCw size={15} />
          </button>
          <button
            className="btn btn-danger btn-icon"
            onClick={() => onDelete(entry.id)}
            title="删除这条记录"
            aria-label="删除这条记录"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </header>
      <div className="reader">
        {entry.markdown ? (
          <Markdown markdown={entry.markdown} />
        ) : (
          <p style={{ color: "var(--muted-fg)" }}>这条记录还没有译文。</p>
        )}
      </div>
    </article>
  );
}

export function ResultSkeleton() {
  return (
    <div className="card" aria-busy="true" aria-label="正在翻译">
      <div className="result-head">
        <div className="skeleton" style={{ width: 120, height: 20 }} />
        <div className="result-actions">
          <div className="skeleton" style={{ width: 104, height: 34, borderRadius: 10 }} />
        </div>
      </div>
      <div className="reader" style={{ display: "grid", gap: 12 }}>
        <div className="skeleton" style={{ width: "42%", height: 20 }} />
        <div className="skeleton" style={{ width: "100%", height: 14 }} />
        <div className="skeleton" style={{ width: "96%", height: 14 }} />
        <div className="skeleton" style={{ width: "88%", height: 14 }} />
        <div className="skeleton" style={{ width: "100%", height: 58, marginTop: 8 }} />
        <div className="skeleton" style={{ width: "92%", height: 14 }} />
        <div className="skeleton" style={{ width: "70%", height: 14 }} />
      </div>
    </div>
  );
}

/** Live card shown while SSE deltas arrive. */
export function StreamingResult({
  text,
  provider,
  model,
  progressive,
  toast,
}: {
  text: string;
  provider: string;
  model: string;
  /** true = SSE，边收边渲染；false = 直出，等整段 */
  progressive: boolean;
  toast: (text: string, tone?: "default" | "error") => void;
}) {
  return (
    <article className="card" aria-busy="true" aria-label="正在生成译文">
      <header className="result-head">
        <div className="result-meta">
          <span className="chip" data-active="true">{PROVIDER_LABEL[provider] ?? provider}</span>
          <span className="model-name" style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
            {model}
          </span>
          <i className="dot" />
          <span className="stream-badge">
            <span className="spinner" />
            生成中
          </span>
        </div>
        <div className="result-actions">
          <CopyButton
            text={text}
            label={progressive ? "复制已有部分" : "复制译文"}
            disabled={!text}
            onDone={(ok) => toast(ok ? "已复制当前内容" : "复制失败", ok ? "default" : "error")}
          />
        </div>
      </header>
      <div className="reader">
        {text ? (
          <Markdown markdown={text} streaming={progressive} />
        ) : (
          <div style={{ display: "grid", gap: 12 }} aria-hidden>
            <div className="skeleton" style={{ width: "40%", height: 20 }} />
            <div className="skeleton" style={{ width: "100%", height: 14 }} />
            <div className="skeleton" style={{ width: "94%", height: 14 }} />
            <div className="skeleton" style={{ width: "86%", height: 14 }} />
          </div>
        )}
      </div>
    </article>
  );
}

export function EntryPreview({ entry, onDelete }: { entry: Entry; onDelete?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="entry" data-open={open} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="entry-title">{firstLine(entry.markdown) || "（空译文）"}</span>
        <span className="entry-row">
          <span>{relative(entry.timestamp)}</span>
          <i className="dot" style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--border-strong)" }} />
          <span>{PROVIDER_LABEL[entry.provider] ?? entry.provider}</span>
          {entry.tags.map((t) => (
            <span className="chip" key={t}>
              {t}
            </span>
          ))}
        </span>
      </button>
      {open ? (
        <div className="card" style={{ marginTop: 8, padding: "var(--space-4)" }}>
          <Markdown markdown={entry.markdown} />
          <div className="entry-actions">
            <CopyButton text={entry.markdown} label="复制译文" className="btn btn-soft" />
            <button className="btn btn-ghost" onClick={() => onDelete?.(entry.id)} title="删除这条记录">
              <Trash2 size={14} />
              删除
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function firstLine(markdown: string) {
  const line = toPlainText(markdown).split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
