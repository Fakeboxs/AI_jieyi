import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { cancelOverlay, getShot, inTauri, translateRegion } from "./lib/bridge";
import "./styles/app.css";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEMO = new URLSearchParams(window.location.search).has("demo");

export default function Overlay() {
  const [shot, setShot] = useState<{ width: number; height: number } | null>(null);
  const [src, setSrc] = useState<string>("");
  const [rect, setRect] = useState<Rect | null>(null);
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

  useEffect(() => {
    const load = async () => {
      const s = await getShot();
      setRect(null);
      setBusy(false);
      if (s) {
        setSrc(s.data_url);
        setShot({ width: s.width, height: s.height });
      }
    };
    void load();

    let offRefresh = () => {};
    if (inTauri) {
      import("@tauri-apps/api/event")
        .then(({ listen }) => listen("shot:refresh", () => void load()))
        .then((fn) => (offRefresh = fn));
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void cancelOverlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      offRefresh();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  function clamp(v: number, max: number) {
    return Math.max(0, Math.min(v, max));
  }

  function onPointerDown(e: React.PointerEvent) {
    if (busy) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY };
    setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = start.current;
    if (!s) return;
    const x = clamp(Math.min(s.x, e.clientX), vw);
    const y = clamp(Math.min(s.y, e.clientY), vh);
    const w = Math.min(Math.abs(e.clientX - s.x), vw - x);
    const h = Math.min(Math.abs(e.clientY - s.y), vh - y);
    setRect({ x, y, w, h });
  }

  async function onPointerUp() {
    const s = start.current;
    start.current = null;
    if (!s || !rect) return;
    if (rect.w < 8 || rect.h < 8) {
      setRect(null);
      return;
    }
    setBusy(true);
    try {
      if (inTauri) {
        await translateRegion({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
      } else {
        await new Promise((r) => setTimeout(r, 600));
      }
    } finally {
      setBusy(false);
    }
  }

  const maskTop = rect ? { top: 0, left: 0, width: "100%", height: rect.y } : null;
  const maskBottom = rect ? { top: rect.y + rect.h, left: 0, width: "100%", height: Math.max(0, vh - rect.y - rect.h) } : null;
  const maskLeft = rect ? { top: rect.y, left: 0, width: rect.x, height: rect.h } : null;
  const maskRight = rect ? { top: rect.y, left: rect.x + rect.w, width: Math.max(0, vw - rect.x - rect.w), height: rect.h } : null;

  return (
    <div
      className="overlay-root"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
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

      {rect ? (
        <>
          {maskTop ? <div className="overlay-mask" style={maskTop} /> : null}
          {maskBottom ? <div className="overlay-mask" style={maskBottom} /> : null}
          {maskLeft ? <div className="overlay-mask" style={maskLeft} /> : null}
          {maskRight ? <div className="overlay-mask" style={maskRight} /> : null}
          <div
            className="overlay-sel"
            data-size={`${Math.round(rect.w)} × ${Math.round(rect.h)}`}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
          />
        </>
      ) : (
        <div className="overlay-mask" style={{ inset: 0 }} />
      )}

      <div className="overlay-tips">
        {busy ? (
          <>
            <span className="spinner" />
            正在翻译选中的区域…
          </>
        ) : (
          <>
            <span>拖动框选要翻译的区域</span>
            <span>
              <kbd>Esc</kbd> 取消
            </span>
            {shot ? <span>{`${shot.width} × ${shot.height}`}</span> : null}
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Overlay />);

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
          style={{
            height: 12,
            width: `${92 - ((i * 7) % 26)}%`,
            borderRadius: 3,
            background: "#ded9cc",
          }}
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
