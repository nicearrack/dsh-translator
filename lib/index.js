/**
 * dsh-translator — packaged Host half.
 *
 * A plain ESM Cordis plugin module installed through the dsh bundle mechanism
 * (`package.json` `dsh.bundle.patch` → `cordis.patch.yml` row). The browser
 * Client half reaches this half over the **authenticated** `/api` channel,
 * one exact Connection Fetch route per operation:
 *
 *   POST /api/translator/translate         { text }
 *   POST /api/translator/translate-cancel  { seq }
 *   POST /api/translator/list-models       {}
 *   POST /api/translator/default-model     {}
 *
 * The routes are registered with `ctx.connection.fetch.register`, so the
 * carrier's Host/Origin fence and browser authentication apply before the
 * handler runs; no pattern here serves an unauthenticated prefix.
 *
 * Response envelope (kept from the 0.2 line, it is locale-independent):
 *   { ok: true, value: <json> } | { ok: false, error: { code, message } }
 *
 * Configuration is the exported `Config` alone. Every editable field is
 * declared `.volatile()`, which is what makes the entry visible to the Host's
 * schema-driven settings transport (`ctx.settings`) and lets an edit reach
 * this half **live**, without unloading the plugin: the loader rewrites the
 * profile patch and updates the same references in place, and every operation
 * reads them through {@link readConfig}. There is no settings package import
 * and no separate config source to keep in sync.
 *
 * Two engines answer a translation, chosen by the `engine` field:
 *
 *   `api`   (default) — keyless public web endpoints, walked as a fallback
 *           chain by {@link translateFree} in `free-translate.js`. No account,
 *           no API key, no token to paste, nothing to configure.
 *   `model` — streams through `ctx.llm` with the session's configured default
 *           model, a timeout, a single in-flight run, and seq-matched
 *           cancellation. This is what the 0.3 line did unconditionally.
 *
 * Both share the direction detection, the 2000-character cap, the single-flight
 * run slot and the seq-matched cancellation.
 */
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { translateFree, PROVIDERS } from './free-translate.js'

export const name = 'dsh-translator'

/**
 * Required services. `connection` is optional on purpose: a profile without a
 * browser carrier (headless, sdk) still loads this plugin, and the routes are
 * mounted by the `ctx.inject(['connection'], …)` block below only where the
 * carrier exists.
 */
export const inject = ['llm', 'timer']

/** Common prefix of the exact Fetch routes on the shared `/api` channel. */
const API_BASE = '/api/translator'

const PRIMARY_LANGS = ['zh-Hans', 'zh-Hant', 'ja-JP', 'ko-KR', 'ru-RU']
const REASONING_EFFORTS = ['off', 'low', 'high', 'max']

/** Engines the plugin can translate with. */
const ENGINES = ['api', 'model']

/** `auto` plus every keyless provider, i.e. what `apiProvider` accepts. */
const API_PROVIDERS = ['auto', ...PROVIDERS]

/**
 * Plugin configuration (schemastery schema, Cordis Standard Schema).
 *
 * Defaults live here: the same schema validates the `config:` block of the
 * plugin row in `cordis.yml` and the section the settings transport reads and
 * writes, so the two layers can never drift apart. `.volatile()` marks the
 * fields a settings page may edit without remounting the plugin; without it
 * the entry carries no form at all.
 *
 * `api` is the default engine on purpose: it needs nothing configured, while
 * the `model` half of the schema only takes effect once a user selects it.
 */
export const Config = z.object({
  engine: z.union(ENGINES.map(e => z.const(e))).default('api').volatile(),
  apiProvider: z.union(API_PROVIDERS.map(p => z.const(p))).default('auto').volatile(),
  primaryLanguage: z.union([z.const('zh-Hans'), z.const('zh-Hant'), z.const('ja-JP'), z.const('ko-KR'), z.const('ru-RU')]).default('zh-Hans').volatile(),
  customModel: z.object({
    provider: z.string().default('').volatile(),
    model: z.string().default('').volatile(),
  }).default({ provider: '', model: '' }),
  reasoningEffort: z.union([z.const('off'), z.const('low'), z.const('high'), z.const('max')]).default('low').volatile(),
  timeoutMs: z.number().min(1000).default(30000).volatile(),
  maxTokens: z.number().min(1).default(1024).volatile(),
  temperature: z.number().min(0).max(2).step(0.1).default(0.3).volatile(),
})

/** Current value behind a volatile config reference, or the plain value itself. */
function plain(node) {
  return isVolatile(node) ? node.get() : node
}

