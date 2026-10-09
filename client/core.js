// dsh-translator — Client half (packaged bundle core)
//
// This file is the body of the client bundle factory. scripts/build.js wraps
// it into the dsh client-modules bundle format:
//
//   window.__ModuleLoader__.load({ id: "<package-name>", factory: (require) => { ... this body ... } })
//
// Two seats are contributed through the official slot registry:
//
//   shell.overlay       the frame-wide floating layer: the translate button
//                       and the translation card.
//   plugins.row.config  the Plugins page: this bundle's own row gains a
//                       configure control and opens the settings form there,
//                       keyed "<package name>#<row id>". A bundle's
//                       configuration belongs in `plugins.bundle.config` or
//                       `plugins.row.config`, not in a per-plugin settings
//                       item (that slot is the official host-plane pages').
//
// The settings form reads and writes through the Host-supplied `form` prop
// (`view: 'page'`), which is the schema-driven configuration transport
// (`ctx.configForms` behind the page) — the Client owns no settings channel of
// its own, and the Host's Config schema is the only source of defaults.
//
// The Host half is reached over the authenticated `/api` channel for the
// business API only:
//
//   POST api/translator/translate        { text }
//   POST api/translator/translate-cancel { seq }
//   POST api/translator/list-models      {}
//   POST api/translator/default-model    {}
//
// UI strings come from the official dictionary registry (ctx.locale.register
// below); both slot registrations declare `locale:` so the framework's `t`
// seat arrives on the component props and re-renders on locale switches.
//
// CSS is injected through a <style> element whose removal is registered with
// the plugin fiber; selection guard, positioning, races, and cancellation
// follow the Host-side translation flow.

let react = require('react')

const I18N = {
  zh: {
    tooltip: '划词翻译', translating: '翻译中…', truncated: '（译文可能被截断）',
    retry: '重试', pin: '固定', unpin: '取消固定', close: '关闭',
    copied: '已复制', copiedSource: '已复制原文',
    engine: '翻译引擎', engineApi: '免费 API（推荐）', engineModel: '大模型',
    apiProvider: '翻译服务', apiHint: '公共免费接口，无需填写 Key。划选的文本会发送到第三方翻译服务。',
    hostStale: '当前 DSH 实例尚未加载新版本，重启实例后才能使用「免费 API」引擎；下面暂时按「大模型」引擎显示。',
    providerAuto: '自动（推荐）', providerTencent: '腾讯交互翻译', providerBing: '微软 Bing',
    providerVolcengine: '火山翻译', providerMymemory: 'MyMemory',
    primaryLanguage: '主语言', model: '模型', followSession: '跟随会话默认',
    modelHint: '两项都留空时使用当前会话的默认模型',
    reasoningLevel: '推理等级',
    timeout: '超时（毫秒）', maxTokens: '最大输出 token', temperature: '温度',
    save: '保存', saving: '保存中…', discard: '放弃修改', saved: '已保存', saveFailed: '保存失败', overridden: '已覆盖', resetDefault: '恢复默认',
    readOnly: '当前连接不接受写入',
    errorEmpty: '没有可翻译的文本',
    errorNoProvider: '未配置可用模型（无 LLM provider）',
    errorNoModel: 'provider 没有可用模型',
    errorTranslatedEmpty: '模型未返回译文',
    errorTimeout: '翻译超时',
    errorModelFailed: '模型调用失败',
    errorApiFailed: '免费翻译接口暂时不可用，请稍后重试，或把引擎切换为「大模型」',
    errorFailed: '翻译失败',
    errorRequestFailed: '翻译请求失败',
  },
  en: {
    tooltip: 'Word-selection translation', translating: 'Translating…', truncated: '(may be truncated)',
    retry: 'Retry', pin: 'Pin', unpin: 'Unpin', close: 'Close',
    copied: 'Copied', copiedSource: 'Copied source',
    engine: 'Engine', engineApi: 'Free API (recommended)', engineModel: 'Model',
    apiProvider: 'Translation service', apiHint: 'Public free endpoints — no key to enter. Selected text is sent to a third-party translation service.',
    hostStale: 'This DSH instance has not loaded the new version yet — restart it to get the Free API engine. The model engine is shown meanwhile.',
    providerAuto: 'Automatic (recommended)', providerTencent: 'Tencent', providerBing: 'Microsoft Bing',
    providerVolcengine: 'Volcengine', providerMymemory: 'MyMemory',
    primaryLanguage: 'Primary language', model: 'Model', followSession: 'Session default',
    modelHint: 'Leave both empty to use the session\'s default model',
    reasoningLevel: 'Reasoning effort',
    timeout: 'Timeout (ms)', maxTokens: 'Max tokens', temperature: 'Temperature',
    save: 'Save', saving: 'Saving…', discard: 'Discard changes', saved: 'Saved', saveFailed: 'Save failed', overridden: 'Overridden', resetDefault: 'Reset to default',
    readOnly: 'This connection does not accept writes',
    errorEmpty: 'Nothing to translate',
    errorNoProvider: 'No configured model (no LLM provider)',
    errorNoModel: 'Provider has no available model',
    errorTranslatedEmpty: 'The model returned no translation',
    errorTimeout: 'Translation timed out',
    errorModelFailed: 'Model call failed',
    errorApiFailed: 'The free translation endpoints are unavailable — try again later, or switch the engine to Model',
    errorFailed: 'Translation failed',
    errorRequestFailed: 'Translation request failed',
  },
}
const ERROR_KEY = {
  'empty': 'errorEmpty',
  'no-provider': 'errorNoProvider',
  'no-model': 'errorNoModel',
  'translated-empty': 'errorTranslatedEmpty',
  'timeout': 'errorTimeout',
  'api-timeout': 'errorTimeout',
  'model-error': 'errorModelFailed',
  'api-failed': 'errorApiFailed',
}
const LANG_NAMES = {
  'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', 'ja-JP': '日本語', 'ko-KR': '한국어', 'ru-RU': 'Русский', 'en': 'English',
}
/** Keyless providers the API engine offers, in chain order, `auto` first. */
const API_PROVIDER_IDS = ['auto', 'tencent', 'bing', 'volcengine', 'mymemory']
/** Localized label of one provider id, falling back to the raw id. */
function providerName(t, id) {
  if (!id) return ''
  const label = t('provider' + id.charAt(0).toUpperCase() + id.slice(1))
  return label || id
}
function formatTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}
function langName(code) {
  return LANG_NAMES[code] || code
}

