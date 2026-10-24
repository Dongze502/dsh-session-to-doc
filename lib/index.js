/**
 * session-to-doc — reorganize the current session transcript into a
 * structured Markdown document instead of exporting it in chronological order.
 *
 * Written against the DSH 0.2.x developer-preview contracts
 * (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-llm`).
 * See README.md for the exact package versions this was developed and tested
 * against; those contracts may change between preview releases.
 *
 * @module session-to-doc
 */
/** Plugin name shown by the DSH plugin loader. */
export const name = 'dsh-session-to-doc';
/**
 * Services read by this plugin. Every `ctx.*` service touched inside
 * `apply()` must be listed here or the plugin either fails to load or its
 * tool silently loses that capability.
 *
 * - `tools`    → `ctx.tools.register(...)`
 * - `sessions` → `ctx.sessions` (resolving the current Session)
 * - `llm`      → `ctx.llm.stream(...)` (the two drafting rounds)
 */
export const inject = ['tools', 'sessions', 'llm'];
/** Tool name presented to the model. */
const TOOL_NAME = 'session_to_doc';
/** Fixed model-facing description required by the product contract. */
const DESCRIPTION = '将当前会话中的对话记录重新组织为一份结构化 Markdown 文档，而不是按时间顺序原样导出。适合在用户需要把一段讨论整理成可交付文档时调用。';
/** Below this many non-whitespace characters the transcript is considered too thin to organize. */
const MIN_TRANSCRIPT_CHARS = 200;
/** Hard cap on the transcript handed to the model (characters, not tokens). */
const MAX_TRANSCRIPT_CHARS = 60_000;
/** Hard safety cap for one leaf section when the caller gives no `maxSectionBudget`. */
const MAX_AUTO_SECTION_BUDGET = 2_000;
/** Floor for a requested section budget; smaller values cannot hold a section. */
const MIN_SECTION_BUDGET = 40;
/** Written verbatim when a section has no source material, so the gap stays visible. */
const INSUFFICIENT_MARKER = '[原始对话中相关信息较少]';
/** Default leaf budget, used when the model omits one. */
const DEFAULT_LEAF_BUDGET = {
    concise: 160,
    standard: 300,
    detailed: 600,
};
/**
 * Output DSL, kept only for type-level documentation and for the schema
 * parity test. The registered definition carries {@link OUTPUT_SCHEMA}, the
 * compiled form, because a profile-installed bundle cannot import DSH packages
 * at runtime (see README, "Why this plugin has no runtime imports").
 */
export const OUTPUT_SPEC = {
    type: 'object',
    additionalProperties: false,
    properties: {
        markdown: {
            type: 'string',
            required: true,
            description: '最终完整文档（含或不含 TOC，由 includeToc 决定）。',
        },
        outline: {
            type: 'array',
            required: true,
            description: 'AI 规划出的大纲，供 UI 卡片预览“准备怎么组织”。',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    title: { type: 'string', required: true },
                    level: { type: 'integer', required: true },
                    budget: { type: 'number', required: true },
                },
            },
        },
        toc: {
            type: 'string',
            required: true,
            description: '单独返回的目录字符串，方便用户复制。',
        },
        notes: {
            type: 'array',
            // Optional: omitted when empty so the value stays the original triple.
            description: '非致命提示，例如某章节信息不足、预算被压缩、对话被截断；无提示时不返回该字段。',
            items: { type: 'string' },
        },
    },
};
/** `OUTPUT_SPEC` compiled to the enforced JSON Schema subset. */
const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        markdown: {
            type: 'string',
            description: '最终完整文档（含或不含 TOC，由 includeToc 决定）。',
        },
        outline: {
            type: 'array',
            description: 'AI 规划出的大纲，供 UI 卡片预览“准备怎么组织”。',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    title: { type: 'string' },
                    level: { type: 'integer' },
                    budget: { type: 'number' },
                },
                required: ['title', 'level', 'budget'],
            },
        },
        toc: {
            type: 'string',
            description: '单独返回的目录字符串，方便用户复制。',
        },
        notes: {
            type: 'array',
            description: '非致命提示，例如某章节信息不足、预算被压缩、对话被截断；无提示时不返回该字段。',
            items: { type: 'string' },
        },
    },
    required: ['markdown', 'outline', 'toc'],
};
/**
 * Parameter DSL, kept for `InferArgs` and for the schema parity test; the
 * registered definition carries {@link PARAMETER_SCHEMA}.
 */
