/**
 * Smoke test for the browser half: load client/client.js against a fake
 * __ModuleLoader__ and a stub react, then walk the plugin it registers.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')

let registered = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      registered = definition
    },
  },
}

// Evaluate exactly like the browser would: a module body calling loader.load().
new Function('window', source)(globalThis.window)

assert.ok(registered, 'client module must call __ModuleLoader__.load')
assert.equal(registered.id, 'dsh-session-to-doc')

const h = (type, props, ...children) => ({ type, props, children })
const React = { createElement: h, Fragment: Symbol('Fragment'), useState: () => [null, () => {}], useEffect: () => {} }

const slotsCalls = []
const ctx = {
  slots: {
    inject(name, factory) {
      slotsCalls.push({ name, factory })
      return () => {}
    },
    register(entry, Component) {
      return { entry, Component }
    },
  },
  effect(factory) {
    return factory()
  },
}

const plugin = registered.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

assert.deepEqual(plugin.inject, ['slots'])
plugin.apply(ctx)

assert.equal(slotsCalls.length, 1)
assert.equal(slotsCalls[0].name, 'conversation.composer.dock')

const registration = slotsCalls[0].factory()
assert.equal(registration.entry.name, 'conversation.composer.dock')
assert.equal(registration.entry.id, 'dsh-session-to-doc')
assert.equal(registration.entry.order, 40)
assert.equal(typeof registration.Component, 'function')

// The slot's inject callback hands the component a working `generate`.
const business = registration.entry.inject('session-42')
assert.equal(typeof business.generate, 'function')

// Rendering the component without hooks must not throw: render a tree manually
// by calling it with React's hook shims (useState/useEffect stubs above).
const tree = registration.Component(business)
assert.equal(tree.type, React.Fragment)

// --- layout regression: the result panel must scroll, not clip -----------------
//
// A flex child with `overflow: auto` only scrolls if it may shrink below its
// content (`min-height: 0`). Without that, the panel keeps its intrinsic height,
// the overlay clips it, and a long document is unreachable inside the window.
// Simulate an open panel holding a long document, then assert the layout chain.
const LONG_DOC = { markdown: '# 长文档\n' + '段落\n'.repeat(400), notes: ['已裁剪'] }
const noop = () => {}
// Hook order: ComposerButton {open, busy, promise} then DocumentPanel {doc, error, copied}.
const states = [
  [true, noop],
  [false, noop],
  [null, noop],
  [LONG_DOC, noop],
  [null, noop],
  [false, noop],
]
let stateIndex = 0
const React2 = {
  createElement: h,
  Fragment: React.Fragment,
  useState: (initial) => {
    const override = states[stateIndex++]
    return override === undefined ? [initial, () => {}] : override
  },
  useEffect: () => {},
}

let registered2 = null
const window2 = { __ModuleLoader__: { load: (definition) => (registered2 = definition) } }
new Function('window', source)(window2)
const plugin2 = registered2.factory((name) => {
  if (name === 'react') return React2
  throw new Error(`unexpected require(${name})`)
})
const slots2 = []
plugin2.apply({
  slots: {
    inject(name, factory) {
      slots2.push({ name, factory })
      return () => {}
    },
    register: (entry, Component) => ({ entry, Component }),
  },
  effect: (factory) => factory(),
})
const panel = slots2[0].factory().Component({ generate: () => Promise.resolve(LONG_DOC) })

const styles = []
const walk = (node) => {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach(walk)
    return
  }
  if (typeof node.type === 'function') {
    walk(node.type(node.props ?? {}))
    return
  }
  if (node.props !== null && node.props !== undefined && node.props.style !== undefined) {
    styles.push(node.props.style)
  }
  for (const child of node.children ?? []) walk(child)
}
walk(panel)

assert.ok(
  styles.some((style) => style.position === 'fixed' && style.overflow === 'auto'),
  'overlay must scroll when the panel is taller than the viewport',
)
assert.ok(
  styles.some((style) => style.maxHeight === '100%' && style.display === 'flex'),
  'panel must cap its height against the overlay, not against the viewport unit',
)
assert.ok(
  styles.some(
    (style) => style.flex === '1 1 auto' && style.minHeight === 0 && style.display === 'flex',
  ),
  'content column must be allowed to shrink so the body can take the remaining height',
)
assert.ok(
  styles.some(
    (style) =>
      style.overflow === 'auto' && style.flex === '1 1 auto' && style.minHeight === 0,
  ),
  'document body must scroll inside the panel',
)

console.log('client half smoke test: OK')