/** One finite number inside `[min, max]`, or the fallback. */
function numberIn(value, min, max, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback
}

/**
 * Read the effective configuration for one operation.
 *
 * Called per request rather than captured at apply time: a live settings edit
 * only updates the references, so a captured plain object would go stale.
 * @param config - validated plugin Config (volatile references at the marked fields).
 * @returns the plain values the translation core consumes.
 */
function readConfig(config) {
  const root = config !== null && typeof config === 'object' ? config : Config({})
  const primaryLanguage = plain(root.primaryLanguage)
  const customModel = root.customModel !== null && typeof root.customModel === 'object' ? root.customModel : {}
  const engine = plain(root.engine)
  const apiProvider = plain(root.apiProvider)
  return {
    engine: ENGINES.includes(engine) ? engine : 'api',
    apiProvider: API_PROVIDERS.includes(apiProvider) ? apiProvider : 'auto',
    primaryLanguage: PRIMARY_LANGS.includes(primaryLanguage) ? primaryLanguage : 'zh-Hans',
    customModel: {
      provider: String(plain(customModel.provider) ?? ''),
      model: String(plain(customModel.model) ?? ''),
    },
    reasoningEffort: REASONING_EFFORTS.includes(plain(root.reasoningEffort)) ? plain(root.reasoningEffort) : 'low',
    timeoutMs: Math.floor(numberIn(plain(root.timeoutMs), 1000, Number.MAX_SAFE_INTEGER, 30000)),
    maxTokens: Math.floor(numberIn(plain(root.maxTokens), 1, Number.MAX_SAFE_INTEGER, 1024)),
    temperature: numberIn(plain(root.temperature), 0, 2, 0.3),
  }
}

