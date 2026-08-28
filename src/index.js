/**
 * dsh-translator — packaged Host half
 *
 * ESM Cordis plugin module, installed through the dsh bundle mechanism
 * (cordis.patch.yml row; see docs/user/develop/basic/publish). The browser
 * Client half calls this over HTTP for the business API only:
 *
 *   POST /translator/api/translate         { text, seq? }
 *   POST /translator/api/translate-cancel  { seq }
 *   POST /translator/api/list-models       { }
 *   POST /translator/api/default-model     { }
 *
 * The settings card is NOT served over this custom API: the card binds the
 * official `ctx.settingsScope` namespace (docs/reference/cookbook/
 * adding-a-settings-card), writing through the settings transport and
 * rendering the host-provided value/base/user layers.
 *
 * Response envelope (mirrors the dsh-better-sidebar API convention):
 *   { ok: true, value: <json> } | { ok: false, error: { code, message } }
 *
 * The translation core streams through ctx.llm with the user's default
 * model, a timeout, a single in-flight run, and seq-matched cancellation.
 *
 * Configuration follows docs/user/develop/basic/config: every tunable is a
 * plugin `Config` field with its default in the schema, so a deployment can
 * change any value from `cordis.yml` without touching code. The validated row
 * config arrives as `apply(ctx, config)` and is installed as the composition
 * `base` of the per-profile `settings` namespace (`dsh-translator`) through
 * the canonical `installSettingsSection` wiring: schema defaults ← row config
 * ← user document; without a settings provider the row config is the only
 * source and the plugin keeps working exactly as composed.
 */
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'dsh-translator'

export const inject = ['webServer', 'llm', 'timer']

const ROUTE_PREFIX = '/translator/api'

/** Browser pair key: the settings namespace the card binds on `ctx.settingsScope`. */
const TRANSLATOR_NS = settingsNamespace('dsh-translator')

/**
 * Plugin configuration (schemastery schema, Cordis Standard Schema).
 *
 * Defaults live here — the same schema validates the `config:` block of the
 * plugin row in `cordis.yml` and the user settings section stored under the
 * `dsh-translator` namespace, so the two layers can never drift apart.
 */
export const Config = z.object({
  primaryLanguage: z.union([z.const('zh-Hans'), z.const('zh-Hant'), z.const('ja-JP'), z.const('ko-KR'), z.const('ru-RU')]).default('zh-Hans'),
  customModel: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
  }).default({ provider: '', model: '' }),
  reasoningEffort: z.union([z.const('off'), z.const('low'), z.const('high'), z.const('max')]).default('low'),
  timeoutMs: z.number().min(1000).default(30000),
  maxTokens: z.number().min(1).default(1024),
  temperature: z.number().min(0).max(2).step(0.1).default(0.3),
})

function regularize(c) {
  return {
    primaryLanguage: PRIMARY_LANGS.includes(c.primaryLanguage) ? c.primaryLanguage : 'zh-Hans',
    customModel: { provider: String((c.customModel && c.customModel.provider) || ''), model: String((c.customModel && c.customModel.model) || '') },
    reasoningEffort: ['off', 'low', 'high', 'max'].includes(c.reasoningEffort) ? c.reasoningEffort : 'low',
    timeoutMs: (typeof c.timeoutMs === 'number' && c.timeoutMs >= 1000) ? Math.floor(c.timeoutMs) : 30000,
    maxTokens: (typeof c.maxTokens === 'number' && c.maxTokens >= 1) ? Math.floor(c.maxTokens) : 1024,
    temperature: (typeof c.temperature === 'number' && c.temperature >= 0 && c.temperature <= 2) ? c.temperature : 0.3,
  }
}

export function apply(ctx, config) {
  // Required services are ready before apply runs (docs/user/develop/framework/service):
  // injected services are read from ctx directly; only optional ones use ctx.get().
  const llm = ctx.llm
  const defaultModel = ctx.get('agentDefaultModel')
  // Row config (cordis.yml `config:`), validated and default-filled by Cordis
  // against the exported schema. It is the deployment base layer; the settings
  // user document wins over it.
  const rowConfig = config && typeof config === 'object' ? regularize(config) : null
  const schemaDefaults = Config({})
  let seq = 0
  let runSeq = 0
  let inflight = null

  // Canonical optional-settings consumer wiring
  // (docs/reference/cookbook/adding-a-settings-card): while a settings
  // service exists the namespace resolves schema defaults ← row config ←
  // user document; when the service goes away the config source falls back
  // to the composition entry, so translation keeps working as composed.
  let source = () => rowConfig ?? schemaDefaults
  installSettingsSection(ctx, TRANSLATOR_NS, Config, rowConfig ?? schemaDefaults, {
    setSource: (next) => { source = next },
    onChange: () => {},
  })

  // Exposure guard (docs/reference/subsystems/web-server: the carrier has no
  // TLS/auth/origin policy; only the app index is behind the browser-auth
  // fence, so every named route — including this one — is unauthenticated).
  // The official Typert Remote path is not available to out-of-repo plugins
  // (marker tables are module-private), so the honest posture is a loud
  // warning when the deployment deliberately listens on all interfaces.
  if (ctx.webServer.host === '0.0.0.0') {
    console.warn(
      '[dsh-translator] bound to 0.0.0.0: the unauthenticated /translator/api '
      + 'endpoints are reachable by anyone on the network; prefer 127.0.0.1 '
      + '(or upstream gate the prefix) when the harness serves a LAN.',
    )
  }
  // Fiber teardown aborts any in-flight provider stream (docs/user/develop/
  // framework: registrations and open work belong to the fiber).
  ctx.effect(() => () => {
    if (inflight && inflight.abort) inflight.abort()
  }, 'dsh-translator: abort in-flight translation')

  function currentConfig() {
    return regularize(source())
  }

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
    if (c.customModel && c.customModel.provider && c.customModel.model) {
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
    // carries it), so an abort actually tears down the provider request
    // instead of merely breaking out of the read loop while the fetch keeps
    // running — a stalled stream could otherwise outlive its timeout forever.
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
    const c = currentConfig()
    const target = resolveTarget(text, c)
    try {
      const picked = await pickModel(c)
      if (run.cancelled) return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }
      const result = await translateWithModel(picked.provider, picked.model, text, target, c, run)
      if (result.cancelled) return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }
      return { ok: true, value: { target, text: result.text, engine: 'model', truncated: result.truncated === true, model: picked.model, reasoningEffort: c.reasoningEffort, tokens: result.tokens } }
    } catch (err) {
      // Error codes are the locale-independent contract; the browser card
      // renders them through its own zh/en dictionary. `message` stays as a
      // neutral fallback for non-localized clients.
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
      } else if (method === 'list-models') {
        result = await handleListModels()
      } else if (method === 'default-model') {
        result = await handleDefaultModel()
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

const PRIMARY_LANGS = ['zh-Hans', 'zh-Hant', 'ja-JP', 'ko-KR', 'ru-RU']