const TRANSLATOR_CSS = `
[data-dsh-translator-root] {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
}
[data-dsh-translator-btn] {
  position: absolute;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  margin: 0;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
  pointer-events: auto;
  transition: transform 120ms ease;
}
[data-dsh-translator-btn]:hover {
  transform: scale(1.08);
}
[data-dsh-translator-btn]:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
[data-dsh-translator-card] {
  position: absolute;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  pointer-events: auto;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 1.55;
  max-height: 60vh;
  overflow: hidden;
}
[data-dsh-translator-actions] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  flex: 0 0 auto;
}
[data-dsh-translator-actions] button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  pointer-events: auto;
}
[data-dsh-translator-actions] button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
[data-dsh-translator-actions] [data-dsh-translator-pin="on"] {
  color: var(--dsw-alias-brand-primary);
}
[data-dsh-translator-source] {
  padding: 10px 12px 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 1.5;
  max-height: 4.5em;
  overflow: hidden;
  word-break: break-word;
  cursor: move;
  -webkit-user-select: none;
  user-select: none;
}
[data-dsh-translator-body] {
  padding: 2px 12px 10px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  word-break: break-word;
  white-space: pre-wrap;
  user-select: none;
  -webkit-user-select: none;
  cursor: pointer;
}
[data-dsh-translator-error] {
  color: var(--dsw-alias-state-error-primary);
}
[data-dsh-translator-foot] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.4;
}
[data-dsh-translator-meta] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-translator-foot] [data-dsh-translator-act] {
  appearance: none;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
[data-dsh-translator-copied] {
  position: absolute;
  right: 12px;
  bottom: 40px;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.4;
  pointer-events: none;
  opacity: 0.95;
}
[data-dsh-translator-settings] {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
[data-dsh-translator-settings-row] {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
[data-dsh-translator-field] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 0;
  min-width: 0;
}
[data-dsh-translator-field-head] {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
}
[data-dsh-translator-field-label] {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}
[data-dsh-translator-field-badges] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
[data-dsh-translator-badge] {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 1.5;
}
[data-dsh-translator-reset] {
  appearance: none;
  padding: 0;
  border: none;
  background: none;
  color: var(--dsw-alias-brand-primary);
  font-family: inherit;
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
}
[data-dsh-translator-reset]:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
[data-dsh-translator-field-hint] {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.4;
}
[data-dsh-translator-select] {
  position: relative;
}
[data-dsh-translator-select-trigger] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 34px;
  box-sizing: border-box;
  padding: 0 10px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
}
[data-dsh-translator-select-trigger]:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
[data-dsh-translator-select-trigger]:disabled {
  opacity: 0.5;
  cursor: default;
}
[data-dsh-translator-select-label] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-translator-select-arrow] {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-tertiary);
}
[data-dsh-translator-select-menu] {
  position: absolute;
  z-index: 10;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  max-height: 260px;
  overflow-y: auto;
  padding: 4px;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
}
[data-dsh-translator-select-option] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  text-align: left;
  cursor: pointer;
}
[data-dsh-translator-select-option]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
[data-dsh-translator-select-option][aria-selected="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
}
[data-dsh-translator-settings] input {
  height: 34px;
  padding: 0 12px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
}
[data-dsh-translator-settings] input:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
[data-dsh-translator-settings] input:disabled {
  opacity: 0.5;
}
[data-dsh-translator-settings-footer] {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
[data-dsh-translator-settings-status] {
  margin-left: auto;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
[data-dsh-translator-settings-discard] {
  appearance: none;
  padding: 5px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
[data-dsh-translator-settings-discard]:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
[data-dsh-translator-settings-save] {
  appearance: none;
  padding: 5px 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
[data-dsh-translator-settings-save]:hover:not(:disabled) {
  opacity: 0.92;
}
[data-dsh-translator-settings-discard]:disabled,
[data-dsh-translator-settings-save]:disabled {
  opacity: 0.4;
  cursor: default;
}
[data-dsh-translator-settings-discard]:focus-visible,
[data-dsh-translator-settings-save]:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  [data-dsh-translator-btn] {
    transition: none;
  }
}
`

/** One POST to an exact Fetch route on the authenticated `/api` channel. */
async function callApi(method, payload) {
  const response = await fetch('api/translator/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const parsed = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true) {
    const error = parsed && parsed.error
    const err = new Error(error ? (error.message || error.code) : 'HTTP ' + response.status)
    if (error && typeof error.code === 'string') err.code = error.code
    if (error && typeof error.detail !== 'undefined') err.detail = error.detail
    throw err
  }
  return parsed.value
}

let requestSeq = 0
let selHideTimer = null
let btnSuppressed = false
let dragging = false
let dragStartX = 0, dragStartY = 0, dragLeft = 0, dragTop = 0
let suppressNextUp = false
let unmounted = false
let stateRef = { card: null, btnText: null }
const CARD_W = 320

