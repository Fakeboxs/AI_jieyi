import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Info, Moon, Plug, Save, Sun, Monitor } from "lucide-react";
import type { Config, Provider } from "../types";
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
};

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
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => setDraft(config), [config]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(config), [draft, config]);

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

        <div className="field">
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

        <div className="field">
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

        <div className="field">
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

      <Section title="翻译偏好" desc="提示词决定了译文风格、是否保留公式与段落结构">
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

      <Section title="快捷键与数据" desc="快捷键在任意应用内生效">
        <div className="hint-strip">
          <span>截图翻译</span>
          <span className="kbd">
            <kbd>Ctrl</kbd>
            <kbd>Alt</kbd>
            <kbd>S</kbd>
          </span>
          <span style={{ marginLeft: 8 }}>Esc 取消选区</span>
        </div>
        <div className="banner">
          <Info size={14} />
          <span>归档存放在应用数据目录的 jieyi.db 与 images/ 下，可以直接备份或迁移旧版 history.db。</span>
        </div>
      </Section>

      <div className="settings-foot">
        <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
          <Save size={14} />
          {saving ? "保存中…" : dirty ? "保存设置" : "已保存"}
        </button>
        {dirty ? <span className="status">有未保存的修改</span> : null}
      </div>
    </div>
  );
}
