export function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hh}:${mm}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hh}:${mm}`;
}

export function relative(iso: string) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return fmtTime(iso);
}

export function groupKey(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "今天";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "昨天";
  if (now.getTime() - d.getTime() < 1000 * 60 * 60 * 24 * 7) return "本周";
  return "更早";
}

export function groupEntries<T extends { timestamp: string }>(items: T[]) {
  const order = ["今天", "昨天", "本周", "更早"];
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = groupKey(it.timestamp);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(it);
  }
  return order.filter((k) => map.has(k)).map((k) => ({ label: k, items: map.get(k)! }));
}
