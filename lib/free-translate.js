/**
 * dsh-translator — keyless public translation providers.
 *
 * The `api` engine translates through public web endpoints that ask for no
 * account, no API key and no token of any kind: the temporary signature one of
 * them wants is minted here, on the fly, and never stored on disk. Every
 * provider below was called for real, repeatedly and in both directions, from
 * a mainland-China network before it was added — an endpoint a user cannot
 * reach is worse than no endpoint at all.
 *
 * None of these is a documented API with an SLA, and measured behaviour drove
 * the chain order rather than reputation:
 *
 *   tencent   — correct on en↔zh, ja→zh, zh→zh-Hant and en→ru, ~70–220 ms.
 *   bing      — correct everywhere and the best quality (its own `usedLLM`),
 *               but 0.8–1.5 s per call plus an hourly token page load.
 *   volcengine— fast, but its automatic source detection silently returns the
 *               input unchanged for zh→en; only an explicit source language
 *               makes it correct, so that is what this module sends.
 *   mymemory  — the only formally documented API here and the weakest: its
 *               translation memory answers some pairs with unrelated prose,
 *               caps one query at 500 UTF-8 bytes, and allows only ~5000
 *               characters a day anonymously.
 *
 * Because a provider can answer HTTP 200 with the source text echoed back, a
 * result is only accepted once {@link looksLikeEcho} agrees the script of the
 * answer matches the script the target language needs.
 *
 * Requests are issued from the Host process (Node), never from the browser, so
 * there is no CORS negotiation and no ambient cookie or credential is sent.
 */

/** Providers in the order the automatic chain tries them. */
export const PROVIDERS = ['tencent', 'bing', 'volcengine', 'mymemory']

/**
 * Canonical plugin target → the code one provider expects.
 *
 * A provider missing a target is skipped rather than asked: an untranslatable
 * request is answered with the input, which the echo guard would reject only
 * after paying for the round trip.
 */
