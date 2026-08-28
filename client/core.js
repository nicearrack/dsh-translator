// dsh-translator — Client half (packaged bundle core)
//
// This file is the body of the client bundle factory. scripts/build.js wraps
// it into the dsh client-modules bundle format:
//
//   window.__ModuleLoader__.load({ id: "<package-name>", factory: (require) => { ... this body ... } })
//
// The client runtime mounts the exports (apply + inject) as a browser plugin
// on the client root context. 'slots' hosts the UI seats; 'settingsScope'
// carries the official settings-namespace transport for the config card
// (the snapshot lives in the value/base/user layers; writes ride the
// settings transport with a revision fence — no custom config HTTP API).
//
// The Host half is reached over HTTP only for the business API:
//
//   POST /translator/api/translate        { text, seq }
//   POST /translator/api/translate-cancel { seq }
//   POST /translator/api/list-models      { }
//   POST /translator/api/default-model    { }
//
// UI strings come from the official dictionary registry (ctx.locale.register
// 'dsh-translator' below) — both slot registrations declare `locale:` so the
// `t` seat is used when the runtime delivers it, with a service-backed
// fallback for runtimes that forward no props to list-slot occupants.
//
// CSS is injected through a <style> element whose removal is registered with
// the plugin fiber; selection guard, positioning, races, and cancellation
// follow the same logic as the Host-side translation flow.

let react = require('react')

const I18N = {
  zh: {
    tooltip: '划词翻译', translating: '翻译中…', truncated: '（译文可能被截断）',
    retry: '重试', pin: '固定', unpin: '取消固定', close: '关闭',
    copied: '已复制', copiedSource: '已复制原文',
    cardTitle: '划词翻译', cardDesc: '选中文字即译，用你配置的模型翻译',
    primaryLanguage: '主语言', model: '模型',
    reasoningLevel: '推理等级',
    timeout: '超时（毫秒）', maxTokens: '最大输出 token', temperature: '温度',
    save: '保存', saving: '保存中…', discard: '放弃修改', saved: '已保存', saveFailed: '保存失败', overridden: '已覆盖', resetDefault: '恢复默认',
    errorEmpty: '没有可翻译的文本',
    errorNoProvider: '未配置可用模型（无 LLM provider）',
    errorNoModel: 'provider 没有可用模型',
    errorTranslatedEmpty: '模型未返回译文',
    errorTimeout: '翻译超时',
    errorModelFailed: '模型调用失败',
    errorFailed: '翻译失败',
    errorRequestFailed: '翻译请求失败',
  },
  en: {
    tooltip: 'Word-selection translation', translating: 'Translating…', truncated: '(may be truncated)',
    retry: 'Retry', pin: 'Pin', unpin: 'Unpin', close: 'Close',
    copied: 'Copied', copiedSource: 'Copied source',
    cardTitle: 'Word-selection translation', cardDesc: 'Translate selected text with your configured model',
    primaryLanguage: 'Primary language', model: 'Model',
    reasoningLevel: 'Reasoning effort',
    timeout: 'Timeout (ms)', maxTokens: 'Max tokens', temperature: 'Temperature',
    save: 'Save', saving: 'Saving…', discard: 'Discard changes', saved: 'Saved', saveFailed: 'Save failed', overridden: 'Overridden', resetDefault: 'Reset to default',
    errorEmpty: 'Nothing to translate',
    errorNoProvider: 'No configured model (no LLM provider)',
    errorNoModel: 'Provider has no available model',
    errorTranslatedEmpty: 'The model returned no translation',
    errorTimeout: 'Translation timed out',
    errorModelFailed: 'Model call failed',
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
  'model-error': 'errorModelFailed',
}
// Language OPTIONS keep their self-described names (endonyms), never
// translated with the UI locale — same convention as the DSH locale picker.
const LANG_NAMES = {
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
  'ru-RU': 'Русский',
  en: 'English',
}
function formatTokens(n) {
  const scaled = (v) => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1000) return String(n)
  if (n < 1000000) return scaled(n / 1000) + 'K'
  return scaled(n / 1000000) + 'M'
}
// Language OPTIONS keep their self-described names (endonyms) — module-level,
// never locale-dependent. UI strings otherwise come from the official locale
// seat `t` (registered below and injected by the slot framework).
function langName(code) {
  return LANG_NAMES[code] || code
}