function isInsideRoot(target) {
  let node = target
  while (node && node !== document) {
    if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-dsh-translator-root')) {
      return true
    }
    node = node.parentNode
  }
  return false
}

function inputSelectionRect(el, start, end) {
  try {
    const cs = window.getComputedStyle(el)
    const width = Math.max(el.clientWidth, 1)
    const css = [
      'position:absolute', 'top:0', 'left:0', 'visibility:hidden', 'pointer-events:none',
      'white-space:pre-wrap',
      'word-break:' + (cs.wordBreak || 'break-word'),
      'overflow-wrap:' + (cs.overflowWrap || 'break-word'),
      'font:' + (cs.font || ''),
      'line-height:' + (cs.lineHeight || 'normal'),
      'letter-spacing:' + (cs.letterSpacing || 'normal'),
      'word-spacing:' + (cs.wordSpacing || 'normal'),
      'tab-size:' + (cs.tabSize || '8'),
      'padding:0', 'border:0', 'box-sizing:border-box',
      'width:' + width + 'px',
    ].join(';')
    function measure(offset) {
      const mirror = document.createElement('div')
      mirror.style.cssText = css
      const mark = document.createElement('span')
      mark.textContent = '\u200b'
      mirror.textContent = el.value.slice(0, offset)
      mirror.appendChild(mark)
      document.body.appendChild(mirror)
      const r = mark.getBoundingClientRect()
      document.body.removeChild(mirror)
      return r
    }
    const s = measure(start)
    const e = measure(end)
    const elRect = el.getBoundingClientRect()
    const padLeft = parseFloat(cs.paddingLeft) || 0
    const padTop = parseFloat(cs.paddingTop) || 0
    const x = elRect.left + padLeft - (el.scrollLeft || 0)
    const y = elRect.top + padTop - (el.scrollTop || 0)
    const top = y + s.top
    const bottom = y + e.bottom
    const left = x + s.left
    const right = x + e.left
    const rect = {
      top,
      bottom: Math.max(bottom, top + 8),
      left,
      right: Math.max(right, left + 8),
    }
    if (rect.right <= rect.left || rect.bottom <= rect.top) return null
    return rect
  } catch (err) {
    return null
  }
}

function currentSelection() {
  const el = document.activeElement
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number' && el.selectionStart !== el.selectionEnd) {
    const text = el.value.slice(el.selectionStart, el.selectionEnd).replace(/\s+/g, ' ').trim()
    if (!text) return null
    const rect = inputSelectionRect(el, el.selectionStart, el.selectionEnd)
    if (!rect) return null
    return { text, rect }
  }
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (range.collapsed) return null
  if (isInsideRoot(range.startContainer) || isInsideRoot(range.endContainer)) return null
  const text = range.toString().replace(/\s+/g, ' ').trim()
  if (!text) return null
  const rect = range.getBoundingClientRect()
  if (!rect || (rect.width === 0 && rect.height === 0)) return null
  return { text, rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}

function cancelLoadingCard(card) {
  if (card && card.status === 'loading' && card.reqId) {
    callApi('translate-cancel', { seq: card.reqId }).catch(() => {})
  }
}

