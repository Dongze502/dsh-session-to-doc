# dsh-session-to-doc

[![npm](https://img.shields.io/npm/v/dsh-session-to-doc?color=0f172a)](https://www.npmjs.com/package/dsh-session-to-doc)
[![CI](https://github.com/Dongze502/dsh-session-to-doc/actions/workflows/ci.yml/badge.svg)](https://github.com/Dongze502/dsh-session-to-doc/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-0ea5e9.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-6366f1.svg)](#版本与契约适用性)

把当前会话中一段又长又散的对话，**重新组织**成一份带大纲、章节层级和目录的结构化 Markdown 文档——而不是按时间顺序原样导出。

这是一个 DSH（DeepSeek Harness）插件，同时提供三种入口，三者共用同一套编排代码：

1. **模型工具** `session_to_doc` —— 用户说“整理成文档”时由模型调用；
2. **界面按钮** —— 输入框下方常驻的「整理成文档」按钮，点一下直接生成并在弹层里展示（`client/client.js` + `POST /session-to-doc/generate`）；
3. **HTTP 端点** —— 上面那个按钮背后的接口，也可被脚本调用。

参数与返回值只有一份 canonical 形状；`output.render` 只投影纯文本。编译产物是一个**自包含的纯 JS 模块**，不依赖宿主之外的任何运行时包。

```
用户调用 session_to_doc / 点击「整理成文档」
        │
        ├─ 1. 从 ctx.sessions 提取会话文本（用户输入 + 助手最终回复）
        ├─ 2. 第一轮 LLM：按主题聚类，产出 outline（标题 / 层级 / 字数预算）
        ├─ 3. 第二轮 LLM：按大纲逐节填充正文（不跨章借用、信息不足标注）
        ├─ 4. 确定性生成 GitHub 风格 TOC（跳代码块、去重锚点）
        └─ 5. 组装：TOC 可选嵌入，outline/toc/notes 原样返回
```

## 版本与契约适用性

> **开发所用的 DSH 版本：`0.2.0-rc.2`（开发者预览版）。**
> 0.1.x / 0.2.x 都处于开发者预览阶段，插件契约、类型签名与服务名**可能随版本变动**。
> 升级 DSH 后请先核对下表的依赖版本，再重新构建并跑测试。

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| `@deepseek-ai/dsh` | `0.2.0-rc.2` | 宿主版本（仅用于核对契约） |
| `@deepseek-ai/cordis` | `4.0.4` | `Context` 类型（**仅类型**） |
| `@deepseek-ai/dsh-tools` | `0.2.0-rc.2` | `ToolDefinition` / `InferArgs` 等类型，以及测试里的 schema 对照 oracle（**仅开发期**） |
| `@deepseek-ai/dsh-session` | `0.2.0-rc.2` | `ctx.sessions`、`Session.deriveMessages()` 类型 |
| `@deepseek-ai/dsh-llm` | `0.2.0-rc.2` | `ctx.llm.stream()`、消息与 chunk 类型 |

所有 `@deepseek-ai/*` 都是 **devDependencies / 仅类型导入**：编译产物 `lib/index.js` 里没有任何运行时 `@deepseek-ai/*` import。原因和验证方式见下文“为什么没有运行时 import”。

本插件按以下契约实现：

- 插件最小形态：`export const name`、`export const inject = ['tools', 'sessions', 'llm']`、`export function apply(ctx)`。
- **`inject` 是授权列表**：`apply()` 里读到的每个 `ctx.*` 服务都必须在 `inject` 中声明（`tools` / `sessions` / `llm`），漏声明会导致插件不加载或能力静默失效。
- `execute` 是纯函数契约：只返回 `output.schema` 声明的 canonical JSON 值；基础设施故障直接 `throw`（标记为 `isError`），业务上的非理想结果仍正常返回 canonical 值并在返回值里标注。
- 参数校验：`detailLevel` / `includeToc` 的类型与枚举由注册时提交的 JSON Schema 描述，`execute` 内置的 `validateArguments()` 做同样的检查；DSL 表达不了的约束（`maxSectionBudget` 必须是有限正数且不小于 40）也在 `execute` 里手查。违规统一抛 `name: 'ToolArgsError'`、`code: 'INVALID_ARGS'`、`violations: string[]` 的错误，与 DSH 的 schema 违规同通道。

### 为什么没有运行时 import

DSH profile 的 `node_modules` 只装第三方包，**不提供 `@deepseek-ai/*`**；profile 里的插件入口如果顶层 `import { defineTool } from '@deepseek-ai/dsh-tools'`，加载时会直接失败：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-tools'
imported from ...\node_modules\session-to-doc\lib\index.js
```

表现就是插件页面显示“启用失败”。官方技能文档的措辞也是“A Host-only bundle needs no dependencies”。因此本插件：

- 不调用 `defineTool`，而是把一个**完整的 `ToolDefinition` 对象**交给 `ctx.tools.register()`（`defineTool` 本质上只是“编译 DSL + 包装 execute 做参数校验”的语法糖，这两步这里都自己做）；
- 仍然用 `defineTool` 的类型推导：参数 DSL 标成 `satisfies ParameterSchemaSpec`，参数类型由 `InferArgs<typeof PARAMETER_SPEC>` 得出；
- 提交的是手写的 JSON Schema（`PARAMETER_SCHEMA` / `OUTPUT_SCHEMA`），并由测试用 DSH 自己的 `parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema` 做**逐字段对照**，确保与 `defineTool` 编译结果完全一致；
- 测试里还有一条用例直接扫描 `lib/index.js`，禁止出现 `import … from '@deepseek-ai/…'`，防止这个坑复发。

## 获取当前会话

同一套编排有两种触发方式：

| 方式 | 触发 | 说明 |
| --- | --- | --- |
| 自然语言 | 发送「整理成文档」「把这段讨论整理成文档」 | 模型根据工具 description 判断调用 `session_to_doc`，参数可自选 `detailLevel` 等。 |
| 界面按钮 | 点击输入框下方的「整理成文档」 | 直接 `POST /session-to-doc/generate`，用默认参数（`standard` + 带 TOC）生成，结果在弹层里展示，可一键复制 Markdown。 |

两条路都落到 `generateDocument(ctx, input)`，所以同一份会话在两种入口下产出同样的文档结构（按钮固定用默认参数，没有额外选项面板）。

### Web 按钮

按钮是一个 **client 半边插件**，与宿主 half 同包发布：

- `package.json` 里的 `dsh.client` 声明（`platform: "web"`、`immediately: true`、`inject: ["@deepseek-ai/dsh-client-ui-conversation"]`）与 `exports["./client"]` 让宿主把 `client/client.js` 作为浏览器模块加载；
- `client/client.js` 用 `window.__ModuleLoader__.load({ id: 'dsh-session-to-doc', factory(require) { ... } })` 注册一个懒工厂，React 从宿主模块表 `require('react')` 取（**不打包第二份 React、不走 CDN**）；
- 工厂通过 `ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name, id: 'dsh-session-to-doc', order: 40, inject: (sessionId) => ({...}) }, ComposerButton))` 挂到输入框下方的 dock；
- 组件只用 `--dsw-alias-*` 主题 token，不读别的插件的 DOM / 样式。
- 弹层正文是一个可滚动区域：外壳 `display: flex; flex-direction: column` + `max-height: 100%`，正文容器与 `pre` 都设 `flex: 1 1 auto; min-height: 0; overflow: auto`。少了 `min-height: 0` 时 flex 子项会保持内容高度，超长文档会被弹层裁掉且没有滚动条（只能整体复制）。`scripts/client-smoke.mjs` 里有对应的布局回归断言，故意删掉 `min-height: 0` 会让它失败。

宿主 half 在 `apply()` 里用 `ctx.inject(['webServer'], ...)` 等 Web 服务就绪后注册精确路由 `POST /session-to-doc/generate`，并用 `ctx.effect` 绑定路由的 disposer（卸载时可再次注册，不会撞 “duplicate exact route”）。

**这个端点会消耗模型调用**，所以按写接口收紧：

- `Host` 必须是回环权威（`127.0.0.1` / `localhost` / `[::1]`），缺失或不可解析一律 403；
- `Sec-Fetch-Site: cross-site` / `cross-origin` 一律 403；
- 带 `Origin` 时必须与 `Host` 同源；
- 只接受 `POST`（其它方法 405），body 上限 64 KiB，非法 JSON 400；
- 未知 `sessionId` 404、没有可整理的会话 409、流水线内部异常 500。

请求体：`{ sessionId?: string, detailLevel?, includeToc?, maxSectionBudget? }`；响应：`200 { ok: true, markdown, outline, toc, notes? }` 或 `{ ok: false, error }`。

## 工具定义

### `session_to_doc`

**description（写给模型看）**

> 将当前会话中的对话记录重新组织为一份结构化 Markdown 文档，而不是按时间顺序原样导出。适合在用户需要把一段讨论整理成可交付文档时调用。

**parameters**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `detailLevel` | `'concise' \| 'standard' \| 'detailed'` | `'standard'` | 章节填充的详细程度。`concise` 压低预算，`detailed` 放宽预算，`standard` 按信息密度分配。 |
| `includeToc` | `boolean` | `true` | 是否在文档开头嵌入目录。 |
| `maxSectionBudget` | `number`（可选） | — | 单章节最大字数上限。不传则由 AI 在规划阶段自行分配（内部上限 2000 字，超过 `maxSectionBudget` 的预算会被压缩并记录到 `notes`）。 |

> `default` 只是 schema 注解，DSH 运行时**不会**注入默认值；缺省值在 `execute` 内以 `args.detailLevel ?? 'standard'` 的方式落地。

**output.schema（对象根）**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `markdown` | `string` | 最终完整文档；`includeToc` 为真时目录已插到正文开头。 |
| `outline` | `Array<{ title: string, level: number, budget: number }>` | 第一轮规划出的大纲，可直接用于 UI 卡片预览“准备怎么组织”。 |
| `toc` | `string` | 单独返回的目录字符串，始终生成（即使 `includeToc` 为 `false`），方便用户复制。 |
| `notes` | `string[]`（可选） | **附加字段**：仅在出现业务上的非理想结果时才返回，例如某章节信息不足、预算被压缩、会话被裁剪、大纲规划失败降级、大纲外多出小节。无提示时该字段**不出现**。 |

> `notes` 是在你给的最小三元组之外**新增的可选字段**，用来满足“非理想结果仍然正常返回 canonical 值，并**在返回值里标注**”这一条——否则标注只能塞进 `markdown`，污染交付物。它已写入 `output.schema`（`additionalProperties: false`，但不在 `required` 里），是合法声明，不是未声明字段：主路径（一切顺利时）返回的仍是干净的三元组 `{ markdown, outline, toc }`，需要标注的调用方才读得到 `notes`。
>
> 这是对原三元组的**向后兼容扩展**。若宿主严格要求三元组，删除 schema 中的 `notes` 及 `execute` 里所有写入点即可，不影响主路径。

`output.render` 只做投影：

```ts
render(_args, value) {
  return [{ type: 'text', text: value.markdown }]
}
```

模型看到 Markdown，调用方拿到的仍是完整 canonical 对象。

## 工作流程

### 1. 提取会话文本

通过 `ctx.sessions` 解析“当前会话”：优先使用 `exec.agent.session`；若工具在无 agent 的上下文被直接调用，则退化为 `ctx.sessions.list()` 中 `seq` 最大的会话。

只纳入 **user 与 assistant 消息里的 text block**；tool 调用、tool 结果、思维链（reasoning）、图片与文件默认不纳入。超长会话（超过 60000 字）保留头 65% + 尾 30%（结论通常集中在结尾），裁掉中间部分，并在 `notes` 里写明**原始字数与裁剪字数**：

> 会话过长（N 字），已裁剪中间 X 字；部分主题可能不完整。

这条提示很重要：某个主题的某一轮如果正好落在裁剪区，聚类合并会缺一块，而用户否则无从得知。

**空会话 / 过短会话**：有效文本（去空白后）不足 **200 字**时，不调用模型、不抛错，直接返回 `outline: []`、`toc: ''` 和一份说明性 Markdown（含有效字数与消息条数），`notes` 里注明“已跳过规划与填充”。

### 2. 第一轮：规划 + 预算

prompt 的硬约束（与产品需求逐条对应）：

- 按主题聚类，**忽略对话轮次的先后顺序**；同一主题在对话中被其他话题打断过，必须合并到同一章节；
- 标题必须是陈述性的、可交付的，**禁止**“用户询问了……”“助手回答了……”这类元描述；
- 用嵌套编号列表表示层级，最多三级；
- 为每个叶子章节分配建议字数预算（`maxSectionBudget` 存在时全部不得超过该值）；
- 只输出 JSON：`{ outline: [{ title, level, budget }] }`；
- `detailLevel` 影响预算口径（`concise` 100–200 字、`standard` 200–400 字、`detailed` 500–800 字），并明确要求“先聚类、再命名”两步走，避免模型退化成按时间顺序复述。

解析侧做了容错：允许 JSON 被 ```` ```json ```` 围栏包裹；解析失败会用“这不是合法 JSON，请只输出 JSON”重试一次。

**两次都失败时降级，不抛错**：返回 `outline: []`、一份 `# 未能生成结构化大纲` 的说明性 Markdown、把整段会话以 `> ` 引用原样转写（引用是必要的——否则 `### 用户` 会被当成标题进 TOC），并在 `notes` 记录 `大纲规划失败（…），已降级为原样转写。`。`execute` 里的 `throw` 只留给基础设施故障（provider 不可达、无可用模型等）；模型输出格式错误属于业务非理想结果，按契约应正常返回 canonical 值。

规划结果会做规范化：清标题、层级夹到 1–3 且不跳级、预算夹到 `[40, 2000]`、最多 40 节；若调用方给了 `maxSectionBudget`，再统一压缩到上限内并写入 `notes`。

### 3. 第二轮：逐节填充

prompt 要求：

- 每章只能使用对话记录中**与该主题直接相关**的内容，不得跨章借用；
- 信息不足时写 `[原始对话中相关信息较少]`，不要编造；
- 遵守每章字数预算；超预算时优先保留具体结论和事实，删减过渡性表述；
- 输出完整 Markdown，用 `#` / `##` / `###` 控制层级，标题文本与大纲完全一致；
- 不要在正文中嵌入目录（TOC 由系统生成）。

拿到正文后再做**确定性对账**：按 ATX 标题解析（跳过 fenced code block），按大纲顺序重排；同名标题合并为一节（这正是“A 的两个片段合并到同一章节”的兜底）；缺失的叶子章节补占位标记；大纲之外的小节追加到文末——这三类非理想情况都会记录到 `notes`。

### 4. 生成 TOC（确定性，不靠模型）

- 跳过 fenced code block 内的 `#` 行，避免把 shell / 代码注释误判为标题。围栏同时支持 ```` ``` ```` 与 `~~~`，且围栏最多允许 3 个空格缩进（CommonMark）；
- 4 个及以上空格缩进的行是 **indented code block**，其中的 `#` 不是标题，也不参与围栏状态的切换；
- 锚点按 GitHub 风格：标题转小写 → 移除 HTML 标签与 `* _ ~` 强调符 → 只保留字母/数字/空格/连字符 → 空格替换为 `-`；
- 重复锚点追加 `-1`、`-2` 等后缀；
- 缩进基准取文档中最小标题级别，逐级缩进 2 个空格，输出为 Markdown 列表链接。

**Setext 标题（`===` / `---` 下划线式）MVP 暂不支持**，只识别 ATX（`#`）标题；GitHub 也认 Setext，但对话整理产出的正文极少使用，后续可补。

### 5. 组装返回值

`includeToc` 为真时，把 `> **目录**\n\n${toc}\n\n${正文}` 放到文档开头（TOC 本身不参与标题层级）；`outline` 原样返回第一轮结果；`toc` 始终返回。

## 验收测试

`test/session-to-doc.test.mjs` 直接 `import` 编译产物 `lib/index.js`，因此驱动的是**真实注册出去的那个 definition**；`@deepseek-ai/dsh-tools` 只在测试进程里作为 oracle 使用，不进入产物。只有外围服务被替换：

- `ctx.tools`：捕获注册的 tool definition；
- `ctx.sessions`：返回脚本化的 Session（`deriveMessages()`）；
- `ctx.llm`：按调用顺序回放脚本化回复，yield `text-delta` + `finish`；
- `ctx.get('agentDefaultModel')`：返回固定的 provider / model。

主用例就是题目要求的**主题交错对话**：

| 时间线 | 内容 |
| --- | --- |
| A（第 1 轮） | 向量数据库选型标准：Milvus / Qdrant / pgvector |
| B（第 2 轮） | 岔开：团队排期 |
| A（第 3 轮） | 回到 A：最终选 Qdrant、压测指标 |
| C（第 4 轮） | 监控告警治理 |

断言覆盖：

- A 的两个片段（`A1-SENTINEL` / `A2-SENTINEL`）落在**同一个** `# 向量数据库选型结论` 章节，且全文只出现一次；
- B、C 各自独立成章，顺序为 A → B → C，而不是时间线的 A → B → A → C；
- 叶子章节标题是陈述性的，不出现“用户询问…”“助手回答…”；
- TOC 锚点为 GitHub 风格、可点击、按层级缩进、位于正文之前；重复标题自动带 `-1` / `-2` 后缀；
- 代码块（```` ```bash ```` / ```` ```js ```` / ```` ~~~yaml ````）与 4 空格缩进代码块里的 `#` 行没有被提取为 TOC 条目，也没有被解析成章节；
- 详细程度三档分别命中规划 prompt 的预算口径；
- 过短会话不调模型、返回说明性文档；
- 缺失章节 / 大纲外小节都正常返回并写进 `notes`；
- `malformed JSON` 会重试一次；围栏包裹的 JSON 可解析；
- 两次都是 malformed JSON 时**降级**为原样转写（`outline: []`、`notes` 记录降级、正文不含被误判的标题），而不是抛错；
- 超长会话被裁剪时，`notes` 里带原始字数与裁剪字数；
- 无默认模型时回退到第一个 provider / model；
- reasoning block 与 tool 消息不会进入 prompt；
- `includeToc: false` 时 `markdown` 不嵌 TOC，但 `toc` 字段仍然可用；
- 一切顺利时返回值不带 `notes` 字段（仍是干净三元组）；
- 非法 `maxSectionBudget`（0、负数、过小、NaN、Infinity）抛 `ToolArgsError`；
- `detailLevel: 'verbose'` 在任何模型调用之前被拦下；
- 注册出去的 `parameters` 与 `output.schema` 和 `defineTool` 对同一 DSL 的编译结果**逐字段相等**，且都通过 DSH 的 `assertSupportedJsonSchema`；
- 编译产物里**没有**任何运行时 `@deepseek-ai/*` import（防止“启用失败”复发）；
- `apply()` 在宿主 Web 服务上注册一个 `exact` 路由，路径为 `/session-to-doc/generate`；
- Web 端点拒绝非 `POST`、非回环 `Host`、跨站 `Sec-Fetch-Site`、异源 `Origin`、无 `Host` 与坏 JSON；
- Web 端点对 `sessionId` 返回 canonical 文档（含 TOC、`notes` 缺省时不出现、`Cache-Control: no-store`），未知会话 404、无会话 409、非法参数 400 且不触发模型调用。

当前结果：**31 个测试全部通过**（DSH `0.2.0-rc.2`，Node `v24.21.0`）。

```bash
# 构建 + 测试（在插件目录）
npm run verify
# 等价的直接命令
node node_modules/typescript/bin/tsc -p tsconfig.json
node test/session-to-doc.test.mjs
node scripts/client-smoke.mjs   # 浏览器 half 的结构性冒烟（假 __ModuleLoader__ + stub react）
```

> 测试脚本用 `node test/...` 直接运行，而不是 `node --test`：在受限沙箱里 `node --test` 需要 spawn 子进程并通过管道回传结果，会被拒绝（`spawn EPERM`）。脚本本身仍用 `node:test` 编写，换到普通终端时 `node --test test/session-to-doc.test.mjs` 同样可用。

## 安装到 DSH

1. 构建插件（产物在 `lib/`）：

   ```bash
   npm install
   npm run build
   ```

2. 让 DSH profile 能解析到包。profile 位于 `~/.dsh/profiles/<name>`（例如 `C:\Users\DONG\.dsh\profiles\desktop`），在其 `package.json` 里：
   - 把 `dsh-session-to-doc` 加入 `dependencies`（本地开发用 `link:` / `file:` 指向本目录）；
   - 把 `dsh-session-to-doc` 加入 `dsh.profile.bundles` 数组。

3. 把构建产物放进 profile 的 `node_modules`（或让包管理器装进去）。手工安装时，目标目录只需要下面这些，**不要**复制插件自己的 `node_modules`——它会和宿主的依赖树打架：

   ```
   <profile>/node_modules/dsh-session-to-doc/
     lib/index.js          # 宿主 half，零 @deepseek-ai 运行时依赖
     client/client.js      # 浏览器 half（composer 按钮），零构建、零运行时依赖
     package.json          # dsh.client 与 "./client" export 必须存在，否则按钮不会加载
     cordis.patch.yml
     README.md
   ```

4. 重启 DSH（或重新加载 profile）。加载成功后，模型侧会多出 `session_to_doc` 工具；`dsh-session-to-doc/cordis.patch.yml` 只做 `insert`，不替换任何官方组件：

   ```yaml
   - insert:
       - id: dsh-session-to-doc
         name: dsh-session-to-doc
   ```

> 改完源码后要重新 `npm run build`，并把 `lib/`、`client/`、`package.json`、`cordis.patch.yml`、`README.md` 重新复制进目标目录，然后完全退出 DSH（含托盘图标）再启动——工具注册表与浏览器模块表都只在启动时绑定。

## 开发

```bash
# 插件目录内；沙箱 / 受限环境必须把 store 与 cache 放进工作区
pnpm install \
  --node-linker=hoisted \
  --store-dir "$PWD/.pnpm-store" \
  --cache-dir "$PWD/.pnpm-cache"
npm run build
npm test
```

客户端文件是手写的浏览器模块，不需要额外构建步骤；`node --check client/client.js` 可以做语法自检。

**`--node-linker=hoisted` 是本地测试专用参数，故意不写进 `.npmrc`**：插件自己的 devDependencies 里带了 `@deepseek-ai/dsh-tools` 等包，pnpm 默认的 junction 布局下，Node ESM 会从 junction 路径向上找包，找不到只存在于虚拟 store 里的传递依赖（典型报错：`Cannot find package '@deepseek-ai/cosmokit' imported from ...@deepseek-ai/cordis/lib/index.js`）。hoisted 布局把传递依赖摊平到顶层 `node_modules`，测试才能在**没有 DSH 宿主**的目录里加载真实 `defineTool`。把它放在命令行而不是 `.npmrc`，是因为 `.npmrc` 有被 `npm pack` 带进发布包的风险，会污染下游安装环境；安装进 DSH profile 时 `@deepseek-ai/*` 由宿主提供，本来就不需要这个参数。

> 不要在 `.npmrc` 或命令行里写 `store-dir` / `cache-dir` 的**相对**路径：pnpm 在打开 store 索引时尚未按项目目录解析它们，会报 `[ERR_SQLITE_ERROR] unable to open database file`；用绝对路径（如上 `$PWD/...`）。

## 当前限制

- **两轮模型调用**：规划与填充各一次，超长会话会有明显耗时；`exec.signal` 已透传到两次调用，取消会以 `aborted` 失败结束。
- 按钮固定使用默认参数（`standard` + 带 TOC），没有选项面板；需要别的参数走模型调用或直接 POST。
- 按钮请求不流式返回，弹层在整份文档生成完才出现；生成期间按钮显示「整理中…」。
- Web 端点只允许回环 + 同源，不做跨机调用；部署在反向代理后面时需要自行在代理层放行 `Host`。
- 会话提取只覆盖 user / assistant 的 text block；工具调用与思维链默认排除，后续可加开关。
- 正文是单次模型输出，没有按章节拆分调用——“逐节填充”目前靠 prompt 约束 + 确定性对账保证章节边界。
- 预算只约束 prompt，不做事后截断：模型超预算时，正文可能长于 `budget`。
- `output.presentationMeta` 卡片尚未实现；`outline` 字段已经预留好预览所需数据。
- 同一会话并发调用会各自跑两轮模型，没有缓存。

## 发布与上架

仓库已经按「可开源 + 可上架 dshmarket」准备过：`LICENSE`（MIT）、`package.json` 元数据与 `engines.dsh`、`prepack` 构建、`.github/workflows/ci.yml`（构建 + 31 个测试 + 客户端冒烟 + 零运行时 `@deepseek-ai` import 检查）、`assets/icon-180.png` 市场卡片图标。

完整步骤见 **[docs/PUBLISHING.md](docs/PUBLISHING.md)**，包含：

- 为什么「上架 dshmarket」= 给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR 加一个 `data/plugins/<owner>__<repo>.yml`（dshmarket 只是市场界面，不接受插件条目）；
- 建 GitHub 账号、建仓库、加 `dsh-plugin` topic、**等满 1 天**（CI 会查仓库年龄）；
- `npm publish`（包名 `dsh-session-to-doc`，已确认 npm 上未被占用）；
- 投稿 YAML 的全文、`category` 怎么选、图标与截图规则；
- 常见被拒原因清单与版本更新流程。

发布后的安装方式就变成一句：

```bash
dsh plugin --profile web add dsh-session-to-doc
```

## 许可

MIT，见 [LICENSE](LICENSE)。
