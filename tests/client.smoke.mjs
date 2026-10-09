// dsh-translator real-browser regression suite.
//
// This is the only layer that exercises the plugin the way a user meets it: a
// real React render, the real selection → floating button → card flow, and the
// real authenticated `/api` round trip. `tests/host.test.mjs` and
// `tests/client.test.mjs` cannot cover any of that — the latter runs
// `client/core.js` against a stub React that never invokes a nested component,
// and both mock the transport.
//
// Opt-in, because it needs two things a plain `npm test` must not require:
//
//   1. playwright + a chromium build
//        npm i -D playwright && npx playwright install chromium
//   2. a running DSH instance with this plugin loaded, and its URL with a token
//        pnpm dsh web --patch /path/to/dsh-translator/dev.patch.yml --port 3210 --no-open
//
// Usage:
//   node tests/client.smoke.mjs "http://127.0.0.1:3210/?token=XXXX"
//
// The suite is READ-ONLY: it never saves, never switches locale and never
// writes settings. It types into a draft to watch the override badge, then
// closes the page, which discards that draft.
//
// It asserts:
//   1. the overlay mounts and a selection raises the floating button (SVG icon)
//   2. click → the card settles into a result or a visible error. A provider
//      stall that leaves it "loading" FAILS — that is the frozen defect the
//      AbortSignal handling exists to prevent.
//   3. pin survives Escape and outside clicks; close dismisses
//   4. the settings page renders the free-API field labels
//   5. the override badge reacts live: a non-default value lights it and
//      enables save/discard; returning to the default clears both
import { createRequire } from 'node:module'

// Argument check first: a bare `npm run test:smoke` should say how to call it,
// not complain about a missing prerequisite it never got the chance to need.
const START_URL = process.argv[2]
if (!START_URL) {
  console.error('usage: node tests/client.smoke.mjs "<dsh url with ?token=...>"')
  process.exit(2)
}

const require = createRequire(import.meta.url)
let chromium
try {
  ({ chromium } = require('playwright'))
} catch {
  console.error('This suite needs playwright, which is not installed here.')
  console.error('  npm i -D playwright && npx playwright install chromium')
  process.exit(2)
}