function PinIcon(props) {
  return react.createElement('svg', { viewBox: '0 0 24 24', width: 13, height: 13, 'aria-hidden': true, fill: props.filled ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    react.createElement('path', { d: 'M12 17v5' }),
    react.createElement('path', { d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z' }),
  )
}

// Universal translate glyph: lucide "languages" (MIT) — the 文/A pair as one
// vector path; stroke style matches the card's Pin/X icons, currentColor.
function TranslateIcon() {
  return react.createElement('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    react.createElement('path', { d: 'm5 8l6 6m-7 0l6-6l2-3M2 5h12M7 2h1m14 20l-5-10l-5 10m2-4h6' }),
  )
}

function XIcon() {
  return react.createElement('svg', { viewBox: '0 0 24 24', width: 13, height: 13, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    react.createElement('path', { d: 'M18 6 6 18' }),
    react.createElement('path', { d: 'm6 6 12 12' }),
  )
}

function ChevronDownIcon() {
  return react.createElement('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    react.createElement('path', { d: 'm6 9 6 6 6-6' }),
  )
}

// The framework delivers the typed `t` seat (a `Translate(key, params)`
// function) because both registrations declare `locale: 'dsh-translator'`; the
// dictionary-backed fallback covers a seat the runtime did not forward.
// Never read the dictionary by property here: `props.t` is a function, so
// `t.tooltip` would silently be `undefined`.
function translate(props) {
  if (props && typeof props.t === 'function') return props.t
  return (key) => I18N.zh[key]
}

function TranslatorRoot(props) {
  const t = translate(props)
  const [btn, setBtn] = react.useState(null)
  const [card, setCard] = react.useState(null)
  const [copied, setCopied] = react.useState(null)
  stateRef.card = card

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    } catch (err) { /* ignore */ }
  }

  function copy(which) {
    const text = which === 'source' ? card && card.text : (card && ((card.result && card.result.text) || card.error))
    if (!text) return
    setCopied(which)
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {}).catch(() => fallbackCopy(text))
      } else {
        fallbackCopy(text)
      }
    } catch (err) {
      fallbackCopy(text)
    }
  }

  react.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), 1200)
    return () => clearTimeout(timer)
  }, [copied])

  function beginDrag(e) {
    if (!stateRef.card || stateRef.card.pinned) return
    dragging = true
    dragStartX = e.clientX
    dragStartY = e.clientY
    dragLeft = stateRef.card.left
    dragTop = stateRef.card.top
    e.preventDefault()
  }

  function onDragMove(e) {
    if (!dragging || !stateRef.card) return
    const c = stateRef.card
    const left = clamp(dragLeft + (e.clientX - dragStartX), 0, Math.max(0, window.innerWidth - c.width))
    const top = clamp(dragTop + (e.clientY - dragStartY), 0, Math.max(0, window.innerHeight - 80))
    setCard(prev => prev && prev.reqId === c.reqId ? { ...prev, left, top, dragged: true } : prev)
  }

  function onDragEnd() {
    if (dragging) { dragging = false; suppressNextUp = true }
  }

  // Shared by the mouseup flow and the close button: re-show the floating
  // button when the selection is still present, honor the suppression flag.
  function refreshButton() {
    if (btnSuppressed) return
    const info = currentSelection()
    if (!info) {
      setBtn(null)
      stateRef.btnText = null
      return
    }
    const rect = info.rect
    const left = clamp(rect.right - 8 - 32, 4, window.innerWidth - 36)
    let top = rect.top - 32 - 6
    if (top < 4) top = rect.bottom + 6
    setBtn({ left, top, text: info.text, rect })
    stateRef.btnText = info.text
  }

  react.useEffect(() => {
    unmounted = false
    function onMouseUp(e) {
      if (suppressNextUp) { suppressNextUp = false; return }
      if (dragging) return
      if (isInsideRoot(e.target)) return
      btnSuppressed = false
      // A pinned card owns its in-flight translation: clicking elsewhere must
      // not kill the run the user pinned to keep. Escape already behaves this
      // way (it returns before cancelLoadingCard when the card is pinned).
      const pinned = Boolean(stateRef.card && stateRef.card.pinned)
      if (!pinned) cancelLoadingCard(stateRef.card)
      const info = currentSelection()
      if (!info) {
        setBtn(null)
        stateRef.btnText = null
        if (!pinned) setCard(null)
        return
      }
      if (!pinned) setCard(null)
      refreshButton()
    }

    function onSelectionChange() {
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        if (typeof el.selectionStart === 'number' && el.selectionStart !== el.selectionEnd) return
      }
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        // Debounce: a streaming DOM update can transiently collapse the
        // selection; only hide if it stays empty for a moment.
        if (selHideTimer) clearTimeout(selHideTimer)
        selHideTimer = setTimeout(() => { setBtn(null); stateRef.btnText = null }, 200)
        return
      }
      if (selHideTimer) { clearTimeout(selHideTimer); selHideTimer = null }
      const range = sel.getRangeAt(0)
      if (isInsideRoot(range.startContainer) || isInsideRoot(range.endContainer)) {
        setBtn(null)
        stateRef.btnText = null
        return
      }
      // Do NOT show the button here: selectionchange fires continuously while
      // the user is still dragging a selection. Only mouseup shows the button.
    }

    function onMouseDown(e) {
      // Starting a new interaction/selection hides any lingering button.
      if (!isInsideRoot(e.target)) { setBtn(null); stateRef.btnText = null }
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        if (stateRef.card && stateRef.card.pinned) { setBtn(null); return }
        btnSuppressed = false
        cancelLoadingCard(stateRef.card)
        setCard(null)
        setBtn(null)
      }
    }

    function onScroll(e) {
      if (isInsideRoot(e.target)) return
      if (btnSuppressed) return
      // Streaming output triggers continuous scroll events. Do not dismiss
      // the UI: reposition the button while the selection stays on screen,
      // hide only when it scrolls out of view. The card is fixed and stays.
      const info = currentSelection()
      if (!info) { setBtn(null); stateRef.btnText = null; return }
      const r = info.rect
      if (r.bottom < -20 || r.top > window.innerHeight + 20 || r.right < -20 || r.left > window.innerWidth + 20) {
        setBtn(null)
        stateRef.btnText = null
        return
      }
      if (stateRef.btnText !== info.text) return
      const left = clamp(r.right - 8 - 32, 4, window.innerWidth - 36)
      let top = r.top - 32 - 6
      if (top < 4) top = r.bottom + 6
      setBtn({ left, top, text: info.text, rect: r })
    }

    function onResize() {
      cancelLoadingCard(stateRef.card)
      setBtn(null)
      setCard(null)
    }

    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('mouseup', onDragEnd)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('mousemove', onDragMove)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      unmounted = true
      cancelLoadingCard(stateRef.card)
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mouseup', onDragEnd)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('mousemove', onDragMove)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  // The initial placement uses an estimated height (280 px). Once the card
  // is rendered, measure it and snap the position to the real height —
  // otherwise an above-placed card leaves a gap between its bottom and the
  // selection when the real height is smaller than the estimate.
  react.useEffect(() => {
    if (!card || !card.anchor || card.dragged) return
    const el = document.querySelector('[data-dsh-translator-card]')
    if (!el) return
    const h = el.offsetHeight
    let top = card.anchor.bottom + 10
    if (top + h > window.innerHeight - 8) top = card.anchor.top - h - 10
    top = clamp(top, 8, Math.max(8, window.innerHeight - h - 8))
    if (Math.abs(top - card.top) > 2) {
      setCard(prev => prev && prev.reqId === card.reqId ? { ...prev, top } : prev)
    }
  }, [card])

  function errorText(errCode, fallbackMessage) {
    const key = errCode && ERROR_KEY[errCode]
    const text = key ? t(key) : undefined
    if (text) return text
    return fallbackMessage || t('errorFailed')
  }

  function translateText(text) {
    const id = ++requestSeq
    setCard(prev => prev ? { ...prev, status: 'loading', error: null, reqId: id } : prev)
    callApi('translate', { text, seq: id }).then((value) => {
      if (unmounted || id !== requestSeq) return
      const v = value && typeof value === 'object' ? value : {}
      if (typeof v.text === 'string') {
        setCard(prev => prev ? { ...prev, status: 'done', result: { target: v.target, text: v.text, engine: v.engine, provider: v.provider, truncated: v.truncated === true, model: v.model, reasoningEffort: v.reasoningEffort, tokens: v.tokens } } : prev)
      } else {
        setCard(prev => prev ? { ...prev, status: 'error', error: errorText() } : prev)
      }
    }).catch((err) => {
      if (unmounted || id !== requestSeq) return
      // Cancellation is something this client asked for, not a failure to
      // report. `cancelled` deliberately has no ERROR_KEY entry, so rendering
      // it through errorText would fall through to err.message and print the
      // raw internal token on the card.
      if (err && err.code === 'cancelled') return
      setCard(prev => prev ? { ...prev, status: 'error', error: errorText(err && err.code, (err && err.message) || t('errorRequestFailed')) } : prev)
    })
  }

  function openPopup() {
    if (!btn) return
    // The button is a one-shot trigger: hide it once the card takes over.
    btnSuppressed = true
    setBtn(null)
    const rect = btn.rect
    const maxH = Math.min(window.innerHeight * 0.6, 420)
    const estH = Math.min(maxH, 280)
    let top = rect.bottom + 10
    if (top + estH > window.innerHeight - 8) top = rect.top - estH - 10
    top = clamp(top, 8, Math.max(8, window.innerHeight - estH - 8))
    const left = clamp(rect.left, 8, Math.max(8, window.innerWidth - CARD_W - 8))
    setCard({ left, top, width: CARD_W, text: btn.text, status: 'loading', result: null, error: null, reqId: 0, anchor: rect })
    translateText(btn.text)
  }

  const children = []
  if (btn) {
    children.push(react.createElement('button', {
      key: 'btn',
      'data-dsh-translator-btn': '',
      style: { left: btn.left + 'px', top: btn.top + 'px' },
      title: t('tooltip'),
      onMouseDown: (e) => e.preventDefault(),
      onClick: openPopup,
    }, react.createElement(TranslateIcon)))
  }
  if (card) {
    const bodyChildren = []
    if (card.status === 'loading') {
      bodyChildren.push(react.createElement('div', { key: 'loading' }, t('translating')))
    } else if (card.status === 'error') {
      bodyChildren.push(react.createElement('div', { key: 'err', 'data-dsh-translator-error': '' }, card.error))
    } else if (card.result) {
      bodyChildren.push(react.createElement('div', { key: 'ok' }, card.result.text))
    }
    const footChildren = []
    if (card.result && card.result.engine === 'api') {
      // The free path has no model and no token count; naming the provider it
      // actually used is the only honest metadata it can show.
      const metaParts = []
      if (card.result.target) metaParts.push('→ ' + langName(card.result.target))
      if (card.result.provider) metaParts.push(providerName(t, card.result.provider))
      if (metaParts.length) footChildren.push(react.createElement('span', { key: 'dir', 'data-dsh-translator-meta': '' }, metaParts.join(' · ')))
    } else if (card.result && card.result.engine === 'model') {
      const metaParts = []
      if (card.result.target) metaParts.push('→ ' + langName(card.result.target))
      if (card.result.model) metaParts.push(card.result.model)
      if (card.result.reasoningEffort) metaParts.push(card.result.reasoningEffort)
      if (card.result.tokens) {
        const total = (card.result.tokens.input || 0) + (card.result.tokens.output || 0)
        if (total > 0) metaParts.push(formatTokens(total) + ' tokens')
      }
      if (metaParts.length) footChildren.push(react.createElement('span', { key: 'dir', 'data-dsh-translator-meta': '' }, metaParts.join(' · ')))
    }
    if (card.result && card.result.truncated) {
      footChildren.push(react.createElement('span', { key: 'trunc' }, t('truncated')))
    }
    if (card.status === 'error') {
      footChildren.push(react.createElement('button', { key: 'retry', 'data-dsh-translator-act': '', onClick: () => translateText(card.text) }, t('retry')))
    }
    footChildren.push(react.createElement('div', { key: 'actions', 'data-dsh-translator-actions': '' },
      react.createElement('button', { 'data-dsh-translator-pin': card.pinned ? 'on' : 'off', title: card.pinned ? t('unpin') : t('pin'), onClick: () => setCard(prev => prev ? { ...prev, pinned: !prev.pinned } : prev) }, react.createElement(PinIcon, { filled: card.pinned === true })),
      react.createElement('button', { 'data-dsh-translator-close': '', title: t('close'), onClick: () => { btnSuppressed = false; cancelLoadingCard(stateRef.card); setCard(null); refreshButton() } }, react.createElement(XIcon)),
    ))
    children.push(react.createElement('div', {
      key: 'card',
      'data-dsh-translator-card': '',
      'data-dsh-translator-pinned': card.pinned ? '' : undefined,
      style: { left: card.left + 'px', top: card.top + 'px', width: card.width + 'px' },
    },
      react.createElement('div', { 'data-dsh-translator-source': '', onMouseDown: beginDrag, onClick: () => copy('source') }, card.text),
      react.createElement('div', { 'data-dsh-translator-body': '', onClick: () => copy('result') }, ...bodyChildren),
      react.createElement('div', { 'data-dsh-translator-foot': '' }, ...footChildren),
      copied ? react.createElement('div', { key: 'copied', 'data-dsh-translator-copied': '' }, copied === 'source' ? t('copiedSource') : t('copied')) : null,
    ))
  }
  return react.createElement('div', { 'data-dsh-translator-root': '' }, ...children)
}