export const PARAMETER_SPEC = {
    detailLevel: {
        type: 'string',
        enum: ['concise', 'standard', 'detailed'],
        default: 'standard',
        description: '章节填充的详细程度：concise 更紧凑，standard 按信息密度，detailed 更充分。',
    },
    includeToc: {
        type: 'boolean',
        default: true,
        description: '是否在文档开头生成目录。',
    },
    maxSectionBudget: {
        type: 'number',
        description: '单章节最大字数上限；不传则由 AI 在规划阶段按信息密度自行分配。',
    },
};
/** `PARAMETER_SPEC` compiled to the enforced JSON Schema subset. */
const PARAMETER_SCHEMA = {
    type: 'object',
    properties: {
        detailLevel: {
            type: 'string',
            enum: ['concise', 'standard', 'detailed'],
            default: 'standard',
            description: '章节填充的详细程度：concise 更紧凑，standard 按信息密度，detailed 更充分。',
        },
        includeToc: {
            type: 'boolean',
            default: true,
            description: '是否在文档开头生成目录。',
        },
        maxSectionBudget: {
            type: 'number',
            description: '单章节最大字数上限；不传则由 AI 在规划阶段按信息密度自行分配。',
        },
    },
};
/**
 * Build the error shape DSH's tool pipeline recognizes for bad arguments.
 *
 * `defineTool` throws an imported `ToolArgsError`; a bundle without runtime
 * imports reproduces that contract structurally (`name` + `code` +
 * `violations`), which is what the pipeline reads.
 * @param violations - one message per violation, in check order.
 */
function toolArgsError(violations) {
    const error = new Error(`invalid arguments: ${violations.join('; ')}`);
    error.name = 'ToolArgsError';
    return Object.assign(error, { code: 'INVALID_ARGS', violations });
}
/**
 * Validate the arguments DSH cannot check from the schema alone.
 * @param args - raw model arguments.
 * @returns Path-qualified violations; empty means valid.
 */
function validateArguments(args) {
    const violations = [];
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return ['arguments must be an object'];
    }
    const raw = args;
    if (raw.detailLevel !== undefined &&
        raw.detailLevel !== 'concise' &&
        raw.detailLevel !== 'standard' &&
        raw.detailLevel !== 'detailed') {
        violations.push('arguments.detailLevel must be one of "concise", "standard", "detailed"');
    }
    if (raw.includeToc !== undefined && typeof raw.includeToc !== 'boolean') {
        violations.push('arguments.includeToc must be a boolean');
    }
    if (raw.maxSectionBudget !== undefined && typeof raw.maxSectionBudget !== 'number') {
        violations.push('arguments.maxSectionBudget must be a number');
    }
    return violations;
}
/**
 * Register the `session_to_doc` tool.
 * @param ctx - plugin context carrying the tools, sessions and llm services.
 */
export function apply(ctx) {
    /**
     * A plain `ToolDefinition` rather than `defineTool({...})`.
     *
     * `defineTool` is pure sugar: it compiles the DSL and wraps `execute` with
     * `validateArgs`. It lives in `@deepseek-ai/dsh-tools`, which a
     * profile-installed bundle cannot resolve at runtime, so this plugin hands
     * the registry the same compiled JSON Schema and performs the equivalent
     * checks itself. Types still come from `defineTool`'s `InferArgs`.
     */
    const definition = {
        name: TOOL_NAME,
        description: DESCRIPTION,
        // `ToolSchema.parameters` is the provider-facing raw JSON Schema object;
        // DSH asserts the same enforced subset on it as `assertSupportedJsonSchema`.
        parameters: PARAMETER_SCHEMA,
        output: {
            schema: OUTPUT_SCHEMA,
            render(_args, value) {
                // The canonical value stays the source of truth; render only projects
                // the Markdown string for the model.
                return [{ type: 'text', text: value.markdown }];
            },
        },
        async execute(rawArgs, exec) {
            const options = normalizeOptions(rawArgs);
            return generateDocument(ctx, {
                session: resolveSession(ctx, exec.agent?.session),
                ...options,
                signal: exec.signal,
            });
        },
    };
    ctx.tools.register(definition);
    // The Web button is an optional surface: profiles without a web server (or
    // before the client is loaded) must keep the tool working. `ctx.inject`
    // waits for the service instead of making it a hard requirement.
    ctx.inject(['webServer'], (webCtx) => {
        const webServer = webCtx.webServer;
        if (webServer === undefined)
            return;
        // register() returns a disposer and does not own an effect itself; tie the
        // route to this plugin's lifetime so a reload can register it again.
        webCtx.effect(() => webServer.register({
            kind: 'exact',
            path: ROUTE_PATH,
            handler: createRouteHandler(ctx),
        }));
    });
}
/** The single HTTP surface used by the Web button. */
export const ROUTE_PATH = '/session-to-doc/generate';
/**
 * Run the full pipeline once.
 *
 * Shared by the agent tool and the Web button so both paths produce the same
 * document for the same arguments (no drifted implementations).
 * @param ctx - plugin context with the sessions and llm services.
 * @param input - session, detail level and budget settings.
 * @returns the canonical document value.
 */
