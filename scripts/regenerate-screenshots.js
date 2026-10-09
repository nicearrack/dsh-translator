// Regenerate the README screenshots (screenshots/*.png).
//
// Maintainer tool, opt-in and machine-specific in one respect: it drives a
// session literally named 「截图专用」 in the instance it is pointed at, so that
// no real conversation ever ends up in the README.
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

  const conv = await page.evaluate(() => {
    const el = document.querySelector('.SLC67a_scroll')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  if (!conv) { console.error('no conversation container'); await browser.close(); process.exit(1) }
  console.log('conv:', JSON.stringify(conv))

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

  // ── 1. select-button.png ────────────────────────────────────────────────
  // Short sessions show the conversation header (workspace chip + created
  // date) above the messages — the earlier crop picked it up as a black
  // block. Crop from the selected reply itself: button above, reply below.
  if (!(await selectText('prints its arguments', 20))) { console.error('en reply not found'); await browser.close(); process.exit(1) }
  if (await waitButton()) {
    const reply = await itemRectOf('prints its arguments')
    const btn = await page.evaluate(() => { const b = document.querySelector('[data-dsh-translator-btn]'); return b ? b.getBoundingClientRect().toJSON() : null })
    if (reply) {
      const top = Math.min(reply.y, btn ? btn.y : reply.y) - 12
      const clip = { x: Math.max(0, conv.x + 12), y: Math.max(0, top), width: Math.min(WIDTH, conv.width - 24), height: reply.y + reply.height - top + 12 }
      await page.screenshot({ path: join(OUT, 'select-button.png'), clip })
      console.log('saved select-button.png', JSON.stringify(clip))
    }
  } else console.error('button did not appear (1)')

  // ── 2. en-zh.png ────────────────────────────────────────────────────────
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  if (!(await selectText('hello world', 11))) { console.error('prompt not found'); await browser.close(); process.exit(1) }
  if (await waitButton()) {
    await page.evaluate(() => { document.querySelector('[data-dsh-translator-btn]')?.click() })
    await page.waitForTimeout(45000)
    const bubble = await itemRectOf('hello world')
    const echo = await itemRectOf('echo prints its arguments')
    const card = await page.evaluate(() => document.querySelector('[data-dsh-translator-card]')?.getBoundingClientRect().toJSON() || null)
    const bottom = Math.max(echo ? (echo.y + echo.height) : 0, card ? card.bottom : 0)
    if (bubble) {
      const clip = { x: Math.max(0, conv.x + 12), y: Math.max(0, bubble.y - 12), width: Math.min(WIDTH, conv.width - 24), height: bottom - bubble.y + 24 }
      await page.screenshot({ path: join(OUT, 'en-zh.png'), clip })
      console.log('saved en-zh.png', JSON.stringify(clip))
    }
  } else console.error('button did not appear (2)')

  // ── 3. zh-en.png ────────────────────────────────────────────────────────
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  if (!(await selectText('把跟在它后面的内容原样打印到屏幕（标准输出）上', 26))) { console.error('zh phrase not found'); await browser.close(); process.exit(1) }
  if (await waitButton()) {
    await page.evaluate(() => { document.querySelector('[data-dsh-translator-btn]')?.click() })
    await page.waitForTimeout(45000)
    const sel = await page.evaluate(() => { const s = window.getSelection(); const n = s && s.anchorNode; const item = n && n.parentElement && n.parentElement.closest('.SLC67a_flowItem'); return item ? item.getBoundingClientRect().toJSON() : null })
    const next = await page.evaluate(() => { const s = window.getSelection(); const n = s && s.anchorNode; const item = n && n.parentElement && n.parentElement.closest('.SLC67a_flowItem'); const nx = item && item.nextElementSibling; return nx ? nx.getBoundingClientRect().toJSON() : null })
    const card = await page.evaluate(() => document.querySelector('[data-dsh-translator-card]')?.getBoundingClientRect().toJSON() || null)
    if (sel) {
      const bottom = Math.max(next ? (next.y + next.height) : 0, card ? card.bottom : 0)
      const clip = { x: Math.max(0, conv.x + 12), y: Math.max(0, sel.y - 12), width: Math.min(WIDTH, conv.width - 24), height: bottom - sel.y + 24 }
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
