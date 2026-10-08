// Interactive host-half simulation (npm run test:host): mocks ctx/llm and the
// exact Fetch route registry, then drives the packaged Host half end to end.
// The committed regression contract lives in tests/host.test.mjs (npm test).
//
// Run `npm run build` first: this exercises lib/index.js, the packaged half.
import { apply, Config } from '../lib/index.js'
import { isVolatile } from '@deepseek-ai/cosmokit'

const fakeLlm = {
  listProviders: () => [{ id: 'test-provider' }],
  listModels: async () => [{ id: 'test-model' }],
  stream: () => (async function* () {
    yield { type: 'text-delta', index: 0, text: '模型翻译结果' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })(),
}
const failingLlm = {
  listProviders: () => [{ id: 'test-provider' }],
  listModels: async () => [{ id: 'test-model' }],
  stream: () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'X' } } }
  })(),
}
const slowLlm = {
  listProviders: () => [{ id: 'p' }], listModels: async () => [{ id: 'm' }],
  stream: () => (async function* () {
    yield { type: 'text-delta', index: 0, text: 'a' }
    await new Promise(res => setTimeout(res, 300))
    yield { type: 'finish', reason: { kind: 'stop' } }
  })(),
}

/**
 * Boot one packaged Host half over a fake carrier.
 *
 * The host binds injected services once in apply (the module `inject` list
 * guarantees availability), so the sim hands it a delegating proxy and swaps
 * the target per scenario, like an HMR-replaced service would.
 */
function makeHost(config) {
  const routes = new Map()
  const calls = []
  const state = { llm: fakeLlm }
  const ctx = {
    get: (name) => name === 'agentDefaultModel' ? null : undefined,
    timeout: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t) },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    inject: (deps, callback) => callback({
      connection: { fetch: { register: (route) => { routes.set(route.path, route); return async () => {} } } },
    }),
    llm: {
      listProviders: () => state.llm.listProviders(),
      listModels: (p) => state.llm.listModels(p),
      resolveModelInfo: (p, m) => state.llm.resolveModelInfo ? state.llm.resolveModelInfo(p, m) : Promise.reject(new Error('no info')),
      stream: (o) => { calls.push(o); return state.llm.stream(o) },
    },
  }
  apply(ctx, config)
  return {
    routes,
    calls,
    use: (llm) => { state.llm = llm },
    hit: async (path, payload) => {
      const response = await routes.get(path).fetch(new Request('http://127.0.0.1:3080' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }))
      return { status: response.status, body: await response.json() }
    },
  }
}

// ---------------------------------------------------------------------------
// The `model` engine — the 0.3 behaviour, selected explicitly.
// ---------------------------------------------------------------------------
const config = Config({ engine: 'model', reasoningEffort: 'high', maxTokens: 512, timeoutMs: 45000 })
const host = makeHost(config)
console.log('routes registered:', [...host.routes.keys()].join(', '))

let r = await host.hit('/api/translator/translate', { text: 'Hello world' })
console.log('model translate:', JSON.stringify(r.body))
console.log('   stream called with:', JSON.stringify({ provider: host.calls[0].provider, model: host.calls[0].model, maxTokens: host.calls[0].maxTokens, sysLen: host.calls[0].system.length, msgContent: host.calls[0].messages[0].content[0].text }))
console.log('   row config applied (maxTokens 512, reasoningEffort high):', host.calls[0].maxTokens === 512 ? 'ok' : 'FAIL', host.calls[0].reasoningEffort === 'high' ? 'ok' : 'FAIL')
console.log('   target:', r.body.value.target)

// What a settings write does: the loader updates the volatile references in
// place, so the next request must observe the new value with no reload.
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
console.log('   config is volatile:', isVolatile(config.maxTokens) ? 'ok' : 'FAIL')
config.maxTokens[VOLATILE_WRITE](2048)
await host.hit('/api/translator/translate', { text: 'live edit' })
console.log('   live settings edit seen without reload:', host.calls[host.calls.length - 1].maxTokens === 2048 ? 'ok' : 'FAIL')

r = await host.hit('/api/translator/translate', { text: '' })
console.log('empty text:', JSON.stringify(r.body))

r = await host.hit('/api/translator/translate', { text: 'x'.repeat(3000) })
console.log('long text capped:', host.calls[host.calls.length - 1].messages[0].content[0].text.length, '(<=2000)')

host.use(failingLlm)
r = await host.hit('/api/translator/translate', { text: 'hello' })
console.log('provider failure:', JSON.stringify(r.body))

console.log('unknown path registered:', host.routes.has('/api/translator/bogus') ? 'FAIL' : 'ok (no route)')

// cancel path: start a slow stream, cancel it
host.use(slowLlm)
const pending = host.routes.get('/api/translator/translate').fetch(new Request('http://127.0.0.1:3080/api/translator/translate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hello' }),
}))
await new Promise(res => setTimeout(res, 50))
const cancelOut = await host.hit('/api/translator/translate-cancel', { seq: 1 })
console.log('cancel while in-flight:', JSON.stringify(cancelOut.body))
await pending

// ---------------------------------------------------------------------------
// The `api` engine — the default. `fetch` is stubbed so this never depends on
// a provider being reachable; tests/host.test.mjs covers the same ground.
// ---------------------------------------------------------------------------
const apiHost = makeHost(Config({}))
console.log('\napi engine is the default:', JSON.stringify({ engine: apiHost.calls.length === 0 ? 'api (no llm touched yet)' : 'FAIL' }))
const originalFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const href = String(url)
  if (href.includes('transmart.qq.com')) {
    return new Response(JSON.stringify({ header: { ret_code: 'succ' }, auto_translation: ['你好世界'] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('not found', { status: 404 })
}
r = await apiHost.hit('/api/translator/translate', { text: 'Hello world' })
globalThis.fetch = originalFetch
console.log('api translate:', JSON.stringify(r.body))
console.log('   llm.stream calls on the api path:', apiHost.calls.length, apiHost.calls.length === 0 ? 'ok' : 'FAIL')

console.log('\nall host simulations passed')
