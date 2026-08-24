/**
 * dsh-translator — Host half (canonical source, dynamic-plugin form)
 *
 * This file is the exact `code.host` body of the running dynamic plugin
 * (trsl-1 / pkg-4): a function body that RETURNS the Cordis plugin object.
 * It is loaded through the DSH dynamic-Cordis mechanism (cordis_define +
 * cordis_run).
 *
 * Package-private RPC methods (Client→Host JSON):
 *   - translate(text, seq)     — stream one LLM translation of the selection
 *   - translate-cancel(seq)    — cancel the in-flight call for request `seq`
 *   - get-config()             — read the current plugin configuration
 *   - set-config(patch)        — update the plugin configuration
 *   - list-models()            — enumerate all currently available DSH models
 *
 * Configuration (dynamic form) is kept in memory for the lifetime of the
 * plugin — dynamic plugins are process-local and transient. The packaged Host
 * (`src/index.js`) persists the same fields through the DSH `settings` service.
 *
 * Runtime contract (verified against the cordis Inspect providers):
 *   - ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>
 *   - ctx.llm.listProviders(): LlmProviderInfo[]
 *   - ctx.llm.listModels(provider): Promise<LlmModelInfo[]>
 *   - ctx.agentDefaultModel.currentSelection(): ModelSelection (optional)
 *   - ctx.timeout(cb, ms) from the timer service (inject: ['timer'])
 *   - `harness` builtin: harness.handle(method, handler) for Package-private
 *     Client→Host JSON RPC.
 */
return {
  inject: ['llm', 'timer'],
  apply(ctx) {
    const llm = ctx.get('llm')
    const defaultModel = ctx.get('agentDefaultModel')
    let seq = 0
    let runSeq = 0
    let inflight = null

    const DEFAULT_CONFIG = {
      primaryLanguage: 'zh-Hans',
      customModel: { provider: '', model: '' },
      reasoningEffort: 'low',
      timeoutMs: 30000,
      maxTokens: 1024,
      temperature: 0.3,
    }
    let cfg = Object.assign({}, DEFAULT_CONFIG, { customModel: Object.assign({}, DEFAULT_CONFIG.customModel) })

    const PRIMARY_LANGS = ['zh-Hans', 'zh-Hant', 'ja-JP', 'ko-KR', 'ru-RU']

    function sanitize(patch) {
      const out = {}
      if (!patch || typeof patch !== 'object') return out
      if (PRIMARY_LANGS.includes(patch.primaryLanguage)) out.primaryLanguage = patch.primaryLanguage
      if (patch.customModel && typeof patch.customModel === 'object') {
        const p = String(patch.customModel.provider || '')
        const m = String(patch.customModel.model || '')
        out.customModel = { provider: p, model: m }
      }
      if (patch.reasoningEffort === 'off' || patch.reasoningEffort === 'low' || patch.reasoningEffort === 'high' || patch.reasoningEffort === 'max') out.reasoningEffort = patch.reasoningEffort
      if (typeof patch.timeoutMs === 'number' && patch.timeoutMs >= 1000) out.timeoutMs = Math.floor(patch.timeoutMs)
      if (typeof patch.maxTokens === 'number' && patch.maxTokens >= 1) out.maxTokens = Math.floor(patch.maxTokens)
      if (typeof patch.temperature === 'number' && patch.temperature >= 0 && patch.temperature <= 2) out.temperature = patch.temperature
      return out
    }

    function currentConfig() {
      return Object.assign({}, DEFAULT_CONFIG, cfg, { customModel: Object.assign({}, DEFAULT_CONFIG.customModel, cfg.customModel || {}) })
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
        case 'zh-Hant': return '你是划词翻譯引擎。使用者訊息中的內容就是需要翻譯的文字，請將其翻譯成繁體中文。只輸出譯文本身：不要解釋、不要加引號、不要輸出原文、不要任何備註。'
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

    harness.handle('translate', async (args) => {
      const raw = args && typeof args === 'object' && typeof args.text === 'string' ? args.text : ''
      const text = raw.trim().slice(0, 2000)
      if (!text) return { ok: false, error: '没有可翻译的文本' }
      if (inflight) inflight.cancelled = true
      const run = { cancelled: false }
      inflight = run
      runSeq += 1
      const c = currentConfig()
      const target = resolveTarget(text, c)
      try {
        const picked = await pickModel(c)
        if (run.cancelled) return { ok: false, error: 'cancelled' }
        const result = await translateWithModel(picked.provider, picked.model, text, target, c, run)
        if (result.cancelled) return { ok: false, error: 'cancelled' }
        return { ok: true, result: { target, text: result.text, engine: 'model', truncated: result.truncated === true, model: picked.model, reasoningEffort: c.reasoningEffort, tokens: result.tokens } }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: message }
      } finally {
        if (inflight === run) inflight = null
      }
    })

    harness.handle('translate-cancel', (args) => {
      if (args && typeof args === 'object' && typeof args.seq === 'number' && args.seq === runSeq && inflight) {
        inflight.cancelled = true
      }
      return null
    })

    harness.handle('get-config', () => ({ ok: true, value: currentConfig() }))

    harness.handle('set-config', (args) => {
      const patch = sanitize(args && args.patch)
      cfg = Object.assign({}, cfg, patch, patch.customModel ? { customModel: Object.assign({}, cfg.customModel, patch.customModel) } : {})
      return { ok: true, value: currentConfig() }
    })

    harness.handle('list-models', async () => ({ ok: true, value: await enumerateModels() }))

    harness.handle('default-model', async () => {
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
    })
  },
}
