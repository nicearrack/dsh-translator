/**
 * dsh-translator — Client half (canonical source, dynamic-plugin form)
 *
 * This file is the exact `code.client` body of the running dynamic plugin
 * (trsl-1 / pkg-4): a function body that RETURNS the Cordis plugin object.
 * It runs in the browser page through the DSH dynamic-Cordis mechanism.
 *
 * Responsibilities:
 *   - Register a frame-wide overlay in the `shell.overlay` slot
 *     (id: 'dsh-translator-overlay', additive entry, replaceRisk: none).
 *   - Observe document selection (mouseup / selectionchange), show the
 *     floating 「译」 button at the selection's top-right corner, open a
 *     translation card on click, and call the Host half over
 *     host.call('translate' | 'translate-cancel').
 *   - All listeners and styles belong to the Plugin fiber: they are removed
 *     automatically when the plugin stops or updates.
 *
 * Styling follows docs/web-styling.md of the DSH repo: semantic
 * `--dsw-alias-*` tokens only, no color literals, no theme selectors, paired
 * font-size/line-height, :focus-visible, and prefers-reduced-motion guards.
 */
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const locale = ctx.get('locale')
    const LocaleCtx = React.createContext({ tr: I18N.zh, lang: (code) => (LANG_NAMES[code] || {}).zh || code })
    function LocaleBound(props) {
      const [loc, setLoc] = React.useState(() => {
        try { return (locale && locale.getSnapshot() && locale.getSnapshot().active) || 'zh' } catch (err) { return 'zh' }
      })
      React.useEffect(() => {
        if (!locale || !locale.subscribe) return
        const un = locale.subscribe(() => {
          try { setLoc((locale.getSnapshot() && locale.getSnapshot().active) || 'zh') } catch (err) { /* ignore */ }
        })
        return () => { if (un) un() }
      }, [])
      const key = loc === 'en' ? 'en' : 'zh'
      const tr = I18N[key]
      const lang = (code) => (LANG_NAMES[code] || {})[key] || code
      return React.createElement(LocaleCtx.Provider, { value: { tr, lang } }, props.children)
    }
    function useI18n() {
      return React.useContext(LocaleCtx)
    }

    styles.insert(`
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
        padding: 6px 10px 10px;
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
    `)

    let requestSeq = 0
    let selHideTimer = null
    let btnSuppressed = false
    let dragging = false
    let dragStartX = 0, dragStartY = 0, dragLeft = 0, dragTop = 0
    let suppressNextUp = false
    let unmounted = false
    let stateRef = { card: null, btnText: null }
    const CARD_W = 320
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
      },
    }
    const LANG_NAMES = {
      'zh-Hans': { zh: '简体中文', en: 'Simplified Chinese' },
      'zh-Hant': { zh: '繁體中文', en: 'Traditional Chinese' },
      'ja-JP': { zh: '日本語', en: 'Japanese' },
      'ko-KR': { zh: '한국어', en: 'Korean' },
      'ru-RU': { zh: 'Русский', en: 'Russian' },
      en: { zh: 'English', en: 'English' },
    }
    function formatTokens(n) {
      const scaled = (v) => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
      if (n < 1000) return String(n)
      if (n < 1000000) return scaled(n / 1000) + 'K'
      return scaled(n / 1000000) + 'M'
    }

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
        host.call('translate-cancel', { seq: card.reqId }).catch(() => {})
      }
    }

    function PinIcon(props) {
      return React.createElement('svg', { viewBox: '0 0 24 24', width: 13, height: 13, 'aria-hidden': true, fill: props.filled ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M12 17v5' }),
        React.createElement('path', { d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z' }),
      )
    }

    function XIcon() {
      return React.createElement('svg', { viewBox: '0 0 24 24', width: 13, height: 13, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M18 6 6 18' }),
        React.createElement('path', { d: 'm6 6 12 12' }),
      )
    }

    function ChevronDownIcon(props) {
      return React.createElement('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'm6 9 6 6 6-6' }),
      )
    }

    function TranslatorRoot() {
      const { tr, lang } = useI18n()
      const [btn, setBtn] = React.useState(null)
      const [card, setCard] = React.useState(null)
      const [copied, setCopied] = React.useState(null)
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

      React.useEffect(() => {
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

      React.useEffect(() => {
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

      function translate(text) {
        const id = ++requestSeq
        setCard(prev => prev ? { ...prev, status: 'loading', error: null, reqId: id } : prev)
        host.call('translate', { text, seq: id }).then((res) => {
          if (unmounted || id !== requestSeq) return
          const r = res && typeof res === 'object' ? res : {}
          if (r.ok && r.result && typeof r.result.text === 'string') {
            setCard(prev => prev ? { ...prev, status: 'done', result: { target: r.result.target, text: r.result.text, engine: r.result.engine, truncated: r.result.truncated === true, model: r.result.model, reasoningEffort: r.result.reasoningEffort, tokens: r.result.tokens } } : prev)
          } else {
            setCard(prev => prev ? { ...prev, status: 'error', error: r.error || '翻译失败' } : prev)
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

      // The initial placement uses an estimated height (280 px). Once the card
      // is rendered, measure it and snap the position to the real height —
      // otherwise an above-placed card leaves a gap between its bottom and the
      // selection when the real height is smaller than the estimate.
      React.useEffect(() => {
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

      const children = []
      if (btn) {
        children.push(React.createElement('button', {
          key: 'btn',
          'data-dsh-translator-btn': '',
          style: { left: btn.left + 'px', top: btn.top + 'px' },
          title: tr.tooltip,
          onMouseDown: (e) => e.preventDefault(),
          onClick: openPopup,
        }, '译'))
      }
      if (card) {
        const bodyChildren = []
        if (card.status === 'loading') {
          bodyChildren.push(React.createElement('div', { key: 'loading' }, tr.translating))
        } else if (card.status === 'error') {
          bodyChildren.push(React.createElement('div', { key: 'err', 'data-dsh-translator-error': '' }, card.error))
        } else if (card.result) {
          bodyChildren.push(React.createElement('div', { key: 'ok' }, card.result.text))
        }
        const footChildren = []
        if (card.result && card.result.engine === 'model') {
          const metaParts = []
          if (card.result.target) metaParts.push('→ ' + lang(card.result.target))
          if (card.result.model) metaParts.push(card.result.model)
          if (card.result.reasoningEffort) metaParts.push(card.result.reasoningEffort)
          if (card.result.tokens) {
            const total = (card.result.tokens.input || 0) + (card.result.tokens.output || 0)
            if (total > 0) metaParts.push(formatTokens(total) + ' tokens')
          }
          if (metaParts.length) footChildren.push(React.createElement('span', { key: 'dir', 'data-dsh-translator-meta': '' }, metaParts.join(' · ')))
        }
        if (card.result && card.result.truncated) {
          footChildren.push(React.createElement('span', { key: 'trunc' }, tr.truncated))
        }
        if (card.status === 'error') {
          footChildren.push(React.createElement('button', { key: 'retry', 'data-dsh-translator-act': '', onClick: () => translate(card.text) }, tr.retry))
        }
        footChildren.push(React.createElement('div', { key: 'actions', 'data-dsh-translator-actions': '' },
          React.createElement('button', { 'data-dsh-translator-pin': card.pinned ? 'on' : 'off', title: card.pinned ? tr.unpin : tr.pin, onClick: () => setCard(prev => prev ? { ...prev, pinned: !prev.pinned } : prev) }, React.createElement(PinIcon, { filled: card.pinned === true })),
          React.createElement('button', { 'data-dsh-translator-close': '', title: tr.close, onClick: () => { btnSuppressed = false; cancelLoadingCard(stateRef.card); setCard(null); refreshButton() } }, React.createElement(XIcon)),
        ))
        children.push(React.createElement('div', {
          key: 'card',
          'data-dsh-translator-card': '',
          'data-dsh-translator-pinned': card.pinned ? '' : undefined,
          style: { left: card.left + 'px', top: card.top + 'px', width: card.width + 'px' },
        },
          React.createElement('div', { 'data-dsh-translator-source': '', onMouseDown: beginDrag, onClick: () => copy('source') }, card.text),
          React.createElement('div', { 'data-dsh-translator-body': '', onClick: () => copy('result') }, ...bodyChildren),
          React.createElement('div', { 'data-dsh-translator-foot': '' }, ...footChildren),
          copied ? React.createElement('div', { key: 'copied', 'data-dsh-translator-copied': '' }, copied === 'source' ? tr.copiedSource : tr.copied) : null,
        ))
      }
      return React.createElement('div', { 'data-dsh-translator-root': '' }, ...children)
    }

    const DEFAULTS = { primaryLanguage: 'zh-Hans', customModel: { provider: '', model: '' }, reasoningEffort: 'low', timeoutMs: 30000, maxTokens: 1024, temperature: 0.3 }
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
      const [open, setOpen] = React.useState(false)
      const ref = React.useRef(null)
      const sel = options && options.find(o => o.value === value)
      React.useEffect(() => {
        if (!open) return
        function onDoc(e) { if (ref.current && ref.current.contains && !ref.current.contains(e.target)) setOpen(false) }
        function onKey(e) { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDoc)
        document.addEventListener('keydown', onKey)
        return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
      }, [open])
      return React.createElement('div', { 'data-dsh-translator-select': '', ref },
        React.createElement('button', { 'data-dsh-translator-select-trigger': '', type: 'button', onClick: () => setOpen(!open), 'aria-haspopup': 'listbox', 'aria-expanded': open ? 'true' : 'false' },
          React.createElement('span', { 'data-dsh-translator-select-label': '' }, sel ? sel.label : (placeholder || '')),
          React.createElement('span', { 'data-dsh-translator-select-arrow': '', 'aria-hidden': 'true' }, React.createElement(ChevronDownIcon)),
        ),
        open ? React.createElement('div', { 'data-dsh-translator-select-menu': '', role: 'listbox' },
          options.map(o => React.createElement('button', { key: o.value, 'data-dsh-translator-select-option': '', type: 'button', role: 'option', 'aria-selected': o.value === value ? 'true' : undefined, onMouseDown: (e) => e.preventDefault(), onClick: () => { onChange(o.value); setOpen(false) } }, o.label)),
        ) : null,
      )
    }
    function ConfigCard() {
      const { tr, lang } = useI18n()
      const [cfg, setCfg] = React.useState(null)
      const [base, setBase] = React.useState(null)
      const [models, setModels] = React.useState([])
      const [defaultModel, setDefaultModel] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [status, setStatus] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const cardRef = React.useRef(null)
      React.useEffect(() => {
        if (!open || !cardRef.current) return
        const t = setTimeout(() => {
          if (cardRef.current) cardRef.current.scrollIntoView({ block: 'end', inline: 'nearest' })
        }, 40)
        return () => clearTimeout(t)
      }, [open])
      function load() {
        host.call('get-config').then((r) => {
          if (r && r.ok && r.value) { setCfg(r.value); setBase(r.value) }
        }).catch(() => {})
        host.call('list-models').then((r) => {
          if (r && r.ok && Array.isArray(r.value)) setModels(r.value)
        }).catch(() => {})
        host.call('default-model').then((r) => {
          if (r && r.ok && r.value) setDefaultModel(r.value)
        }).catch(() => {})
      }
      React.useEffect(load, [])
      if (!cfg || !base) return null
      const set = (k, v) => setCfg(prev => prev ? { ...prev, [k]: v } : prev)
      const dirty = !sameConfig(cfg, base)
      const customKey = (cfg.customModel && cfg.customModel.provider && cfg.customModel.model)
        ? (cfg.customModel.provider + '/' + cfg.customModel.model) : ''
      const modelKey = customKey || (defaultModel ? (defaultModel.provider + '/' + defaultModel.model) : '')
      function isOverridden(field) {
        if (field === 'customModel') {
          const def = defaultModel ? (defaultModel.provider + '/' + defaultModel.model) : ''
          return !!modelKey && modelKey !== def
        }
        return cfg[field] !== DEFAULTS[field]
      }
      function resetField(field) {
        if (field === 'customModel') set('customModel', { provider: '', model: '' })
        else set(field, DEFAULTS[field])
      }
      function save() {
        setSaving(true); setStatus('')
        host.call('set-config', { patch: cfg }).then((r) => {
          setSaving(false)
          if (r && r.ok) { setStatus(tr.saved); setBase(r.value) }
          else setStatus((r && r.error) || tr.saveFailed)
          setTimeout(() => setStatus(''), 1500)
        }).catch((err) => {
          setSaving(false)
          setStatus((err && err.message) || tr.saveFailed)
          setTimeout(() => setStatus(''), 1500)
        })
      }
      function discard() { setStatus(''); setCfg(base) }
      function fieldHead(labelText, field) {
        const over = isOverridden(field)
        return React.createElement('div', { 'data-dsh-translator-field-head': '' },
          React.createElement('span', { 'data-dsh-translator-field-label': '' }, labelText),
          over ? React.createElement('span', { 'data-dsh-translator-field-badges': '' },
            React.createElement('span', { 'data-dsh-translator-badge': '' }, tr.overridden),
            React.createElement('button', { 'data-dsh-translator-reset': '', type: 'button', onClick: () => resetField(field) }, tr.resetDefault),
          ) : null,
        )
      }
      const langCodes = Object.keys(LANG_NAMES).filter(c => c !== 'en')
      return React.createElement('div', { 'data-dsh-translator-plugin-card': '', 'data-open': open ? '1' : undefined, ref: cardRef },
        React.createElement('button', { 'data-dsh-translator-card-header': '', 'aria-expanded': open ? 'true' : 'false', onClick: () => setOpen(!open) },
          React.createElement('span', { 'data-dsh-translator-card-headtext': '' },
            React.createElement('span', { 'data-dsh-translator-card-name': '' }, tr.cardTitle),
            React.createElement('span', { 'data-dsh-translator-card-desc': '' }, tr.cardDesc),
          ),
          React.createElement('span', { 'data-dsh-translator-card-chevron': open ? 'open' : '' }, React.createElement(ChevronDownIcon)),
        ),
        open ? React.createElement('div', { 'data-dsh-translator-card-body': '', 'data-dsh-translator-settings': '' },
          React.createElement('div', { 'data-dsh-translator-field': '' },
            fieldHead(tr.primaryLanguage, 'primaryLanguage'),
            React.createElement(ConfigSelect, { value: cfg.primaryLanguage, onChange: (v) => set('primaryLanguage', v), options: langCodes.map(c => ({ value: c, label: lang(c) })) }),
          ),
          React.createElement('div', { 'data-dsh-translator-field': '' },
            fieldHead(tr.model, 'customModel'),
            React.createElement(ConfigSelect, { value: modelKey, onChange: (v) => { const i = v.indexOf('/'); if (i > 0) set('customModel', { provider: v.slice(0, i), model: v.slice(i + 1) }) }, options: models.map(m => ({ value: m.provider + '/' + m.model, label: m.label })) }),
          ),
          React.createElement('div', { 'data-dsh-translator-field-row': '' },
            React.createElement('div', { 'data-dsh-translator-field': '' },
              fieldHead(tr.reasoningLevel, 'reasoningEffort'),
              React.createElement(ConfigSelect, { value: cfg.reasoningEffort, onChange: (v) => set('reasoningEffort', v), options: [{ value: 'off', label: 'off' }, { value: 'low', label: 'low' }, { value: 'high', label: 'high' }, { value: 'max', label: 'max' }] }),
            ),
            React.createElement('div', { 'data-dsh-translator-field': '' },
              fieldHead(tr.maxTokens, 'maxTokens'),
              React.createElement('input', { type: 'number', value: cfg.maxTokens, min: 1, onChange: (e) => set('maxTokens', Number(e.target.value) || 1024) }),
            ),
          ),
          React.createElement('div', { 'data-dsh-translator-field-row': '' },
            React.createElement('div', { 'data-dsh-translator-field': '' },
              fieldHead(tr.timeout, 'timeoutMs'),
              React.createElement('input', { type: 'number', value: cfg.timeoutMs, min: 1000, onChange: (e) => set('timeoutMs', Number(e.target.value) || 30000) }),
            ),
            React.createElement('div', { 'data-dsh-translator-field': '' },
              fieldHead(tr.temperature, 'temperature'),
              React.createElement('input', { type: 'number', step: 0.1, min: 0, max: 2, value: cfg.temperature, onChange: (e) => set('temperature', Number(e.target.value) || 0.3) }),
            ),
          ),
          React.createElement('div', { 'data-dsh-translator-card-footer': '' },
            React.createElement('button', { 'data-dsh-translator-card-discard': '', onClick: discard, disabled: !dirty || saving }, tr.discard),
            React.createElement('button', { 'data-dsh-translator-card-save': '', onClick: save, disabled: !dirty || saving }, saving ? tr.saving : tr.save),
            status ? React.createElement('span', { 'data-dsh-translator-settings-status': '' }, status) : null,
          ),
        ) : null,
      )
    }

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'dsh-translator-overlay' },
      () => React.createElement(LocaleBound, null, React.createElement(TranslatorRoot)),
    ))
    slots.inject('settings.plugin.item', () => slots.register(
      { name: 'settings.plugin.item', key: 'dsh-translator' },
      () => React.createElement(LocaleBound, null, React.createElement(ConfigCard)),
    ))
  },
}
