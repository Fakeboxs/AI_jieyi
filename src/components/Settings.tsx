import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Info, Moon, Plug, Save, Sun, Monitor } from "lucide-react";
import type { Config, Provider } from "../types";
import {
  deletePack,
  downloadPack,
  hotkeyStatus,
  reregisterHotkeys,
  type HotkeyStatus,
  listMonitors,
  offlineLanguages,
  localStatus,
  offlineStatus,
  onOfflineEngine,
  onOfflineProgress,
  startLocalEngine,
  stopLocalEngine,
  type LocalStatus,
  type OfflineEngineState,
  type PackInfo,
} from "../lib/bridge";
import { Section } from "./ui";

const PRESETS: Record<Provider, { label: string; base: string; model: string; hint: string }> = {
  openai: {
    label: "OpenAI 兼容",
    base: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    hint: "任何 OpenAI 兼容网关都可以：SiliconFlow、DashScope 兼容模式、本地 vLLM / Xinference…",
  },
  anthropic: {
    label: "Anthropic",
    base: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    hint: "使用 /v1/messages 协议，需要支持图片输入的 Claude 模型。",
  },
  gemini: {
    label: "Gemini",
    base: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
    hint: "Key 以 query 参数传递，base_url 填到 /v1beta 为止。",
  },
  custom: {
    label: "自定义端点",
    base: "http://127.0.0.1:8080/v1",
    model: "local-vlm",
    hint: "自定义端点按 OpenAI 兼容格式发送，适合自建服务或反向代理。",
  },
  local: {
    label: "本地离线",
    base: "",
    model: "local",
    hint: "在这台电脑上跑开源模型：先下载资源包，之后断网也能翻译。首次使用会自动加载模型（几秒到十几秒）。",
  },
  advanced: {
    label: "高级模板",
    base: "",
    model: "",
    hint: "自己写 endpoint / headers / body，用 {{model}}、{{prompt_json}}、{{images}} 等占位符拼装请求。",
  },
};

const ADVANCED_BODY_EXAMPLE = `{
  "model": {{model_json}},
  "max_tokens": {{max_tokens}},
  "temperature": {{temperature}},
  "messages": [
    {
      "role": "user",
      "content": [
        {{image_parts}},
        { "type": "text", "text": {{prompt_json}} }
      ]
    }
  ]
}`;

