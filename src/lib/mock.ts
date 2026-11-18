import type { Config, Entry } from "../types";

export const MOCK_CONFIG: Config = {
  provider: "openai",
  base_url: "https://api.siliconflow.cn/v1",
  api_key: "",
  model: "Qwen/Qwen2.5-VL-72B-Instruct",
  prompt: `# 角色
你是专业的学术翻译，擅长中英互译，并能精确处理数学、物理领域的 LaTeX 公式。

# 任务
把图片中的英文内容翻译为中文。

# 要求
1. 只输出译文，不要开场白或解释。
2. 数学变量、常数、公式必须使用 LaTeX（$x$ 或 $$E=mc^2$$）。
3. 保持原文段落结构与术语严谨。`,
  max_tokens: 2048,
  temperature: 0.2,
  theme: "system",
  stream: true,
  capture_screen: -1,
  remember_region: true,
  result_window: "popup",
  advanced: { endpoint: "", headers: [], body: "", response_path: "" },
};

const now = Date.now();

export const MOCK_ENTRIES: Entry[] = [
  {
    id: "demo-1",
    timestamp: new Date(now - 1000 * 60 * 6).toISOString(),
    provider: "openai",
    model: "Qwen/Qwen2.5-VL-72B-Instruct",
    elapsed_ms: 2318,
    image_count: 1,
    images: [],
    tags: ["paper", "统计物理"],
    prompt: MOCK_CONFIG.prompt,
    markdown: `## 鞍点法近似

在最后一步我们应用了鞍点法 [50, 51]。构型熵 $\\Sigma$ 表示总状态数的对数；在具有 $f^{*}$（对配分函数 $Z$ 贡献最大）的状态处，配分函数可写为

$$Z \\approx \\frac{e^{S(f^{*})}}{\\sqrt{2\\pi\\,\\det(-H)}}$$

其中 $H = \\nabla^{2} S(f^{*})$ 是 Hessian 矩阵。**关键条件是** $f^{*}$ 为熵的极大值点，且 $\\det(-H) > 0$。

| 符号 | 含义 |
| --- | --- |
| $S$ | 构型熵 |
| $H$ | 熵的 Hessian |
| $Z$ | 配分函数 |`,
  },
  {
    id: "demo-2",
    timestamp: new Date(now - 1000 * 60 * 52).toISOString(),
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    elapsed_ms: 1840,
    image_count: 2,
    images: [],
    tags: ["code"],
    prompt: MOCK_CONFIG.prompt,
    markdown: `### 读取配置

请使用环境变量覆盖默认值，避免把密钥写进仓库：

\`\`\`python
import os
from dataclasses import dataclass

@dataclass
class Settings:
    base_url: str = os.getenv("API_BASE_URL", "https://api.openai.com/v1")
    model: str = os.getenv("MODEL", "gpt-4o-mini")

    def headers(self, key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {key}"}
\`\`\`

> 注意：`+"`"+`base_url`+"`"+` 结尾不要带多余的斜杠。`,
  },
  {
    id: "demo-3",
    timestamp: new Date(now - 1000 * 60 * 60 * 26).toISOString(),
    provider: "openai",
    model: "Qwen/Qwen2.5-VL-72B-Instruct",
    elapsed_ms: 3120,
    image_count: 1,
    images: [],
    tags: ["docs"],
    prompt: MOCK_CONFIG.prompt,
    markdown: `## 摘要

我们提出一种**轻量级**的视觉检索流程：先在低分辨率下筛选候选区域，再对候选区域做高分辨率重采样。相比逐像素处理，整体吞吐提升了约 3.4 倍，而精度损失可以忽略（< 0.5%）。

1. 候选区域召回
2. 自适应重采样
3. 一致性校验`,
  },
];

export function mockDelay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function mockTranslate() {
  await mockDelay(1500);
  MOCK_ENTRIES.unshift({
    id: `demo-${Date.now()}`,
    timestamp: new Date().toISOString(),
    provider: "openai",
    model: MOCK_CONFIG.model,
    elapsed_ms: 1280 + Math.round(Math.random() * 900),
    image_count: 1,
    images: [],
    tags: [],
    prompt: MOCK_CONFIG.prompt,
    markdown: `## 新的截图翻译

这是浏览器预览模式下的示例结果。真实运行时，这段内容来自视觉模型对截图的识别与翻译，公式会用 KaTeX 渲染：

$$\\int_{-\\infty}^{\\infty} e^{-x^{2}}\\,\\mathrm{d}x = \\sqrt{\\pi}$$

- 右下角可以**一键复制**
- 顶部工具栏可切换译文 / 原文
- 归档页支持搜索与标签筛选`,
  });
}
