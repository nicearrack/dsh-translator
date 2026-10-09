// Regenerate the README screenshots (screenshots/*.png).
//
// Maintainer tool, opt-in and machine-specific in one respect: it drives a
// session literally named 「截图专用」 in the instance it is pointed at, so that
// no real conversation ever ends up in the README.
//
// The fixture session is reproducible: start a new session in a scratch
// workspace, send these two prompts, then rename it to 截图专用 (right-click is
// not it — the row's ⋯ button appears on hover and offers 重命名):
//
//   1. 用 echo 命令演示一下：运行 echo hello world，然后用中文简单解释 echo 是做什么的。
//   2. Now explain in one short English sentence what the echo command does with its arguments.
//
// The PHRASES selected below are taken from that exchange. If you reword the
// prompts, update them too — the script fails loudly when it cannot find one
// (「en reply not found」, 「zh phrase not found」), it does not silently produce
// a wrong crop.
//
// Prerequisites, the same as tests/client.smoke.mjs:
//   npm i -D playwright && npx playwright install chromium
//   a running DSH instance carrying the plugin
//
// Usage:
//   node scripts/regenerate-screenshots.js "http://127.0.0.1:3210/?token=XXXX"
//
// CJK glyphs would otherwise render as tofu boxes. The 25 MB WenKai font lives
// in .fonts/ and is NOT committed (.fonts/ is gitignored), so this generates a
// fontconfig pointing at it, by path relative to this script. When the font is
// absent, nothing is set and the browser falls back to the system's own CJK
// font — the crops degrade, they do not fail.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

// Framing follows the previous set: white conversation-area crops ~815px wide,
// button at the selection, card below it; consistent widths.
const START_URL = process.argv[2]
if (!START_URL) {
  console.error('usage: node scripts/regenerate-screenshots.js "<dsh url with ?token=...>"')
  process.exit(2)
}

