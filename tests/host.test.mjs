// dsh-translator host regression suite (frozen baseline BEFORE the remotes/
// signal/locale refactors). Run: npm test  (node --test tests/)
//
// Mocks ctx/webServer/llm like scripts/host-sim.mjs and drives the packaged
// Host half end to end over its HTTP route. When the business API migrates to
// the official Typert Remote, this suite is updated to drive the remote
// implementations — the asserted BEHAVIOR (config resolution, direction
// detection, error codes, cancellation) is the frozen contract.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyPlugin } from '../src/index.js'

const DEFAULT_CONFIG = {
  primaryLanguage: 'zh-Hans',
  customModel: { provider: '', model: '' },
  reasoningEffort: 'low',
  timeoutMs: 30000,
  maxTokens: 1024,
  temperature: 0.3,
}

/** Build a mock context + captured route like host-sim.mjs. */
function makeCtx(llm = makeFakeLlm(), config = {}) {
  let route = null
  const calls = []
  const ctx = {
    get: (name) => name === 'agentDefaultModel' ? null : undefined,
    timeout: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t) },
    effect: (fn) => fn(),
    webServer: { register: (r) => { route = r; return () => {} } },
    inject: () => {}, // settings service not mounted: config source = row config
  }
  let llmTarget = llm
  ctx.llm = {
    listProviders: () => llmTarget.listProviders(),
    listModels: (p) => llmTarget.listModels(p),
    resolveModelInfo: (p, m) => llmTarget.resolveModelInfo ? llmTarget.resolveModelInfo(p, m) : Promise.reject(new Error('no info')),
    stream: (o) => { calls.push(o); return llmTarget.stream(o) },
  }
  applyPlugin(ctx, config)
  return { ctx, getRoute: () => route, calls }
}

function makeFakeLlm() {
  return {
    listProviders: () => [{ id: 'test-provider', name: 'Test' }],
    listModels: async () => [{ id: 'test-model' }],
    stream: () => (async function* () {
      yield { type: 'text-delta', index: 0, text: '模型翻译结果' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
}

/** Drive one route hit. */
async function hit(route, method, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  const req = { url: '/translator/api/' + method, [Symbol.asyncIterator]: async function* () { yield body } }
  let out = null
  const res = { writeHead: (code, h) => { out = { code, h } }, end: (b) => { out.body = JSON.parse(b) } }
  await route.handler(req, res)
  return out
}

test('Config schema: defaults filled, invalid values rejected', async () => {
  const mod = await import('../src/index.js')
  assert.equal(mod.name, 'dsh-translator')
  assert.deepEqual(mod.inject.sort(), ['llm', 'timer', 'webServer'].sort())
  const cfg = mod.Config({})
  assert.equal(cfg.primaryLanguage, 'zh-Hans')
  assert.equal(cfg.reasoningEffort, 'low')
  assert.equal(cfg.timeoutMs, 30000)
  assert.equal(cfg.maxTokens, 1024)
  assert.equal(cfg.temperature, 0.3)
  assert.deepEqual(cfg.customModel, { provider: '', model: '' })
  assert.throws(() => mod.Config({ reasoningEffort: 'bogus' }))
  assert.throws(() => mod.Config({ timeoutMs: 100 }))
})

test('apply registers the API prefix route', () => {
  const { getRoute } = makeCtx()
  const r = getRoute()
  assert.equal(r.kind, 'prefix')
  assert.equal(r.path, '/translator/api')
  assert.equal(typeof r.handler, 'function')
})

test('translate: success envelope + stream parameters', async () => {
  const { getRoute, calls } = makeCtx()
  const out = await hit(getRoute(), 'translate', { text: 'Hello world' })
  assert.equal(out.body.ok, true)
  const v = out.body.value
  assert.equal(v.target, 'zh-Hans') // no CJK → translate into primary language
  assert.equal(v.text, '模型翻译结果')
  assert.equal(v.engine, 'model')
  assert.equal(v.truncated, false)
  assert.equal(v.model, 'test-model')
  assert.equal(typeof v.tokens.input, 'number')
  assert.equal(typeof v.tokens.output, 'number')
  const opts = calls[0]
  assert.equal(opts.provider, 'test-provider')
  assert.equal(opts.model, 'test-model')
  assert.equal(opts.maxTokens, 1024)
  assert.equal(typeof opts.system, 'string')
  assert.ok(opts.messages[0].content[0].text === 'Hello world')
})

test('translate: direction detection (CJK text → en)', async () => {
  const { getRoute } = makeCtx()
  const out = await hit(getRoute(), 'translate', { text: '你好世界' })
  assert.equal(out.body.value.target, 'en')
})

test('translate: empty text rejected', async () => {
  const { getRoute } = makeCtx()
  const out = await hit(getRoute(), 'translate', { text: '' })
  assert.equal(out.body.ok, false)
  assert.equal(out.body.error.code, 'empty')
})

test('translate: long text capped at 2000 chars', async () => {
  const { getRoute, calls } = makeCtx()
  await hit(getRoute(), 'translate', { text: 'x'.repeat(3000) })
  assert.equal(calls[0].messages[0].content[0].text.length, 2000)
})

test('translate: provider failure → model-error code + detail', async () => {
  const failing = makeFakeLlm()
  failing.stream = () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'X' } } }
  })()
  const { getRoute } = makeCtx(failing)
  const out = await hit(getRoute(), 'translate', { text: 'hello' })
  assert.equal(out.body.ok, false)
  assert.equal(out.body.error.code, 'model-error')
  assert.equal(out.body.error.detail, 'provider exploded')
})