const PROVIDER_LANGS = {
  tencent: { 'zh-Hans': 'zh', 'zh-Hant': 'zh-tw', 'ja-JP': 'ja', 'ko-KR': 'ko', 'ru-RU': 'ru', 'en': 'en' },
  bing: { 'zh-Hans': 'zh-Hans', 'zh-Hant': 'zh-Hant', 'ja-JP': 'ja', 'ko-KR': 'ko', 'ru-RU': 'ru', 'en': 'en' },
  volcengine: { 'zh-Hans': 'zh', 'zh-Hant': 'zh-Hant', 'ja-JP': 'ja', 'ko-KR': 'ko', 'ru-RU': 'ru', 'en': 'en' },
  mymemory: { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', 'ja-JP': 'ja-JP', 'ko-KR': 'ko-KR', 'ru-RU': 'ru-RU', 'en': 'en-GB' },
}

/** Longest per-request slice handed to one provider, in milliseconds. */
const ATTEMPT_TIMEOUT_MS = 15000

/**
 * Cooldown after a provider's first failure, in milliseconds. Every consecutive
 * failure doubles it, up to {@link COOLDOWN_MAX_MS}: one transient network blip
 * then costs seconds instead of minutes, while an endpoint that is genuinely
 * broken still backs off to a single probe per five-minute window.
 */
const COOLDOWN_BASE_MS = 30 * 1000

/** Ceiling of the exponential cooldown. */
const COOLDOWN_MAX_MS = 5 * 60 * 1000

/** MyMemory's hard cap on one `q`, in UTF-8 bytes. */
const MYMEMORY_MAX_BYTES = 500

/** Sent on every request; some endpoints reject an empty agent. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * provider id → `{ until, strikes }`: the epoch ms it may be tried again, and
 * how many consecutive failures put it there. `strikes` drives the backoff, so
 * it is dropped together with the entry on the first success.
 */
const benched = new Map()

/**
 * Drop every cooldown and the cached Bing signature.
 *
 * Both are process-local state that outlives one translation, so a test that
 * fakes `fetch` must start from a clean slate or it would observe the previous
 * case's benchings and page load. Production never calls this.
 */
export function resetProviderHealth() {
  benched.clear()
  bingSession = null
}

/** One failure that already knows the locale-independent code the card renders. */
class FreeTranslateError extends Error {
  constructor(message, code, detail) {
    super(message)
    this.name = 'FreeTranslateError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// Script detection — the guard against a provider echoing its input back.
// ---------------------------------------------------------------------------
// Order matters: Japanese kanji also matches the Han range, so the first
// matching script wins and kana is deliberately tested before Han.
const SCRIPT_TESTS = [
  ['kana', /[\u3040-\u30ff]/],
  ['hangul', /[\u1100-\u11ff\uac00-\ud7af]/],
  ['han', /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/],
  ['cyrillic', /[\u0400-\u04ff]/],
  ['latin', /[a-z\u00c0-\u024f]/i],
]

/** The scripts each target language can legitimately be written in. */
const TARGET_SCRIPTS = {
  'zh-Hans': ['han'],
  'zh-Hant': ['han'],
  'ja-JP': ['kana', 'han'],
  'ko-KR': ['hangul'],
  'ru-RU': ['cyrillic'],
  'en': ['latin'],
}

/** The dominant writing system of one string, or `none` for digits/punctuation. */
function scriptOf(text) {
  for (const [name, pattern] of SCRIPT_TESTS) {
    if (pattern.test(text)) return name
  }
  return 'none'
}

/**
 * Whether an answer is really the input handed back.
 *
 * A provider that cannot serve a direction still answers 200 with the source
 * text (measured: Tencent for `Hello`→ru, volcengine for every zh→en call).
 * Accepting that would show the user their own sentence as a "translation", so
 * the answer must be written in a script the target language actually uses
 * whenever it shares the source's script.
 */
function looksLikeEcho(text, out, target) {
  if (out === text && /\p{L}/u.test(text)) return true
  const source = scriptOf(text)
  const produced = scriptOf(out)
  if (produced === 'none') return false
  const expected = TARGET_SCRIPTS[target] || []
  return produced === source && !expected.includes(produced)
}

/** Whether one provider can serve this target at all. */
function supportsTarget(id, target) {
  return Object.prototype.hasOwnProperty.call(PROVIDER_LANGS[id] || {}, target)
}

/** The provider's code for a target it supports. */
function langOf(id, target) {
  return PROVIDER_LANGS[id][target]
}

/**
 * The source language to declare to a provider that mis-detects on its own.
 *
 * Volcengine is the reason: with `source_language: "auto"` it echoed every
 * Chinese→English request untouched and truncated a Japanese→Chinese one to a
 * single punctuation mark, while the same calls with an explicit source came
 * back correct. The mapping is coarse on purpose — it only has to pick the
 * right language family.
 */
const SCRIPT_LANGS = { han: 'zh', kana: 'ja', hangul: 'ko', cyrillic: 'ru', latin: 'en', none: 'auto' }

/** One combined abort signal: the caller's, plus this attempt's timeout. */
function attemptSignal(timeoutMs, signal) {
  const signals = [AbortSignal.timeout(Math.max(1, timeoutMs))]
  if (signal) signals.push(signal)
  return AbortSignal.any(signals)
}

/** Read a bounded slice of a response body, for error text. */
async function bodyText(response) {
  try {
    return (await response.text()).slice(0, 300)
  } catch {
    return ''
  }
}

/** One request with the shared headers, timeout and abort wiring. */
async function requestJson(url, init, timeoutMs, signal) {
  const response = await fetch(url, {
    ...init,
    signal: attemptSignal(timeoutMs, signal),
    headers: { 'user-agent': USER_AGENT, ...(init && init.headers ? init.headers : {}) },
  })
  if (!response.ok) {
    throw new Error('HTTP ' + response.status + ' ' + (await bodyText(response)))
  }
  return response.json()
}

/** Reject an empty answer before it reaches the card. */
function requireText(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error('provider returned no translation')
  return text
}

// ---------------------------------------------------------------------------
// Tencent interactive translation (腾讯交互翻译) — one keyless POST, and the
// only provider measured correct in every supported direction. The client_key
// is an anonymous browser fingerprint, not a credential: a fresh random one per
// process works, so none is shipped or persisted.
// ---------------------------------------------------------------------------
const TENCENT_CLIENT_KEY = 'browser-chrome-131.0.0-Win32-'
  + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
  + '-' + Date.now()

async function tencent(text, target, timeoutMs, signal) {
  const body = await requestJson('https://transmart.qq.com/api/imt', {
    method: 'POST',
    headers: { 'content-type': 'application/json', referer: 'https://transmart.qq.com/zh-CN/index' },
    body: JSON.stringify({
      header: { fn: 'auto_translation', client_key: TENCENT_CLIENT_KEY },
      type: 'plain',
      model_category: 'normal',
      source: { lang: 'auto', text_list: [text] },
      target: { lang: langOf('tencent', target) },
    }),
  }, timeoutMs, signal)
  const ret = body && body.header ? body.header.ret_code : undefined
  if (ret !== 'succ') throw new Error('tencent: ' + ((body && body.message) || ret || 'failed'))
  const list = body && body.auto_translation
  return requireText(Array.isArray(list) ? list[0] : '')
}

// ---------------------------------------------------------------------------
// Microsoft Bing (微软 Bing) — the translator page mints a temporary
// IG/IID/key/token set that the call must echo back. The set is cached for its
// advertised lifetime and re-minted on the first rejected call, so an hour of
// use costs one extra page load. `www.bing.com` is used rather than a regional
// host so the redirect lands on whichever edition the user's network resolves.
// ---------------------------------------------------------------------------
const IG_RE = /\bIG:"([0-9A-Fa-f]+)"/
const IID_RE = /data-iid="(translator\.[0-9]+)"/
const ABUSE_RE = /params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)/

/** Cached Bing page state: where to call, and the signature it handed out. */
let bingSession = null

/** Mint a fresh Bing session from the translator page (following its redirect). */
async function mintBingSession(timeoutMs, signal) {
  const response = await fetch('https://www.bing.com/translator', {
    signal: attemptSignal(timeoutMs, signal),
    headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
  })
  if (!response.ok) throw new Error('bing portal HTTP ' + response.status)
  const html = await response.text()
  const ig = html.match(IG_RE)
  const iid = html.match(IID_RE)
  const abuse = html.match(ABUSE_RE)
  if (!ig || !iid || !abuse) throw new Error('bing portal: signature markers not found')
  const origin = new URL(response.url || 'https://www.bing.com/translator').origin
  return {
    origin,
    ig: ig[1],
    iid: iid[1],
    key: abuse[1],
    token: abuse[2],
    // The page advertises its own lifetime in ms; refresh a minute early.
    expires: Date.now() + Math.max(60000, Number(abuse[3]) || 3600000) - 60000,
  }
}

/** One call against an existing Bing session. */
async function bingCall(session, text, target, timeoutMs, signal) {
  const url = session.origin + '/ttranslatev3?isVertical=1&IG=' + encodeURIComponent(session.ig)
    + '&IID=' + encodeURIComponent(session.iid + '.1')
  const form = new URLSearchParams({
    fromLang: 'auto-detect',
    text,
    to: langOf('bing', target),
    token: session.token,
    key: session.key,
  })
  const body = await requestJson(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      referer: session.origin + '/translator',
    },
    body: form.toString(),
  }, timeoutMs, signal)
  // A rejected signature answers 200 with a statusCode object, not an array.
  if (!Array.isArray(body)) {
    const error = new Error('bing: ' + ((body && body.statusCode) || 'unexpected response'))
    error.expired = true
    throw error
  }
  const first = body[0]
  const translation = first && Array.isArray(first.translations) ? first.translations[0] : null
  return requireText(translation && translation.text)
}