export async function generateDocument(ctx, input) {
    const detailLevel = input.detailLevel ?? 'standard';
    const includeToc = input.includeToc ?? true;
    const maxSectionBudget = input.maxSectionBudget;
    const signal = input.signal;
    signal?.throwIfAborted();
    const transcript = extractTranscript(input.session);
    if (transcript.effectiveChars < MIN_TRANSCRIPT_CHARS) {
        return thinSessionValue(transcript);
    }
    const selection = await resolveModelSelection(ctx);
    // Round 1 — cluster and plan. A model that cannot produce parseable
    // JSON twice is a business-level failure, not an infrastructure one:
    // degrade to a chronological transcript and keep the canonical shape.
    const plan = await planOutline(ctx, {
        selection,
        transcript: transcript.text,
        detailLevel,
        maxSectionBudget,
        signal,
    });
    if (!plan.ok) {
        return degradedPlanValue(transcript, includeToc, plan.reason);
    }
    const outline = plan.outline;
    if (outline.length === 0) {
        return {
            markdown: buildEmptyPlanMarkdown(transcript),
            outline: [],
            toc: '',
            notes: ['模型没有规划出任何章节；未生成结构化文档。'],
        };
    }
    const notes = [];
    const { outline: finalOutline, clamped } = enforceBudgetCap(outline, maxSectionBudget);
    if (clamped > 0) {
        notes.push(`已按 maxSectionBudget=${maxSectionBudget} 压缩 ${clamped} 个章节的预算。`);
    }
    if (transcript.truncated) {
        notes.push(`会话过长（${transcript.originalChars} 字），已裁剪中间 ${transcript.omittedChars} 字；部分主题可能不完整。`);
    }
    // Round 2 — fill each section.
    const draft = await fillSections(ctx, {
        selection,
        transcript: transcript.text,
        outline: finalOutline,
        detailLevel,
        signal,
    });
    const reconciled = reconcileSections(draft, finalOutline);
    notes.push(...reconciled.notes);
    const toc = generateToc(reconciled.markdown);
    const body = reconciled.markdown;
    const markdown = includeToc && toc.length > 0 ? `> **目录**\n\n${toc}\n\n${body}` : body;
    if (includeToc && toc.length === 0) {
        notes.push('正文中没有可识别的标题，未生成目录。');
    }
    return notes.length > 0
        ? { markdown, outline: finalOutline, toc, notes }
        : { markdown, outline: finalOutline, toc };
}
/**
 * Apply defaults and the cross-field rules, reporting violations the same way
 * the tool pipeline does.
 * @param raw - model arguments or a Web request payload.
 * @returns normalized options; throws `ToolArgsError`-shaped errors.
 */
function normalizeOptions(raw) {
    const violations = validateArguments(raw);
    if (violations.length > 0)
        throw toolArgsError(violations);
    const args = raw;
    const maxSectionBudget = args.maxSectionBudget;
    // Constraints the schema DSL cannot express: a positive, finite, and
    // large-enough budget. Reported like a schema violation.
    if (maxSectionBudget !== undefined) {
        if (!Number.isFinite(maxSectionBudget) || maxSectionBudget <= 0) {
            throw toolArgsError(['arguments.maxSectionBudget must be a positive finite number of characters']);
        }
        if (maxSectionBudget < MIN_SECTION_BUDGET) {
            throw toolArgsError([
                `arguments.maxSectionBudget must be at least ${MIN_SECTION_BUDGET} characters`,
            ]);
        }
    }
    return {
        detailLevel: args.detailLevel ?? 'standard',
        includeToc: args.includeToc ?? true,
        maxSectionBudget,
    };
}
// ---------------------------------------------------------------------------
// Web surface (the composer button)
// ---------------------------------------------------------------------------
/** Largest accepted request body; the payload is only a few short fields. */
const MAX_REQUEST_BYTES = 64 * 1024;
/** Loopback hostnames the Web surface answers to. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/**
 * Resolve the session and run the pipeline for one Web request.
 *
 * Exported separately from the socket handler so tests drive it directly.
 * @param ctx - plugin context.
 * @param payload - parsed JSON body: `sessionId?`, plus tool arguments.
 * @returns status + JSON body, including the canonical document fields.
 */
export async function runGenerateRequest(ctx, payload) {
    let options;
    try {
        options = normalizeOptions(payload ?? {});
    }
    catch (error) {
        return { status: 400, body: { ok: false, error: messageOf(error) } };
    }
    const record = typeof payload === 'object' && payload !== null ? payload : {};
    const requested = record.sessionId;
    let session;
    if (typeof requested === 'string' && requested.length > 0) {
        const found = ctx.sessions.get(requested);
        if (found === undefined) {
            return { status: 404, body: { ok: false, error: `unknown session: ${requested}` } };
        }
        session = found;
    }
    else {
        try {
            session = resolveSession(ctx, undefined);
        }
        catch (error) {
            return { status: 409, body: { ok: false, error: messageOf(error) } };
        }
    }
    try {
        const value = await generateDocument(ctx, { session, ...options });
        return { status: 200, body: { ok: true, ...value } };
    }
    catch (error) {
        return { status: 500, body: { ok: false, error: messageOf(error) } };
    }
}
/**
 * Build the HTTP handler registered on the host Web server.
 * @param ctx - plugin context.
 * @returns a `(req, res)` handler for {@link ROUTE_PATH}.
 */
