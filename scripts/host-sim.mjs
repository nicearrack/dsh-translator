// Interactive host-half simulation (npm run test:host): mocks ctx/llm and the
// exact Fetch route registry, then drives the packaged Host half end to end.
// The committed regression contract lives in tests/host.test.mjs (npm test).
//
// Run `npm run build` first: this exercises lib/index.js, the packaged half.
import { apply, Config } from '../lib/index.js'
import { isVolatile } from '@deepseek-ai/cosmokit'

const routes = new Map()
const calls = []
const fakeLlm = {
  listProviders: () => [{ id: 'test-provider' }],
  listModels: async () => [{ id: 'test-model' }],
  stream: (opts) => {
    calls.push(opts)
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: '模型翻译结果' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
const failingLlm = {
  listProviders: () => [{ id: 'test-provider' }],
  listModels: async () => [{ id: 'test-model' }],
  stream: () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'X' } } }
  })(),
}
const ctx = {
  // The host binds injected services once in apply (the module `inject` list
  // guarantees availability), so the sim hands it a delegating proxy and
  // swaps the target per scenario, like an HMR-replaced service would.
  get: (name) => name === 'agentDefaultModel' ? null : undefined,
  timeout: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t) },
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  inject: (deps, callback) => callback({
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return async () => {} } } },
  }),
}
let llmTarget = fakeLlm
const llmProxy = {
  listProviders: () => llmTarget.listProviders(),
  listModels: (p) => llmTarget.listModels(p),
  resolveModelInfo: (p, m) => llmTarget.resolveModelInfo ? llmTarget.resolveModelInfo(p, m) : Promise.reject(new Error('no info')),
  stream: (o) => { calls.push(o); return llmTarget.stream(o) },
}
ctx.llm = llmProxy
const config = Config({ reasoningEffort: 'high', maxTokens: 512, timeoutMs: 45000 })
apply(ctx, config)
console.log('routes registered:', [...routes.keys()].join(', '))

async function hit(path, payload, llm = fakeLlm) {
  llmTarget = llm
  const route = routes.get(path)
  const response = await route.fetch(new Request('http://127.0.0.1:3080' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
  return { status: response.status, body: await response.json() }
}

let r = await hit('/api/translator/translate', { text: 'Hello world' })
console.log('translate ok:', JSON.stringify(r.body))
console.log('   stream called with:', JSON.stringify({ provider: calls[0].provider, model: calls[0].model, maxTokens: calls[0].maxTokens, sysLen: calls[0].system.length, msgContent: calls[0].messages[0].content[0].text }))
console.log('   row config applied (maxTokens 512, reasoningEffort high):', calls[0].maxTokens === 512 ? 'ok' : 'FAIL', calls[0].reasoningEffort === 'high' ? 'ok' : 'FAIL')
console.log('   target:', r.body.value.target)

// What a settings write does: the loader updates the volatile references in
// place, so the next request must observe the new value with no reload.
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
console.log('   config is volatile:', isVolatile(config.maxTokens) ? 'ok' : 'FAIL')
config.maxTokens[VOLATILE_WRITE](2048)
await hit('/api/translator/translate', { text: 'live edit' })
console.log('   live settings edit seen without reload:', calls[calls.length - 1].maxTokens === 2048 ? 'ok' : 'FAIL')

r = await hit('/api/translator/translate', { text: '' })
console.log('empty text:', JSON.stringify(r.body))

r = await hit('/api/translator/translate', { text: 'x'.repeat(3000) })
console.log('long text capped:', calls[calls.length - 1].messages[0].content[0].text.length, '(<=2000)')

r = await hit('/api/translator/translate', { text: 'hello' }, failingLlm)
console.log('provider failure:', JSON.stringify(r.body))

console.log('unknown path registered:', routes.has('/api/translator/bogus') ? 'FAIL' : 'ok (no route)')

// cancel path: start a slow stream, cancel it
const slowLlm = {
  listProviders: () => [{ id: 'p' }], listModels: async () => [{ id: 'm' }],
  stream: () => (async function* () {
    yield { type: 'text-delta', index: 0, text: 'a' }
    await new Promise(res => setTimeout(res, 300))
    yield { type: 'finish', reason: { kind: 'stop' } }
  })(),
}
llmTarget = slowLlm
const pending = routes.get('/api/translator/translate').fetch(new Request('http://127.0.0.1:3080/api/translator/translate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hello' }),
}))
await new Promise(res => setTimeout(res, 50))
const cancelOut = await hit('/api/translator/translate-cancel', { seq: 1 })
console.log('cancel while in-flight:', JSON.stringify(cancelOut.body))
await pending
console.log('all host simulations passed')
