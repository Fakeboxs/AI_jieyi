import { useMemo, useState } from "react";
import { CheckSquare, Search, Square, Trash2, X } from "lucide-react";
import type { Entry } from "../types";
import { groupEntries } from "../lib/time";
import { EntryPreview } from "./Reader";
import { Confirm } from "./ui";

export function Archive({
  entries,
  onDelete,
  onDeleteMany,
  onClear,
  toast,
}: {
  entries: Entry[];
  onDelete: (id: string) => void;
  onDeleteMany: (ids: string[]) => Promise<void>;
  onClear: () => Promise<void>;
  toast: (text: string, tone?: "default" | "error") => void;
}) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<null | { kind: "picked" | "all"; count: number }>(null);
  const [busy, setBusy] = useState(false);

  const tags = useMemo(() => {
    const set = new Map<string, number>();
    for (const e of entries) for (const t of e.tags) set.set(t, (set.get(t) ?? 0) + 1);
    return [...set.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .filter((e) => (tag ? e.tags.includes(tag) : true))
      .filter((e) =>
        q
          ? e.markdown.toLowerCase().includes(q) ||
            e.model.toLowerCase().includes(q) ||
            e.tags.some((t) => t.toLowerCase().includes(q))
          : true,
      )
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [entries, query, tag]);

  const groups = groupEntries(filtered);
  const visibleIds = filtered.map((e) => e.id);
  const allPicked = visibleIds.length > 0 && visibleIds.every((id) => picked.has(id));

  function toggle(id: string) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setPicked((cur) => {
      if (allPicked) {
        const next = new Set(cur);
        visibleIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...cur, ...visibleIds]);
    });
  }

  async function runConfirm() {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "all") {
        await onClear();
        setPicked(new Set());
        toast("归档已清空");
      } else {
        const ids = [...picked];
        await onDeleteMany(ids);
        setPicked(new Set());
        toast(`已删除 ${ids.length} 条记录`);
      }
      setConfirm(null);
    } catch (e) {
      toast(`操作失败：${String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="archive-layout">
      <div className="search">
        <Search size={15} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索译文、模型或标签…"
          aria-label="搜索归档"
        />
        {query ? (
          <button
            className="btn btn-ghost btn-icon"
            style={{ height: 24, width: 24 }}
            onClick={() => setQuery("")}
            aria-label="清空搜索"
          >
            <X size={13} />
          </button>
        ) : null}
      </div>

      {tags.length ? (
        <div className="filters">
          <span style={{ fontSize: 11.5, color: "var(--muted-fg)" }}>标签</span>
          <button className="chip" data-active={tag === null} onClick={() => setTag(null)}>
            全部 {entries.length}
          </button>
          {tags.map(([t, n]) => (
            <button key={t} className="chip" data-active={tag === t} onClick={() => setTag(tag === t ? null : t)}>
              {t} {n}
            </button>
          ))}
        </div>
      ) : null}

      {entries.length > 0 ? (
        <div className="bulk-bar">
          <button className="btn btn-soft" onClick={toggleAll} disabled={visibleIds.length === 0}>
            {allPicked ? <CheckSquare size={14} /> : <Square size={14} />}
            {allPicked ? "取消全选" : visibleIds.length !== entries.length ? "全选筛选结果" : "全选"}
          </button>
          <span className="bulk-count">{picked.size > 0 ? `已选 ${picked.size} 条` : `共 ${entries.length} 条`}</span>
          <div className="bulk-actions">
            <button
              className="btn btn-ghost"
              disabled={picked.size === 0}
              onClick={() => setConfirm({ kind: "picked", count: picked.size })}
            >
              <Trash2 size={14} />
              删除选中
            </button>
            <button className="btn btn-ghost bulk-danger" onClick={() => setConfirm({ kind: "all", count: entries.length })}>
              <Trash2 size={14} />
              清空全部
            </button>
          </div>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <div className="empty" style={{ minHeight: "34vh" }}>
          <div>
            <h2 style={{ fontSize: 16 }}>{query || tag ? "没有匹配的记录" : "归档还是空的"}</h2>
            <p>按下截图快捷键翻译一次，结果会自动出现在这里。</p>
          </div>
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.label}>
            <div className="group-label">
              {g.label} · {g.items.length}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {g.items.map((e) => (
                <EntryPreview
                  key={e.id}
                  entry={e}
                  onDelete={onDelete}
                  selected={picked.has(e.id)}
                  onToggle={() => toggle(e.id)}
                />
              ))}
            </div>
          </div>
        ))
      )}

      <Confirm
        open={confirm !== null}
        busy={busy}
        title={confirm?.kind === "all" ? "清空整个归档？" : `删除 ${confirm?.count ?? 0} 条记录？`}
        body={
          confirm?.kind === "all"
            ? `会删除 ${confirm?.count ?? 0} 条记录及其截图文件，无法撤销。`
            : "会删除选中的记录及其截图文件，无法撤销。"
        }
        confirmLabel={confirm?.kind === "all" ? "清空全部" : "删除"}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void runConfirm()}
      />
    </div>
  );
}
