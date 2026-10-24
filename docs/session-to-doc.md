# dsh-session-to-doc 插件设计与落地

> **目录**
>
> - [dsh-session-to-doc 插件设计与落地](#dsh-session-to-doc-插件设计与落地)
>   - [问题与目标](#问题与目标)
>     - [长会话按时间顺序导出不可交付](#长会话按时间顺序导出不可交付)
>     - [目标是带层级的可交付文档](#目标是带层级的可交付文档)
>   - [插件形态](#插件形态)
>     - [inject 是授权列表](#inject-是授权列表)
>     - [execute 是纯函数契约](#execute-是纯函数契约)
>   - [三种入口](#三种入口)
>     - [模型工具与会话按钮](#模型工具与会话按钮)
>     - [按钮背后的写接口](#按钮背后的写接口)
>   - [AI 编排](#ai-编排)
>     - [第一轮先聚类再命名](#第一轮先聚类再命名)
>     - [第二轮只填本主题](#第二轮只填本主题)
>     - [预算与降级策略](#预算与降级策略)
>   - [目录生成](#目录生成)
>     - [GitHub 风格锚点](#github-风格锚点)
>     - [代码块与围栏的边界](#代码块与围栏的边界)
>   - [集成踩坑](#集成踩坑)
>     - [Host-only bundle 不能有运行时依赖](#host-only-bundle-不能有运行时依赖)
>     - [启用失败的定位过程](#启用失败的定位过程)
>   - [验证结果](#验证结果)

## 问题与目标

### 长会话按时间顺序导出不可交付

DSH 会话天然是时间序的：用户问 A、中途岔到 B、又回到 A、最后 C。原样导出会得到“A→B→A→C”的流水账，同一主题被切碎在不相邻的两处，读者必须自己重建脉络。

### 目标是带层级的可交付文档

要的是一份按主题聚类、有标题层级、有目录、可直接发给别人的 Markdown；对话只作为素材，不作为结构。

## 插件形态

### inject 是授权列表

插件导出 `name`、`inject = ['tools', 'sessions', 'llm']`、`apply(ctx)`。`inject` 里漏写某个服务，`apply` 里就真的读不到它；用到 `ctx.llm` 就必须声明 `llm`，这不是可选项。

### execute 是纯函数契约

`execute` 只返回 `output.schema` 声明的 canonical JSON：`markdown`、`outline`、`toc`，外加可选的 `notes`（业务降级时标注，正常为空则省略，保证对三元组消费者向后兼容）。基础设施故障直接 `throw`；章节信息不足这类业务结果仍正常返回，在 `notes` 与 `[原始对话中相关信息较少]` 标记里体现。渲染只做投影：`[{ type: 'text', text: markdown }]`。

## 三种入口

### 模型工具与会话按钮

同一套编排有三个入口，全部落到 `generateDocument(ctx, input)`：

1. 模型工具 `session_to_doc`：用户说“整理成文档”时由模型调用，参数由模型自选；
2. 输入框下方的「整理成文档」按钮：`dsh.client` 声明 + `client/client.js` 懒工厂，通过 `ctx.slots.inject('conversation.composer.dock', ...)` 挂载，点击后用固定默认参数请求，结果在弹层里展示、可复制；
3. HTTP 端点：按钮背后的接口，也可被脚本直接调用。

按钮属于「写接口」——它会消耗模型调用，所以端点只接受回环 `Host`、拒绝跨站 `Sec-Fetch-Site` 与异源 `Origin`、只收 `POST`、body 上限 64 KiB；`Host` 缺失或不可解析一律 403。

### 按钮背后的写接口

宿主 half 用 `ctx.inject(['webServer'], ...)` 等 Web 服务就绪后注册 `POST /session-to-doc/generate`，并用 `ctx.effect` 绑定 disposer，避免重载时撞上 “duplicate exact route”。请求体 `{ sessionId?, detailLevel?, includeToc?, maxSectionBudget? }`，响应 `{ ok: true, markdown, outline, toc, notes? }`；未知会话 404、无会话 409、非法参数 400、内部异常 500。

浏览器 half 不打包第二份 React（从宿主模块表 `require('react')`），样式只用 `--dsw-alias-*` token，因此能跟随主题切换。

结果弹层必须真的能滚：外壳是 flex 列、`max-height: 100%`，正文容器与 `pre` 都带 `flex: 1 1 auto; min-height: 0; overflow: auto`。`min-height: 0` 是那一行关键——缺了它，flex 子项保持内容高度，超长文档被弹层裁掉却不出滚动条，只能整份复制出去看。现在 `scripts/client-smoke.mjs` 里有一条渲染级布局回归断言，故意删掉 `min-height: 0` 就会失败。

## AI 编排

### 第一轮先聚类再命名

prompt 明确要求“忽略轮次先后、按主题聚类、被打断的同一主题必须合并”，并且**先聚类、再命名**；标题必须是陈述性结论，禁止“用户询问了…”“助手回答了…”这类元描述。输出只有 JSON 大纲，含 `title/level/budget`。

### 第二轮只填本主题

逐节填充时每章只能使用与该主题直接相关的内容，不得跨章借用；信息不足写占位标记而不是编造；遵守字数预算，超预算优先保留结论与事实，先删过渡句。

### 预算与降级策略

`detailLevel` 决定预算基线（concise 160 / standard 300 / detailed 600 字），`maxSectionBudget` 给了就全局封顶。第一轮 JSON 两次都解析失败时**不 throw**：降级为 outline 为空、把原文用引用块转写成说明性文档，并在 `notes` 里写明原因。超长会话裁剪时 `notes` 会带上原始字数与被裁字数。

## 目录生成

### GitHub 风格锚点

TOC 由代码确定性生成，不交给模型：提取 ATX 标题 → 去 HTML 与强调符 → 小写 → 只保留字母/数字/空格/连字符 → 空格换 `-`，重复标题追加 `-1`、`-2`。缩进基准取最小标题级别，每级两空格。

### 代码块与围栏的边界

围栏（``` 与 `~~~`，最多 3 空格缩进）内部的 `#` 行跳过；4 空格缩进的 indented code 同样视为代码。Setext 标题（下划线式）MVP 不支持，README 已注明。

## 集成踩坑

### Host-only bundle 不能有运行时依赖

插件最初顶层 `import { defineTool } from '@deepseek-ai/dsh-tools'`，装进 profile 后直接崩：profile 的 `node_modules` 不提供 `@deepseek-ai/*`，报 `ERR_MODULE_NOT_FOUND`，插件页显示“启用失败”。官方技能文档的说法是 “A Host-only bundle needs no dependencies”。

改为零运行时 import：`@deepseek-ai/*` 全部变成 `import type`；把完整 `ToolDefinition` 交给 `ctx.tools.register()`（`defineTool` 本来就是“编译 DSL + 参数校验”的语法糖）；参数仍用 `satisfies ParameterSchemaSpec` + `InferArgs` 保留类型推导；手写 JSON Schema 并用 DSH 自己的编译函数做逐字段对照测试；违规抛结构化 `ToolArgsError`（`name`/`code: 'INVALID_ARGS'`/`violations`）。

### 启用失败的定位过程

从 profile 视角直接 `import` 安装副本复现报错，再对比官方第三方插件——`whale-pet`、`dshmarket` 的入口里 `@deepseek-ai` 出现次数为 0，确认这是硬约束而非配置问题。修复后同一命令加载成功，`apply` 注册出 `session_to_doc`，schema 与宿主注入的一致。

## 验证结果

31 个测试全部通过，覆盖验收项：交错对话里 A 的两片段合并进同一章节且全文只出现一次、B 与 C 独立成章、标题无元描述、TOC 锚点格式正确且重复标题带后缀、围栏与缩进代码块里的 `#` 不入目录；防复发断言——注册的 schema 与 `defineTool` 编译结果逐字段相等、编译产物里不得出现 `@deepseek-ai` 运行时 import；Web 侧断言——路由注册为 exact + `/session-to-doc/generate`、非 POST/异源/跨站/坏 JSON 全部拒绝、合法请求返回 canonical 文档且不触发多余模型调用。另有一个浏览器 half 的结构性冒烟脚本（假 `__ModuleLoader__` + stub react），验证工厂能注册进 composer dock 并交出可用的 `generate`。
