// dsh-translator — Client half (packaged bundle core)
//
// This file is the body of the client bundle factory. scripts/build.js wraps
// it into the dsh client-modules bundle format:
//
//   window.__ModuleLoader__.load({ id: "<package-name>", factory: (require) => { ... this body ... } })
//
// The client runtime mounts the exports (apply + inject) as a browser plugin
// on the client root context, where 'slots' is a provided service.
// The Host half is reached over HTTP:
//
//   POST /translator/api/translate        { text, seq }
//   POST /translator/api/translate-cancel { seq }
//
// Adaptations from the dynamic-plugin client (src/client.js):
//   - CSS is injected through a <style> element (cleaned up with the fiber)
//     instead of the dynamic `styles.insert` builtin.
//   - host.call() is replaced by fetch() to the Host HTTP API.
// Everything else (selection guard, positioning, races, cancellation) is
// identical.

let react = require('react')

const TRANSLATOR_CSS = `
[data-dsh-translator-root] {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
}
[data-dsh-translator-btn] {
  position: absolute;
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
  line-height: 30px;
  text-align: center;
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
    const message = parsed && parsed.error
      ? (parsed.error.message || parsed.error.code)
      : 'HTTP ' + response.status
    throw new Error(message)
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
let stateRef = { card: null }
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

function XIcon() {
  return react.createElement('svg', { viewBox: '0 0 24 24', width: 13, height: 13, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    react.createElement('path', { d: 'M18 6 6 18' }),
    react.createElement('path', { d: 'm6 6 12 12' }),
  )
}

function TranslatorRoot() {
  const [btn, setBtn] = react.useState(null)
  const [card, setCard] = react.useState(null)
  stateRef.card = card

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

  react.useEffect(() => {
    function refreshButton() {
      if (btnSuppressed) return
      const info = currentSelection()
      if (!info) {
        setBtn(null)
        return
      }
      const rect = info.rect
      const left = clamp(rect.right - 8 - 32, 4, window.innerWidth - 36)
      let top = rect.top - 32 - 6
      if (top < 4) top = rect.bottom + 6
      setBtn({ left, top, text: info.text, rect })
    }

    function onMouseUp(e) {
      if (suppressNextUp) { suppressNextUp = false; return }
      if (dragging) return
      if (isInsideRoot(e.target)) return
      btnSuppressed = false
      const info = currentSelection()
      if (!info) {
        cancelLoadingCard(stateRef.card)
        setBtn(null)
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
        selHideTimer = setTimeout(() => { setBtn(null) }, 200)
        return
      }
      if (selHideTimer) { clearTimeout(selHideTimer); selHideTimer = null }
      const range = sel.getRangeAt(0)
      if (isInsideRoot(range.startContainer) || isInsideRoot(range.endContainer)) {
        setBtn(null)
        return
      }
      // Do NOT show the button here: selectionchange fires continuously while
      // the user is still dragging a selection. Only mouseup shows the button.
    }

    function onMouseDown(e) {
      // Starting a new interaction/selection hides any lingering button.
      if (!isInsideRoot(e.target)) setBtn(null)
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
      if (!info) { setBtn(null); return }
      const r = info.rect
      if (r.bottom < -20 || r.top > window.innerHeight + 20 || r.right < -20 || r.left > window.innerWidth + 20) {
        setBtn(null)
        return
      }
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

  function translate(text) {
    const id = ++requestSeq
    setCard(prev => prev ? { ...prev, status: 'loading', error: null, reqId: id } : prev)
    callApi('translate', { text, seq: id }).then((value) => {
      if (unmounted || id !== requestSeq) return
      const v = value && typeof value === 'object' ? value : {}
      if (typeof v.text === 'string') {
        setCard(prev => prev ? { ...prev, status: 'done', result: { target: v.target, text: v.text, engine: v.engine, truncated: v.truncated === true } } : prev)
      } else {
        setCard(prev => prev ? { ...prev, status: 'error', error: '翻译失败' } : prev)
      }
    }).catch((err) => {
      if (unmounted || id !== requestSeq) return
      setCard(prev => prev ? { ...prev, status: 'error', error: (err && err.message) || '翻译请求失败' } : prev)
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
      title: '划词翻译',
      onMouseDown: (e) => e.preventDefault(),
      onClick: openPopup,
    }, '译'))
  }
  if (card) {
    const bodyChildren = []
    if (card.status === 'loading') {
      bodyChildren.push(react.createElement('div', { key: 'loading' }, '翻译中…'))
    } else if (card.status === 'error') {
      bodyChildren.push(react.createElement('div', { key: 'err', 'data-dsh-translator-error': '' }, card.error))
    } else if (card.result) {
      bodyChildren.push(react.createElement('div', { key: 'ok' }, card.result.text))
    }
    const footChildren = []
    if (card.result && card.result.engine === 'model') {
      footChildren.push(react.createElement('span', { key: 'dir' }, card.result.target === 'zh-CN' ? '→ 中文' : '→ English'))
    }
    if (card.result && card.result.truncated) {
      footChildren.push(react.createElement('span', { key: 'trunc' }, '（译文可能被截断）'))
    }
    if (card.status === 'error') {
      footChildren.push(react.createElement('button', { key: 'retry', 'data-dsh-translator-act': '', onClick: () => translate(card.text) }, '重试'))
    }
    footChildren.push(react.createElement('div', { key: 'actions', 'data-dsh-translator-actions': '' },
      react.createElement('button', { 'data-dsh-translator-pin': card.pinned ? 'on' : 'off', title: card.pinned ? '取消固定' : '固定', onClick: () => setCard(prev => prev ? { ...prev, pinned: !prev.pinned } : prev) }, react.createElement(PinIcon, { filled: card.pinned === true })),
      react.createElement('button', { 'data-dsh-translator-close': '', title: '关闭', onClick: () => { btnSuppressed = false; cancelLoadingCard(stateRef.card); setCard(null); refreshButton() } }, react.createElement(XIcon)),
    ))
    children.push(react.createElement('div', {
      key: 'card',
      'data-dsh-translator-card': '',
      'data-dsh-translator-pinned': card.pinned ? '' : undefined,
      style: { left: card.left + 'px', top: card.top + 'px', width: card.width + 'px' },
    },
      react.createElement('div', { 'data-dsh-translator-source': '', onMouseDown: beginDrag }, card.text),
      react.createElement('div', { 'data-dsh-translator-body': '' }, ...bodyChildren),
      react.createElement('div', { 'data-dsh-translator-foot': '' }, ...footChildren),
    ))
  }
  return react.createElement('div', { 'data-dsh-translator-root': '' }, ...children)
}

const inject = ['slots']

function apply(ctx) {
  const styleEl = document.createElement('style')
  styleEl.textContent = TRANSLATOR_CSS
  document.head.appendChild(styleEl)
  ctx.effect(() => () => { styleEl.remove() }, 'dsh-translator: styles')

  const slots = ctx.get('slots')
  if (slots === undefined) return
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'dsh-translator-overlay' },
    () => react.createElement(TranslatorRoot),
  ))
}
