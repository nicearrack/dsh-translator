/**
 * dsh-translator — packaged Host half
 *
 * ESM Cordis plugin module, installed through the dsh bundle mechanism
 * (cordis.patch.yml row). The browser Client half calls this over HTTP:
 *
 *   POST /translator/api/translate         { text, seq? }
 *   POST /translator/api/translate-cancel  { seq }
 *   POST /translator/api/get-config        { }
 *   POST /translator/api/set-config        { patch }
 *   POST /translator/api/list-models       { }
 *
 * Response envelope (mirrors the dsh-better-sidebar API convention):
 *   { ok: true, value: <json> } | { ok: false, error: { code, message } }
 *
 * The translation core is identical to the dynamic-plugin host
 * (src/host.js): ctx.llm.stream with the user's default model, timeout,
 * single in-flight run, seq-matched cancellation.
 *
 * Configuration is persisted through the DSH `settings` service under the
 * `dsh-translator` namespace (per-profile), using a schemastery schema. This
 * is the DSH-recommended plugin configuration surface: the client card
 * registers in the `settings.plugin.item` slot and reads/writes over HTTP.
 */
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-translator'

export const inject = ['webServer', 'llm', 'timer']

const ROUTE_PREFIX = '/translator/api'

const DEFAULT_CONFIG = {
  primaryLanguage: 'zh-Hans',
  customModel: { provider: '', model: '' },
  reasoningEffort: 'low',
  timeoutMs: 30000,
  maxTokens: 1024,
  temperature: 0.3,
}

const Config = z.object({
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

function deepMerge(base, extra) {
  const out = Object.assign({}, base, extra)
  if (extra && extra.customModel) {
    out.customModel = Object.assign({}, base.customModel || {}, extra.customModel)
  }
  return out
}

export function apply(ctx) {
  const llm = ctx.get('llm')
  const defaultModel = ctx.get('agentDefaultModel')
  let settingsSvc = undefined
  let seq = 0
  let runSeq = 0
  let inflight = null

  // Memory fallback so the plugin still works if the settings service is not
  // mounted (e.g. a profile without the settings provider). When settings is
  // present, this is only used as a bootstrap default for `get-config`.
  let memConfig = deepMerge(DEFAULT_CONFIG, {})

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

  function currentConfig() {
    if (settingsSvc) {
      try {
        const v = settingsSvc.get('dsh-translator')
        if (v && typeof v === 'object') return regularize(deepMerge(DEFAULT_CONFIG, v))
      } catch (err) {
        console.error('[translator] settings.get failed:', err)
      }
    }
    return regularize(memConfig)
  }

  async function saveConfig(patch) {
    if (settingsSvc) {
      await settingsSvc.update('dsh-translator', patch || {})
    } else {
      memConfig = deepMerge(memConfig, patch || {})
    }
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
      throw new Error('未配置可用模型（无 LLM provider）')
    }
    const models = await llm.listModels(providers[0].id)
    if (!models || models.length === 0) {
      throw new Error('provider ' + providers[0].id + ' 没有可用模型')
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
    const disposeTimeout = ctx.timeout(() => { timedOut = true }, c.timeoutMs)
    const consume = async (effort) => {
      const stream = llm.stream({
        provider,
        model,
        messages: [{ id: 'tr-' + (++seq), role: 'user', content: [{ type: 'text', text }] }],
        system,
        temperature: c.temperature,
        maxTokens: c.maxTokens,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      })
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
              : '模型调用失败（' + chunk.reason.kind + '）'
            break
          }
        }
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
        if (eff !== undefined && /reasoning effort/i.test(message)) {
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
    if (timedOut) throw new Error('翻译超时（' + c.timeoutMs + ' 秒）')
    if (failure) throw new Error(failure)
    if (!out || !out.trim()) throw new Error('模型未返回译文')
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
    if (!text) return { ok: false, error: { code: 'empty', message: '没有可翻译的文本' } }
    if (inflight) inflight.cancelled = true
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

  async function handleGetConfig() {
    return { ok: true, value: currentConfig() }
  }

  async function handleSetConfig(payload) {
    try {
      await saveConfig(payload && payload.patch)
      return { ok: true, value: currentConfig() }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: { code: 'config-invalid', message } }
    }
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
      } else if (method === 'get-config') {
        result = await handleGetConfig()
      } else if (method === 'set-config') {
        result = await handleSetConfig(payload)
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

  // Register the settings namespace as soon as the settings service is
  // available (the DSH-recommended pattern; the service may mount after this
  // plugin's apply so a plain ctx.get at apply time is too early). Capturing
  // the service handle also lets currentConfig()/saveConfig() read and write
  // the persisted per-profile value.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsSvc = settingsCtx.settings
    try {
      settingsCtx.settings.register('dsh-translator', Config)
    } catch (err) {
      console.error('[translator] settings.register failed:', err)
    }
  })
}

const PRIMARY_LANGS = ['zh-Hans', 'zh-Hant', 'ja-JP', 'ko-KR', 'ru-RU']