export function createRouteHandler(ctx) {
    return async (req, res) => {
        const request = req;
        const response = res;
        if (!isLoopbackRequest(request)) {
            sendJson(response, 403, { ok: false, error: 'loopback only' });
            return;
        }
        if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
            sendJson(response, 405, { ok: false, error: 'method not allowed' });
            return;
        }
        let payload;
        try {
            payload = await readJsonBody(request);
        }
        catch (error) {
            sendJson(response, 400, { ok: false, error: messageOf(error) });
            return;
        }
        let result;
        try {
            result = await runGenerateRequest(ctx, payload);
        }
        catch (error) {
            result = { status: 500, body: { ok: false, error: messageOf(error) } };
        }
        sendJson(response, result.status, result.body);
    };
}
/**
 * Whether a request may trigger a document generation.
 *
 * This endpoint spends model calls, so it is stricter than a read route:
 * the request must arrive on a loopback authority, must not be cross-site,
 * and any `Origin` must match the `Host` it was sent to. Anything unparseable
 * is rejected — failing closed matters more than convenience here.
 * @param request - the incoming request.
 * @returns true when the request is same-origin and local.
 */
function isLoopbackRequest(request) {
    const host = firstHeader(request.headers, 'host');
    if (host === undefined || host === '')
        return false;
    let authority;
    try {
        const parsed = new URL(`http://${host}`);
        authority = parsed.host.toLowerCase();
        if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()))
            return false;
    }
    catch {
        return false;
    }
    const fetchSite = (firstHeader(request.headers, 'sec-fetch-site') ?? '').toLowerCase();
    if (fetchSite === 'cross-site' || fetchSite === 'cross-origin')
        return false;
    const origin = firstHeader(request.headers, 'origin');
    if (origin !== undefined && origin !== '') {
        try {
            if (new URL(origin).host.toLowerCase() !== authority)
                return false;
        }
        catch {
            return false;
        }
    }
    return true;
}
function firstHeader(headers, name) {
    if (headers === undefined)
        return undefined;
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== name)
            continue;
        return Array.isArray(value) ? value[0] : value;
    }
    return undefined;
}
async function readJsonBody(request) {
    const chunks = [];
    let size = 0;
    await new Promise((resolve, reject) => {
        request.on('data', (chunk) => {
            const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
            size += text.length;
            if (size > MAX_REQUEST_BYTES) {
                reject(new Error('request body too large'));
                return;
            }
            chunks.push(text);
        });
        request.on('end', () => resolve());
        request.on('error', (error) => reject(error));
    });
    const text = chunks.join('');
    if (text.trim() === '')
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error('request body is not valid JSON');
    }
}
function sendJson(response, status, body) {
    const text = JSON.stringify(body);
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': String(new TextEncoder().encode(text).length),
    });
    response.end(text);
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Resolve the session being organized, preferring the executing agent's session. */
function resolveSession(ctx, session) {
    if (session !== undefined)
        return session;
    // A tool invoked outside an agent still has a "current" session: the most
    // recently appended one. This keeps the tool usable from direct harness calls.
    let newest;
    for (const candidate of ctx.sessions.list()) {
        if (newest === undefined || candidate.seq > newest.seq)
            newest = candidate;
    }
    if (newest === undefined) {
        throw new Error('session-to-doc: no active session is available');
    }
    return newest;
}
/**
 * Extract the conversation as plain text: user messages and assistant final
 * replies only. Tool calls, tool results, reasoning blocks, images and files
 * are intentionally excluded from the MVP extraction.
 */
export function extractTranscript(session) {
    const lines = [];
    let userMessages = 0;
    let assistantMessages = 0;
    for (const message of session.deriveMessages()) {
        const text = messageText(message);
        if (text.length === 0)
            continue;
        if (message.role === 'user') {
            userMessages += 1;
            lines.push(`### 用户\n\n${text}`);
        }
        else if (message.role === 'assistant') {
            assistantMessages += 1;
            lines.push(`### 助手\n\n${text}`);
        }
    }
    const joined = lines.join('\n\n');
    const { text, truncated, omittedChars } = truncateMiddle(joined, MAX_TRANSCRIPT_CHARS);
    return {
        text,
        effectiveChars: countEffectiveChars(joined),
        originalChars: joined.length,
        truncated,
        omittedChars,
        userMessages,
        assistantMessages,
    };
}
/** Visible text of one message; non-text blocks are skipped. */
function messageText(message) {
    if (message.role !== 'user' && message.role !== 'assistant')
        return '';
    const parts = [];
    for (const block of message.content) {
        if (block.type === 'text' && block.text.trim().length > 0) {
            parts.push(block.text.trim());
        }
    }
    return parts.join('\n\n');
}
function countEffectiveChars(text) {
    return text.replace(/\s+/gu, '').length;
}
/** Keep both ends of an oversized transcript, because conclusions cluster at the end. */
function truncateMiddle(text, max) {
    if (text.length <= max)
        return { text, truncated: false, omittedChars: 0 };
    const head = Math.floor(max * 0.65);
    const tail = Math.floor(max * 0.3);
    const omitted = text.length - head - tail;
    return {
        text: `${text.slice(0, head)}\n\n[…会话中间部分因长度限制被省略（${omitted} 字）…]\n\n${text.slice(-tail)}`,
        truncated: true,
        omittedChars: omitted,
    };
}
/** Canonical result for a session that does not carry enough material. */
function thinSessionValue(transcript) {
    const markdown = [
        '# 暂无可整理的会话内容',
        '',
        `当前会话的有效文本不足 ${MIN_TRANSCRIPT_CHARS} 字，未生成结构化文档。请先展开讨论，再重新调用本工具。`,
        '',
        `- 有效文本：${transcript.effectiveChars} 字`,
        `- 用户消息：${transcript.userMessages} 条`,
        `- 助手消息：${transcript.assistantMessages} 条`,
    ].join('\n');
    return {
        markdown,
        outline: [],
        toc: '',
        notes: [`会话文本过短（${transcript.effectiveChars} 字），已跳过规划与填充。`],
    };
}
function buildEmptyPlanMarkdown(transcript) {
    return [
        '# 未能生成结构化文档',
        '',
        '模型没有返回可用的章节大纲，因此没有写正文。会话原文没有丢失，可以重试。',
        '',
        `- 有效文本：${transcript.effectiveChars} 字`,
    ].join('\n');
}
/**
 * Canonical result when the planning round never produced parseable JSON.
 * The transcript is quoted verbatim (not fenced) so its `### 用户` markers stay
 * visible text instead of turning into headings the TOC would pick up.
 */
