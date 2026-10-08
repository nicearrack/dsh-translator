// dsh-translator host regression suite. Run: npm test  (node --test tests/)
//
// Drives the packaged Host half end to end over the exact Connection Fetch
// routes it registers on the authenticated `/api` channel, mocking
// ctx.llm/ctx.connection like scripts/host-sim.mjs does.
//
// The asserted BEHAVIOR (config resolution, live config edits, direction
// detection, error codes, cancellation, timeout) is the frozen contract.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyPlugin, Config, inject as pluginInject, name as pluginName } from '../src/index.js'

/** The shared cross-copy volatile write symbol (cosmokit's protocol). */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Current value behind volatile references, recursively. */
function plain(value) {
  if (value !== null && typeof value === 'object' && VOLATILE_WRITE in value) return plain(value.get())
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]))
  }
  return value
}

/** Build a mock context + captured exact Fetch routes. */
function makeCtx(llm = makeFakeLlm(), config = undefined) {
  const calls = []
  const routes = new Map()
  const injections = []
  let llmTarget = llm
  const ctx = {
    get: (name) => name === 'agentDefaultModel' ? null : undefined,
    timeout: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t) },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    inject: (deps, callback) => {
      injections.push(deps)
      callback({
        connection: {
          fetch: {
            register: (route) => { routes.set(route.path, route); return async () => { routes.delete(route.path) } },
          },
        },
      })
    },
    llm: {
      listProviders: () => llmTarget.listProviders(),
      listModels: (p) => llmTarget.listModels(p),
      resolveModelInfo: (p, m) => llmTarget.resolveModelInfo ? llmTarget.resolveModelInfo(p, m) : Promise.reject(new Error('no info')),
      stream: (o) => { calls.push(o); return llmTarget.stream(o) },
    },
  }
  applyPlugin(ctx, config)
  return { ctx, routes, calls, injections }
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

/** Drive one exact Fetch route with a JSON body. */
async function hit(routes, path, payload) {
  const route = routes.get(path)
  assert.ok(route !== undefined, 'route ' + path + ' is registered')
  const request = new Request('http://127.0.0.1:3080' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const response = await route.fetch(request)
  return { status: response.status, headers: response.headers, body: await response.json() }
}

const TRANSLATE = '/api/translator/translate'

test('Config schema: defaults filled, invalid values rejected', () => {
  assert.equal(pluginName, 'dsh-translator')
  assert.deepEqual([...pluginInject].sort(), ['llm', 'timer'])
  const cfg = plain(Config({}))
  assert.equal(cfg.primaryLanguage, 'zh-Hans')
  assert.equal(cfg.reasoningEffort, 'low')
  assert.equal(cfg.timeoutMs, 30000)
  assert.equal(cfg.maxTokens, 1024)
  assert.equal(cfg.temperature, 0.3)
  assert.deepEqual(cfg.customModel, { provider: '', model: '' })
  assert.throws(() => Config({ reasoningEffort: 'bogus' }))
  assert.throws(() => Config({ timeoutMs: 100 }))
})

test('apply registers exact authenticated /api routes through ctx.connection', () => {
  const { routes, injections } = makeCtx()
  assert.deepEqual(injections, [['connection']])
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/translator/default-model',
    '/api/translator/list-models',
    '/api/translator/translate',
    '/api/translator/translate-cancel',
  ].sort())
  for (const route of routes.values()) {
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')
    assert.equal(typeof route.fetch, 'function')
  }
  // The unauthenticated webserver prefix of the 0.2 line is gone.
  assert.equal(routes.has('/translator/api'), false)
})

test('translate: success envelope + stream parameters', async () => {
  const { routes, calls } = makeCtx()
  const out = await hit(routes, TRANSLATE, { text: 'Hello world' })
  assert.equal(out.status, 200)
  assert.match(out.headers.get('content-type'), /application\/json/)
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
  const { routes } = makeCtx()
  const out = await hit(routes, TRANSLATE, { text: '你好世界' })
  assert.equal(out.body.value.target, 'en')
})