/** JSON response for one exact Fetch route. */
function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export function apply(ctx, config) {
  // Injected services are ready before apply runs; only optional ones use
  // ctx.get()/ctx.inject().
  const llm = ctx.llm
  const defaultModel = ctx.get('agentDefaultModel')
  let seq = 0
  let runSeq = 0
  let inflight = null

  // Fiber teardown aborts any in-flight provider stream.
  ctx.effect(() => () => {
    if (inflight && inflight.abort) inflight.abort()
  }, 'dsh-translator: abort in-flight translation')

  function resolveTarget(text, c) {
    const hasZh = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)
    const hasKana = /[\u3040-\u30ff]/.test(text)
    const hasHangul = /[\uac00-\ud7af]/.test(text)
    const hasCyrillic = /[\u0400-\u04ff]/.test(text)
    switch (c.primaryLanguage) {
      case 'zh-Hans': case 'zh-Hant': return hasZh ? 'en' : c.primaryLanguage
      case 'ja-JP': return hasKana ? 'en' : 'ja-JP'
      case 'ko-KR': return hasHangul ? 'en' : 'ko-KR'
      case 'ru-RU': return hasCyrillic ? 'en' : 'ru-RU'
      default: return hasZh ? 'en' : 'zh-Hans'
    }
  }

  function systemPrompt(target) {
    switch (target) {
      case 'zh-Hans': return '你是划词翻译引擎。用户消息中的内容就是需要翻译的文本，请将其翻译成简体中文。只输出译文本身：不要解释、不要加引号、不要输出原文、不要任何备注。'
      case 'zh-Hant': return '你是劃詞翻譯引擎。使用者訊息中的內容就是需要翻譯的文字，請將其翻譯成繁體中文。只輸出譯文本身：不要解釋、不要加引號、不要輸出原文、不要任何備註。'
      case 'ja-JP': return 'あなたは単語選択翻訳エンジンです。ユーザーメッセージの内容が翻訳対象のテキストです。日本語に翻訳してください。翻訳文のみを出力してください：説明・引用符・原文・注記は不要です。'
      case 'ko-KR': return '당신은 단어 선택 번역 엔진입니다. 사용자 메시지의 내용이 번역할 텍스트입니다. 한국어로 번역하세요. 번역문만 출력하세요: 설명, 인용부호, 원문, 주석은 필요 없습니다.'
      case 'ru-RU': return 'Вы — движок перевода по выделенному слову. Содержимое сообщения пользователя — это текст для перевода. Переведите его на русский язык. Выводите только перевод: без объяснений, без кавычек, без исходного текста, без примечаний.'
      default: return 'You are a word-selection translation engine. The user message content is the text to translate; translate it into English. Output ONLY the translation itself: no explanations, no quotes, no original text, no notes.'
    }
  }

  async function pickModel(c) {
    if (c.customModel.provider && c.customModel.model) {
      return { provider: c.customModel.provider, model: c.customModel.model }
    }
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
      const e = new Error('no configured model: no LLM provider')
      e.code = 'no-provider'
      throw e
    }
    const models = await llm.listModels(providers[0].id)
    if (!models || models.length === 0) {
      const e = new Error('provider has no models: ' + providers[0].id)
      e.code = 'no-model'; e.detail = providers[0].id
      throw e
    }
    return { provider: providers[0].id, model: models[0].id }
  }

  async function translateWithModel(provider, model, text, target, c, run) {
    const system = systemPrompt(target)
    let out = ''
    let timedOut = false
    let failure = null
    let truncated = false
    let tokens = null
    let eff = c.reasoningEffort
    // Real cancellation: the signal rides into llm.stream (GenerateOptions
    // carries it), so an abort tears down the provider request instead of
    // merely breaking out of the read loop.
    const controller = new AbortController()
    run.signal = controller.signal
    run.abort = () => controller.abort()
    const disposeTimeout = ctx.timeout(() => {
      timedOut = true
      controller.abort()
    }, c.timeoutMs)
    const isAbort = (err) => (err && (err.name === 'AbortError' || /abort/i.test(String((err && err.message) || err))))
    const consume = async (effort) => {
      const stream = llm.stream({
        provider,
        model,
        messages: [{ id: 'tr-' + (++seq), role: 'user', content: [{ type: 'text', text }] }],
        system,
        temperature: c.temperature,
        maxTokens: c.maxTokens,
        signal: controller.signal,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      })
      try {
        for await (const chunk of stream) {
          if (run.cancelled) break
          if (timedOut) break
          if (chunk.type === 'text-delta') {
            out += chunk.text
          } else if (chunk.type === 'usage' && chunk.usage) {
            tokens = { input: chunk.usage.inputTokens || 0, output: chunk.usage.outputTokens || 0 }
          } else if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'max-tokens') {
              truncated = true
              break
            }
            if (chunk.reason.kind !== 'stop') {
              failure = chunk.reason.failure && chunk.reason.failure.message
                ? chunk.reason.failure.message
                : 'model error (' + chunk.reason.kind + ')'
              break
            }
          }
        }
      } catch (err) {
        // The provider rejected because we aborted (cancel or timeout): the
        // post-loop flags above decide the outcome, nothing to rethrow here.
        if (run.cancelled || timedOut || isAbort(err)) return null
        throw err
      }
      return null
    }
    try {
      // Only pass a reasoning effort the model actually supports; otherwise
      // omit it so the model uses its own default.
      try {
        const info = await llm.resolveModelInfo(provider, model)
        const efforts = info && info.reasoning && info.reasoning.efforts
        if (!efforts || !efforts.some(e => e.id === eff)) eff = undefined
      } catch (err) { /* keep eff; the stream may still reject below */ }
      try {
        await consume(eff)
      } catch (err) {
        const message = String((err && err.message) || err)
        if (eff !== undefined && !isAbort(err) && !run.cancelled && !timedOut && /reasoning effort/i.test(message)) {
          eff = undefined
          await consume(undefined)
        } else {
          throw err
        }
      }
    } finally {
      disposeTimeout()
      if (inflight === run) inflight = null
    }
    if (run.cancelled) return { cancelled: true }
    if (timedOut) {
      const e = new Error('translation timed out (' + c.timeoutMs + ' ms)')
      e.code = 'timeout'; e.detail = c.timeoutMs
      throw e
    }
    if (failure) {
      const e = new Error('model call failed: ' + failure)
      e.code = 'model-error'; e.detail = failure
      throw e
    }
    if (!out || !out.trim()) {
      const e = new Error('model returned no translation')
      e.code = 'translated-empty'
      throw e
    }
    // Some providers (e.g. OpenAI-compatible local endpoints) report zero
    // usage; estimate from text length rather than hiding the figure.
    if (!tokens || (tokens.input === 0 && tokens.output === 0)) {
      const est = (s) => {
        const cjk = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/g) || []).length
        return Math.max(1, Math.round(cjk * 0.9 + (s.length - cjk) / 3.5))
      }
      tokens = { input: est(text), output: est(out.trim()) }
    }
    return { text: out.trim(), truncated, tokens }
  }

  async function enumerateModels() {
    const out = []
    try {
      const providers = (llm.listProviders && llm.listProviders()) || []
      for (const p of providers) {
        let models = []
        try { models = (await llm.listModels(p.id)) || [] } catch (err) { console.error('[translator] listModels failed:', p.id, err) }
        const pLabel = p.name || p.id
        for (const m of models) {
          out.push({ provider: p.id, model: m.id, label: pLabel + ' / ' + (m.name || m.id) })
        }
      }
    } catch (err) {
      console.error('[translator] list-models failed:', err)
    }
    return out
  }

  async function handleTranslate(payload) {
    const raw = payload && typeof payload.text === 'string' ? payload.text : ''
    const text = raw.trim().slice(0, 2000)
    if (!text) return { ok: false, error: { code: 'empty', message: 'nothing to translate' } }
    if (inflight) { inflight.cancelled = true; if (inflight.abort) inflight.abort() }
    const run = { cancelled: false }
    inflight = run
    runSeq += 1
    const c = readConfig(config)
    const target = resolveTarget(text, c)
    try {
      // Engine `api`: the keyless public chain, no model lookup at all — it
      // must work on a harness with no LLM provider configured.
      if (c.engine === 'api') {
        const controller = new AbortController()
        let timedOut = false
        run.signal = controller.signal
        run.abort = () => controller.abort()
        // The chain applies its own per-provider slices; this is the overall
        // cap that turns a hung endpoint into the same `timeout` code the
        // model engine reports.
        const disposeTimeout = ctx.timeout(() => { timedOut = true; controller.abort() }, c.timeoutMs)
        try {
          const result = await translateFree(text, target, {
            provider: c.apiProvider,
            timeoutMs: c.timeoutMs,
            signal: controller.signal,
          })
          if (run.cancelled) return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }
          return { ok: true, value: { target, text: result.text, engine: 'api', provider: result.provider } }
        } catch (err) {
          if (run.cancelled) return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }
          if (timedOut) {
            const e = new Error('translation timed out (' + c.timeoutMs + ' ms)')
            e.code = 'timeout'; e.detail = c.timeoutMs
            throw e
          }
          throw err
        } finally {
          disposeTimeout()
        }
      }
      const picked = await pickModel(c)
      if (run.cancelled) return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }
      const result = await translateWithModel(picked.provider, picked.model, text, target, c, run)
      if (result.cancelled) return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }
      return { ok: true, value: { target, text: result.text, engine: 'model', truncated: result.truncated === true, model: picked.model, reasoningEffort: c.reasoningEffort, tokens: result.tokens } }
    } catch (err) {
      // Error codes are the locale-independent contract; the browser card
      // renders them through its own zh/en dictionary.
      const code = err && typeof err.code === 'string' ? err.code : 'translate-failed'
      const message = err instanceof Error ? err.message : String(err)
      const detail = err && typeof err.detail !== 'undefined' ? err.detail : undefined
      return { ok: false, error: { code, message, ...(detail !== undefined ? { detail } : {}) } }
    } finally {
      if (inflight === run) inflight = null
    }
  }

  function handleCancel(payload) {
    if (payload && typeof payload.seq === 'number' && payload.seq === runSeq && inflight) {
      inflight.cancelled = true
      if (inflight.abort) inflight.abort()
    }
    return { ok: true, value: null }
  }

  async function handleListModels() {
    return { ok: true, value: await enumerateModels() }
  }

  async function handleDefaultModel() {
    try {
      const sel = defaultModel && defaultModel.currentSelection()
      if (sel && sel.provider && sel.model) return { ok: true, value: { provider: sel.provider, model: sel.model } }
    } catch (err) {
      console.error('[translator] currentSelection failed:', err)
    }
    const providers = llm.listProviders()
    if (providers && providers.length > 0) {
      const models = await llm.listModels(providers[0].id).catch(() => [])
      if (models && models.length > 0) return { ok: true, value: { provider: providers[0].id, model: models[0].id } }
    }
    return { ok: true, value: null }
  }

  async function payloadOf(request) {
    try {
      const body = await request.json()
      return body !== null && typeof body === 'object' ? body : {}
    } catch {
      return {}
    }
  }

  /**
   * Exact Fetch routes on the shared `/api` channel. `ctx.inject` keeps the
   * plugin active in profiles without a carrier and unmounts every route with
   * the child context, so an unload leaves nothing registered.
   */
  ctx.inject(['connection'], (child) => {
    const routes = [
      ['/translate', async (request) => json(await handleTranslate(await payloadOf(request)))],
      ['/translate-cancel', async (request) => json(handleCancel(await payloadOf(request)))],
      ['/list-models', async () => json(await handleListModels())],
      ['/default-model', async () => json(await handleDefaultModel())],
    ]
    for (const [suffix, handler] of routes) {
      child.connection.fetch.register({
        path: API_BASE + suffix,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handler,
      })
    }
  })
}