// UI strings come from the official dictionary registry (ctx.locale), with
// the slot-framework `t` seat preferred when the runtime delivers it — this
// overlay's locale option is declared, but this harness version forwards no
// props to list-slot occupants, so a service-backed fallback supplies `t`.
const LocaleCtx = react.createContext({ t: I18N.zh })
function useI18n() {
  return react.useContext(LocaleCtx)
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
[data-dsh-translator-foot] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 10px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  font-size: 12px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-translator-meta] {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
  white-space: normal;
  overflow-wrap: anywhere;
}
[data-dsh-translator-act] {
  margin: 0;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  pointer-events: auto;
}
[data-dsh-translator-act]:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
[data-dsh-translator-close] {
  margin-left: auto;
}
[data-dsh-translator-error] {
  color: var(--dsw-alias-state-error-primary);
}
[data-dsh-translator-settings] {
  display: flex;
  flex-direction: column;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.4;
}
[data-dsh-translator-field] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
[data-dsh-translator-settings] > [data-dsh-translator-field] + [data-dsh-translator-field] {
  border-top: 1px solid var(--dsw-alias-border-l2);
}
[data-dsh-translator-field-row] {
  display: flex;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
[data-dsh-translator-field-row] [data-dsh-translator-field] {
  flex: 1;
  min-width: 0;
  padding: 0;
}
[data-dsh-translator-field-head] {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
[data-dsh-translator-field-label] {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
[data-dsh-translator-field-badges] {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
[data-dsh-translator-badge] {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-translator-reset] {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
[data-dsh-translator-reset]:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}
[data-dsh-translator-select] {
  position: relative;
  display: block;
}
[data-dsh-translator-select-trigger] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 34px;
  padding: 0 12px;
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
[data-dsh-translator-select-trigger]:hover {
  border-color: var(--dsw-alias-label-dimmed);
}
[data-dsh-translator-select-trigger]:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
[data-dsh-translator-select-label] {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-dsh-translator-select-arrow] {
  flex: none;
  display: inline-flex;
  color: var(--dsw-alias-label-tertiary);
}
[data-dsh-translator-select-menu] {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 100;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--dsw-alias-border-inverted);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-shadow-lv3);
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
[data-dsh-translator-settings-title] {
  font-weight: 600;
  font-size: 13px;
}
[data-dsh-translator-settings-row] {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
[data-dsh-translator-settings-save] {
  padding: 4px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
[data-dsh-translator-settings-save]:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
[data-dsh-translator-settings-status] {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
[data-dsh-translator-plugin-card] {
  list-style: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color 160ms ease, background 160ms ease;
}
[data-dsh-translator-plugin-card]:hover {
  border-color: var(--dsw-alias-label-dimmed);
}
[data-dsh-translator-plugin-card][data-open="1"] {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
[data-dsh-translator-card-header] {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 16px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 15px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  border-radius: 12px;
}
[data-dsh-translator-card-header]:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
[data-dsh-translator-card-headtext] {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
[data-dsh-translator-card-name] {
  font-weight: 600;
  font-size: 15px;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}
[data-dsh-translator-card-desc] {
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 1.5;
}
[data-dsh-translator-card-chevron] {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 160ms ease;
}
[data-dsh-translator-card-chevron="open"] {
  transform: rotate(180deg);
}
[data-dsh-translator-card-body] {
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin: 0 16px;
  padding-bottom: 10px;
}
[data-dsh-translator-card-footer] {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 4px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
[data-dsh-translator-card-discard] {
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
[data-dsh-translator-card-discard]:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
[data-dsh-translator-card-discard]:disabled {
  opacity: 0.4;
  cursor: default;
}
[data-dsh-translator-card-save] {
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
[data-dsh-translator-card-save]:hover:not(:disabled) {
  opacity: 0.92;
}
[data-dsh-translator-card-save]:disabled {
  opacity: 0.4;
  cursor: default;
}
[data-dsh-translator-card-discard]:focus-visible,
[data-dsh-translator-card-save]:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  [data-dsh-translator-btn] {
    transition: none;
  }
}
`

async function callApi(method, payload) {
  const response = await fetch('/translator/api/' + method, {
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

function TranslatorRoot(props) {
  const seat = react.useContext ? useI18n() : null
  const t = (props && props.t) || seat.t
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
    const t = setTimeout(() => setCopied(null), 1200)
    return () => clearTimeout(t)
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
    function onMouseUp(e) {
      if (suppressNextUp) { suppressNextUp = false; return }
      if (dragging) return
      if (isInsideRoot(e.target)) return
      btnSuppressed = false
      const info = currentSelection()
      if (!info) {
        cancelLoadingCard(stateRef.card)
        setBtn(null)
        stateRef.btnText = null
        if (!stateRef.card || !stateRef.card.pinned) setCard(null)
        return
      }
      cancelLoadingCard(stateRef.card)
      if (!stateRef.card || !stateRef.card.pinned) setCard(null)
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
      // Never reveal a button for an in-progress selection (before mouseup):
      // only reposition one that was already shown (stateRef.btnText match).
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
    const text = key ? t[key] : undefined
    if (text) return text
    return fallbackMessage || t.errorFailed
  }

  function translate(text) {
    const id = ++requestSeq
    setCard(prev => prev ? { ...prev, status: 'loading', error: null, reqId: id } : prev)
    callApi('translate', { text, seq: id }).then((value) => {
      if (unmounted || id !== requestSeq) return
      const v = value && typeof value === 'object' ? value : {}
      if (typeof v.text === 'string') {
        setCard(prev => prev ? { ...prev, status: 'done', result: { target: v.target, text: v.text, engine: v.engine, truncated: v.truncated === true, model: v.model, reasoningEffort: v.reasoningEffort, tokens: v.tokens } } : prev)
      } else {
        setCard(prev => prev ? { ...prev, status: 'error', error: errorText() } : prev)
      }
    }).catch((err) => {
      if (unmounted || id !== requestSeq) return
      setCard(prev => prev ? { ...prev, status: 'error', error: errorText(err && err.code, (err && err.message) || t.errorRequestFailed) } : prev)
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
    translate(btn.text)
  }

  const children = []
  if (btn) {
    children.push(react.createElement('button', {
      key: 'btn',
      'data-dsh-translator-btn': '',
      style: { left: btn.left + 'px', top: btn.top + 'px' },
      title: t.tooltip,
      onMouseDown: (e) => e.preventDefault(),
      onClick: openPopup,
    }, react.createElement(TranslateIcon)))
  }
  if (card) {
    const bodyChildren = []
    if (card.status === 'loading') {
      bodyChildren.push(react.createElement('div', { key: 'loading' }, t.translating))
    } else if (card.status === 'error') {
      bodyChildren.push(react.createElement('div', { key: 'err', 'data-dsh-translator-error': '' }, card.error))
    } else if (card.result) {
      bodyChildren.push(react.createElement('div', { key: 'ok' }, card.result.text))
    }
    const footChildren = []
    if (card.result && card.result.engine === 'model') {
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
      footChildren.push(react.createElement('span', { key: 'trunc' }, t.truncated))
    }
    if (card.status === 'error') {
      footChildren.push(react.createElement('button', { key: 'retry', 'data-dsh-translator-act': '', onClick: () => translate(card.text) }, t.retry))
    }
    footChildren.push(react.createElement('div', { key: 'actions', 'data-dsh-translator-actions': '' },
      react.createElement('button', { 'data-dsh-translator-pin': card.pinned ? 'on' : 'off', title: card.pinned ? t.unpin : t.pin, onClick: () => setCard(prev => prev ? { ...prev, pinned: !prev.pinned } : prev) }, react.createElement(PinIcon, { filled: card.pinned === true })),
      react.createElement('button', { 'data-dsh-translator-close': '', title: t.close, onClick: () => { btnSuppressed = false; cancelLoadingCard(stateRef.card); setCard(null); refreshButton() } }, react.createElement(XIcon)),
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
      copied ? react.createElement('div', { key: 'copied', 'data-dsh-translator-copied': '' }, copied === 'source' ? t.copiedSource : t.copied) : null,
    ))
  }
  return react.createElement('div', { 'data-dsh-translator-root': '' }, ...children)
}

// Last-resort defaults. The official settings scope snapshot carries the
// composition layer as `base` and the raw user section as `user` (field
// PRESENCE there = user-overridden), so the card never needs its own copy of
// the schema defaults except as this fallback while `base` is absent.
const FALLBACK_DEFAULTS = { primaryLanguage: 'zh-Hans', customModel: { provider: '', model: '' }, reasoningEffort: 'low', timeoutMs: 30000, maxTokens: 1024, temperature: 0.3 }
const CONFIG_FIELDS = ['primaryLanguage', 'customModel', 'reasoningEffort', 'timeoutMs', 'maxTokens', 'temperature']
function userHas(field, user) {
  return !!user && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, field)
}
function sameConfig(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return a.primaryLanguage === b.primaryLanguage
    && a.timeoutMs === b.timeoutMs
    && a.maxTokens === b.maxTokens && a.temperature === b.temperature
    && a.reasoningEffort === b.reasoningEffort
    && (a.customModel && a.customModel.provider) === (b.customModel && b.customModel.provider)
    && (a.customModel && a.customModel.model) === (b.customModel && b.customModel.model)
}
function ConfigSelect(props) {
  const { value, onChange, options, placeholder } = props
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
    react.createElement('button', { 'data-dsh-translator-select-trigger': '', type: 'button', onClick: () => setOpen(!open), 'aria-haspopup': 'listbox', 'aria-expanded': open ? 'true' : 'false' },
      react.createElement('span', { 'data-dsh-translator-select-label': '' }, sel ? sel.label : (placeholder || '')),
      react.createElement('span', { 'data-dsh-translator-select-arrow': '', 'aria-hidden': 'true' }, react.createElement(ChevronDownIcon)),
    ),
    open ? react.createElement('div', { 'data-dsh-translator-select-menu': '', role: 'listbox' },
      options.map(o => react.createElement('button', { key: o.value, 'data-dsh-translator-select-option': '', type: 'button', role: 'option', 'aria-selected': o.value === value ? 'true' : undefined, onMouseDown: (e) => e.preventDefault(), onClick: () => { onChange(o.value); setOpen(false) } }, o.label)),
    ) : null,
  )
}
function ConfigCard(props) {
  const scope = props.scope
  const seat = useI18n()
  const t = (props && props.t) || seat.t
  // Official settings transport (docs/reference/cookbook/adding-a-settings-card):
  // snapshot = { status, value, base, user, revision, writable, mode }.
  const [snap, setSnap] = react.useState(() => scope.getSnapshot())
  const [cfg, setCfg] = react.useState(null)
  const [models, setModels] = react.useState([])
  const [defaultModel, setDefaultModel] = react.useState(null)
  const [open, setOpen] = react.useState(false)
  const [status, setStatus] = react.useState('')
  const [saving, setSaving] = react.useState(false)
  const cardRef = react.useRef(null)
  react.useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [])
  react.useEffect(() => {
    if (cfg === null && snap.status === 'ready' && snap.value) setCfg(snap.value)
  }, [snap, cfg])
  react.useEffect(() => {
    if (!open || !cardRef.current) return
    const t = setTimeout(() => {
      if (cardRef.current) cardRef.current.scrollIntoView({ block: 'end', inline: 'nearest' })
    }, 40)
    return () => clearTimeout(t)
  }, [open])
  react.useEffect(() => {
    callApi('list-models').then((value) => { if (Array.isArray(value)) setModels(value) }).catch(() => {})
    callApi('default-model').then((value) => { if (value && typeof value === 'object') setDefaultModel(value) }).catch(() => {})
  }, [])
  if (snap.status !== 'ready' || !snap.value || cfg === null) return null
  const value = snap.value
  const base = snap.base || FALLBACK_DEFAULTS
  const layerField = (field) => {
    const b = base && typeof base === 'object' ? base[field] : undefined
    return (b !== undefined && b !== null) ? b : FALLBACK_DEFAULTS[field]
  }
  const set = (k, v) => setCfg(prev => prev ? { ...prev, [k]: v } : prev)
  // Dirty = the draft differs from the committed snapshot, nothing else:
  // restoring a field to its layer value while the committed value equals
  // that layer means there is nothing to persist, so 保存/放弃修改 stay
  // disabled. A user-layer entry that merely repeats the default (left over
  // from a full-section write) shows no badge either — the badge tracks the
  // effective difference, and stale entries are cleaned on the next real save.
  const dirty = !sameConfig(cfg, value)
  const customKey = (cfg.customModel && cfg.customModel.provider && cfg.customModel.model)
    ? (cfg.customModel.provider + '/' + cfg.customModel.model) : ''
  const modelKey = customKey || (defaultModel ? (defaultModel.provider + '/' + defaultModel.model) : '')
  // Live override state: a field is shown as 「已覆盖」 when its effective
  // value leaves the composition layer (row config). Draft-based, so the
  // badge vanishes the moment「恢复默认」restores the layer value and appears
  // the moment a typed value leaves it — before anything is saved. Presence
  // alone (a user-layer entry equal to the default) does not light the badge.
  function isOverridden(field) {
    return JSON.stringify(cfg[field]) !== JSON.stringify(layerField(field))
  }
  function resetField(field) {
    const v = layerField(field)
    if (field === 'customModel') set('customModel', { provider: (v && v.provider) || '', model: (v && v.model) || '' })
    else set(field, v)
  }
  function save() {
    const ops = []
    for (const field of CONFIG_FIELDS) {
      const changed = JSON.stringify(cfg[field]) !== JSON.stringify(value[field])
      const atLayer = JSON.stringify(cfg[field]) === JSON.stringify(layerField(field))
      // A real change: set the user choice, or clear it when it now equals
      // the layer. A stale user-layer entry equal to the default is cleaned
      // together with a real save (its presence is invisible to the badge).
      if (changed) {
        ops.push(atLayer ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: cfg[field] })
      } else if (atLayer && userHas(field, snap.user)) {
        ops.push({ op: 'unset', path: [field] })
      }
    }
    if (ops.length === 0) return
    setSaving(true); setStatus('')
    scope.mutate(ops, snap.revision).then(() => {
      setSaving(false); setStatus(t.saved)
      setTimeout(() => setStatus(''), 1500)
    }).catch((err) => {
      setSaving(false)
      setStatus((err && err.message) || t.saveFailed)
      setTimeout(() => setStatus(''), 1500)
    })
  }
  function discard() {
    setStatus(''); setCfg(value)
  }
  function fieldHead(labelText, field) {
    const over = isOverridden(field)
    return react.createElement('div', { 'data-dsh-translator-field-head': '' },
      react.createElement('span', { 'data-dsh-translator-field-label': '' }, labelText),
      over ? react.createElement('span', { 'data-dsh-translator-field-badges': '' },
        react.createElement('span', { 'data-dsh-translator-badge': '' }, t.overridden),
        react.createElement('button', { 'data-dsh-translator-reset': '', type: 'button', onClick: () => resetField(field) }, t.resetDefault),
      ) : null,
    )
  }
  const langCodes = Object.keys(LANG_NAMES).filter(c => c !== 'en')
  return react.createElement('div', { 'data-dsh-translator-plugin-card': '', 'data-open': open ? '1' : undefined, ref: cardRef },
    react.createElement('button', { 'data-dsh-translator-card-header': '', 'aria-expanded': open ? 'true' : 'false', onClick: () => setOpen(!open) },
      react.createElement('span', { 'data-dsh-translator-card-headtext': '' },
        react.createElement('span', { 'data-dsh-translator-card-name': '' }, t.cardTitle),
        react.createElement('span', { 'data-dsh-translator-card-desc': '' }, t.cardDesc),
      ),
      react.createElement('span', { 'data-dsh-translator-card-chevron': open ? 'open' : '' }, react.createElement(ChevronDownIcon)),
    ),
    open ? react.createElement('div', { 'data-dsh-translator-card-body': '', 'data-dsh-translator-settings': '' },
      react.createElement('div', { 'data-dsh-translator-field': '' },
        fieldHead(t.primaryLanguage, 'primaryLanguage'),
        react.createElement(ConfigSelect, { value: cfg.primaryLanguage, onChange: (v) => set('primaryLanguage', v), options: langCodes.map(c => ({ value: c, label: langName(c) })) }),
      ),
      react.createElement('div', { 'data-dsh-translator-field': '' },
        fieldHead(t.model, 'customModel'),
        react.createElement(ConfigSelect, { value: modelKey, onChange: (v) => { const i = v.indexOf('/'); if (i > 0) set('customModel', { provider: v.slice(0, i), model: v.slice(i + 1) }) }, options: models.map(m => ({ value: m.provider + '/' + m.model, label: m.label })) }),
      ),
      react.createElement('div', { 'data-dsh-translator-field-row': '' },
        react.createElement('div', { 'data-dsh-translator-field': '' },
          fieldHead(t.reasoningLevel, 'reasoningEffort'),
          react.createElement(ConfigSelect, { value: cfg.reasoningEffort, onChange: (v) => set('reasoningEffort', v), options: [{ value: 'off', label: 'off' }, { value: 'low', label: 'low' }, { value: 'high', label: 'high' }, { value: 'max', label: 'max' }] }),
        ),
        react.createElement('div', { 'data-dsh-translator-field': '' },
          fieldHead(t.maxTokens, 'maxTokens'),
          react.createElement('input', { type: 'number', value: cfg.maxTokens, min: 1, onChange: (e) => set('maxTokens', Number(e.target.value) || 1024) }),
        ),
      ),
      react.createElement('div', { 'data-dsh-translator-field-row': '' },
        react.createElement('div', { 'data-dsh-translator-field': '' },
          fieldHead(t.timeout, 'timeoutMs'),
          react.createElement('input', { type: 'number', value: cfg.timeoutMs, min: 1000, onChange: (e) => set('timeoutMs', Number(e.target.value) || 30000) }),
        ),
        react.createElement('div', { 'data-dsh-translator-field': '' },
          fieldHead(t.temperature, 'temperature'),
          react.createElement('input', { type: 'number', step: 0.1, min: 0, max: 2, value: cfg.temperature, onChange: (e) => set('temperature', Number(e.target.value) || 0.3) }),
        ),
      ),
      react.createElement('div', { 'data-dsh-translator-card-footer': '' },
        react.createElement('button', { 'data-dsh-translator-card-discard': '', onClick: discard, disabled: !dirty || saving }, t.discard),
        react.createElement('button', { 'data-dsh-translator-card-save': '', onClick: save, disabled: !dirty || saving }, saving ? t.saving : t.save),
        status ? react.createElement('span', { 'data-dsh-translator-settings-status': '' }, status) : null,
      ),
    ) : null,
  )
}

const inject = ['slots', 'settingsScope', 'locale']

function apply(ctx) {
  const styleEl = document.createElement('style')
  styleEl.textContent = TRANSLATOR_CSS
  document.head.appendChild(styleEl)
  ctx.effect(() => () => { styleEl.remove() }, 'dsh-translator: styles')

  const slots = ctx.slots
  if (slots === undefined) return
  // Official settings-namespace scope (docs/reference/cookbook/adding-a-settings-card):
  // snapshot and writes ride the settings transport; the business API stays HTTP.
  const scope = ctx.settingsScope.bind({ namespace: 'dsh-translator' })
  // Official locale wiring (the slots register options below declare the
  // namespace, which puts the typed `t` seat on the component props and
  // re-renders it on locale switches).
  ctx.locale.register('dsh-translator', I18N)
  const locale = ctx.locale
  function LocaleBound(props) {
    const [active, setActive] = react.useState(() => {
      try { return (locale && locale.getSnapshot && locale.getSnapshot().active) || 'zh' } catch (err) { return 'zh' }
    })
    react.useEffect(() => {
      if (!locale || !locale.subscribe) return
      const un = locale.subscribe(() => {
        try { setActive((locale.getSnapshot && locale.getSnapshot().active) || 'zh') } catch (err) { /* ignore */ }
      })
      return () => { if (un) un() }
    }, [])
    const t = I18N[active === 'en' ? 'en' : 'zh']
    return react.createElement(LocaleCtx.Provider, { value: { t } }, props.children)
  }
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'dsh-translator-overlay', locale: 'dsh-translator' },
    () => react.createElement(LocaleBound, null, react.createElement(TranslatorRoot)),
  ))
  slots.inject('settings.plugin.item', () => slots.register(
    { name: 'settings.plugin.item', key: 'dsh-translator', locale: 'dsh-translator' },
    () => react.createElement(LocaleBound, null, react.createElement(ConfigCard, { scope })),
  ))
}