async function bing(text, target, timeoutMs, signal) {
  if (!bingSession || bingSession.expires <= Date.now()) {
    bingSession = await mintBingSession(timeoutMs, signal)
  }
  try {
    return await bingCall(bingSession, text, target, timeoutMs, signal)
  } catch (err) {
    // Only a stale signature is worth a second page load; a real network
    // failure would just repeat itself.
    if (!err || err.expired !== true) throw err
    bingSession = await mintBingSession(timeoutMs, signal)
    return bingCall(bingSession, text, target, timeoutMs, signal)
  }
}

// ---------------------------------------------------------------------------
// Volcengine (火山翻译) — one keyless POST and the fastest of the four, but
// only with an explicit source language (see SCRIPT_LANGS). It also answers
// HTTP 500 intermittently, which the chain absorbs as an ordinary failure.
// ---------------------------------------------------------------------------
async function volcengine(text, target, timeoutMs, signal) {
  const body = await requestJson('https://translate.volcengine.com/crx/translate/v1/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source_language: SCRIPT_LANGS[scriptOf(text)] || 'auto',
      target_language: langOf('volcengine', target),
      text,
    }),
  }, timeoutMs, signal)
  const status = body && body.base_resp ? body.base_resp.status_code : undefined
  if (typeof status === 'number' && status !== 0) {
    throw new Error('volcengine ' + status + ': ' + ((body.base_resp && body.base_resp.status_message) || ''))
  }
  return requireText(body && body.translation)
}

// ---------------------------------------------------------------------------
// MyMemory — the only formally documented API here, and the last resort.
// ---------------------------------------------------------------------------
const MYMEMORY_ERROR_RE = /QUERY LENGTH LIMIT|INVALID (TARGET|SOURCE) LANGUAGE|MYMEMORY WARNING|YOU USED ALL AVAILABLE FREE TRANSLATIONS/i

