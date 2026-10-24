/**
 * Browser half of dsh-session-to-doc: the composer button and its result panel.
 *
 * Loaded through the DSH web module loader (no bundler needed): the factory
 * receives the host's module table and returns a Cordis plugin. React comes
 * from that table — this file must never import it directly.
 *
 * @module dsh-session-to-doc/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-to-doc',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Endpoint registered by the host half. */
    const ENDPOINT = '/session-to-doc/generate'

    const S = {
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: '28px',
        padding: '0 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonBusy: {
        cursor: 'progress',
        opacity: 0.7,
      },
      overlay: {
        position: 'fixed',
        inset: '0',
        background: 'rgba(0, 0, 0, 0.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        padding: '24px',
        overflow: 'auto',
        zIndex: 1000,
      },
      panel: {
        width: 'min(880px, 92vw)',
        maxHeight: '100%',
        margin: 'auto',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.28)',
        overflow: 'hidden',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '12px 16px',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
      },
      title: { flex: '1', fontSize: '14px', fontWeight: 600 },
      action: {
        height: '28px',
        padding: '0 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        cursor: 'pointer',
      },
      /** Scroll host: must be allowed to shrink below its content, or the panel clips instead. */
      content: {
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        minHeight: 0,
      },
      body: {
        margin: 0,
        padding: '16px',
        flex: '1 1 auto',
        minHeight: 0,
        overflow: 'auto',
        overscrollBehavior: 'contain',
        scrollbarWidth: 'thin',
        scrollbarColor: 'var(--dsw-alias-scrollbar-bg-l2) transparent',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: '12.5px',
        lineHeight: 1.6,
      },
      hint: {
        flex: 'none',
        padding: '12px 16px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-tertiary)',
        borderTop: '1px solid var(--dsw-alias-border-l2)',
      },
    }

    /** POST the current session to the host and return the parsed body. */
    async function requestDocument(sessionId, options) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          sessionId,
          detailLevel: options.detailLevel,
          includeToc: options.includeToc,
          maxSectionBudget: options.maxSectionBudget,
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok !== true) {
        throw new Error(body.error || `request failed with ${response.status}`)
      }
      return body
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text)
      }
      return Promise.reject(new Error('clipboard unavailable'))
    }

    function DocumentPanel(props) {
      const [doc, setDoc] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [copied, setCopied] = React.useState(false)

      React.useEffect(() => {
        if (!props.open || props.promise === null) return undefined
        let cancelled = false
        setDoc(null)
        setError(null)
        setCopied(false)
        props.promise
          .then((value) => {
            if (!cancelled) setDoc(value)
          })
          .catch((reason) => {
            if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
          })
        return () => {
          cancelled = true
        }
      }, [props.open, props.promise])

      if (!props.open) return null

      const markdown = doc === null ? '' : String(doc.markdown ?? '')
      const notes = doc !== null && Array.isArray(doc.notes) ? doc.notes : []

      return h(
        'div',
        { style: S.overlay, role: 'dialog', 'aria-modal': 'true' },
        h(
          'div',
          { style: S.panel },
          h(
            'div',
            { style: S.header },
            h('div', { style: S.title }, '会话整理结果'),
            h(
              'button',
              {
                type: 'button',
                style: S.action,
                disabled: doc === null,
                onClick: () => {
                  copyText(markdown)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false))
                },
              },
              copied ? '已复制' : '复制 Markdown',
            ),
            h('button', { type: 'button', style: S.action, onClick: props.onClose }, '关闭'),
          ),
          error !== null
            ? h('div', { style: S.hint }, `生成失败：${error}`)
            : doc === null
              ? h('div', { style: S.hint }, '正在整理当前会话…')
              : h(
                  'div',
                  { style: S.content },
                  h('pre', { style: S.body }, markdown),
                  notes.length > 0 ? h('div', { style: S.hint }, notes.join('；')) : null,
                ),
        ),
      )
    }

    function ComposerButton(props) {
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [promise, setPromise] = React.useState(null)

      const start = () => {
        if (busy) return
        setBusy(true)
        const pending = props.generate()
        // Both the panel and the spinner observe the same request.
        pending.catch(() => {}).finally(() => setBusy(false))
        setPromise(pending)
        setOpen(true)
      }

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            style: busy ? Object.assign({}, S.button, S.buttonBusy) : S.button,
            title: '把当前会话整理成结构化 Markdown 文档',
            'aria-label': '把当前会话整理成结构化 Markdown 文档',
            disabled: busy,
            onClick: start,
          },
          busy ? '整理中…' : '整理成文档',
        ),
        h(DocumentPanel, {
          open,
          promise,
          onClose: () => setOpen(false),
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'dsh-session-to-doc',
              order: 40,
              inject: (sessionId) => ({
                generate: () => requestDocument(sessionId, {}),
              }),
            },
            ComposerButton,
          ),
        )
      },
    }
  },
})
