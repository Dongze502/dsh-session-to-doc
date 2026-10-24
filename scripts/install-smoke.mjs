import { createRequire } from 'node:module'

const require = createRequire('C:/Users/DONG/.dsh/profiles/desktop/')
const resolved = require.resolve('dsh-session-to-doc')
console.log('resolved:', resolved)

const mod = await import(require('node:url').pathToFileURL(resolved).href)
console.log('name:', mod.name, 'inject:', JSON.stringify(mod.inject))

const routes = []
const tools = []
const ctx = {
  tools: { register: definition => tools.push(definition) },
  sessions: { get: () => undefined, list: () => [] },
  llm: { stream: async function* () {}, listProviders: () => [], listModels: async () => [] },
  get: () => undefined,
  effect: fn => fn(),
  inject: (deps, callback) => {
    console.log('inject deps:', JSON.stringify(deps))
    callback({
      effect: fn => fn(),
      webServer: { register: route => { routes.push(route); return () => {} } },
    })
  },
}

mod.apply(ctx)
console.log('tool:', tools.map(t => t.name).join(','))
console.log('route:', routes.map(r => `${r.kind} ${r.path} ${typeof r.handler}`).join(','))
console.log('params:', JSON.stringify(Object.keys(tools[0].parameters.properties)))
console.log('out required:', JSON.stringify(tools[0].output.schema.required))
console.log('render:', JSON.stringify(tools[0].output.render({}, { markdown: '# hi', outline: [], toc: '' })))

const pkg = require('dsh-session-to-doc/package.json')
console.log('pkg name:', pkg.name, 'version:', pkg.version, 'dsh.client:', JSON.stringify(pkg.dsh.client))
console.log('client export:', pkg.exports['./client'])