async function mymemory(text, target, timeoutMs, signal) {
  const form = new URLSearchParams({ q: text, langpair: 'autodetect|' + langOf('mymemory', target) })
  const body = await requestJson('https://api.mymemory.translated.net/get?' + form.toString(), {}, timeoutMs, signal)
  const status = body && body.responseStatus
  const raw = body && body.responseData ? body.responseData.translatedText : ''
  if (status !== 200 || (body && body.quotaFinished === true) || MYMEMORY_ERROR_RE.test(String(raw))) {
    throw new Error('mymemory: ' + (String(raw) || ('status ' + status)).slice(0, 120))
  }
  return requireText(raw)
}

/** provider id → the call that performs one translation. */
const CALLS = { tencent, bing, volcengine, mymemory }

/**
 * Translate through the keyless public providers.
 *
 * @param text - the source text, already trimmed and length-capped by the caller.
 * @param target - canonical plugin target language (`zh-Hans`, `en`, …).
 * @param options - `provider` (`auto` or one id), `timeoutMs`, `signal`, and
 *   `force` — set by an explicit user retry to ignore every cooldown, so a
 *   chain that is merely benched is always reachable by hand.
 * @returns `{ text, provider, attempts }` — the first answer that is usable.
 * @throws FreeTranslateError with code `api-failed`, `api-timeout` or `cancelled`;
 *   its `detail` carries one `{ provider, reason, error }` record per attempt,
 *   where `reason` is `unsupported`, `too-long`, `benched`, `echo` or `failed`.
 */
export async function translateFree(text, target, options = {}) {
  const requested = typeof options.provider === 'string' && PROVIDERS.includes(options.provider)
    ? options.provider
    : 'auto'
  const chain = requested === 'auto' ? PROVIDERS : [requested]
  const total = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000
  const signal = options.signal
  const force = options.force === true
  const deadline = Date.now() + total
  const attempts = []

  for (const id of chain) {
    if (signal && signal.aborted) throw new FreeTranslateError('cancelled', 'cancelled')
    if (!supportsTarget(id, target)) {
      attempts.push({ provider: id, reason: 'unsupported', error: 'does not support ' + target })
      continue
    }
    if (id === 'mymemory' && Buffer.byteLength(text, 'utf8') > MYMEMORY_MAX_BYTES) {
      attempts.push({ provider: id, reason: 'too-long', error: 'text exceeds ' + MYMEMORY_MAX_BYTES + ' bytes' })
      continue
    }
    const health = benched.get(id)
    if (!force && health !== undefined && health.until > Date.now()) {
      attempts.push({ provider: id, reason: 'benched', error: 'benched after an earlier failure' })
      continue
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new FreeTranslateError('translation timed out (' + total + ' ms)', 'api-timeout', attempts)
    }
    try {
      const out = await CALLS[id](text, target, Math.min(remaining, ATTEMPT_TIMEOUT_MS), signal)
      if (looksLikeEcho(text, out, target)) {
        const echo = new Error('provider echoed the source text instead of translating it')
        echo.reason = 'echo'
        throw echo
      }
      benched.delete(id)
      return { text: out, provider: id, attempts }
    } catch (err) {
      if (signal && signal.aborted) throw new FreeTranslateError('cancelled', 'cancelled')
      const message = err instanceof Error ? err.message : String(err)
      // `reason` is the locale-independent half of the record: the card maps it
      // to a translated phrase instead of parsing the English `error` text.
      attempts.push({ provider: id, reason: (err && err.reason) || 'failed', error: message })
      // Bench the provider so a hanging or broken endpoint costs at most one
      // probe per backoff window instead of one per translation. The window
      // doubles per consecutive failure, so a transient blip — which takes the
      // whole chain down at once — no longer locks every provider out for the
      // full five minutes.
      const strikes = ((health && health.strikes) || 0) + 1
      const cooldown = Math.min(COOLDOWN_BASE_MS * 2 ** (strikes - 1), COOLDOWN_MAX_MS)
      benched.set(id, { until: Date.now() + cooldown, strikes })
    }
  }

  const timedOut = Date.now() >= deadline
  const message = attempts.length
    ? 'every free API provider failed: ' + attempts.map(a => a.provider + ' (' + a.error + ')').join('; ')
    : 'no free API provider can serve ' + target
  throw new FreeTranslateError(message, timedOut ? 'api-timeout' : 'api-failed', attempts)
}
