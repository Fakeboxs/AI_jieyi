import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import type { Entry } from "../types";
import { groupEntries } from "../lib/time";
import { EntryPreview } from "./Reader";

export function Archive({ entries, onDelete }: { entries: Entry[]; onDelete: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);

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
          <button className="btn btn-ghost btn-icon" style={{ height: 24, width: 24 }} onClick={() => setQuery("")} aria-label="清空搜索">
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

      {groups.length === 0 ? (
        <div className="empty" style={{ minHeight: "38vh" }}>
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
                <EntryPreview key={e.id} entry={e} onDelete={onDelete} />
              ))}
            </div>
          </div>
        ))
      )}

      {entries.length > 0 ? (
        <p className="hint-strip" style={{ marginTop: 4 }}>
          共 {entries.length} 条 · 展开任意一条可以复制或删除
        </p>
      ) : null}
    </div>
  );
}
