/**
 * Acceptance tests for session-to-doc.
 *
 * The compiled plugin is a bundle with no runtime imports, so these tests drive
 * the registered definition directly. `@deepseek-ai/dsh-tools` is imported as a
 * dev-only oracle to prove the hand-written JSON Schema equals what
 * `defineTool` would have compiled from the same DSL, and that DSH's own
 * `assertSupportedJsonSchema` accepts both schemas.
 * Only the surrounding services are faked:
 *
 *   - `ctx.tools`     captures the registered tool definition
 *   - `ctx.sessions`  returns a scripted Session with `deriveMessages()`
 *   - `ctx.llm`       plays back scripted replies, one per model call
 *   - `ctx.get`       returns a fixed default model selection
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  assertSupportedJsonSchema,
  parameterSchemaSpecToJsonSchema,
  valueSchemaSpecToJsonSchema,
} from '@deepseek-ai/dsh-tools'

import {
  OUTPUT_SPEC,
  PARAMETER_SPEC,
  ROUTE_PATH,
  apply,
  createRouteHandler,
  inject,
  internals,
  runGenerateRequest,
} from '../lib/index.js'

const { generateToc, parseMarkdownDocument, slugifyTitle } = internals

const DESCRIPTION =
  '将当前会话中的对话记录重新组织为一份结构化 Markdown 文档，而不是按时间顺序原样导出。适合在用户需要把一段讨论整理成可交付文档时调用。'

const INSUFFICIENT = '[原始对话中相关信息较少]'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let messageSeq = 0

function userMessage(text) {
  messageSeq += 1
  return {
    id: `msg-${messageSeq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function assistantMessage(text, extraBlocks = []) {
  messageSeq += 1
  return {
    id: `msg-${messageSeq}`,
    role: 'assistant',
    content: [...extraBlocks, { type: 'text', text }],
    source: { kind: 'model', model: 'fake-model' },
  }
}

function createSession(messages) {
  return {
    id: 'session-1',
    seq: messages.length,
    header: { cwd: '/workspace' },
    deriveMessages: () => messages,
  }
}

function chunkText(text, size = 64) {
  const pieces = []
  for (let index = 0; index < text.length; index += size) {
    pieces.push(text.slice(index, index + size))
  }
  return pieces
}

/**
 * Build a fake ctx whose llm service replies with `replies[n]` on call n.
 * A reply may be a string or `(prompt) => string`.
 */