// ---------------------------------------------------------------------------
// Plugins page: this bundle's own configuration.
//
// A bundle's configuration belongs on its own page in the Plugins list, in the
// `plugins.bundle.config` seat keyed by the bundle's package name — the same
// one-click placement an official plugin's page has. The page passes
// `view: 'page'` and no form, so this half owns the entry's form through
// `ctx.configForms.get(<row id>)`, exactly like the shipped settings pages do.
//
// The snapshot resolves `value` through schema defaults → composition base →
// user layer, `base` is the layer a cleared field reverts to, and `user`'s
// field PRESENCE marks a field overridden.
// ---------------------------------------------------------------------------

/** The bundle's package name: the `plugins.bundle.config` cell key. */
const PACKAGE_NAME = '@nicearrack/dsh-translator'

/** Settings namespace: the profile entry id our own patch row declares. */
const SETTINGS_NS = 'dsh-translator'

/** Schema defaults, used only when the Host reports no composition base. */
const FALLBACK_BASE = { engine: 'api', apiProvider: 'auto', primaryLanguage: 'zh-Hans', customModel: { provider: '', model: '' }, reasoningEffort: 'low', timeoutMs: 30000, maxTokens: 1024, temperature: 0.3 }

/**
 * Every editable field path. `customModel` is addressed through its children
 * because the schema marks the leaves volatile, not the container: a write to
 * the parent path is refused as non-volatile.
 */
