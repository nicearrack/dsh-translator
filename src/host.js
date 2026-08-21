/**
 * dsh-translator — Host half (canonical source, dynamic-plugin form)
 *
 * This file is the exact `code.host` body of the running dynamic plugin
 * (trsl-1 / pkg-4): a function body that RETURNS the Cordis plugin object.
 * It is loaded through the DSH dynamic-Cordis mechanism (cordis_define +
 * cordis_run).
 *
 * Provides two Package-private RPC methods:
 *   - translate(text)        — stream one LLM translation of the selection
 *   - translate-cancel(seq)  — cancel the in-flight call for request `seq`
 *
 * Runtime contract (verified against the cordis Inspect providers):
 *   - ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>
 *   - ctx.agentDefaultModel.currentSelection(): ModelSelection (optional)
 *   - ctx.timeout(cb, ms) from the timer service (inject: ['timer'])
 *   - `harness` builtin: harness.handle(method, handler) for Package-private
 *     Client→Host JSON RPC (dynamic-plugin only; a future packaged-bundle
 *     adapter must re-expose these methods through a Remote service).
 */
return {
  inject: ['llm', 'timer'],
  apply(ctx) {
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

    harness.handle('translate', async (args) => {
      const raw = args && typeof args === 'object' && typeof args.text === 'string' ? args.text : ''
      const text = raw.trim().slice(0, 2000)
      if (!text) return { ok: false, error: '没有可翻译的文本' }
      if (inflight) inflight.cancelled = true
      const run = { cancelled: false }
      inflight = run
      runSeq += 1
      const target = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text) ? 'en' : 'zh-CN'
      try {
        const picked = await pickModel()
        if (run.cancelled) return { ok: false, error: 'cancelled' }
        const result = await translateWithModel(picked.provider, picked.model, text, target, run)
        if (result.cancelled) return { ok: false, error: 'cancelled' }
        return { ok: true, result: { target, text: result.text, engine: 'model', truncated: result.truncated === true } }
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
  },
}
