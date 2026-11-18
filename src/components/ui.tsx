import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, X } from "lucide-react";
import { copyText } from "../lib/bridge";

export function Kbd({ keys }: { keys: string[] }) {
  return (
    <span className="kbd">
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden />;
}

export interface ToastItem {
  id: number;
  text: string;
  tone?: "default" | "error";
}

export function Toasts({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      {items.map((t) => (
        <ToastBubble key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastBubble({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), 2600);
    return () => clearTimeout(timer);
  }, [item.id, onDismiss]);
  return (
    <div className="toast" data-tone={item.tone ?? "default"}>
      {item.tone === "error" ? <X size={13} /> : <Check size={13} />}
      <span>{item.text}</span>
    </div>
  );
}

export function CopyButton({
  text,
  label = "复制译文",
  plain = false,
  className = "btn btn-primary",
  onDone,
  disabled,
}: {
  text: string;
  label?: string;
  plain?: boolean;
  className?: string;
  onDone?: (ok: boolean) => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function handle(e: React.MouseEvent) {
    e.stopPropagation();
    const ok = await copyText(text);
    setState(ok ? "done" : "fail");
    onDone?.(ok);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1500);
  }

  const Icon = state === "done" ? Check : Copy;
  const text2 = state === "done" ? "已复制" : state === "fail" ? "复制失败" : label;

  return (
    <button
      type="button"
      className={`${className}${state === "done" ? " is-success" : ""}`}
      onClick={handle}
      disabled={disabled || !text}
      aria-label={plain ? `${label}（纯文本）` : label}
      title={plain ? `${label}（纯文本）` : label}
    >
      <Icon size={14} />
      <span>{text2}</span>
    </button>
  );
}

export function Section({
  title,
  desc,
  children,
  actions,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card section">
      <header>
        <div>
          <h3>{title}</h3>
          {desc ? <p>{desc}</p> : null}
        </div>
        {actions ? <div style={{ marginLeft: "auto" }}>{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** Small in-app confirmation dialog: used for destructive archive actions. */
export function Confirm({
  open,
  title,
  body,
  confirmLabel = "确定",
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {body ? <p>{body}</p> : null}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