const MODEL_PROVIDER = ['customModel', 'provider']
const MODEL_NAME = ['customModel', 'model']
const CONFIG_PATHS = [
  ['engine'],
  ['apiProvider'],
  ['primaryLanguage'],
  MODEL_PROVIDER,
  MODEL_NAME,
  ['reasoningEffort'],
  ['timeoutMs'],
  ['maxTokens'],
  ['temperature'],
]

function atPath(root, path) {
  let node = root
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[key]
  }
  return node
}

function hasPath(root, path) {
  let node = root
  for (const key of path) {
    if (node === null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key)) return false
    node = node[key]
  }
  return true
}

function cloneConfig(value) {
  return value === null || typeof value !== 'object' ? value : JSON.parse(JSON.stringify(value))
}

function sameAtPath(a, b, path) {
  return JSON.stringify(atPath(a, path)) === JSON.stringify(atPath(b, path))
}

/** Whether two already-resolved values are equal for a settings field. */
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The layer value one field reverts to, falling back to the schema default. */
function layerValue(base, path) {
  const fromBase = atPath(base, path)
  return (fromBase !== undefined && fromBase !== null) ? fromBase : atPath(FALLBACK_BASE, path)
}

/**
 * Build the write for one draft against the Host's committed section.
 *
 * A changed field is `set`, or `unset` when the draft already equals the layer
 * it would revert to (the Host then re-inherits or drops the entry). A field
 * that is unchanged but still carries a stale user-layer entry equal to the
 * layer is cleaned in the same write; its presence is invisible to the
 * `overridden` badge, which tracks the effective difference.
 * @param draft - the edited section.
 * @param value - the committed resolved section.
 * @param base - the composition layer beneath the user's entries.
 * @param user - the raw user section, whose field presence marks an override.
 * @returns ordered path operations for one atomic mutation.
 */
function settingsOps(draft, value, base, user) {
  const ops = []
  for (const path of CONFIG_PATHS) {
    const changed = !sameAtPath(draft, value, path)
    const atLayer = sameValue(atPath(draft, path), layerValue(base, path))
    if (changed) {
      ops.push(atLayer ? { op: 'unset', path } : { op: 'set', path, value: atPath(draft, path) })
    } else if (atLayer && hasPath(user, path)) {
      ops.push({ op: 'unset', path })
    }
  }
  return ops
}