test('translate: reasoning effort stripped when the model cannot support it', async () => {
  const llm = makeFakeLlm()
  llm.resolveModelInfo = async () => ({ reasoning: { efforts: [{ id: 'low' }] } })
  const c = makeCtx(llm, { reasoningEffort: 'max' })
  const out = await hit(c.getRoute(), 'translate', { text: 'hello' })
  assert.equal(out.body.ok, true)
  assert.equal(c.calls[0].reasoningEffort, undefined)
})

test('translate-cancel: seq-matched cancel on an in-flight run', async () => {
  const slow = makeFakeLlm()
  slow.stream = () => (async function* () {
    yield { type: 'text-delta', index: 0, text: 'a' }
    await new Promise(res => setTimeout(res, 300))
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const { getRoute } = makeCtx(slow)
  const req = { url: '/translator/api/translate', [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ text: 'hello', seq: 1 })) } }
  const pending = getRoute().handler(req, { writeHead: () => {}, end: () => {} })
  await new Promise(res => setTimeout(res, 50))
  const cancelOut = await hit(getRoute(), 'translate-cancel', { seq: 1 })
  assert.equal(cancelOut.body.ok, true)
  assert.equal(cancelOut.body.value, null)
  await pending
})

test('list-models enumerates provider/model pairs', async () => {
  const { getRoute } = makeCtx()
  const out = await hit(getRoute(), 'list-models', {})
  assert.equal(out.body.ok, true)
  assert.ok(Array.isArray(out.body.value))
  assert.equal(out.body.value[0].provider, 'test-provider')
  assert.equal(out.body.value[0].model, 'test-model')
})

test('default-model falls back to first provider/model', async () => {
  const { getRoute } = makeCtx()
  const out = await hit(getRoute(), 'default-model', {})
  assert.equal(out.body.ok, true)
  assert.equal(out.body.value.provider, 'test-provider')
})

test('row config (cordis.yml) is applied when settings is absent', async () => {
  const { getRoute, calls } = makeCtx(undefined, { maxTokens: 512, reasoningEffort: 'high', timeoutMs: 45000 })
  await hit(getRoute(), 'translate', { text: 'hello' })
  assert.equal(calls[0].maxTokens, 512)
  assert.equal(calls[0].reasoningEffort, 'high')
})

test('config endpoints are gone (custom config API removed)', async () => {
  const { getRoute } = makeCtx()
  const out = await hit(getRoute(), 'get-config', {})
  assert.equal(out.body.ok, false)
  assert.equal(out.body.error.code, 'method-not-found')
})

test('unknown method → method-not-found', async () => {
  const { getRoute } = makeCtx()
  const out = await hit(getRoute(), 'bogus', {})
  assert.equal(out.body.ok, false)
  assert.equal(out.body.error.code, 'method-not-found')
})

test('stalled stream + timeout: the abort signal settles the handler (frozen defect fixed)', async () => {
  // A provider that never yields chunks and never fails on its own: without
  // the AbortSignal ride-along the for-await would block forever past the
  // timeout. The fake generator rejects on `signal` abort, exactly like a
  // provider fetch that honors GenerateOptions.signal.
  const stalled = makeFakeLlm()
  stalled.stream = (opts) => (async function* () {
    await new Promise((resolve, reject) => {
      if (opts.signal) opts.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      })
    })
    yield { type: 'text-delta', index: 0, text: 'unreachable' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const { getRoute } = makeCtx(stalled, { timeoutMs: 1200 })
  const started = Date.now()
  const out = await hit(getRoute(), 'translate', { text: 'hello' })
  assert.equal(out.body.ok, false)
  assert.equal(out.body.error.code, 'timeout')
  assert.ok(Date.now() - started < 4000, 'handler must settle shortly after the timeout')
})

test('cancel aborts the underlying stream instead of leaving it running', async () => {
  let aborted = false
  const slow = makeFakeLlm()
  slow.stream = (opts) => (async function* () {
    try {
      await new Promise((resolve, reject) => {
        if (opts.signal) opts.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
      })
    } catch { /* settle the iterator */ }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const { getRoute } = makeCtx(slow)
  const req = { url: '/translator/api/translate', [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ text: 'hello', seq: 1 })) } }
  const pending = getRoute().handler(req, { writeHead: () => {}, end: () => {} })
  await new Promise(res => setTimeout(res, 100))
  await hit(getRoute(), 'translate-cancel', { seq: 1 })
  await pending
  assert.equal(aborted, true, 'the underlying stream must be aborted on cancel')
})

test('exposure guard: 0.0.0.0 binding logs a loud warning', async () => {
  const warns = []
  const orig = console.warn
  console.warn = (...args) => warns.push(String(args[0]))
  try {
    const llm = makeFakeLlm()
    let route = null
    const calls = []
    const ctx = {
      get: (name) => name === 'agentDefaultModel' ? null : undefined,
      timeout: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t) },
      effect: (fn) => fn(),
      webServer: { host: '0.0.0.0', register: (r) => { route = r; return () => {} } },
      inject: () => {},
      llm,
    }
    applyPlugin(ctx, {})
    assert.ok(warns.some(w => w.includes('0.0.0.0') && w.includes('/translator/api')), warns.join(' | '))
    assert.equal(route.path, '/translator/api')
  } finally {
    console.warn = orig
  }
})