function createHarness({ messages, replies, defaultSelection = true }) {
  const calls = []
  const routes = []
  const session = createSession(messages)
  let definition

  const llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: async () => [{ provider: 'fake-provider', id: 'fake-model', name: 'Fake Model' }],
    stream(options) {
      const prompt = options.messages
        .flatMap((message) => message.content)
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      calls.push({ provider: options.provider, model: options.model, prompt })
      const reply = replies[calls.length - 1]
      if (reply === undefined) {
        throw new Error(`unexpected model call #${calls.length}`)
      }
      return (async function* generate() {
        const text = typeof reply === 'function' ? reply(prompt) : reply
        for (const piece of chunkText(text)) {
          yield { type: 'text-delta', index: 0, text: piece }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }

  const ctx = {
    tools: {
      register(candidate) {
        definition = candidate
      },
    },
    sessions: {
      get: () => session,
      list: () => [session],
    },
    llm,
    get(name) {
      if (name === 'agentDefaultModel' && defaultSelection) {
        return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
      }
      return undefined
    },
    inject(dependencies, callback) {
      const scoped = {
        webServer: {
          register(route) {
            routes.push(route)
            return () => {}
          },
        },
        effect(factory) {
          return factory()
        },
      }
      return callback(scoped, dependencies)
    },
  }

  apply(ctx)
  assert.ok(definition, 'apply() must register the session_to_doc tool')

  const execContext = () => ({
    callId: 'call-1',
    name: definition.name,
    arguments: {},
    agent: { session },
    signal: new AbortController().signal,
  })

  return {
    definition,
    calls,
    routes,
    ctx,
    session,
    run: (args = {}) => definition.execute(args, execContext()),
    render: (args, value) => definition.output.render(args, value),
  }
}

/** The interleaved conversation: A → B → A → C. */
function interleavedMessages() {
  return [
    userMessage(
      '我们在给知识库挑向量数据库，候选是 Milvus、Qdrant 和 pgvector。数据量大概两千万条，QPS 峰值 300，团队没有人专职运维。先帮我把选型标准定下来。',
    ),
    assistantMessage(
      '选型建议按四个维度打分：召回质量与过滤能力、写入与索引成本、运维复杂度、以及和现有 Postgres 生态的耦合。两千万条、QPS 300 属于中等规模，pgvector 加 HNSW 可以覆盖，但复杂过滤和水平扩展会受限；Milvus 扩展性最好但组件多；Qdrant 折中，单二进制部署，过滤表达能力强。',
    ),
    userMessage('等一下，先说说这周团队排期怎么排？三个人，两个人还在做上一个项目的收尾。'),
    assistantMessage(
      '排期按两周一个迭代：第一周只安排一个人做接口联调和数据迁移脚本，另外两人收尾旧项目；第二周三人并行，一人负责索引参数压测，一人负责灰度与回滚脚本，一人负责监控接入。工作日不排会议集中在周三下午。',
    ),
    userMessage('好，回到向量数据库。那你觉得我们最终该选哪个？给个明确结论。'),
    assistantMessage(
      '结论是选 Qdrant。理由是：过滤条件多、团队无专职运维、两千万规模下单节点足够，后续扩容可以加副本；pgvector 的过滤性能在复杂条件下不稳定，Milvus 的组件数量超出团队承受能力。压测指标定为 p95 延迟 50ms、召回率 0.92。',
    ),
    userMessage('最后再聊聊监控告警吧，我们现在的告警太多，基本没人看。'),
    assistantMessage(
      '告警治理先做三件事：一是按 SLO 分级，只有影响可用性和延迟目标的才升级为电话告警，其余进日报；二是删掉没有负责人和历史处置记录的规则；三是给每条告警补上“下一步做什么”的链接。目标是把每周告警条数从 400 降到 50 以内。',
    ),
  ]
}

const OUTLINE_JSON = JSON.stringify({
  outline: [
    { title: '向量数据库选型结论', level: 1, budget: 300 },
    { title: '团队排期安排', level: 1, budget: 200 },
    { title: '监控告警治理', level: 1, budget: 240 },
  ],
})

const FILLED_BODY = `# 向量数据库选型结论

A1-SENTINEL 最终结论是选择 Qdrant：复杂过滤表达能力强、单二进制部署、团队无需专职运维。两千万条数据、QPS 300 的规模下单节点可以覆盖，后续通过增加副本来扩容。

# 团队排期安排

B-SENTINEL 两周一个迭代：第一周一人做接口联调与迁移脚本，两人收尾旧项目；第二周三人并行，分别负责压测、灰度回滚和监控接入。

# 向量数据库选型结论

A2-SENTINEL 压测验收指标定为 p95 延迟 50ms、召回率 0.92；如果 Qdrant 在复杂过滤下达不到该指标，则回退评估 pgvector 加分区表方案。

# 监控告警治理

C-SENTINEL 告警按 SLO 分级，只有影响可用性和延迟目标的规则升级为电话告警；删除无负责人、无处置历史的规则，每条告警补充处置链接，目标每周告警从 400 条降到 50 条以内。`

function headingLines(markdown) {
  return parseMarkdownDocument(markdown).sections
}

// ---------------------------------------------------------------------------
// Plugin contract
// ---------------------------------------------------------------------------

test('plugin declares its injected services and registers one tool', () => {
  assert.deepEqual([...inject].sort(), ['llm', 'sessions', 'tools'])

  const harness = createHarness({ messages: interleavedMessages(), replies: [OUTLINE_JSON, FILLED_BODY] })
  assert.equal(harness.definition.name, 'session_to_doc')
  assert.equal(harness.definition.description, DESCRIPTION)

  const parameters = harness.definition.parameters
  assert.equal(parameters.type, 'object')
  assert.deepEqual(parameters.properties.detailLevel.enum, ['concise', 'standard', 'detailed'])
  assert.equal(parameters.properties.detailLevel.default, 'standard')
  assert.equal(parameters.properties.includeToc.default, true)
  assert.equal(parameters.properties.maxSectionBudget.type, 'number')
})

test('render projects the Markdown string as one text block', async () => {
  const harness = createHarness({ messages: interleavedMessages(), replies: [OUTLINE_JSON, FILLED_BODY] })
  const value = await harness.run()
  const blocks = harness.render({}, value)

  assert.deepEqual(blocks, [{ type: 'text', text: value.markdown }])
})

// ---------------------------------------------------------------------------
// Acceptance: interleaved A → B → A → C
// ---------------------------------------------------------------------------

test('planning prompt demands clustering, merging and statement-style titles', async () => {
  const harness = createHarness({ messages: interleavedMessages(), replies: [OUTLINE_JSON, FILLED_BODY] })
  await harness.run()

  const planPrompt = harness.calls[0].prompt
  assert.match(planPrompt, /按主题聚类/)
  assert.match(planPrompt, /忽略对话轮次的先后顺序/)
  assert.match(planPrompt, /必须合并到同一章节/)
  assert.match(planPrompt, /禁止/)
  assert.match(planPrompt, /用户询问了/)
  assert.match(planPrompt, /只输出 JSON/)
  assert.match(planPrompt, /standard/)

  const fillPrompt = harness.calls[1].prompt
  assert.match(fillPrompt, /不得跨章借用/)
  assert.ok(fillPrompt.includes(INSUFFICIENT))
  assert.match(fillPrompt, /字数预算/)
  assert.match(fillPrompt, /不要在正文中嵌入目录/)
  for (const title of ['向量数据库选型结论', '团队排期安排', '监控告警治理']) {
    assert.ok(fillPrompt.includes(title), `fill prompt should list "${title}"`)
  }
})

test('sections follow the outline, not the conversation timeline', async () => {
  const harness = createHarness({ messages: interleavedMessages(), replies: [OUTLINE_JSON, FILLED_BODY] })
  const value = await harness.run()

  assert.deepEqual(value.outline, [
    { title: '向量数据库选型结论', level: 1, budget: 300 },
    { title: '团队排期安排', level: 1, budget: 200 },
    { title: '监控告警治理', level: 1, budget: 240 },
  ])
  // A clean run carries no notes field at all: the canonical value stays a triple.
  assert.equal(value.notes, undefined)

  const titles = headingLines(value.markdown).map((section) => section.title)
  assert.deepEqual(titles, ['向量数据库选型结论', '团队排期安排', '监控告警治理'])

  const document = value.markdown
  const topicA = document.indexOf('# 向量数据库选型结论')
  const topicB = document.indexOf('# 团队排期安排')
  const topicC = document.indexOf('# 监控告警治理')
  assert.ok(topicA >= 0 && topicB > topicA && topicC > topicB, 'A, B, C must be ordered as planned')

  // A's two fragments land in the same, single section.
  assert.equal((document.match(/^# 向量数据库选型结论$/gm) ?? []).length, 1)
  const sectionA = document.slice(topicA, topicB)
  assert.ok(sectionA.includes('A1-SENTINEL'))
  assert.ok(sectionA.includes('A2-SENTINEL'))
  assert.ok(!document.slice(topicB, topicC).includes('A1-SENTINEL'))

  // B and C are separate top-level chapters.
  assert.ok(document.slice(topicB, topicC).includes('B-SENTINEL'))
  assert.ok(document.slice(topicC).includes('C-SENTINEL'))

  // No meta-descriptive headings and no accidental reordering by time.
  for (const title of titles) {
    assert.doesNotMatch(title, /^(用户|助手)\s*(询问|提问|问|回答|回复)/)
    assert.doesNotMatch(title, /用户询问|助手回答/)
  }
})

test('repeated headings are merged silently, because merging is the designed shape', async () => {
  const outlineRow = JSON.stringify({
    outline: [{ title: '向量数据库选型结论', level: 1, budget: 300 }],
  })
  const body = `# 向量数据库选型结论\n\n第一段。\n\n# 向量数据库选型结论\n\n第二段。`
  const harness = createHarness({ messages: interleavedMessages(), replies: [outlineRow, body] })
  const value = await harness.run()

  assert.equal((value.markdown.match(/^# 向量数据库选型结论$/gm) ?? []).length, 1)
  assert.ok(value.markdown.includes('第一段。'))
  assert.ok(value.markdown.includes('第二段。'))
  assert.equal(value.notes, undefined)
})

// ---------------------------------------------------------------------------
// Acceptance: TOC generation
// ---------------------------------------------------------------------------

test('TOC anchors are GitHub-style, nested, and precede the body', async () => {
  const harness = createHarness({ messages: interleavedMessages(), replies: [OUTLINE_JSON, FILLED_BODY] })
  const value = await harness.run()

  assert.equal(
    value.toc,
    [
      '- [向量数据库选型结论](#向量数据库选型结论)',
      '- [团队排期安排](#团队排期安排)',
      '- [监控告警治理](#监控告警治理)',
    ].join('\n'),
  )

  const lines = value.toc.split('\n')
  assert.equal(lines.length, 3)
  for (const line of lines) {
    assert.match(line, /^- \[.+\]\(#[^()\s]+\)$/)
  }

  // The embedded copy sits at the very top, before the first heading.
  const embedded = value.markdown.indexOf('- [向量数据库选型结论](#向量数据库选型结论)')
  assert.ok(embedded >= 0)
  assert.ok(embedded < value.markdown.indexOf('# 向量数据库选型结论'))
  assert.match(value.markdown, /^> \*\*目录\*\*/)
})

test('TOC nests by heading level and de-duplicates anchors with -1/-2 suffixes', async () => {
  const outline = JSON.stringify({
    outline: [
      { title: '总览', level: 1, budget: 120 },
      { title: '预算口径', level: 2, budget: 120 },
      { title: '排期口径', level: 2, budget: 120 },
      { title: '风险', level: 1, budget: 120 },
    ],
  })
  const body = [
    '# 总览',
    '',
    '总览正文。',
    '',
    '## 预算口径',
    '',
    '预算正文。',
    '',
    '## 排期口径',
    '',
    '排期正文。',
    '',
    '# 风险',
    '',
    '风险正文。',
  ].join('\n')

  const harness = createHarness({ messages: interleavedMessages(), replies: [outline, body] })
  const value = await harness.run()

  assert.equal(
    value.toc,
    [
      '- [总览](#总览)',
      '  - [预算口径](#预算口径)',
      '  - [排期口径](#排期口径)',
      '- [风险](#风险)',
    ].join('\n'),
  )
  assert.match(value.markdown, /^## 预算口径$/m)
  assert.match(value.markdown, /^## 排期口径$/m)

  const duplicateToc = generateToc(
    ['# 安装', '', '正文。', '', '## 安装', '', '正文。', '', '### 安装', '', '正文。'].join('\n'),
  )
  assert.equal(
    duplicateToc,
    [
      '- [安装](#安装)',
      '  - [安装](#安装-1)',
      '    - [安装](#安装-2)',
    ].join('\n'),
  )
})

test('TOC ignores heading-like lines inside fenced code blocks', async () => {
  const markdown = [
    '# 安装',
    '',
    '```bash',
    '# 这不是标题，只是 shell 注释',
    'echo "hello"',
    '```',
    '',
    '## 安装',
    '',
    '```js',
    '// # 也不是标题',
    'console.log(1)',
    '```',
    '',
    '### **加粗** _强调_ <b>标签</b> 与 ~删除线~',
    '',
    '正文。',
  ].join('\n')

  assert.equal(
    generateToc(markdown),
    ['- [安装](#安装)', '  - [安装](#安装-1)', '    - [加粗 强调 标签 与 删除线](#加粗-强调-标签-与-删除线)'].join(
      '\n',
    ),
  )

  // The fenced content survives parsing untouched, so `# 注释` is never a section.
  const titles = parseMarkdownDocument(markdown).sections.map((section) => section.title)
  assert.deepEqual(titles, ['安装', '安装', '加粗 强调 标签 与 删除线'])
  assert.equal(slugifyTitle('  Hello,   World!  '), 'hello-world')
})

// ---------------------------------------------------------------------------
// Degraded but canonical results
// ---------------------------------------------------------------------------

test('a thin session returns an explanatory value without calling the model', async () => {
  const harness = createHarness({
    messages: [userMessage('你好，帮我看一下这个报错。')],
    replies: [],
  })
  const value = await harness.run()

  assert.deepEqual(value.outline, [])
  assert.equal(value.toc, '')
  assert.match(value.markdown, /暂无可整理的会话内容/)
  assert.match(value.markdown, /不足 200 字/)
  assert.equal(value.notes.length, 1)
  assert.equal(harness.calls.length, 0)
})

test('a missing section still returns a value and is flagged', async () => {
  const body = [
    '# 向量数据库选型结论',
    '',
    '选型正文。',
    '',
    '# 监控告警治理',
    '',
    '告警正文。',
  ].join('\n')
  const harness = createHarness({ messages: interleavedMessages(), replies: [OUTLINE_JSON, body] })
  const value = await harness.run()

  assert.equal(value.outline.length, 3)
  assert.ok(value.markdown.includes(`# 团队排期安排\n\n${INSUFFICIENT}`))
  assert.ok(value.notes.some((note) => note.includes('团队排期安排')))
  const titles = headingLines(value.markdown).map((section) => section.title)
  assert.deepEqual(titles, ['向量数据库选型结论', '团队排期安排', '监控告警治理'])
})

test('extra sections outside the outline are appended and reported', async () => {
  const body = `${FILLED_BODY}\n\n## 附录：未列入大纲的讨论\n\n额外内容。`
  const harness = createHarness({ messages: interleavedMessages(), replies: [OUTLINE_JSON, body] })
  const value = await harness.run()

  assert.match(value.markdown, /## 附录：未列入大纲的讨论/)
  assert.ok(value.notes.some((note) => note.includes('大纲之外')))
})

// ---------------------------------------------------------------------------
// Budget handling and manual validation
// ---------------------------------------------------------------------------

test('maxSectionBudget caps every planned section', async () => {
  const expensiveOutline = JSON.stringify({
    outline: [
      { title: '向量数据库选型结论', level: 1, budget: 5000 },
      { title: '团队排期安排', level: 1, budget: 3000 },
    ],
  })
  const harness = createHarness({
    messages: interleavedMessages(),
    replies: [expensiveOutline, FILLED_BODY],
  })
  const value = await harness.run({ maxSectionBudget: 400 })

  for (const entry of value.outline) {
    assert.ok(entry.budget <= 400, `${entry.title} budget ${entry.budget} exceeds cap`)
  }
  assert.ok(value.notes.some((note) => note.includes('maxSectionBudget=400')))
  assert.match(harness.calls[0].prompt, /不得超过 400 字/)
})

test('detailLevel changes the budget guidance in the planning prompt', async () => {
  for (const [detailLevel, marker] of [
    ['concise', /100–200 字/],
    ['standard', /200–400 字/],
    ['detailed', /500–800 字/],
  ]) {
    const harness = createHarness({
      messages: interleavedMessages(),
      replies: [OUTLINE_JSON, FILLED_BODY],
    })
    await harness.run({ detailLevel, includeToc: false })
    assert.match(harness.calls[0].prompt, marker)
    assert.match(harness.calls[1].prompt, new RegExp(`详细程度：${detailLevel}`))
  }
})

test('invalid maxSectionBudget is rejected with a ToolArgsError', async () => {
  const harness = createHarness({ messages: interleavedMessages(), replies: [] })

  for (const bad of [0, -10, 10, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => harness.run({ maxSectionBudget: bad }),
      (error) => {
        assert.equal(error.name, 'ToolArgsError')
        assert.equal(error.code, 'INVALID_ARGS')
        return true
      },
      `maxSectionBudget=${bad} should be rejected`,
    )
  }
  assert.equal(harness.calls.length, 0)
})

test('unknown detailLevel is rejected before any model call', async () => {
  const harness = createHarness({ messages: interleavedMessages(), replies: [] })
  await assert.rejects(
    () => harness.run({ detailLevel: 'verbose' }),
    (error) => {
      assert.equal(error.name, 'ToolArgsError')
      assert.ok(error.violations.some((violation) => violation.includes('detailLevel')))
      return true
    },
  )
  assert.equal(harness.calls.length, 0)
})

test('registered schemas equal the defineTool compilation of the same DSL', () => {
  const harness = createHarness({ messages: interleavedMessages(), replies: [] })

  assert.deepEqual(
    harness.definition.parameters,
    parameterSchemaSpecToJsonSchema(PARAMETER_SPEC),
  )
  assert.deepEqual(
    harness.definition.output.schema,
    valueSchemaSpecToJsonSchema(OUTPUT_SPEC),
  )

  // DSH asserts this subset again on `register` and on every projection.
  assertSupportedJsonSchema(harness.definition.parameters)
  assertSupportedJsonSchema(harness.definition.output.schema)
})

test('the compiled bundle has no runtime @deepseek-ai import', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')

  // A profile-installed bundle cannot resolve DSH packages, so any runtime
  // import here would make the plugin fail to load at enable time.
  assert.doesNotMatch(source, /^\s*import\s[^\n]*from\s+['"]@deepseek-ai\//mu)
  assert.doesNotMatch(source, /^\s*export\s[^\n]*from\s+['"]@deepseek-ai\//mu)
  assert.doesNotMatch(source, /require\(\s*['"]@deepseek-ai\//u)
})

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test('malformed planning JSON is retried once', async () => {
  const harness = createHarness({
    messages: interleavedMessages(),
    replies: ['抱歉，我先解释一下思路：应该按主题分组。', OUTLINE_JSON, FILLED_BODY],
  })
  const value = await harness.run()

  assert.equal(harness.calls.length, 3)
  assert.match(harness.calls[1].prompt, /不是合法 JSON/)
  assert.equal(value.outline.length, 3)
})

test('planning JSON inside a code fence is accepted', async () => {
  const fenced = '```json\n{"outline":[{"title":"向量数据库选型结论","level":1,"budget":300}]}\n```'
  const body = '# 向量数据库选型结论\n\n正文。'
  const harness = createHarness({ messages: interleavedMessages(), replies: [fenced, body] })
  const value = await harness.run()

  assert.deepEqual(value.outline, [{ title: '向量数据库选型结论', level: 1, budget: 300 }])
})

test('model fallback uses the first registered provider when no default is configured', async () => {
  const harness = createHarness({
    messages: interleavedMessages(),
    replies: [OUTLINE_JSON, FILLED_BODY],
    defaultSelection: false,
  })
  await harness.run()

  assert.equal(harness.calls[0].provider, 'fake-provider')
  assert.equal(harness.calls[0].model, 'fake-model')
})

test('reasoning blocks and tool messages never reach the transcript', async () => {
  const messages = [
    userMessage(
      '我们在给知识库选向量数据库，请先给出评估标准。候选是 Milvus、Qdrant 和 pgvector，数据量两千万条，QPS 峰值 300，团队没有专职运维。',
    ),
    assistantMessage(
      '标准分四个维度：召回质量与过滤能力、写入与索引成本、运维复杂度、生态耦合度。两千万条、QPS 300 属于中等规模，pgvector 加 HNSW 能覆盖，复杂过滤会受限。',
      [{ type: 'reasoning', text: 'THINKING-SENTINEL' }],
    ),
    {
      id: 'tool-1',
      role: 'tool',
      content: [{ type: 'text', text: 'TOOL-RESULT-SENTINEL' }],
      source: { kind: 'tool', callId: 'call-9' },
      toolCallId: 'call-9',
    },
    userMessage('再补充一点：我们希望尽量少引入新组件，灰度发布要能按租户维度控制，回滚时间不能超过五分钟。'),
    assistantMessage(
      '那么优先看单二进制部署和过滤表达力：Qdrant 与 pgvector 的组件数最少。若复杂过滤下 p95 延迟超过 50ms，再评估分片方案。',
    ),
  ]
  const harness = createHarness({ messages, replies: [OUTLINE_JSON, FILLED_BODY] })
  await harness.run()

  const prompt = harness.calls[0].prompt
  assert.ok(prompt.includes('两千万条'))
  assert.ok(!prompt.includes('THINKING-SENTINEL'))
  assert.ok(!prompt.includes('TOOL-RESULT-SENTINEL'))
})

test('includeToc=false returns the same toc field without embedding it', async () => {
  const harness = createHarness({ messages: interleavedMessages(), replies: [OUTLINE_JSON, FILLED_BODY] })
  const value = await harness.run({ includeToc: false })

  assert.match(value.toc, /^- \[向量数据库选型结论\]\(#向量数据库选型结论\)$/m)
  assert.doesNotMatch(value.markdown, /^> \*\*目录\*\*$/m)
  assert.equal(value.markdown.indexOf('- [向量数据库选型结论]'), -1)
})

test('an empty outline degrades to an explanatory document', async () => {
  const harness = createHarness({
    messages: interleavedMessages(),
    replies: ['{"outline":[]}'],
  })
  const value = await harness.run()

  assert.deepEqual(value.outline, [])
  assert.equal(value.toc, '')
  assert.match(value.markdown, /未能生成结构化文档/)
  assert.ok(value.notes.length > 0)
  assert.equal(harness.calls.length, 1)
})

test('planning JSON that never parses degrades instead of throwing', async () => {
  const harness = createHarness({
    messages: interleavedMessages(),
    replies: ['抱歉，我先解释一下思路。', '还是不加 JSON，再来一段说明。'],
  })

  // Two attempts, then a canonical value — never an exception.
  const value = await harness.run()
  assert.equal(harness.calls.length, 2)

  assert.deepEqual(value.outline, [])
  assert.equal(value.notes.length, 1)
  assert.match(value.notes[0], /降级/)
  assert.match(value.notes[0], /原样转写/)

  // The degraded document still carries the raw conversation, quoted so its
  // `### 用户` markers cannot be mistaken for headings.
  assert.match(value.markdown, /# 未能生成结构化大纲/)
  assert.ok(value.markdown.includes('两千万条'))
  assert.deepEqual(
    parseMarkdownDocument(value.markdown).sections.map((section) => section.title),
    ['未能生成结构化大纲', '会话原文'],
  )
})

test('an oversized transcript is truncated and reports how much was dropped', async () => {
  const filler = '这是一段用于撑长会话的填充内容，讨论了很多无关细节。'.repeat(3000)
  const messages = [
    userMessage(`先看这段长背景：${filler}`),
    assistantMessage('背景收到，下面开始讨论向量数据库选型。两千万条、QPS 300。'),
    userMessage('给个结论。'),
    assistantMessage('结论是 Qdrant。'),
  ]
  const harness = createHarness({ messages, replies: [OUTLINE_JSON, FILLED_BODY] })
  const value = await harness.run()

  const truncationNote = value.notes.find((note) => note.includes('会话过长'))
  assert.ok(truncationNote, 'truncation must be reported in notes')
  const sizes = /会话过长（(\d+) 字），已裁剪中间 (\d+) 字/.exec(truncationNote)
  assert.ok(sizes, `unexpected note text: ${truncationNote}`)
  assert.ok(Number(sizes[1]) > 60_000)
  assert.ok(Number(sizes[2]) > 0)
})

test('TOC skips ~~~ fences and four-space indented code blocks', () => {
  const markdown = [
    '# 部署',
    '',
    '~~~yaml',
    '# 不是标题：yaml 注释',
    'replicas: 2',
    '~~~',
    '',
    '    # 缩进代码块里的井号也不是标题',
    '',
    '## 回滚',
    '',
    '正文。',
  ].join('\n')

  assert.equal(generateToc(markdown), ['- [部署](#部署)', '  - [回滚](#回滚)'].join('\n'))
  assert.deepEqual(
    parseMarkdownDocument(markdown).sections.map((section) => section.title),
    ['部署', '回滚'],
  )
})

// ---------------------------------------------------------------------------
// Web surface: the composer button and its endpoint
// ---------------------------------------------------------------------------

/** Minimal `http.IncomingMessage` stand-in for the route handler. */
function fakeRequest({
  method = 'POST',
  headers = { host: '127.0.0.1:19387' },
  body = '',
} = {}) {
  const handlers = new Map()
  const request = {
    method,
    headers,
    on(event, listener) {
      const list = handlers.get(event) ?? []
      list.push(listener)
      handlers.set(event, list)
      return request
    },
  }
  queueMicrotask(() => {
    if (body.length > 0) {
      for (const listener of handlers.get('data') ?? []) listener(body)
    }
    for (const listener of handlers.get('end') ?? []) listener()
  })
  return request
}

/** Minimal `http.ServerResponse` stand-in that records status and payload. */
function fakeResponse() {
  const response = {
    status: 0,
    headers: {},
    payload: '',
    writeHead(status, headers = {}) {
      response.status = status
      response.headers = headers
      return response
    },
    end(payload = '') {
      response.payload = payload
      return response
    },
  }
  return response
}

async function invoke(handler, options) {
  const response = fakeResponse()
  await handler(fakeRequest(options), response)
  return { status: response.status, headers: response.headers, body: JSON.parse(response.payload) }
}

test('apply() exposes the composer endpoint on the host Web server', () => {
  const harness = createHarness({ messages: interleavedMessages(), replies: [] })

  assert.equal(harness.routes.length, 1)
  assert.equal(harness.routes[0].kind, 'exact')
  assert.equal(harness.routes[0].path, ROUTE_PATH)
  assert.equal(typeof harness.routes[0].handler, 'function')
})

test('the Web endpoint refuses non-POST, foreign hosts and broken bodies', async () => {
  const harness = createHarness({ messages: interleavedMessages(), replies: [] })
  const handler = createRouteHandler(harness.ctx)

  const notPost = await invoke(handler, { method: 'GET' })
  assert.equal(notPost.status, 405)
  assert.equal(notPost.body.ok, false)

  const foreign = await invoke(handler, { headers: { host: 'evil.example' } })
  assert.equal(foreign.status, 403)

  const crossSite = await invoke(handler, {
    headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSite.status, 403)

  const otherOrigin = await invoke(handler, {
    headers: { host: '127.0.0.1:19387', origin: 'https://evil.example' },
  })
  assert.equal(otherOrigin.status, 403)

  const noHost = await invoke(handler, { headers: {} })
  assert.equal(noHost.status, 403)

  const broken = await invoke(handler, { body: '{ not json' })
  assert.equal(broken.status, 400)
  assert.match(broken.body.error, /not valid JSON/)
})

test('the Web endpoint returns the canonical document for a session id', async () => {
  const harness = createHarness({
    messages: interleavedMessages(),
    replies: [OUTLINE_JSON, FILLED_BODY],
  })
  const result = await invoke(createRouteHandler(harness.ctx), {
    body: JSON.stringify({ sessionId: 'session-1' }),
  })

  assert.equal(result.status, 200)
  assert.equal(result.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.equal(result.headers['Cache-Control'], 'no-store')
  assert.equal(result.body.ok, true)
  assert.equal(result.body.outline.length, 3)
  assert.match(result.body.toc, /^- \[向量数据库选型结论\]\(#向量数据库选型结论\)$/m)
  assert.ok(result.body.markdown.includes('A1-SENTINEL'))
  assert.equal(result.body.notes, undefined)
})

test('the Web endpoint reports unknown and missing sessions', async () => {
  const ctx = {
    sessions: {
      get: () => undefined,
      list: () => [],
    },
  }

  const unknown = await runGenerateRequest(ctx, { sessionId: 'gone' })
  assert.equal(unknown.status, 404)
  assert.match(unknown.body.error, /unknown session/)

  const missing = await runGenerateRequest(ctx, {})
  assert.equal(missing.status, 409)
  assert.equal(missing.body.ok, false)
})

test('invalid Web options are rejected with 400 before any model call', async () => {
  const harness = createHarness({ messages: interleavedMessages(), replies: [] })
  const result = await invoke(createRouteHandler(harness.ctx), {
    body: JSON.stringify({ detailLevel: 'verbose' }),
  })

  assert.equal(result.status, 400)
  assert.match(result.body.error, /detailLevel/)
  assert.equal(harness.calls.length, 0)
})