function ConfigSelect(props) {
  const { value, onChange, options, placeholder, disabled } = props
  const [open, setOpen] = react.useState(false)
  const ref = react.useRef(null)
  const sel = options && options.find(o => o.value === value)
  react.useEffect(() => {
    if (!open) return
    function onDoc(e) { if (ref.current && ref.current.contains && !ref.current.contains(e.target)) setOpen(false) }
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  return react.createElement('div', { 'data-dsh-translator-select': '', ref },
    react.createElement('button', { 'data-dsh-translator-select-trigger': '', type: 'button', disabled: disabled === true, onClick: () => setOpen(!open), 'aria-haspopup': 'listbox', 'aria-expanded': open ? 'true' : 'false' },
      react.createElement('span', { 'data-dsh-translator-select-label': '' }, sel ? sel.label : (placeholder || '')),
      react.createElement('span', { 'data-dsh-translator-select-arrow': '', 'aria-hidden': 'true' }, react.createElement(ChevronDownIcon)),
    ),
    open ? react.createElement('div', { 'data-dsh-translator-select-menu': '', role: 'listbox' },
      options.map(o => react.createElement('button', { key: o.value, 'data-dsh-translator-select-option': '', type: 'button', role: 'option', 'aria-selected': o.value === value ? 'true' : undefined, onMouseDown: (e) => e.preventDefault(), onClick: () => { onChange(o.value); setOpen(false) } }, o.label)),
    ) : null,
  )
}

/** One-liner for the row description fallback (the bundle's own locale meta wins). */
function SettingsSummary(props) {
  const t = translate(props)
  const state = snapshotOf(props)
  const value = state ? state.value : null
  if (value === null || value === undefined) return null
  // Only claim the free API engine when the Host actually reports it: a Host
  // that predates the field still runs the model engine, so the summary must
  // not advertise a default it does not have.
  const apiMode = value.engine === 'api'
  const pick = apiMode
    ? providerName(t, value.apiProvider || 'auto')
    : (value.customModel && value.customModel.provider && value.customModel.model
      ? value.customModel.provider + ' / ' + value.customModel.model
      : t('followSession'))
  const parts = [
    apiMode ? t('engineApi') : t('engineModel'),
    langName(value.primaryLanguage),
    pick,
    apiMode ? null : value.reasoningEffort,
  ]
  return react.createElement('span', { 'data-dsh-translator-summary': '' }, parts.filter(Boolean).join(' · '))
}

/** The current Host snapshot of the entry behind `props.form` (a `ConfigForm`). */
function snapshotOf(props) {
  const form = props.form
  if (!form || typeof form.getSnapshot !== 'function') return null
  return form.getSnapshot()
}

/** The bundle's configuration form. */
function SettingsForm(props) {
  const t = translate(props)
  const form = props.form
  // `plugins.bundle.config` is not a configuration page itself: it passes no
  // snapshot, so this half subscribes to the shared entry form and re-renders
  // on every revision the Host publishes.
  const [state, setState] = react.useState(() => snapshotOf(props))
  react.useEffect(() => {
    if (!form || typeof form.subscribe !== 'function') return
    return form.subscribe(() => setState(form.getSnapshot()))
  }, [form])
  const committed = state && state.status === 'ready' ? state.value : undefined
  // Seed the draft on the first render that has a committed section (and again
  // through the effect when the section arrives later), so the form never
  // flashes an empty pass.
  const [draft, setDraft] = react.useState(() => (committed ? cloneConfig(committed) : null))
  const [models, setModels] = react.useState([])
  const [defaultModel, setDefaultModel] = react.useState(null)
  const [status, setStatus] = react.useState('')
  const [saving, setSaving] = react.useState(false)

  react.useEffect(() => {
    if (draft === null && committed) setDraft(cloneConfig(committed))
  }, [committed, draft])
  react.useEffect(() => {
    callApi('list-models').then((value) => { if (Array.isArray(value)) setModels(value) }).catch(() => {})
    callApi('default-model').then((value) => { if (value && typeof value === 'object') setDefaultModel(value) }).catch(() => {})
  }, [])

  if (state === null || state.status !== 'ready' || !committed || draft === null) return null
  const disabled = state.writable === false
  const value = committed
  const base = state.base && typeof state.base === 'object' ? state.base : FALLBACK_BASE
  const isOverridden = (path) => !sameValue(atPath(draft, path), layerValue(base, path))
  // The model is two leaves shown as one control: the badge and reset follow
  // the pair, while the write still addresses each volatile leaf.
  const modelOverridden = () => !sameValue(
    [atPath(draft, MODEL_PROVIDER), atPath(draft, MODEL_NAME)],
    [layerValue(base, MODEL_PROVIDER), layerValue(base, MODEL_NAME)],
  )
  const resetModel = () => {
    setPath(MODEL_PROVIDER, layerValue(base, MODEL_PROVIDER))
    setPath(MODEL_NAME, layerValue(base, MODEL_NAME))
  }
  const setPath = (path, v) => setDraft((prev) => {
    if (!prev) return prev
    const next = cloneConfig(prev)
    let node = next
    for (const key of path.slice(0, -1)) {
      if (node[key] === null || typeof node[key] !== 'object') node[key] = {}
      node = node[key]
    }
    node[path[path.length - 1]] = v
    return next
  })
  const dirty = CONFIG_PATHS.some(path => !sameAtPath(draft, value, path))

  function resetPath(path) {
    setPath(path, layerValue(base, path))
  }

  function save() {
    const ops = settingsOps(draft, value, base, state.user)
    if (ops.length === 0) return
    setSaving(true); setStatus('')
    form.mutate(ops, state.revision).then((accepted) => {
      setSaving(false)
      setStatus(accepted === false ? t('saveFailed') : t('saved'))
      setTimeout(() => setStatus(''), 1500)
    }).catch((err) => {
      setSaving(false)
      setStatus((err && err.message) || t('saveFailed'))
      setTimeout(() => setStatus(''), 1500)
    })
  }

  function discard() {
    setStatus('')
    setDraft(cloneConfig(value))
  }

  function fieldHead(labelText, over, onReset) {
    return react.createElement('div', { 'data-dsh-translator-field-head': '' },
      react.createElement('span', { 'data-dsh-translator-field-label': '' }, labelText),
      over ? react.createElement('span', { 'data-dsh-translator-field-badges': '' },
        react.createElement('span', { 'data-dsh-translator-badge': '' }, t('overridden')),
        react.createElement('button', { 'data-dsh-translator-reset': '', type: 'button', disabled, onClick: onReset }, t('resetDefault')),
      ) : null,
    )
  }

  const langCodes = Object.keys(LANG_NAMES).filter(c => c !== 'en')
  const custom = draft.customModel || {}
  const customKey = (custom.provider && custom.model) ? (custom.provider + '/' + custom.model) : ''
  const modelKey = customKey || (defaultModel ? (defaultModel.provider + '/' + defaultModel.model) : '')
  const field = (labelText, path, control, over, onReset) => react.createElement('div', { 'data-dsh-translator-field': '' },
    fieldHead(labelText, over === undefined ? isOverridden(path) : over, onReset || (() => resetPath(path))),
    control,
  )
  const numberInput = (path, extra) => react.createElement('input', {
    type: 'number', value: atPath(draft, path), disabled, ...extra,
    onChange: (e) => setPath(path, Number(e.target.value)),
  })
  const row = (key, ...children) => react.createElement('div', { key, 'data-dsh-translator-settings-row': '' }, ...children)

  // The engine selects which half of the schema is live. `api` reads none of
  // the model controls, so they are not rendered at all rather than disabled:
  // a temperature box that changes nothing would be a lie about what the
  // plugin does with it.
  //
  // The Host resolves this section from its OWN schema, so a field it does not
  // report is a field it does not have — the bundle on disk was updated but the
  // instance was not restarted. Rendering the control anyway would offer a
  // choice whose write the Host refuses, and would show a blank select in the
  // meantime. Fall back to the shape such a Host does understand (the model
  // engine) and say why, instead of guessing at a default it cannot store.
  const engineSupported = atPath(value, ['engine']) !== undefined
  const apiMode = engineSupported && draft.engine !== 'model'
  const languageField = field(t('primaryLanguage'), ['primaryLanguage'],
    react.createElement(ConfigSelect, { value: draft.primaryLanguage, disabled, onChange: (v) => setPath(['primaryLanguage'], v), options: langCodes.map(c => ({ value: c, label: langName(c) })) }))

  const engineBody = apiMode
    ? [
      react.createElement('div', { key: 'api-hint', 'data-dsh-translator-field-hint': '' }, t('apiHint')),
      languageField,
      field(t('apiProvider'), ['apiProvider'],
        react.createElement(ConfigSelect, {
          value: draft.apiProvider,
          disabled,
          onChange: (v) => setPath(['apiProvider'], v),
          options: API_PROVIDER_IDS.map(id => ({ value: id, label: providerName(t, id) })),
        })),
      row('api-row',
        field(t('timeout'), ['timeoutMs'], numberInput(['timeoutMs'], { min: 1000 }))),
    ]
    : [
      languageField,
      field(t('model'), MODEL_PROVIDER,
        react.createElement(ConfigSelect, {
          value: modelKey,
          disabled,
          onChange: (v) => {
            const i = v.indexOf('/')
            if (i > 0) { setPath(MODEL_PROVIDER, v.slice(0, i)); setPath(MODEL_NAME, v.slice(i + 1)) }
          },
          options: models.map(m => ({ value: m.provider + '/' + m.model, label: m.label })),
          placeholder: modelKey || t('followSession'),
        }), modelOverridden(), resetModel),
      react.createElement('div', { key: 'model-hint', 'data-dsh-translator-field-hint': '' }, t('modelHint')),
      row('model-row',
        field(t('reasoningLevel'), ['reasoningEffort'],
          react.createElement(ConfigSelect, { value: draft.reasoningEffort, disabled, onChange: (v) => setPath(['reasoningEffort'], v), options: [{ value: 'off', label: 'off' }, { value: 'low', label: 'low' }, { value: 'high', label: 'high' }, { value: 'max', label: 'max' }] })),
        field(t('maxTokens'), ['maxTokens'], numberInput(['maxTokens'], { min: 1 }))),
      row('advanced-row',
        field(t('timeout'), ['timeoutMs'], numberInput(['timeoutMs'], { min: 1000 })),
        field(t('temperature'), ['temperature'], numberInput(['temperature'], { step: 0.1, min: 0, max: 2 }))),
    ]

  // The engine select exists only when the Host has the field to store it in;
  // otherwise the reader gets a one-line explanation instead of two selects
  // that render blank and could never be saved.
  const engineField = engineSupported
    ? field(t('engine'), ['engine'],
      react.createElement(ConfigSelect, {
        value: draft.engine,
        disabled,
        onChange: (v) => setPath(['engine'], v),
        options: [
          { value: 'api', label: t('engineApi') || 'Free API' },
          { value: 'model', label: t('engineModel') || 'Model' },
        ],
      }))
    : react.createElement('div', { key: 'host-stale-hint', 'data-dsh-translator-field-hint': '' }, t('hostStale'))

  return react.createElement('div', { 'data-dsh-translator-settings': '' },
    engineField,
    ...engineBody,
    react.createElement('div', { 'data-dsh-translator-settings-footer': '' },
      // The actions lead, in DOM order as well as on screen, so the tab order
      // follows the eye: discard, save, then the status the save reports.
      react.createElement('button', { 'data-dsh-translator-settings-discard': '', type: 'button', disabled: !dirty || saving, onClick: discard }, t('discard')),
      react.createElement('button', { 'data-dsh-translator-settings-save': '', type: 'button', disabled: !dirty || saving, onClick: save }, saving ? t('saving') : t('save')),
      status
        ? react.createElement('span', { 'data-dsh-translator-settings-status': '' }, status)
        : (disabled ? react.createElement('span', { 'data-dsh-translator-settings-status': '' }, t('readOnly')) : null),
    ),
  )
}

/** The `plugins.bundle.config` occupant: the page asks for a one-liner or the form. */
function TranslatorSettings(props) {
  if (props.view === 'summary') return react.createElement(SettingsSummary, props)
  return react.createElement(SettingsForm, props)
}

const inject = ['slots', 'locale', 'configForms']

function apply(ctx) {
  const styleEl = document.createElement('style')
  styleEl.textContent = TRANSLATOR_CSS
  document.head.appendChild(styleEl)
  ctx.effect(() => () => { styleEl.remove() }, 'dsh-translator: styles')

  const slots = ctx.slots
  if (slots === undefined) return
  ctx.effect(() => ctx.locale.register('dsh-translator', I18N), 'dsh-translator: dictionaries')
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'dsh-translator-overlay', locale: 'dsh-translator' },
    TranslatorRoot,
  ))
  // The bundle's own configuration, rendered on this bundle's page in the
  // Plugins list: one click from the list, no intermediate row page. The entry
  // form comes from the shared settings transport; the registration appears
  // only while the Host actually serves our namespace.
  const form = ctx.configForms.get(SETTINGS_NS)
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => slots.inject(
    'plugins.bundle.config',
    () => slots.register(
      { name: 'plugins.bundle.config', key: PACKAGE_NAME, locale: 'dsh-translator' },
      (props) => react.createElement(TranslatorSettings, { ...props, form }),
    ),
  )), 'dsh-translator: bundle settings page')
}