let chromium
try {
  ({ chromium } = require('playwright'))
} catch {
  console.error('This tool needs playwright, which is not installed here.')
  console.error('  npm i -D playwright && npx playwright install chromium')
  process.exit(2)
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FONT_DIR = join(ROOT, '.fonts')
const FONT_FAMILY = 'LXGW WenKai'
const FONT_CACHE = join(ROOT, '.fonts-cache')
const OUT = join(ROOT, 'screenshots')
const WIDTH = 815

/**
 * The exact strings the fixture session is expected to contain.
 *
 * `enReply` is the whole English sentence, because the point of the en→zh
 * screenshot is to show an English passage selected with its Chinese
 * translation beneath it — selecting an English token out of the Chinese
 * prompt instead reads as neither direction. `zhReply` is the matching Chinese
 * sentence for the reverse shot.
 *
 * These have to be runs that live inside a SINGLE text node: selection works by
 * finding one node containing the string. `echo` is rendered in its own code
 * chip, so the sentence below deliberately starts after it.
 */
const FIXTURE = {
  enShort: 'prints its arguments',
  enReply: 'prints its arguments to standard output, separated by spaces, followed by a newline.',
  zhReply: '把传给它的参数原样打印到标准输出',
}

/**
 * The `FONTCONFIG_FILE` env chromium should get, or nothing when there is no
 * in-repo font to point at.
 *
 * Two things are required for the font to actually be used, and skipping either
 * leaves the crops silently rendered in the system CJK font:
 *
 *   1. a `match` rule that PREPENDS the family. A bare `<dir>` only adds the
 *      file to the pool; the system font still wins the match.
 *   2. `fc-cache -f` against this exact config. fontconfig keeps per-directory
 *      caches and will not notice a newly added `<dir>` until they are rebuilt,
 *      so without the rescan even a correct rule does nothing.
 *
 * The rule is deliberately global rather than scoped with a `lang` test:
 * measured on this machine, `lang contains zh` also matches `lang=en`, `ja` and
 * `ko`, so the scope would be a fiction. Every screenshot therefore has to be
 * regenerated together, or they will differ in typeface.
 */
function fontConfigEnv() {
  if (!existsSync(FONT_DIR)) return {}
  mkdirSync(FONT_CACHE, { recursive: true })
  const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const file = join(FONT_CACHE, 'fontconfig.conf')
  writeFileSync(file, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${escape(FONT_DIR)}</dir>
  <cachedir>${escape(FONT_CACHE)}</cachedir>
  <match target="pattern">
    <edit name="family" mode="prepend" binding="strong"><string>${FONT_FAMILY}</string></edit>
  </match>
</fontconfig>
`)
  const cached = spawnSync('fc-cache', ['-f'], {
    env: { ...process.env, FONTCONFIG_FILE: file },
    stdio: 'ignore',
  })
  if (cached.error) {
    console.error('note: fc-cache not available, the in-repo font may be ignored:', cached.error.message)
  }
  return { FONTCONFIG_FILE: file }
}

async function main() {
  // `channel: 'chromium'` rather than the default headless shell: it reuses a
  // chromium that is already installed (a DSH checkout has one) and renders
  // exactly what the user sees, which is the point of a screenshot.
  const browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    env: { ...process.env, ...fontConfigEnv() },
  })
  const page = await browser.newPage({ viewport: { width: 1120, height: 820 } })
  const errs = []
  page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 160)))

  await page.goto(START_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body && document.body.textContent.length > 100, { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.getByText('截图专用', { exact: true }).first().click()
  await page.waitForTimeout(4000)

  /** The conversation column's CURRENT viewport rect. Re-measured per crop. */
  const convRect = () => page.evaluate(() => {
    const el = document.querySelector('.SLC67a_scroll')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  if (!(await convRect())) { console.error('no conversation container'); await browser.close(); process.exit(1) }

  /**
   * Bring the flow item containing `text` into view, and let the scroll settle.
   *
   * Measuring without this yields rects measured against a scrolled container —
   * seen here as `y: -166` for the prompt and `conv.y: -182` — so the crop lands
   * on the session header instead of the message. Note that scrolling also moves
   * the container itself, which is why the rect is re-read for every crop
   * rather than captured once at the start.
   */
  const scrollTo = async (text) => {
    const found = await page.evaluate((t) => {
      const conv = document.querySelector('.SLC67a_scroll')
      if (!conv) return false
      const w = document.createTreeWalker(conv, NodeFilter.SHOW_TEXT)
      let n
      while ((n = w.nextNode())) {
        if ((n.textContent || '').includes(t)) {
          const item = n.parentElement.closest('.SLC67a_flowItem')
          if (item) { item.scrollIntoView({ block: 'center' }); return true }
        }
      }
      return false
    }, text)
    if (found) await page.waitForTimeout(1000)
    return found
  }

  /**
   * One crop region: the full conversation column, from `top` down to `bottom`.
   *
   * The width is the whole column rather than a narrower slice because the
   * translation card is clamped to the window, not to this column — a narrower
   * crop slices its right edge and the close button off.
   */
  const crop = async (top, bottom) => {
    const c = await convRect()
    const y = Math.max(0, top)
    return { x: Math.max(0, c.x), y, width: c.width, height: Math.max(0, bottom - y) }
  }

  const selectText = (text, n) => page.evaluate(([t, len]) => {
    const w = document.createTreeWalker(document.querySelector('.SLC67a_scroll'), NodeFilter.SHOW_TEXT)
    let node
    while ((node = w.nextNode())) {
      const tx = node.textContent || ''
      const i = tx.indexOf(t)
      if (i < 0) continue
      if (node.parentElement.closest('script,style')) continue
      const r = document.createRange()
      r.setStart(node, i); r.setEnd(node, Math.min(i + len, node.length))
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
      node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
      return true
    }
    return false
  }, [text, n])

  const itemRectOf = (text) => page.evaluate((t) => {
    const w = document.createTreeWalker(document.querySelector('.SLC67a_scroll'), NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) if ((n.textContent || '').includes(t) && !n.parentElement.closest('script,style')) {
      const item = n.parentElement.closest('.SLC67a_flowItem')
      return item ? item.getBoundingClientRect().toJSON() : null
    }
    return null
  }, text)

  const waitButton = async () => {
    for (let i = 0; i < 25; i++) {
      if (await page.locator('[data-dsh-translator-btn]').count() > 0) return true
      await page.evaluate(() => { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
      await page.waitForTimeout(300)
    }
    return false
  }

  /** Poll until the card settles into a result or a visible error. */
  const waitCard = async (maxMs = 45000) => {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => {
        const card = document.querySelector('[data-dsh-translator-card]')
        if (!card) return 'gone'
        if (card.querySelector('[data-dsh-translator-meta]')) return 'done'
        if (card.querySelector('[data-dsh-translator-error]')) return 'error'
        return 'loading'
      })
      if (state === 'done' || state === 'error') return state
      await page.waitForTimeout(500)
    }
    return 'loading'
  }

  // ── 1. select-button.png ────────────────────────────────────────────────
  // Short sessions show the conversation header (workspace chip + created
  // date) above the messages. Scroll the reply to the middle first, then crop
  // from the reply itself: button above, reply below.
  if (!(await scrollTo(FIXTURE.enShort))) { console.error('en reply not found'); await browser.close(); process.exit(1) }
  if (!(await selectText(FIXTURE.enShort, 20))) { console.error('en reply not found'); await browser.close(); process.exit(1) }
  if (await waitButton()) {
    const reply = await itemRectOf(FIXTURE.enShort)
    const btn = await page.evaluate(() => { const b = document.querySelector('[data-dsh-translator-btn]'); return b ? b.getBoundingClientRect().toJSON() : null })
    if (reply) {
      const top = Math.min(reply.y, btn ? btn.y : reply.y) - 12
      const clip = await crop(top, reply.y + reply.height + 12)
      await page.screenshot({ path: join(OUT, 'select-button.png'), clip })
      console.log('saved select-button.png', JSON.stringify(clip))
    }
  } else console.error('button did not appear (1)')

  // ── 2. en-zh.png ────────────────────────────────────────────────────────
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  if (!(await scrollTo(FIXTURE.enReply))) { console.error('en reply not found'); await browser.close(); process.exit(1) }
  if (!(await selectText(FIXTURE.enReply, FIXTURE.enReply.length))) { console.error('en reply not found'); await browser.close(); process.exit(1) }
  if (await waitButton()) {
    await page.evaluate(() => { document.querySelector('[data-dsh-translator-btn]')?.click() })
    const settled = await waitCard()
    if (settled !== 'done') console.error('en-zh: card did not settle on a result:', settled)
    const bubble = await itemRectOf(FIXTURE.enReply)
    const card = await page.evaluate(() => document.querySelector('[data-dsh-translator-card]')?.getBoundingClientRect().toJSON() || null)
    const bottom = Math.max(bubble ? (bubble.y + bubble.height) : 0, card ? card.bottom : 0)
    if (bubble) {
      const clip = await crop(bubble.y - 12, bottom + 12)
      await page.screenshot({ path: join(OUT, 'en-zh.png'), clip })
      console.log('saved en-zh.png', JSON.stringify(clip))
    }
  } else console.error('button did not appear (2)')

  // ── 3. zh-en.png ────────────────────────────────────────────────────────
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  if (!(await scrollTo(FIXTURE.zhReply))) { console.error('zh phrase not found'); await browser.close(); process.exit(1) }
  if (!(await selectText(FIXTURE.zhReply, FIXTURE.zhReply.length))) { console.error('zh phrase not found'); await browser.close(); process.exit(1) }
  if (await waitButton()) {
    await page.evaluate(() => { document.querySelector('[data-dsh-translator-btn]')?.click() })
    const settled = await waitCard()
    if (settled !== 'done') console.error('zh-en: card did not settle on a result:', settled)
    const sel = await page.evaluate(() => { const s = window.getSelection(); const n = s && s.anchorNode; const item = n && n.parentElement && n.parentElement.closest('.SLC67a_flowItem'); return item ? item.getBoundingClientRect().toJSON() : null })
    const next = await page.evaluate(() => { const s = window.getSelection(); const n = s && s.anchorNode; const item = n && n.parentElement && n.parentElement.closest('.SLC67a_flowItem'); const nx = item && item.nextElementSibling; return nx ? nx.getBoundingClientRect().toJSON() : null })
    const card = await page.evaluate(() => document.querySelector('[data-dsh-translator-card]')?.getBoundingClientRect().toJSON() || null)
    if (sel) {
      const bottom = Math.max(next ? (next.y + next.height) : 0, card ? card.bottom : 0)
      const clip = await crop(sel.y - 12, bottom + 12)
      await page.screenshot({ path: join(OUT, 'zh-en.png'), clip })
      console.log('saved zh-en.png', JSON.stringify(clip))
    }
  } else console.error('button did not appear (3)')

  // ── 4. config.png ───────────────────────────────────────────────────────
  // The settings form is a page in the Plugins list, not a card. Reach it with
  // 插件 → the bundle's own entry. Do NOT click 设置 first: that opens the
  // general Settings modal on top of it, and the crop would capture the modal
  // instead of the plugin form.
  // The viewport is narrowed first so the form lands near the same ~815px width
  // the conversation crops above use.
  await page.keyboard.press('Escape'); await page.waitForTimeout(400)
  await page.setViewportSize({ width: 1120, height: 820 })
  await page.waitForTimeout(600)
  const nav = async (text) => page.evaluate((t) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) if ((n.textContent || '').trim() === t) { let el = n.parentElement; for (let i = 0; i < 6 && el; i++) { if (el.onclick || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'menuitem') break; el = el.parentElement } if (el) { el.click(); return true } }
    return false
  }, text)
  await nav('插件'); await page.waitForTimeout(2500)
  await nav('划词翻译'); await page.waitForTimeout(1800)
  const form = await page.evaluate(() => document.querySelector('[data-dsh-translator-settings]')?.getBoundingClientRect().toJSON() || null)
  if (form) {
    // Full form width plus a margin: the select controls span the whole form,
    // so a narrower crop would slice their right edges off.
    const clip = { x: Math.max(0, form.x - 16), y: Math.max(0, form.y - 28), width: Math.min(WIDTH, form.width + 32), height: form.height + 56 }
    await page.screenshot({ path: join(OUT, 'config.png'), clip })
    console.log('saved config.png', JSON.stringify(clip))
  } else {
    console.error('settings form not found — the Plugins-list navigation may have changed')
  }

  console.log('errors:', errs.length ? errs.join(' || ') : 'none')
  await browser.close()
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