export function Settings({
  config,
  onSave,
  onTest,
  onThemePreview,
  toast,
}: {
  config: Config;
  onSave: (c: Config) => Promise<void>;
  onTest: (c: Config) => Promise<{ ok: boolean; message: string }>;
  onThemePreview: (t: Config["theme"]) => void;
  toast: (text: string, tone?: "default" | "error") => void;
}) {
  const [draft, setDraft] = useState<Config>(config);
  const [showKey, setShowKey] = useState(false);
  const [monitors, setMonitors] = useState<{ index: number; name: string; width: number; height: number }[]>([]);
  const [hk, setHk] = useState<HotkeyStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => setDraft(config), [config]);

  useEffect(() => {
    hotkeyStatus().then(setHk).catch(() => setHk(null));
  }, []);

  useEffect(() => {
    listMonitors()
      .then((list) => setMonitors(list))
      .catch(() => setMonitors([]));
  }, []);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(config), [draft, config]);
  const hotkeyConflict =
    draft.hotkey_capture.trim().toLowerCase() === draft.hotkey_repeat.trim().toLowerCase();

  function patch(p: Partial<Config>) {
    setDraft((d) => ({ ...d, ...p }));
  }

  function switchProvider(p: Provider) {
    const preset = PRESETS[p];
    setDraft((d) => ({
      ...d,
      provider: p,
      base_url: d.base_url && d.provider === p ? d.base_url : preset.base,
      model: d.model && d.provider === p ? d.model : preset.model,
    }));
    setTestMsg(null);
  }

  async function save() {
    if (hotkeyConflict) {
      toast("两个功能不能绑定同一个快捷键", "error");
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      toast("设置已保存");
    } catch (e) {
      toast(`保存失败：${String(e)}`, "error");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await onTest(draft);
      setTestMsg(r);
      toast(r.ok ? "连接测试通过" : "连接测试失败", r.ok ? "default" : "error");
    } finally {
      setTesting(false);
    }
  }

  const preset = PRESETS[draft.provider];

  return (
    <div className="settings">
      <Section title="模型服务" desc="截图会以图片形式发送给这里配置的视觉模型">
        <div className="field">
          <label>服务商</label>
          <div className="segmented" role="group" aria-label="服务商">
            {(Object.keys(PRESETS) as Provider[]).map((p) => (
              <button key={p} aria-pressed={draft.provider === p} onClick={() => switchProvider(p)}>
                {PRESETS[p].label}
              </button>
            ))}
          </div>
          <span className="hint">{preset.hint}</span>
        </div>

        {draft.provider === "local" ? (
          <OfflinePanel draft={draft} patch={patch} toast={toast} />
        ) : null}

        <div className="field" style={draft.provider === "local" ? { display: "none" } : undefined}>
          <label htmlFor="base-url">API 基础地址</label>
          <input
            id="base-url"
            className="input"
            value={draft.base_url}
            onChange={(e) => patch({ base_url: e.target.value })}
            placeholder={preset.base}
            spellCheck={false}
          />
        </div>

        <div className="field" style={draft.provider === "local" ? { display: "none" } : undefined}>
          <label htmlFor="api-key">API Key</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              id="api-key"
              className="input"
              type={showKey ? "text" : "password"}
              value={draft.api_key}
              onChange={(e) => patch({ api_key: e.target.value })}
              placeholder="sk-…"
              spellCheck={false}
              autoComplete="off"
            />
            <button className="btn btn-icon" onClick={() => setShowKey((v) => !v)} aria-label={showKey ? "隐藏密钥" : "显示密钥"} title={showKey ? "隐藏" : "显示"}>
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <span className="hint">密钥只保存在本机的配置文件里，不会上传到任何第三方。</span>
        </div>

        <div className="field" style={draft.provider === "local" ? { display: "none" } : undefined}>
          <label htmlFor="model">模型名称</label>
          <input
            id="model"
            className="input"
            value={draft.model}
            onChange={(e) => patch({ model: e.target.value })}
            placeholder={preset.model}
            spellCheck={false}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="btn" onClick={test} disabled={testing}>
            <Plug size={14} />
            {testing ? "测试中…" : "测试连接"}
          </button>
          {testMsg ? (
            <span style={{ fontSize: 12, color: testMsg.ok ? "var(--primary-ink)" : "var(--danger)" }}>{testMsg.message}</span>
          ) : null}
        </div>
      </Section>

      {draft.provider === "advanced" ? (
        <Section
          title="高级 API 模板"
          desc="占位符：{{api_key}} {{model}} {{model_json}} {{prompt}} {{prompt_json}} {{max_tokens}} {{temperature}} {{stream}} {{image_parts}} {{images}} {{image_data}} {{image_count}}"
          actions={
            <button
              className="btn btn-ghost"
              onClick={() =>
                patch({ advanced: { ...draft.advanced, body: ADVANCED_BODY_EXAMPLE } })
              }
            >
              填入示例
            </button>
          }
        >
          <div className="field">
            <label htmlFor="adv-endpoint">Endpoint</label>
            <input
              id="adv-endpoint"
              className="input"
              value={draft.advanced.endpoint}
              onChange={(e) => patch({ advanced: { ...draft.advanced, endpoint: e.target.value } })}
              placeholder="https://api.example.com/v1/chat/completions"
              spellCheck={false}
            />
            <span className="hint">可以带占位符，例如 https://host/v1/models/{"{{model}}"}:generate</span>
          </div>

          <div className="field">
            <label>Headers</label>
            {draft.advanced.headers.map((h, i) => (
              <div className="kv-row" key={i}>
                <input
                  className="input"
                  value={h.key}
                  placeholder="Authorization"
                  spellCheck={false}
                  onChange={(e) => {
                    const headers = [...draft.advanced.headers];
                    headers[i] = { ...h, key: e.target.value };
                    patch({ advanced: { ...draft.advanced, headers } });
                  }}
                />
                <input
                  className="input"
                  value={h.value}
                  placeholder="Bearer {'{{api_key}}'}"
                  spellCheck={false}
                  onChange={(e) => {
                    const headers = [...draft.advanced.headers];
                    headers[i] = { ...h, value: e.target.value };
                    patch({ advanced: { ...draft.advanced, headers } });
                  }}
                />
                <button
                  className="btn btn-ghost btn-icon"
                  aria-label="删除该 Header"
                  onClick={() =>
                    patch({
                      advanced: {
                        ...draft.advanced,
                        headers: draft.advanced.headers.filter((_, j) => j !== i),
                      },
                    })
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className="btn btn-soft"
              style={{ width: "fit-content" }}
              onClick={() =>
                patch({
                  advanced: {
                    ...draft.advanced,
                    headers: [...draft.advanced.headers, { key: "", value: "" }],
                  },
                })
              }
            >
              + 添加 Header
            </button>
          </div>

          <div className="field">
            <label htmlFor="adv-body">请求体（JSON 模板）</label>
            <textarea
              id="adv-body"
              className="textarea"
              style={{ minHeight: 200 }}
              value={draft.advanced.body}
              placeholder={ADVANCED_BODY_EXAMPLE}
              spellCheck={false}
              onChange={(e) => patch({ advanced: { ...draft.advanced, body: e.target.value } })}
            />
            <span className="hint">
              {"{{image_parts}}"} 会展开成多个 image_url part（不含外层 [ ]），直接写在 content 数组里即可；
              {"{{images}}"} 则是图片 data URL 的数组。
            </span>
          </div>

          <div className="field">
            <label htmlFor="adv-resp">响应字段（JSON Pointer，可选）</label>
            <input
              id="adv-resp"
              className="input"
              value={draft.advanced.response_path}
              onChange={(e) => patch({ advanced: { ...draft.advanced, response_path: e.target.value } })}
              placeholder="/choices/0/message/content"
              spellCheck={false}
            />
            <span className="hint">留空时自动尝试 OpenAI / Anthropic / Gemini 的常见结构。</span>
          </div>
        </Section>
      ) : null}

      <Section
        title="翻译偏好"
        desc="提示词决定了译文风格、是否保留公式与段落结构；思考模式决定了要等多久才见到第一个字"
      >
        <div className="field">
          <label>输出方式</label>
          <div className="segmented" role="group" aria-label="输出方式">
            <button aria-pressed={draft.stream} onClick={() => patch({ stream: true })}>
              流式返回（SSE）
            </button>
            <button aria-pressed={!draft.stream} onClick={() => patch({ stream: false })}>
              一次性直出
            </button>
          </div>
          <span className="hint">
            流式：首字到达即显示，边生成边排版（推荐）；直出：等待整段完成再显示，适合不支持 SSE 的网关。
          </span>
        </div>

        <div className="field">
          <label htmlFor="prompt">系统提示词</label>
          <textarea
            id="prompt"
            className="textarea"
            value={draft.prompt}
            onChange={(e) => patch({ prompt: e.target.value })}
            spellCheck={false}
          />
          <span className="hint">建议明确要求：只输出译文、公式用 LaTeX、保留段落结构。</span>
        </div>
        <div className="field">
          <label>思考模式</label>
          <div className="segmented" role="group" aria-label="思考模式">
            {(
              [
                ["off", "关闭（最快）"],
                ["default", "服务商默认"],
                ["on", "开启"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={draft.thinking === value}
                onClick={() => patch({ thinking: value })}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="hint">
            DeepSeek 的思考模式**默认开启**（effort=high），会在输出译文前先想几秒——这就是"一百来个单词要等十秒"的主因。翻译不需要推理，选「关闭」通常能把首字压到 1 秒内；若服务商不认识该参数，改回「服务商默认」。
          </span>
        </div>
        <div className="row-2">
          <div className="field">
            <label htmlFor="max-tokens">最大输出 tokens</label>
            <input
              id="max-tokens"
              className="input"
              type="number"
              min={256}
              max={32000}
              value={draft.max_tokens}
              onChange={(e) => patch({ max_tokens: Number(e.target.value) || 2048 })}
            />
          </div>
          <div className="field">
            <label htmlFor="temperature">温度</label>
            <input
              id="temperature"
              className="input"
              type="number"
              step="0.1"
              min={0}
              max={2}
              value={draft.temperature}
              onChange={(e) => patch({ temperature: Number(e.target.value) })}
            />
          </div>
        </div>
      </Section>

      <Section title="截图" desc="决定热键截取哪块屏幕，以及是否记住上次的框选">
        <div className="field">
          <label htmlFor="capture-screen">捕获屏幕</label>
          <select
            id="capture-screen"
            className="select"
            value={draft.capture_screen}
            onChange={(e) => patch({ capture_screen: Number(e.target.value) })}
          >
            <option value={-1}>跟随鼠标所在屏幕</option>
            {monitors.map((m) => (
              <option key={m.index} value={m.index}>
                {m.name} · {m.width}×{m.height}
              </option>
            ))}
          </select>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.remember_region}
            onChange={(e) => patch({ remember_region: e.target.checked })}
          />
          记住上次框选区域（下次打开选区时自动预选，可拖动调整）
        </label>
        <div className="field">
          <label>翻译结果显示在</label>
          <div className="segmented" role="group" aria-label="结果显示位置">
            {(
              [
                ["popup", "选区旁的独立小窗"],
                ["main", "主窗口"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={draft.result_window === value}
                onClick={() => patch({ result_window: value })}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="hint">
            独立小窗是窄边、置顶的浮窗，出现在选区旁边，不会把主窗口拉到前台；按 Esc 或右上角 × 可关闭。
          </span>
        </div>
        <div className="field">
          <label htmlFor="img-edge">上传给模型的图片（长边上限）</label>
          <select
            id="img-edge"
            className="select"
            value={draft.image_max_edge}
            onChange={(e) => patch({ image_max_edge: Number(e.target.value) })}
          >
            <option value={0}>不缩放（最清晰，最慢）</option>
            <option value={1920}>1920px</option>
            <option value={1440}>1440px（推荐）</option>
            <option value={1280}>1280px</option>
            <option value={1024}>1024px（最快）</option>
          </select>
          <span className="hint">
            模型按像素计费、也按像素等待：边长减半 ≈ 图片 token 降到 1/4。文字截图 1280–1440px 仍然清晰。
          </span>
        </div>
        <div className="field">
          <label htmlFor="img-quality">JPEG 质量（{draft.image_quality}）</label>
          <input
            id="img-quality"
            type="range"
            min={60}
            max={95}
            step={1}
            value={draft.image_quality}
            onChange={(e) => patch({ image_quality: Number(e.target.value) })}
          />
          <span className="hint">只在 JPEG 比 PNG 更小时才会采用；文字截图通常仍走 PNG。</span>
        </div>
        <div className="hint-strip">
          <span>重复上次区域（不弹选区，直接翻译）</span>
          <span className="kbd">
            <kbd>Ctrl</kbd>
            <kbd>Alt</kbd>
            <kbd>D</kbd>
          </span>
        </div>
      </Section>

      <Section title="外观" desc="跟随系统，或固定为浅色 / 深色">
        <div className="segmented" role="group" aria-label="主题">
          {(
            [
              { v: "light", label: "浅色", icon: <Sun size={13} /> },
              { v: "dark", label: "深色", icon: <Moon size={13} /> },
              { v: "system", label: "跟随系统", icon: <Monitor size={13} /> },
            ] as const
          ).map((o) => (
            <button
              key={o.v}
              aria-pressed={draft.theme === o.v}
              onClick={() => {
                patch({ theme: o.v });
                onThemePreview(o.v);
              }}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              {o.icon}
              {o.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="快捷键与数据" desc="全局快捷键在任意应用内生效，点一下后按新组合即可改绑">
        <div className="field">
          <label>截图翻译</label>
          <HotkeyPicker
            ariaLabel="截图翻译快捷键"
            value={draft.hotkey_capture}
            onChange={(next) => patch({ hotkey_capture: next })}
          />
        </div>
        <div className="field">
          <label>重复上次区域</label>
          <HotkeyPicker
            ariaLabel="重复上次区域快捷键"
            value={draft.hotkey_repeat}
            onChange={(next) => patch({ hotkey_repeat: next })}
          />
        </div>
        <div className="hotkey-state">
          <span className={`chip ${hk?.capture_ok ? "is-ok" : "is-bad"}`}>
            {hk?.capture_ok ? "截图键已注册" : "截图键未注册"}
          </span>
          <span className={`chip ${hk?.repeat_ok ? "is-ok" : "is-bad"}`}>
            {hk?.repeat_ok ? "重复键已注册" : "重复键未注册"}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              const next = await reregisterHotkeys();
              setHk(next);
              toast(next?.capture_ok ? "快捷键已重新注册" : next?.error ?? "注册失败", next?.capture_ok ? "default" : "error");
            }}
          >
            重新注册
          </button>
          {hk?.error ? <span className="hint" style={{ color: "var(--danger)" }}>{hk.error}</span> : null}
        </div>

        {hotkeyConflict ? (
          <div className="banner banner-danger">
            <Info size={14} />
            <span>两个功能不能绑定同一个快捷键，换一个再保存。</span>
          </div>
        ) : (
          <span className="hint">
            组合键至少包含一个修饰键（Ctrl / Alt / Shift / Super）。保存时会真的去系统里注册一次：如果这个组合已被其它程序占用，会立刻报错并保留原来的绑定。
          </span>
        )}
        <div className="banner">
          <Info size={14} />
          <span>归档存放在应用数据目录的 jieyi.db 与 images/ 下，可以直接备份或迁移旧版 history.db。</span>
        </div>
      </Section>

      <div className="settings-foot">
        <button className="btn btn-primary" onClick={save} disabled={!dirty || saving || hotkeyConflict}>
          <Save size={14} />
          {saving ? "保存中…" : dirty ? "保存设置" : "已保存"}
        </button>
        {dirty ? <span className="status">有未保存的修改</span> : null}
      </div>
    </div>
  );
}

const KEY_LABELS: Record<string, string> = {
  Space: "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** "KeyS" -> "S", "Digit1" -> "1", "F5" -> "F5" */
function keyFromEvent(e: KeyboardEvent): string | null {
  const fromCode = keyFromCode(e.code || "");
  if (fromCode) return fromCode;
  // Synthetic input (automation, some IMEs) can arrive without a usable `code`;
  // fall back to the printed key so the binding is still recorded.
  const k = e.key || "";
  if (/^[a-zA-Z]$/.test(k)) return k.toUpperCase();
  if (/^[0-9]$/.test(k)) return k;
  if (/^F[0-9]{1,2}$/.test(k)) return k;
  if (k === " ") return "Space";
  if (k.length === 1) return k.toUpperCase();
  return null;
}

function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Num${code.slice(6)}`;
  if (/^F[0-9]{1,2}$/.test(code)) return code;
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (code === "Escape") return null;
  if (code.startsWith("Control") || code.startsWith("Alt") || code.startsWith("Shift") || code.startsWith("Meta")) {
    return null; // modifier alone is not a binding
  }
  return code || null;
}

export function HotkeyPicker({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
}) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("Ctrl");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      if (e.metaKey) mods.push("Super");
      const key = keyFromEvent(e);
      if (!key) return; // still holding only modifiers
      if (mods.length === 0) {
        // a bare letter would swallow normal typing everywhere: refuse it
        return;
      }
      onChange([...mods, key].join("+"));
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);

  const parts = value.split("+").filter(Boolean);

  return (
    <button
      type="button"
      className={recording ? "hotkey-field is-recording" : "hotkey-field"}
      onClick={() => setRecording((v) => !v)}
      aria-label={ariaLabel}
      title="点一下，然后按下想要的组合键（Esc 取消）"
    >
      {recording ? (
        <span className="hotkey-hint">按下组合键…（Esc 取消）</span>
      ) : parts.length ? (
        <span className="kbd">
          {parts.map((p, i) => (
            <kbd key={`${p}-${i}`}>{p}</kbd>
          ))}
        </span>
      ) : (
        <span className="hotkey-hint">未设置</span>
      )}
    </button>
  );
}

function human(bytes: number): string {
  if (!bytes) return "0 MB";
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** Everything about offline translation: packs, engine pick, sidecar state. */
function OfflinePanel({
  draft,
  patch,
  toast,
}: {
  draft: Config;
  patch: (p: Partial<Config>) => void;
  toast: (text: string, tone?: "default" | "error") => void;
}) {
  const [packs, setPacks] = useState<PackInfo[]>([]);
  const [progress, setProgress] = useState<Record<string, { got: number; total: number; phase: string; message: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [engine, setEngine] = useState<OfflineEngineState | null>(null);
  const [langs, setLangs] = useState<string[]>([]);
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [starting, setStarting] = useState(false);

  const reload = useCallback(async () => {
    try {
      setPacks(await offlineStatus());
    } catch {
      setPacks([]);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await localStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void reload();
    void refreshStatus();
    offlineLanguages().then(setLangs).catch(() => setLangs([]));
    const offs: (() => void)[] = [];
    let gone = false;
    onOfflineProgress((p) => {
      setProgress((cur) => ({ ...cur, [p.id]: { got: p.got, total: p.total, phase: p.phase, message: p.message } }));
      if (p.phase === "done") {
        setBusy(null);
        void reload();
      }
    }).then((fn) => (gone ? fn() : offs.push(fn)));
    onOfflineEngine((p) => {
      setEngine(p);
      if (p.state === "ready" || p.state === "error" || p.state === "stopped") {
        void refreshStatus();
      }
    }).then((fn) => (gone ? fn() : offs.push(fn)));
    return () => {
      gone = true;
      offs.forEach((fn) => fn());
    };
  }, [reload, refreshStatus]);

  async function start(id: string) {
    setBusy(id);
    try {
      await downloadPack(id);
      toast("资源包已就绪");
    } catch (e) {
      toast(`下载失败：${String(e)}`, "error");
    } finally {
      setBusy(null);
      void reload();
    }
  }

  async function boot() {
    setStarting(true);
    try {
      const r = await startLocalEngine();
      setStatus(r);
      toast(r.port ? `本地服务已启动（端口 ${r.port}）` : "本地服务已启动");
    } catch (e) {
      toast(`启动失败：${String(e)}`, "error");
    } finally {
      setStarting(false);
      void refreshStatus();
      void reload();
    }
  }

  async function shutdown() {
    await stopLocalEngine();
    setEngine({ state: "stopped" });
    void refreshStatus();
    toast("本地服务已停止，内存/显存已释放");
  }

  async function remove(id: string) {
    try {
      await deletePack(id);
      toast("已删除资源包");
    } catch (e) {
      toast(`删除失败：${String(e)}`, "error");
    }
    void reload();
  }

  const engineLabel = { loading: "正在加载模型…", ready: "本地模型已就绪", error: "本地模型出错", stopped: "本地模型已卸载" };

  return (
    <div className="offline-panel">
      <div className="field">
        <label>离线引擎</label>
        <div className="segmented">
          <button aria-pressed={draft.offline_engine !== "ocr"} onClick={() => patch({ offline_engine: "vlm" })}>
            视觉模型（推荐）
          </button>
          <button aria-pressed={draft.offline_engine === "ocr"} onClick={() => patch({ offline_engine: "ocr" })}>
            轻量 OCR
          </button>
        </div>
        <span className="hint">
          {draft.offline_engine === "ocr"
            ? "先用 Windows 自带 OCR 认字，再交给小模型翻译：CPU 也能跑，但公式、表格、上下标会丢。"
            : "视觉模型直接看图翻译，公式与排版保留得最好；需要下载约 2.8 GB。"}
        </span>
      </div>

      <div className="field">
        <label>资源包</label>
        {packs.map((p) => {
          const prog = progress[p.id];
          const active = busy === p.id || (prog && prog.phase !== "done");
          const pct = prog && prog.total > 0 ? Math.min(100, Math.round((prog.got / prog.total) * 100)) : 0;
          return (
            <div className="pack-row" key={p.id}>
              <div className="pack-main">
                <div className="pack-title">
                  {p.title}
                  <span className="pack-size">{human(p.bytes)}</span>
                  {p.installed ? <span className="pack-badge ok">已就绪</span> : null}
                </div>
                <div className="pack-desc">{p.desc}</div>
                {active ? (
                  <>
                    <div className="pack-bar">
                      <span style={{ width: `${prog?.phase === "extract" ? 100 : pct}%` }} />
                    </div>
                    <div className="pack-status">
                      {prog?.phase === "extract" ? "正在解压…" : `${pct}% · ${human(prog?.got ?? 0)} / ${human(prog?.total ?? p.bytes)}`}
                    </div>
                  </>
                ) : null}
              </div>
              <div className="pack-actions">
                {p.installed ? (
                  <button className="btn btn-ghost" onClick={() => void remove(p.id)} disabled={Boolean(busy)}>
                    删除
                  </button>
                ) : (
                  <button className="btn btn-primary" onClick={() => void start(p.id)} disabled={Boolean(busy)}>
                    {busy === p.id ? "下载中…" : "下载"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <span className="hint">
          下载完成后文件在 <code>%APPDATA%\app.jieyi.desktop\models</code>，之后完全不需要联网；也可以把整个 models 目录拷到另一台机器直接用。
        </span>
      </div>

      <div className="field">
        <label>本地服务</label>
        <div className="pack-row">
          <div className="pack-main">
            <div className="pack-status">
              {starting
                ? "正在下载 / 部署 / 加载，稍等…"
                : status?.running
                  ? `运行中 · 端口 ${status.port ?? "?"} · ${status.engine === "ocr" ? "轻量 OCR" : "视觉模型"}`
                  : engine
                    ? `${engineLabel[engine.state]}${engine.message ? ` · ${engine.message}` : ""}`
                    : status?.ready === false
                      ? `未启动 · 还需下载 ${human(status.missing_bytes)}`
                      : "未启动（点右侧按钮即可，缺什么会自动下载）"}
            </div>
            {draft.offline_engine === "ocr" ? (
              <div className="pack-desc">
                系统 OCR 语言：{langs.length ? langs.join("、") : "未检测到"}
                {langs.length && !langs.some((l) => l.toLowerCase().startsWith("en")) ? (
                  <span style={{ color: "var(--danger)", display: "block", marginTop: 4 }}>
                    没有英文 OCR 模型：中文 OCR 认英文会出现「iguration」「乙过」这类乱码。请到 Windows 设置 → 时间和语言 → 语言 → 添加「English (United States)」→ 可选功能里勾选 OCR，装完重启本应用。
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="pack-actions">
            {status?.running ? (
              <button className="btn btn-ghost" onClick={() => void shutdown()} disabled={starting}>
                停止本地服务
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void boot()} disabled={starting}>
                {starting ? "启动中…" : status?.ready === false ? "启动（自动下载）" : "启动本地服务"}
              </button>
            )}
          </div>
        </div>
        <span className="hint">
          点「启动」时如果模型或运行时还没下载，会先自动下载并解压（视觉包约 2.8 GB），装好立刻启动；关闭或强杀本应用时，本地服务会一起退出（Windows 作业对象），不会在后台占内存。翻译时若还没启动也会自动拉起。
        </span>
      </div>
    </div>
  );
}
