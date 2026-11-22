// Renders the plugin's own client bundle in a page so screenshots show the real
// component output (React 18 + the shipped client.js), not a hand-drawn mock.
const params = new URLSearchParams(location.search)
const state = params.get('state') ?? 'button'
if (params.get('theme') === 'dark') document.body.classList.add('dark')

const MARKDOWN = `> **目录**

- [问题与目标](#问题与目标)
- [插件形态](#插件形态)
- [AI 编排：两轮调用](#ai-编排两轮调用)
- [目录生成与锚点](#目录生成与锚点)
- [集成踩坑](#集成踩坑)
- [验证结果](#验证结果)

# session-to-doc 插件设计与落地

## 问题与目标

一段几十轮的讨论，按时间顺序读起来是散的：同一个主题被打断三次，
回到它的时候上下文已经隔了很远。这个插件把当前会话重组成文档：
按主题聚类、给章节层级、生成可点击的目录。

## 插件形态

宿主半是 TypeScript 写的工具定义，浏览器半是 \`__ModuleLoader__\` 包。
三处入口共用同一条生成链路。

## AI 编排：两轮调用

第一轮只出大纲：按主题聚类、忽略轮次先后、同一主题被打断必须合并到同一章节。
第二轮逐节填充，每章只能用与该主题直接相关的内容。

## 目录生成与锚点

标题转小写、去掉 HTML 与强调符、空格换成连字符，重复标题追加 \`-1\`、\`-2\`。
围栏代码块里的 \`#\` 不算标题。

## 集成踩坑

\`\`\`ts
// 编译产物零运行时 @deepseek-ai import，插件才装得进宿主
export const inject = ['tools', 'sessions', 'llm']
\`\`\`

## 验证结果

21 个验收测试：主题交错对话里 A 的两段合并、B 与 C 独立成章、
标题无元描述、TOC 锚点可跳转、代码块里的 # 不入目录。
`

const DOC = {
  ok: true,
  markdown: MARKDOWN,
  outline: [
    { title: '问题与目标', level: 2, budget: 240 },
    { title: '插件形态', level: 2, budget: 200 },
  ],
  toc: '- [问题与目标](#问题与目标)',
  notes: ['已按 maxSectionBudget 压缩：2 节从 480 字压到 400 字'],
}

const loaded = window.__loaded
window.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => DOC,
  text: async () => JSON.stringify(DOC),
})

const plugin = loaded.registration.factory(name => {
  if (name === 'react') return window.React
  if (name === 'react-dom') return window.ReactDOM
  throw new Error(`unexpected require(${name})`)
})

const entries = []
plugin.apply({
  slots: {
    inject(_name, body) {
      body()
    },
    register(entry, Component) {
      entries.push({ entry, Component })
    },
  },
})

const target = entries.find(item => item.entry.id === 'dsh-session-to-doc')
// Use the slot's own inject() so the component receives exactly the props the
// host would hand it (here: a generate() that POSTs to the stubbed endpoint).
const injected = target.entry.inject ? target.entry.inject('demo-session') : {}
window.ReactDOM.createRoot(document.getElementById('root')).render(
  window.React.createElement(target.Component, Object.assign({ sessionId: 'demo-session' }, injected)),
)

if (state === 'panel') {
  setTimeout(() => {
    const button = document.querySelector('#root button')
    if (button) button.click()
  }, 120)
}
