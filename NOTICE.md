# NOTICE

## 来源说明

本软件（截译 / JieYi）是按 clean-room 思路重写的实现：只借鉴
[AI-Screenshot-Translator](https://github.com/Diraw/AI-Screenshot-Translator)（GPL-3.0）
的**产品思路与用户可见交互**，不包含其 C++ 源码、HTML 模板或图片资源，
因此本仓库按 MIT 许可发布，不受上游 GPL-3.0 的传染性约束。

若后续要复用上游任何代码或资源，本仓库必须改为 GPL-3.0 并保留其版权声明。

## 运行时与第三方依赖

| 组件 | 许可 | 说明 |
|---|---|---|
| Microsoft Edge WebView2 Runtime | 随 Windows 提供 | 安装包缺失时自动引导安装 |
| Tauri 2 | MIT / Apache-2.0 | 应用外壳 |
| React 19 | MIT | 前端运行时 |
| KaTeX | MIT | 数学公式渲染 |
| marked | MIT | Markdown 解析 |
| DOMPurify | Apache-2.0 / MPL-2.0 | HTML 消毒 |
| lucide | ISC | 图标 |
| reqwest / rusqlite / image / xcap | MIT / Apache-2.0 | Rust 侧依赖，详见 `src-tauri/Cargo.lock` |

## 品牌资源

`src-tauri/icons/`、`docs/screenshots/` 中的应用图标与截图随本仓库以 MIT 发布，
但不代表任何第三方商标授权。