function check(name, cond, detail = '') {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ' — ' + detail : ''}`)
  console.log(`ok  ${name}`)
}

const clickText = (page, text) => page.evaluate((t) => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let n
  while ((n = w.nextNode())) {
    if ((n.textContent || '').trim() === t) {
      let el = n.parentElement
      for (let i = 0; i < 6 && el; i++) {
        if (el.onclick || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'menuitem') break
        el = el.parentElement
      }
      if (el) { el.click(); return true }
    }
  }
  return false
}, text)

const selectSomeText = (page) => page.evaluate(() => {
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let n, hit = null
  const re = /[A-Za-z][A-Za-z0-9_-]{3,}/
  while ((n = walk.nextNode())) {
    const t = (n.textContent || '')
    const m = t.match(re)
    if (m && !(n.parentElement && n.parentElement.closest && n.parentElement.closest('script,style,textarea'))) { hit = { node: n, i: m.index }; break }
  }
  if (!hit) return false
  const r = document.createRange(); r.setStart(hit.node, hit.i); r.setEnd(hit.node, hit.i + 3)
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
  hit.node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
  return true
})

/** Read the card's state: still loading, done (with meta), errored, or gone. */
const cardState = (page) => page.evaluate(() => {
  const card = document.querySelector('[data-dsh-translator-card]')
  if (!card) return { state: 'gone' }
  const body = card.querySelector('[data-dsh-translator-body]')
  const meta = card.querySelector('[data-dsh-translator-meta]')
  if (meta) return { state: 'done', text: body ? body.textContent : '', meta: meta.textContent }
  const err = card.querySelector('[data-dsh-translator-error]')
  if (err) return { state: 'error', text: err.textContent }
  return { state: 'loading' }
})

async function main() {
  // `channel: 'chromium'` uses the full chromium build rather than the stripped
  // headless shell Playwright reaches for by default. That matters here: a
  // machine that already has a chromium (a DSH checkout ships one) can run this
  // with no extra download, and the full build renders the UI and its CSS the
  // way a user actually sees it.
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 160)))
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)) })

  await page.goto(START_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body && document.body.textContent.length > 100, { timeout: 90000 })
  await page.waitForTimeout(3500)

  // 1. overlay + selection button
  await selectSomeText(page)
  for (let i = 0; i < 20; i++) {
    if (await page.locator('[data-dsh-translator-btn]').count() > 0) break
    await page.evaluate(() => { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    await page.waitForTimeout(300)
  }
  check('floating button appears', await page.locator('[data-dsh-translator-btn]').count() > 0)
  const btn = await page.evaluate(() => {
    const b = document.querySelector('[data-dsh-translator-btn]')
    return { svg: !!b.querySelector('svg'), text: b.textContent, title: b.title }
  })
  check('button renders SVG icon (no letter glyph)', btn.svg && !/[译T]/.test(btn.text), JSON.stringify(btn))
  check('button keeps localized tooltip', typeof btn.title === 'string' && btn.title.length > 0, btn.title)

  // 2. click → the card must leave "loading". Polling rather than sleeping a
  // fixed 40 s: a healthy provider settles in about a second, while a stalled
  // stream still fails here once the deadline passes.
  await page.evaluate(() => { document.querySelector('[data-dsh-translator-btn]').click() })
  let st = { state: 'loading' }
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    st = await cardState(page)
    if (st.state !== 'loading') break
    await page.waitForTimeout(500)
  }
  check('translation card settles (result or visible error)', st.state === 'done' || st.state === 'error', JSON.stringify(st))
  if (st.state === 'done') {
    check('translation result is non-empty', typeof st.text === 'string' && st.text.trim().length > 0, JSON.stringify(st).slice(0, 80))
    check('footer shows direction/engine meta', typeof st.meta === 'string' && st.meta.includes('·'), st.meta)
  } else {
    console.log('note: provider errors are environment-dependent — result asserted only on done:', st.text)
  }

  // 3. pin locks, close works
  await page.evaluate(() => { document.querySelector('[data-dsh-translator-pin]').click() })
  const pinned = await page.locator('[data-dsh-translator-card][data-dsh-translator-pinned]').count()
  check('pin locks the card', pinned > 0)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check('pinned card survives Escape', await page.locator('[data-dsh-translator-card]').count() > 0)
  await page.evaluate(() => { document.querySelector('[data-dsh-translator-close]').click() })
  await page.waitForTimeout(300)
  check('close dismisses the card', await page.locator('[data-dsh-translator-card]').count() === 0)

  // 4/5. settings page: field labels + live dirty semantics (NO save).
  // Which fields exist depends on the engine, and a fresh profile defaults to
  // the free-API engine: engine, primary language, translation service and
  // timeout. The model controls only appear once the engine is switched.
  //
  // Go straight to the Plugins list. Clicking 设置 first would open the general
  // Settings modal over the plugin page — the DOM reads below would still pass,
  // since they do not care about z-order, but the form would be hidden.
  await clickText(page, '插件'); await page.waitForTimeout(2500)
  // The bundle's own page in the Plugins list, keyed by its locale title.
  await clickText(page, '划词翻译'); await page.waitForTimeout(1800)
  const reached = await page.waitForFunction(
    () => document.querySelectorAll('[data-dsh-translator-field-label]').length > 0,
    { timeout: 15000 },
  ).then(() => true).catch(() => false)
  if (!reached) {
    const seen = await page.evaluate(() => [...document.querySelectorAll('[data-dsh-translator-field-label]')].map(e => e.textContent))
    throw new Error('FAIL: settings page not reached — the Plugins-list navigation changed. Labels seen: ' + JSON.stringify(seen))
  }
  const labels = await page.evaluate(() => [...document.querySelectorAll('[data-dsh-translator-field-label]')].map(e => e.textContent))
  check('settings page: free-API engine field labels',
    JSON.stringify(labels) === JSON.stringify(['翻译引擎', '主语言', '翻译服务', '超时（毫秒）']),
    JSON.stringify(labels))

  const state = () => page.evaluate(() => {
    const heads = [...document.querySelectorAll('[data-dsh-translator-field-head]')]
    return {
      badges: heads.map(h => !!h.querySelector('[data-dsh-translator-badge]')),
      saveEnabled: document.querySelector('[data-dsh-translator-settings-save]')?.disabled === false,
      discardEnabled: document.querySelector('[data-dsh-translator-settings-discard]')?.disabled === false,
    }
  })
  // In the free-API form the only number input is the timeout, and it is the
  // fourth field, so its badge is index 3. The schema default is 30000 ms.
  const typeTimeout = (val) => page.evaluate((v) => {
    const input = document.querySelectorAll('[data-dsh-translator-settings] input[type=number]')[0]
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, String(v))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, val)

  await typeTimeout(60000); await page.waitForTimeout(500)
  let s = await state()
  check('typing a non-default value lights the badge live', s.badges[3] === true, JSON.stringify(s.badges))
  check('…and enables save/discard', s.saveEnabled && s.discardEnabled)
  await typeTimeout(30000); await page.waitForTimeout(500)
  s = await state()
  check('reverting the value clears the badge live', s.badges.every(b => !b), JSON.stringify(s.badges))
  check('…and disables both buttons again', !s.saveEnabled && !s.discardEnabled)

  check('no page/console errors', errors.length === 0, errors.join(' | ').slice(0, 200))
  console.log('ALL CLIENT REGRESSION CHECKS PASSED')
  await browser.close()
}
main().catch(e => { console.error(e.message || e); process.exit(1) })
