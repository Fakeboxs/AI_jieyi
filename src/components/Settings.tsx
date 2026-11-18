import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Info, Moon, Plug, Save, Sun, Monitor } from "lucide-react";
import type { Config, Provider } from "../types";
import { listMonitors } from "../lib/bridge";
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
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => setDraft(config), [config]);

  useEffect(() => {
    listMonitors()
      .then((list) => setMonitors(list))
      .catch(() => setMonitors([]));
  }, []);

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
