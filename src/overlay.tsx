import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { cancelOverlay, getShot, inTauri, translateRegions } from "./lib/bridge";
import type { Rect } from "./types";
import "./styles/app.css";

const DEMO = new URLSearchParams(window.location.search).has("demo");

export default function Overlay() {
  const [src, setSrc] = useState("");
  const [shotSize, setShotSize] = useState<{ width: number; height: number } | null>(null);
  const [regions, setRegions] = useState<Rect[]>([]);
  // true while the only region is the remembered one from the last capture
  const [ghost, setGhost] = useState(false);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [vw, setVw] = useState(window.innerWidth);
  const [vh, setVh] = useState(window.innerHeight);

  useEffect(() => {
    const onResize = () => {
      setVw(window.innerWidth);
      setVh(window.innerHeight);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Drag state must never re-trigger the screenshot load: reading the frozen
  // frame again on every pointermove stalls the webview. Refs keep the keyboard
  // handler stable while still seeing the latest drag.
  const draftRef = useRef<Rect | null>(null);
  const regionsRef = useRef<Rect[]>([]);
  const busyRef = useRef(false);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    regionsRef.current = regions;
  }, [regions]);

  const submit = useCallback(async (all: Rect[]) => {
    if (!all.length || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (inTauri) {
        await translateRegions(all);
      } else {
        await new Promise((r) => setTimeout(r, 600));
        busyRef.current = false;
        setBusy(false);
      }
    } catch {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      const s = await getShot();
      busyRef.current = false;
      setDraft(null);
      setBusy(false);
      if (s) {
        setSrc(s.data_url);
        setShotSize({ width: s.width, height: s.height });
        // pre-select the previous rectangle on this monitor
        const prev = s.last_region;
        setRegions(
          prev ? [{ x: prev[0], y: prev[1], w: prev[2], h: prev[3] }] : [],
        );
        setGhost(Boolean(prev));
      }
    };
    void load();

    let offRefresh = () => {};
    if (inTauri) {
      import("@tauri-apps/api/event")
        .then(({ listen }) => listen("shot:refresh", () => void load()))
        .then((fn) => (offRefresh = fn));
    }
    return () => offRefresh();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void cancelOverlay();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const d = draftRef.current;
        const all = d ? [...regionsRef.current, d] : regionsRef.current;
        if (!all.length) return;
        setDraft(null);
        setRegions(all);
        void submit(all);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        setRegions((cur) => cur.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submit]);

  function clamp(v: number, max: number) {
    return Math.max(0, Math.min(v, max));
  }

  // Track the drag on window so it survives fast pointer moves and focus quirks
  // inside the WebView2 overlay (element-level capture is unreliable there).
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const s = start.current;
      if (!s) return;
      e.preventDefault();
      const x = clamp(Math.min(s.x, e.clientX), window.innerWidth);
      const y = clamp(Math.min(s.y, e.clientY), window.innerHeight);
      const w = Math.min(Math.abs(e.clientX - s.x), window.innerWidth - x);
      const h = Math.min(Math.abs(e.clientY - s.y), window.innerHeight - y);
      setDraft({ x, y, w, h });
    };
    const up = () => {
      if (!start.current) return;
      start.current = null;
      setDraft((d) => {
        if (!d) return null;
        if (d.w < 8 || d.h < 8) return null;
        // each drag adds a region; Enter sends them all
        setRegions((cur) => [...cur, d]);
        return null;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  function onPointerDown(e: React.PointerEvent) {
    if (busy || e.button !== 0) return;
    // A new drag replaces the remembered rectangle instead of stacking on it.
    if (ghost) {
      setRegions([]);
      setGhost(false);
    }
    start.current = { x: e.clientX, y: e.clientY };
    setDraft({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
  }

  const all: Rect[] = draft ? [...regions, draft] : regions;

  return (
    <div
      className="overlay-root"
      onPointerDown={onPointerDown}
      onDoubleClick={() => void submit(regions)}
    >
      {src ? (
        <img className="overlay-shot" src={src} alt="" draggable={false} />
      ) : DEMO ? (
        <DemoPage />
      ) : (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#9fd8d0" }}>
          <div style={{ textAlign: "center" }}>
            <div className="spinner" style={{ margin: "0 auto 10px" }} />
            正在抓取屏幕…
          </div>
        </div>
      )}

      <svg className="overlay-mask-svg" width={vw} height={vh} aria-hidden>
        <defs>
          <mask id="cut">
            <rect x={0} y={0} width={vw} height={vh} fill="white" />
            {all.map((r, i) => (
              <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill="black" />
            ))}
          </mask>
        </defs>
        <rect x={0} y={0} width={vw} height={vh} fill="rgba(3,16,18,0.55)" mask="url(#cut)" />
      </svg>

      {all.map((r, i) => (
        <div
          key={i}
          className={[
            "overlay-sel",
            i === all.length - 1 && draft ? "is-draft" : "",
            ghost && !draft ? "is-ghost" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          data-size={`${Math.round(r.w)} × ${Math.round(r.h)}`}
          style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
        >
          <span className="overlay-idx">{i + 1}</span>
        </div>
      ))}

      {/* stopPropagation: clicking a control must not start a new selection */}
      <div className="overlay-tips" onPointerDown={(e) => e.stopPropagation()}>
        {busy ? (
          <>
            <span className="spinner" />
            正在翻译选中的 {regions.length} 块区域…
          </>
        ) : (
          <>
            <span className="overlay-hint">拖动框选，可连续框多块</span>
            <button
              className="btn btn-primary overlay-btn"
              disabled={regions.length === 0}
              onClick={() => void submit(regions)}
            >
              翻译{regions.length > 0 ? ` ${regions.length} 块` : ""}
            </button>
            <button className="btn btn-ghost overlay-btn" onClick={() => void cancelOverlay()}>
              取消
            </button>
            <button
              className="btn btn-ghost overlay-btn"
              disabled={regions.length === 0}
              onClick={() => setRegions((cur) => cur.slice(0, -1))}
            >
              撤销
            </button>
            <span className="overlay-keys">
              <kbd>Enter</kbd> 翻译 · <kbd>Backspace</kbd> 撤销 · <kbd>Esc</kbd> 取消
            </span>
            {shotSize ? <span className="overlay-size">{`${shotSize.width} × ${shotSize.height}`}</span> : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Fake paper page so the selection UI can be previewed in a browser. */
function DemoPage() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "#f7f5ef",
        padding: "56px 96px",
        display: "grid",
        gap: 14,
        alignContent: "start",
        color: "#2b2b2b",
        fontFamily: "Georgia, serif",
        overflow: "hidden",
      }}
    >
      <div style={{ fontSize: 26, fontWeight: 600, marginBottom: 6 }}>Saddle-point approximation</div>
      <div style={{ fontSize: 14, color: "#666" }}>Phys. Rev. E — section 3.2</div>
      {Array.from({ length: 14 }).map((_, i) => (
        <div
          key={i}
          style={{ height: 12, width: `${92 - ((i * 7) % 26)}%`, borderRadius: 3, background: "#ded9cc" }}
        />
      ))}
      <div
        style={{
          margin: "10px 0",
          padding: "18px 24px",
          background: "#fff",
          border: "1px solid #e6e1d4",
          textAlign: "center",
          fontSize: 18,
        }}
      >
        Z ≈ e<sup>S(f*)</sup> / √(2π det(−H))
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Overlay />);
