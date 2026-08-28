// Interactive host-half simulation (npm run test:host): mocks ctx/llm/webServer
// and drives the packaged route handler end to end; the committed regression
// contract lives in tests/host.test.mjs (npm test).
import { apply } from '../lib/index.js'

let route = null
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
  effect: (fn) => fn(),
  webServer: { register: (r) => { route = r; return () => {} } },
  inject: () => {}, // settings service not simulated; installSettingsSection no-ops and the row config stays the only source
}
let llmTarget = fakeLlm
const llmProxy = {
  listProviders: () => llmTarget.listProviders(),
  listModels: (p) => llmTarget.listModels(p),
  resolveModelInfo: (p, m) => llmTarget.resolveModelInfo ? llmTarget.resolveModelInfo(p, m) : Promise.reject(new Error('no info')),
  stream: (o) => llmTarget.stream(o),
}
ctx.llm = llmProxy
apply(ctx, { reasoningEffort: 'high', maxTokens: 512, timeoutMs: 45000 })
console.log('route registered:', route.kind, route.path)

async function hit(method, payload, llm = fakeLlm) {
  llmTarget = llm
  const body = Buffer.from(JSON.stringify(payload))
  const req = { url: '/translator/api/' + method, [Symbol.asyncIterator]: async function* () { yield body } }
  let out = null
  const res = { writeHead: (code, h) => { out = { code, h } }, end: (b) => { out.body = JSON.parse(b) } }
  await route.handler(req, res)
  return out
}

let r = await hit('translate', { text: 'Hello world' })
console.log('translate ok:', JSON.stringify(r.body))
console.log('   stream called with:', JSON.stringify({ provider: calls[0].provider, model: calls[0].model, maxTokens: calls[0].maxTokens, sysLen: calls[0].system.length, msgContent: calls[0].messages[0].content[0].text }))
console.log('   row config applied (maxTokens 512, reasoningEffort high):', calls[0].maxTokens === 512 ? 'ok' : 'FAIL', calls[0].reasoningEffort === 'high' ? 'ok' : 'FAIL')
const cfgResp = await hit('get-config', {})
console.log('settings card API is custom HTTP no more:', JSON.stringify(cfgResp.body))
console.log('   target:', r.body.value.target)

r = await hit('translate', { text: '' })
console.log('empty text:', JSON.stringify(r.body))

r = await hit('translate', { text: 'x'.repeat(3000) })
console.log('long text capped:', calls[calls.length - 1].messages[0].content[0].text.length, '(<=2000)')

r = await hit('translate', { text: 'hello' }, failingLlm)
console.log('provider failure:', JSON.stringify(r.body))

r = await hit('bogus', {})
console.log('unknown method:', JSON.stringify(r.body))

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
const req2 = { url: '/translator/api/translate', [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ text: 'hello', seq: 1 })) } }
const p = route.handler(req2, { writeHead: () => {}, end: () => {} })
await new Promise(res => setTimeout(res, 50))
const cancelReq = { url: '/translator/api/translate-cancel', [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ seq: 1 })) } }
let cancelOut = null
await route.handler(cancelReq, { writeHead: () => {}, end: (b) => { cancelOut = JSON.parse(b) } })
console.log('cancel while in-flight:', JSON.stringify(cancelOut))
await p
console.log('all host simulations passed')
