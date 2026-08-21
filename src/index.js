/**
 * dsh-translator — packaged Host half
 *
 * ESM Cordis plugin module, installed through the dsh bundle mechanism
 * (cordis.patch.yml row). The browser Client half calls this over HTTP:
 *
 *   POST /translator/api/translate         { text, seq? }
 *   POST /translator/api/translate-cancel  { seq }
 *
 * Response envelope (mirrors the dsh-better-sidebar API convention):
 *   { ok: true, value: <json> } | { ok: false, error: { code, message } }
 *
 * The translation core is identical to the dynamic-plugin host
 * (src/host.js): ctx.llm.stream with the user's default model, 30 s timeout,
 * single in-flight run, seq-matched cancellation.
 */
export const name = 'dsh-translator'

export const inject = ['webServer', 'llm', 'timer']

const ROUTE_PREFIX = '/translator/api'

export function apply(ctx) {
  const llm = ctx.get('llm')
  const defaultModel = ctx.get('agentDefaultModel')
  let seq = 0
  let runSeq = 0
  let inflight = null

  async function pickModel() {
    try {
      const sel = defaultModel && defaultModel.currentSelection()
      if (sel && sel.provider && sel.model) {
        return { provider: sel.provider, model: sel.model }
      }
    } catch (err) {
      console.error('[translator] currentSelection failed:', err)
    }
    const providers = llm.listProviders()
    if (!providers || providers.length === 0) {
      throw new Error('未配置可用模型（无 LLM provider）')
    }
    const models = await llm.listModels(providers[0].id)
    if (!models || models.length === 0) {
      throw new Error('provider ' + providers[0].id + ' 没有可用模型')
    }
    return { provider: providers[0].id, model: models[0].id }
  }

  async function translateWithModel(provider, model, text, target, run) {
    const system = target === 'zh-CN'
      ? '你是划词翻译引擎。用户消息中的内容就是需要翻译的文本，请将其翻译成简体中文。只输出译文本身：不要解释、不要加引号、不要输出原文、不要任何备注。'
      : 'You are a word-selection translation engine. The user message content is the text to translate; translate it into English. Output ONLY the translation itself: no explanations, no quotes, no original text, no notes.'
    let out = ''
    let timedOut = false
    let failure = null
    let truncated = false
    const disposeTimeout = ctx.timeout(() => { timedOut = true }, 30000)
    try {
      const stream = llm.stream({
        provider,
        model,
        messages: [{ id: 'tr-' + (++seq), role: 'user', content: [{ type: 'text', text }] }],
        system,
        temperature: 0.3,
        maxTokens: 1024,
      })
      for await (const chunk of stream) {
        if (run.cancelled) break
        if (timedOut) break
        if (chunk.type === 'text-delta') {
          out += chunk.text
        } else if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'max-tokens') {
            truncated = true
            break
          }
          if (chunk.reason.kind !== 'stop') {
            failure = chunk.reason.failure && chunk.reason.failure.message
              ? chunk.reason.failure.message
              : '模型调用失败（' + chunk.reason.kind + '）'
            break
          }
        }
      }
    } finally {
      disposeTimeout()
      if (inflight === run) inflight = null
    }
    if (run.cancelled) return { cancelled: true }
    if (timedOut) throw new Error('翻译超时（30 秒）')
    if (failure) throw new Error(failure)
    if (!out || !out.trim()) throw new Error('模型未返回译文')
    return { text: out.trim(), truncated }
  }

  async function handleTranslate(payload) {
    const raw = payload && typeof payload.text === 'string' ? payload.text : ''
    const text = raw.trim().slice(0, 2000)
    if (!text) return { ok: false, error: { code: 'empty', message: '没有可翻译的文本' } }
    if (inflight) inflight.cancelled = true
    const run = { cancelled: false }
    inflight = run
    runSeq += 1
    const target = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text) ? 'en' : 'zh-CN'
    try {
      const picked = await pickModel()
      if (run.cancelled) return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }
      const result = await translateWithModel(picked.provider, picked.model, text, target, run)
      if (result.cancelled) return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }
      return { ok: true, value: { target, text: result.text, engine: 'model', truncated: result.truncated === true } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: { code: 'translate-failed', message } }
    } finally {
      if (inflight === run) inflight = null
    }
  }

  function handleCancel(payload) {
    if (payload && typeof payload.seq === 'number' && payload.seq === runSeq && inflight) {
      inflight.cancelled = true
    }
    return { ok: true, value: null }
  }

  async function readJsonBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw) return {}
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const method = pathname.startsWith(ROUTE_PREFIX + '/')
        ? pathname.slice(ROUTE_PREFIX.length + 1)
        : ''
      const payload = await readJsonBody(req)
      let result
      if (method === 'translate') {
        result = await handleTranslate(payload)
      } else if (method === 'translate-cancel') {
        result = handleCancel(payload)
      } else {
        result = { ok: false, error: { code: 'method-not-found', message: 'unknown method: ' + method } }
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(JSON.stringify(result))
    },
  }), 'dsh-translator: api route')
}
