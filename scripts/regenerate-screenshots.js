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
// CJK glyphs come from the workspace LXGWWenKai font via fontconfig.conf at the
// package root, so the crops render Chinese instead of tofu boxes.
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
const FONT_CONFIG = join(ROOT, 'fontconfig.conf')
const OUT = join(ROOT, 'screenshots')
const WIDTH = 815

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    env: { ...process.env, FONTCONFIG_FILE: FONT_CONFIG },
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
  // The settings form is a page in the Plugins list rather than a card, so the
  // crop targets the form container itself.
  await page.keyboard.press('Escape'); await page.waitForTimeout(400)
  const nav = async (text) => page.evaluate((t) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) if ((n.textContent || '').trim() === t) { let el = n.parentElement; for (let i = 0; i < 6 && el; i++) { if (el.onclick || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'menuitem') break; el = el.parentElement } if (el) { el.click(); return true } }
    return false
  }, text)
  await nav('设置'); await page.waitForTimeout(2000)
  await nav('插件'); await page.waitForTimeout(2500)
  await nav('划词翻译'); await page.waitForTimeout(1500)
  const form = await page.evaluate(() => document.querySelector('[data-dsh-translator-settings]')?.getBoundingClientRect().toJSON() || null)
  if (form) {
    const clip = { x: Math.max(0, form.x - 16), y: Math.max(0, form.y - 24), width: Math.min(WIDTH + 16, Math.min(831, 1400 - Math.max(0, form.x - 16))), height: form.height + 48 }
    await page.screenshot({ path: join(OUT, 'config.png'), clip })
    console.log('saved config.png', JSON.stringify(clip))
  } else {
    console.error('settings form not found — the Plugins-list navigation may have changed')
  }

  console.log('errors:', errs.length ? errs.join(' || ') : 'none')
  await browser.close()
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