function degradedPlanValue(transcript, includeToc, reason) {
    const quoted = transcript.text
        .split('\n')
        .map((line) => (line.length === 0 ? '>' : `> ${line}`))
        .join('\n');
    const body = [
        '# 未能生成结构化大纲',
        '',
        '模型两次都没有返回可解析的大纲，本次已降级为按时间顺序的原样转写；如需结构化文档，请重试。',
        '',
        '## 会话原文',
        '',
        quoted,
    ].join('\n');
    const toc = generateToc(body);
    return {
        markdown: includeToc && toc.length > 0 ? `> **目录**\n\n${toc}\n\n${body}` : body,
        outline: [],
        toc,
        notes: [`大纲规划失败（${reason}），已降级为原样转写。`],
    };
}
function isModelSelection(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const candidate = value;
    return (typeof candidate.provider === 'string' &&
        candidate.provider.length > 0 &&
        typeof candidate.model === 'string' &&
        candidate.model.length > 0);
}
/**
 * Pick the model used for planning and filling. The agent's configured default
 * is preferred; otherwise fall back to the first registered provider/model.
 */
async function resolveModelSelection(ctx) {
    const service = ctx.get('agentDefaultModel');
    const selected = typeof service?.currentSelection === 'function' ? service.currentSelection() : service?.selection;
    if (isModelSelection(selected))
        return selected;
    const provider = ctx.llm.listProviders()[0];
    if (provider === undefined) {
        throw new Error('session-to-doc: no LLM provider is registered');
    }
    const models = await ctx.llm.listModels(provider.id);
    const first = models[0];
    if (first === undefined) {
        throw new Error(`session-to-doc: provider "${provider.id}" advertises no models`);
    }
    return { provider: provider.id, model: first.id };
}
async function runModel(ctx, selection, prompt, signal) {
    const options = {
        provider: selection.provider,
        model: selection.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        temperature: 0.2,
        signal,
    };
    let text = '';
    let finish;
    for await (const chunk of ctx.llm.stream(options)) {
        if (chunk.type === 'text-delta') {
            text += chunk.text;
        }
        else if (chunk.type === 'finish') {
            finish = chunk;
        }
    }
    if (finish === undefined) {
        throw new Error('session-to-doc: LLM stream ended without a terminal finish chunk');
    }
    const reason = finish.reason;
    if (reason.kind === 'error' || reason.kind === 'aborted') {
        throw new Error(`session-to-doc: LLM call failed (${reason.failure.code}): ${reason.failure.message}`);
    }
    return { text, truncated: reason.kind === 'max-tokens' };
}
async function planOutline(ctx, input) {
    const prompt = buildPlanPrompt(input);
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const instruction = attempt === 0
            ? prompt
            : `${prompt}\n\n注意：上一次输出不是合法 JSON。这次只输出一个 JSON 对象，形如 {"outline":[{"title":"…","level":1,"budget":300}]}，不要解释、不要代码块围栏。`;
        const turn = await runModel(ctx, input.selection, instruction, input.signal);
        try {
            return { ok: true, outline: normalizeOutline(parseOutlineJson(turn.text), input) };
        }
        catch (error) {
            lastError = error;
        }
    }
    // A model that keeps returning prose is a business-level miss, not an
    // infrastructure failure: the caller gets a canonical degraded value.
    return {
        ok: false,
        reason: lastError instanceof Error ? lastError.message : String(lastError),
    };
}
function buildPlanPrompt(input) {
    const detail = input.detailLevel === 'concise'
        ? 'concise：预算整体压低，叶子章节通常 100–200 字，只保留结论与关键事实。'
        : input.detailLevel === 'detailed'
            ? 'detailed：预算放宽，信息密集的叶子章节可分配到 500–800 字，保留背景、取舍和示例。'
            : 'standard：预算按信息密度正常分配，叶子章节通常 200–400 字。';
    const cap = input.maxSectionBudget === undefined
        ? ''
        : `\n所有叶子章节的预算都不得超过 ${input.maxSectionBudget} 字（这是调用方给出的硬上限）。\n`;
    return `你收到一段对话记录。你的任务不是按时间顺序复述它，而是把它重组为一份结构化文档。先只输出大纲，不要写正文。要求：
1）按主题聚类，忽略对话轮次的先后顺序。同一个主题如果在对话中被其他话题打断过，必须合并到同一章节。
2）每个章节标题必须是陈述性、可交付的，禁止“用户询问了…”“助手回答了…”这类元描述。
3）用嵌套编号列表表示层级，最多三级（对应 JSON 中的 level 1/2/3）。
4）为每个叶子章节分配一个建议字数预算（基于该主题在对话中的信息密度；如果调用方给了 maxSectionBudget，所有预算不得超过该值）。
5）只输出 JSON：{ outline: [{ title, level, budget }] }，不要输出任何额外文字。

方法：先在脑中把对话片段按主题聚类，再为每个聚类命名，最后才决定层级和顺序。绝对不要按照对话出现的轮次来排列章节。

详细程度：${detail}
${cap}
对话记录如下：
<<<
${input.transcript}
>>>`;
}
/** Parse the planning JSON, tolerating code fences and surrounding prose. */
export function parseOutlineJson(text) {
    const withoutFences = text
        .split('\n')
        .filter((line) => !/^\s*(```|~~~)/.test(line))
        .join('\n');
    const start = withoutFences.indexOf('{');
    const end = withoutFences.lastIndexOf('}');
    if (start < 0 || end <= start) {
        throw new Error('回复中没有 JSON 对象');
    }
    const parsed = JSON.parse(withoutFences.slice(start, end + 1));
    if (parsed === null || typeof parsed !== 'object') {
        throw new Error('JSON 根值不是对象');
    }
    const outline = parsed.outline;
    if (!Array.isArray(outline)) {
        throw new Error('JSON 中缺少 outline 数组');
    }
    return outline.map((item) => {
        const entry = (item ?? {});
        return {
            title: typeof entry.title === 'string' ? entry.title : '',
            level: typeof entry.level === 'number' ? entry.level : 1,
            budget: typeof entry.budget === 'number' ? entry.budget : 0,
        };
    });
}
/** Clean and bound the model's outline: titles, levels, budgets, section count. */
export function normalizeOutline(raw, input) {
    const cleaned = raw
        .map((item) => ({ ...item, title: cleanTitle(item.title) }))
        .filter((item) => item.title.length > 0);
    // Bound the number of sections so one runaway plan cannot explode the output.
    const capped = cleaned.slice(0, 40);
    if (capped.length === 0)
        return [];
    const minLevel = Math.min(...capped.map((item) => clampInteger(item.level, 1, 3)));
    // Only the automatic ceiling is applied here. A caller-provided
    // `maxSectionBudget` is enforced later by `enforceBudgetCap`, which also
    // reports how many sections it had to shrink.
    const budgetCap = MAX_AUTO_SECTION_BUDGET;
    let previousLevel = 0;
    const result = [];
    for (const item of capped) {
        let level = clampInteger(item.level, 1, 3) - (minLevel - 1);
        level = clampInteger(level, 1, 3);
        // Never jump down more than one level at a time; that keeps headings a tree.
        if (previousLevel > 0 && level > previousLevel + 1)
            level = previousLevel + 1;
        const fallback = DEFAULT_LEAF_BUDGET[input.detailLevel];
        const rawBudget = Number.isFinite(item.budget) && item.budget > 0 ? item.budget : fallback;
        const budget = clampInteger(rawBudget, MIN_SECTION_BUDGET, Math.max(budgetCap, MIN_SECTION_BUDGET));
        result.push({ title: item.title, level, budget });
        previousLevel = level;
    }
    return result;
}
/** Count sections whose budget exceeded the caller's cap, and clamp them. */
function enforceBudgetCap(outline, maxSectionBudget) {
    if (maxSectionBudget === undefined)
        return { outline, clamped: 0 };
    let clamped = 0;
    const result = outline.map((entry) => {
        if (entry.budget <= maxSectionBudget)
            return entry;
        clamped += 1;
        return { ...entry, budget: maxSectionBudget };
    });
    return { outline: result, clamped };
}
/** Round 2: ask for the full Markdown body, one section per leaf. */
async function fillSections(ctx, input) {
    const outlineLines = input.outline
        .map((entry) => `${'  '.repeat(entry.level - 1)}- level ${entry.level}，预算 ${entry.budget} 字：${entry.title}`)
        .join('\n');
    const prompt = `基于以下大纲，为每个叶子章节撰写正文。约束：
1）每一章只能使用对话记录中与该主题直接相关的内容，不得跨章借用。
2）如果某章信息不足，写 ${INSUFFICIENT_MARKER}，不要编造。
3）遵守每个章节的字数预算；超预算时优先保留具体结论和事实，删减过渡性表述。
4）输出完整的 Markdown 正文，用 #/##/### 控制层级；标题文本必须与大纲完全一致。
5）不要在正文中嵌入目录（TOC），TOC 由系统在下一步生成。
6）严格按大纲顺序输出，不要新增大纲之外的章节。

详细程度：${input.detailLevel}

大纲（缩进表示层级）：
${outlineLines}

对话记录如下：
<<<
${input.transcript}
>>>`;
    const turn = await runModel(ctx, input.selection, prompt, input.signal);
    const markdown = stripOuterFence(turn.text).trim();
    if (markdown.length === 0) {
        throw new Error('session-to-doc: filling round returned an empty document');
    }
    return markdown;
}
/** Remove a single Markdown fence wrapped around the whole response. */
function stripOuterFence(text) {
    const trimmed = text.trim();
    const match = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/u.exec(trimmed);
    return match?.[1] ?? trimmed;
}
/**
 * Rebuild the document from the authoritative outline: sections are reordered
 * to match the plan, repeated titles are merged into one section, and missing
 * leaves receive the explicit insufficiency marker.
 */
export function reconcileSections(markdown, outline) {
    const parsed = parseMarkdownDocument(markdown);
    const notes = [];
    const byTitle = new Map();
    for (const section of parsed.sections) {
        const key = normalizeTitleKey(section.title);
        const list = byTitle.get(key);
        if (list === undefined)
            byTitle.set(key, [section]);
        else
            list.push(section);
    }
    const used = new Set();
    const blocks = [];
    const missing = [];
    outline.forEach((entry, index) => {
        const isLeaf = !hasDeeperSuccessor(outline, index);
        const matches = (byTitle.get(normalizeTitleKey(entry.title)) ?? []).filter((section) => !used.has(section));
        let body = '';
        if (matches.length > 1) {
            // Merging the same topic back into one chapter is the intended shape, not
            // a degraded result, so it does not produce a note.
            body = matches.map((section) => section.body.trim()).filter(Boolean).join('\n\n');
        }
        else if (matches.length === 1) {
            body = matches[0].body.trim();
        }
        for (const section of matches)
            used.add(section);
        if (body.length === 0 && isLeaf) {
            body = INSUFFICIENT_MARKER;
            missing.push(entry.title);
        }
        blocks.push(`${'#'.repeat(entry.level)} ${entry.title}${body.length > 0 ? `\n\n${body}` : ''}`);
    });
    if (missing.length > 0) {
        notes.push(`以下章节在模型正文中缺失，已用占位标记补齐：${missing.join('、')}`);
    }
    const leftovers = parsed.sections.filter((section) => !used.has(section));
    if (leftovers.length > 0) {
        notes.push(`模型额外产出了 ${leftovers.length} 个大纲之外的小节，已追加到文末。`);
        for (const section of leftovers) {
            const level = clampInteger(section.level, 1, 3);
            blocks.push(`${'#'.repeat(level)} ${section.title}${section.body.trim() ? `\n\n${section.body.trim()}` : ''}`);
        }
    }
    const preamble = parsed.preamble.trim();
    const document = (preamble.length > 0 ? [preamble, ...blocks] : blocks).join('\n\n');
    return { markdown: document, notes };
}
function hasDeeperSuccessor(outline, index) {
    const current = outline[index];
    if (current === undefined)
        return false;
    for (let next = index + 1; next < outline.length; next += 1) {
        const candidate = outline[next];
        if (candidate === undefined)
            continue;
        if (candidate.level <= current.level)
            return false;
        return true;
    }
    return false;
}
/**
 * A fence may be indented by at most three spaces (CommonMark); four or more
 * spaces start an indented code block instead, so its `#` lines are never
 * headings and never toggle fence state.
 */
const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/u;
/** An ATX heading may be indented by at most three spaces. */
const HEADING_LINE = /^( {0,3})(#{1,6})\s+(.*?)\s*$/u;
/** Split Markdown into ATX-heading sections while ignoring `#` lines inside fenced code. */
export function parseMarkdownDocument(markdown) {
    const lines = markdown.split(/\r?\n/u);
    const sections = [];
    let preamble = [];
    let current;
    let fence;
    for (const line of lines) {
        const fenceMatch = FENCE_LINE.exec(line);
        if (fence !== undefined) {
            appendLine(line);
            if (fenceMatch !== null &&
                fenceMatch[2].startsWith(fence.marker) &&
                fenceMatch[2].length >= fence.length) {
                fence = undefined;
            }
            continue;
        }
        if (fenceMatch !== null) {
            fence = { marker: fenceMatch[2][0], length: fenceMatch[2].length };
            appendLine(line);
            continue;
        }
        const heading = HEADING_LINE.exec(line);
        if (heading !== null) {
            const title = cleanTitle(heading[3].replace(/\s+#+\s*$/u, ''));
            current = { title, level: heading[2].length, body: '' };
            sections.push(current);
            continue;
        }
        appendLine(line);
    }
    function appendLine(line) {
        if (current === undefined)
            preamble.push(line);
        else
            current.body = current.body.length === 0 ? line : `${current.body}\n${line}`;
    }
    return { preamble: preamble.join('\n'), sections };
}
/** Strip list markers, heading hashes and meta-descriptive prefixes from a title. */
export function cleanTitle(raw) {
    let title = raw.replace(/\s+/gu, ' ').trim();
    title = title.replace(/^#{1,6}\s+/u, '');
    title = title.replace(/^\d+(?:\.\d+)*[.)、]\s*/u, '');
    title = title.replace(/^[-*+]\s+/u, '');
    title = stripInlineMarkup(title);
    title = title.replace(/^(?:用户|助手|提问者|回答者)\s*(?:询问|提问|问|回答|回复|提到|说明|指出|表示)\s*[:：]?\s*/u, '');
    return title.trim();
}
/**
 * Remove the inline markup that GitHub renders as styling rather than text:
 * HTML tags, paired emphasis markers and stray `*`/`~` characters. Underscores
 * inside words (snake_case identifiers) are preserved.
 */
function stripInlineMarkup(input) {
    return input
        .replace(/<[^>]*>/gu, '')
        .replace(/\*\*(.+?)\*\*/gu, '$1')
        .replace(/__(.+?)__/gu, '$1')
        .replace(/~~(.+?)~~/gu, '$1')
        .replace(/(^|[\s(])\*([^*]+)\*(?=$|[\s).,])/gu, '$1$2')
        .replace(/(^|[\s(])_([^_]+)_(?=$|[\s).,])/gu, '$1$2')
        .replace(/[*~]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}
/** Case/punctuation-insensitive key used to merge headings that name the same section. */
function normalizeTitleKey(title) {
    return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
// ---------------------------------------------------------------------------
// Table of contents
// ---------------------------------------------------------------------------
/**
 * GitHub-style anchor slug: lowercase, strip HTML tags and emphasis markers,
 * keep letters/numbers/spaces/hyphens, then turn spaces into hyphens.
 */
export function slugifyTitle(title) {
    const withoutHtml = title.replace(/<[^>]*>/gu, '');
    const withoutEmphasis = withoutHtml.replace(/[*_~]/gu, '');
    const lowered = withoutEmphasis.toLowerCase();
    const kept = Array.from(lowered)
        .filter((char) => /[\p{L}\p{N}\s-]/u.test(char))
        .join('');
    const slug = kept.trim().replace(/\s+/gu, '-');
    return slug.length > 0 ? slug : 'section';
}
/**
 * Build a nested Markdown list of links from the document headings. Heading
 * lines inside fenced code blocks are ignored; duplicate titles receive
 * `-1`, `-2`, … suffixes so every anchor stays unique.
 */
export function generateToc(markdown) {
    const headings = extractHeadings(markdown);
    if (headings.length === 0)
        return '';
    const minLevel = Math.min(...headings.map((heading) => heading.level));
    const seen = new Map();
    const lines = headings.map((heading) => {
        const base = slugifyTitle(heading.title);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const slug = count === 0 ? base : `${base}-${count}`;
        const indent = '  '.repeat(heading.level - minLevel);
        return `${indent}- [${escapeLinkText(heading.title)}](#${slug})`;
    });
    return lines.join('\n');
}
function escapeLinkText(title) {
    return title.replace(/[[\]]/gu, (match) => `\\${match}`);
}
function extractHeadings(markdown) {
    const headings = [];
    let fence;
    for (const line of markdown.split(/\r?\n/u)) {
        const fenceMatch = FENCE_LINE.exec(line);
        if (fence !== undefined) {
            if (fenceMatch !== null &&
                fenceMatch[2].startsWith(fence.marker) &&
                fenceMatch[2].length >= fence.length) {
                fence = undefined;
            }
            continue;
        }
        if (fenceMatch !== null) {
            fence = { marker: fenceMatch[2][0], length: fenceMatch[2].length };
            continue;
        }
        const heading = HEADING_LINE.exec(line);
        if (heading === null)
            continue;
        const title = cleanTitle(heading[3].replace(/\s+#+\s*$/u, ''));
        if (title.length === 0)
            continue;
        headings.push({ level: heading[2].length, title });
    }
    return headings;
}
// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
function clampInteger(value, min, max) {
    const rounded = Number.isFinite(value) ? Math.round(value) : min;
    return Math.min(Math.max(rounded, min), max);
}
/** Pure helpers exposed for tests; not part of the plugin's public contract. */
export const internals = {
    extractTranscript,
    parseOutlineJson,
    normalizeOutline,
    reconcileSections,
    parseMarkdownDocument,
    generateToc,
    slugifyTitle,
    cleanTitle,
    truncateMiddle,
    countEffectiveChars,
    normalizeOptions,
    readJsonBody,
    isLoopbackRequest,
};
