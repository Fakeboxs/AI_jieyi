import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive as ArchiveIcon,
  Camera,
  Languages,
  Moon,
  ScanLine,
  Settings2,
  Sun,
} from "lucide-react";
import type { Config, Entry, Status } from "./types";
import {
  deleteEntry,
  inTauri,
  listEntries,
  loadConfig,
  onTranslationChunk,
  onTranslationDone,
  onTranslationError,
  onTranslationStart,
  retranslate,
  saveConfig,
  startCapture,
  testConnection,
  updateTags,
} from "./lib/bridge";
import { Archive } from "./components/Archive";
import { ResultCard, ResultSkeleton, StreamingResult } from "./components/Reader";
import { Settings } from "./components/Settings";
import { Kbd, Toasts, type ToastItem } from "./components/ui";

type Tab = "translate" | "archive" | "settings";

const TABS: { id: Tab; label: string; icon: typeof Languages; title: string; sub: string }[] = [
  { id: "translate", label: "翻译", icon: Languages, title: "翻译", sub: "截图 → 识别 → 译文，全程不用离开键盘" },
  { id: "archive", label: "归档", icon: ArchiveIcon, title: "归档", sub: "每一次翻译都会自动保存，可搜索、可打标签" },
  { id: "settings", label: "设置", icon: Settings2, title: "设置", sub: "模型服务、提示词与外观" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("translate");
  const [config, setConfig] = useState<Config | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [stream, setStream] = useState<{
    id: string;
    text: string;
    provider: string;
    model: string;
    progressive: boolean;
  } | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const streamBuf = useRef({ text: "", last: 0, timer: 0 });
  const contentRef = useRef<HTMLDivElement>(null);

  const toast = useCallback((text: string, tone: "default" | "error" = "default") => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, text, tone }]);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const refresh = useCallback(async (selectLatest = false) => {
    const list = await listEntries();
    setEntries(list);
    setCurrentId((cur) => (selectLatest ? (list[0]?.id ?? null) : cur ?? list[0]?.id ?? null));
    return list;
  }, []);

  useEffect(() => {
    (async () => {
      const [cfg, list] = await Promise.all([loadConfig(), listEntries()]);
      setConfig(cfg);
      setEntries(list);
      setCurrentId(list[0]?.id ?? null);
    })();
  }, []);

  // Translation lifecycle: start → chunk* → done | error.
  // NB: under StrictMode effects mount twice and `listen()` resolves asynchronously,
  // so latch a cancelled flag or every listener ends up registered twice.
  useEffect(() => {
    let cancelled = false;
    const offs: Array<() => void> = [];
    const reg = (p: Promise<() => void>) => p.then((fn) => (cancelled ? fn() : offs.push(fn)));

    reg(
      onTranslationStart((payload) => {
        streamBuf.current = { text: "", last: 0, timer: 0 };
        setStream({
          id: payload.id,
          text: "",
          provider: payload.provider,
          model: payload.model,
          progressive: payload.stream,
        });
        setStatus("translating");
        setTab("translate");
      }),
    );

    reg(
      onTranslationChunk((delta) => {
        const buf = streamBuf.current;
        buf.text += delta;
        const flush = () => setStream((s) => (s ? { ...s, text: buf.text } : s));
        const now = performance.now();
        // Re-rendering markdown + KaTeX per token is wasteful; coalesce to ~12fps.
        if (now - buf.last >= 80) {
          buf.last = now;
          flush();
        } else if (!buf.timer) {
          buf.timer = window.setTimeout(() => {
            buf.timer = 0;
            buf.last = performance.now();
            flush();
          }, 80);
        }
      }),
    );

    reg(
      onTranslationDone(async (id) => {
        window.clearTimeout(streamBuf.current.timer);
        setStream(null);
        await refresh(false);
        setCurrentId(id);
        setTab("translate");
        setStatus("idle");
      }),
    );

    reg(
      onTranslationError((message) => {
        window.clearTimeout(streamBuf.current.timer);
        setStream(null);
        setStatus("idle");
        toast(message, "error");
      }),
    );

    return () => {
      cancelled = true;
      window.clearTimeout(streamBuf.current.timer);
      offs.forEach((fn) => fn());
    };
  }, [refresh, toast]);

  // Follow the tail of a growing translation unless the user scrolled up.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || !stream) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 180;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [stream?.text, stream]);

  // theme
  useEffect(() => {
    if (!config) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const t = config.theme === "system" ? (mq.matches ? "dark" : "light") : config.theme;
      document.documentElement.dataset.theme = t;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [config]);

  // tab shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const map: Record<string, Tab> = { "1": "translate", "2": "archive", "3": "settings" };
      const next = map[e.key];
      if (next) {
        e.preventDefault();
        setTab(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function capture() {
    if (status !== "idle") return;
    setStatus("capturing");
    try {
      await startCapture();
      if (!inTauri) {
        const list = await refresh(true);
        setTab("translate");
        setCurrentId(list[0]?.id ?? null);
        toast("翻译完成");
      }
    } catch (e) {
      toast(`截图失败：${String(e)}`, "error");
    } finally {
      setStatus("idle");
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("删除这条翻译记录？")) return;
    await deleteEntry(id);
    const list = await refresh(false);
    if (currentId === id) setCurrentId(list[0]?.id ?? null);
    toast("已删除");
  }

  async function handleRetranslate(id: string) {
    setStatus("translating");
    try {
      await retranslate(id);
      await refresh(false);
      toast("已重新翻译");
    } catch (e) {
      toast(`重译失败：${String(e)}`, "error");
    } finally {
      setStatus("idle");
    }
  }

  async function handleSave(c: Config) {
    const saved = await saveConfig(c);
    setConfig(saved);
    await refresh(false);
  }

  const current = entries.find((e) => e.id === currentId) ?? entries[0] ?? null;
  const activeTab = TABS.find((t) => t.id === tab)!;
  const busy = status === "translating";

  if (!config) {
    return (
      <div className="app" aria-busy="true">
        <aside className="rail" />
        <main className="main">
          <div className="content" style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <div className="skeleton" style={{ width: 220, height: 26 }} />
            <div className="skeleton" style={{ width: "100%", height: 320, borderRadius: 16 }} />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand-mark" title="截译">
          <ScanLine size={19} />
        </div>
        {TABS.map((t) => (
          <button
            key={t.id}
            className="rail-item"
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
            title={`${t.label}（Ctrl+${TABS.indexOf(t) + 1}）`}
          >
            <t.icon size={19} />
            {t.label}
          </button>
        ))}
        <div className="rail-spacer" />
        <button
          className="rail-item"
          onClick={async () => {
            const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
            const cfg = { ...config, theme: next as Config["theme"] };
            setConfig(cfg);
            try {
              await saveConfig(cfg); // keep the choice across restarts
            } catch {
              /* theme still applied for this session */
            }
          }}
          title="切换主题"
        >
          {document.documentElement.dataset.theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
          主题
        </button>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>{activeTab.title}</h1>
            <p className="sub">{activeTab.sub}</p>
          </div>
          <div className="topbar-actions">
            <Kbd keys={["Ctrl", "Alt", "S"]} />
            <button className="btn btn-primary" onClick={capture} disabled={status !== "idle"}>
              <Camera size={15} />
              {status === "capturing" ? "截图中…" : "截图翻译"}
            </button>
          </div>
        </header>

        <div className="content" ref={contentRef}>
          {tab === "translate" ? (
            stream ? (
              <StreamingResult
                text={stream.text}
                provider={stream.provider}
                model={stream.model}
                progressive={stream.progressive}
                toast={toast}
              />
            ) : busy ? (
              <ResultSkeleton />
            ) : current ? (
              <ResultCard
                entry={current}
                onDelete={handleDelete}
                onRetranslate={handleRetranslate}
                toast={toast}
                busy={busy}
              />
            ) : (
              <div className="empty">
                <div>
                  <div className="glyph" style={{ margin: "0 auto var(--space-4)" }}>
                    <ScanLine size={26} />
                  </div>
                  <h2>截图，即得译文</h2>
                  <p>按下快捷键框选论文、文档或网页，译文会带着公式排版出现在这里，并自动归档。</p>
                  <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center" }}>
                    <button className="btn btn-primary" onClick={capture}>
                      <Camera size={15} />
                      截图翻译
                    </button>
                    <Kbd keys={["Ctrl", "Alt", "S"]} />
                  </div>
                  {!inTauri ? (
                    <p style={{ marginTop: 14, fontSize: 12 }}>浏览器预览模式：点击按钮会生成一条示例译文。</p>
                  ) : null}
                </div>
              </div>
            )
          ) : null}

          {tab === "archive" ? (
            <Archive entries={entries} onDelete={handleDelete} />
          ) : null}

          {tab === "settings" ? (
            <Settings
              config={config}
              onSave={handleSave}
              onTest={testConnection}
              onThemePreview={(t) => setConfig((c) => (c ? { ...c, theme: t } : c))}
              toast={toast}
            />
          ) : null}
        </div>
      </main>

      <Toasts items={toasts} onDismiss={dismiss} />
    </div>
  );
}
