// Host-half simulation test (temporary): mocks ctx/llm/webServer and drives the
// packaged route handler end to end. Run: node scripts/host-sim.mjs
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
  get: (name) => name === 'llm' ? fakeLlm : name === 'agentDefaultModel' ? null : undefined,
  timeout: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t) },
  effect: (fn) => fn(),
  webServer: { register: (r) => { route = r; return () => {} } },
}
apply(ctx)
console.log('route registered:', route.kind, route.path)

async function hit(method, payload, llm = fakeLlm) {
  ctx.get = (name) => name === 'llm' ? llm : name === 'agentDefaultModel' ? null : undefined
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
ctx.get = (name) => name === 'llm' ? slowLlm : name === 'agentDefaultModel' ? null : undefined
const req2 = { url: '/translator/api/translate', [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ text: 'hello', seq: 1 })) } }
const p = route.handler(req2, { writeHead: () => {}, end: () => {} })
await new Promise(res => setTimeout(res, 50))
const cancelReq = { url: '/translator/api/translate-cancel', [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ seq: 1 })) } }
let cancelOut = null
await route.handler(cancelReq, { writeHead: () => {}, end: (b) => { cancelOut = JSON.parse(b) } })
console.log('cancel while in-flight:', JSON.stringify(cancelOut))
await p
console.log('all host simulations passed')