test('translate: empty text rejected', async () => {
  const { routes } = makeCtx()
  const out = await hit(routes, TRANSLATE, { text: '' })
  assert.equal(out.body.ok, false)
  assert.equal(out.body.error.code, 'empty')
})

test('translate: long text capped at 2000 chars', async () => {
  const { routes, calls } = makeCtx()
  await hit(routes, TRANSLATE, { text: 'x'.repeat(3000) })
  assert.equal(calls[0].messages[0].content[0].text.length, 2000)
})

test('translate: provider failure → model-error code + detail', async () => {
  const failing = makeFakeLlm()
  failing.stream = () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'X' } } }
  })()
  const { routes } = makeCtx(failing)
  const out = await hit(routes, TRANSLATE, { text: 'hello' })
  assert.equal(out.body.ok, false)
  assert.equal(out.body.error.code, 'model-error')
  assert.equal(out.body.error.detail, 'provider exploded')
})

test('translate: reasoning effort stripped when the model cannot support it', async () => {
  const llm = makeFakeLlm()
  llm.resolveModelInfo = async () => ({ reasoning: { efforts: [{ id: 'low' }] } })
  const c = makeCtx(llm, Config({ reasoningEffort: 'max' }))
  const out = await hit(c.routes, TRANSLATE, { text: 'hello' })
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
  const { routes } = makeCtx(slow)
  const pending = routes.get(TRANSLATE).fetch(new Request('http://127.0.0.1:3080' + TRANSLATE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  }))
  await new Promise(res => setTimeout(res, 50))
  const cancelOut = await hit(routes, '/api/translator/translate-cancel', { seq: 1 })
  assert.equal(cancelOut.body.ok, true)
  assert.equal(cancelOut.body.value, null)
  await pending
})

test('list-models enumerates provider/model pairs', async () => {
  const { routes } = makeCtx()
  const out = await hit(routes, '/api/translator/list-models', {})
  assert.equal(out.body.ok, true)
  assert.ok(Array.isArray(out.body.value))
  assert.equal(out.body.value[0].provider, 'test-provider')
  assert.equal(out.body.value[0].model, 'test-model')
})

test('default-model falls back to first provider/model', async () => {
  const { routes } = makeCtx()
  const out = await hit(routes, '/api/translator/default-model', {})
  assert.equal(out.body.ok, true)
  assert.equal(out.body.value.provider, 'test-provider')
})

test('row config (cordis.yml) is applied', async () => {
  const { routes, calls } = makeCtx(undefined, Config({ maxTokens: 512, reasoningEffort: 'high', timeoutMs: 45000 }))
  await hit(routes, TRANSLATE, { text: 'hello' })
  assert.equal(calls[0].maxTokens, 512)
  assert.equal(calls[0].reasoningEffort, 'high')
})

test('a live settings edit updates an in-flight-less plugin without a reload', async () => {
  const config = Config({ maxTokens: 512 })
  const { routes, calls } = makeCtx(undefined, config)
  await hit(routes, TRANSLATE, { text: 'hello' })
  assert.equal(calls[0].maxTokens, 512)
  // What the loader does on a settings write: update the reference in place.
  config.maxTokens[VOLATILE_WRITE](2048)
  await hit(routes, TRANSLATE, { text: 'hello again' })
  assert.equal(calls[1].maxTokens, 2048)
})

test('an unregistered method has no route (404 from the shared channel)', () => {
  const { routes } = makeCtx()
  assert.equal(routes.has('/api/translator/get-config'), false)
  assert.equal(routes.has('/api/translator/bogus'), false)
})

test('stalled stream + timeout: the abort signal settles the handler', async () => {
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
  const { routes } = makeCtx(stalled, Config({ timeoutMs: 1200 }))
  const started = Date.now()
  const out = await hit(routes, TRANSLATE, { text: 'hello' })
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
  const { routes } = makeCtx(slow)
  const pending = routes.get(TRANSLATE).fetch(new Request('http://127.0.0.1:3080' + TRANSLATE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  }))
  await new Promise(res => setTimeout(res, 100))
  await hit(routes, '/api/translator/translate-cancel', { seq: 1 })
  await pending
  assert.equal(aborted, true, 'the underlying stream must be aborted on cancel')
})
