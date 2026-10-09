// dsh-translator Client half regression suite. Run: npm test  (node --test tests/)
//
// The Client core runs in the browser bundle factory, so this suite evaluates
// it with a minimal React/document stub. It asserts the two things that are
// ours to get right without a browser:
//
//   1. WHERE the plugin contributes: the shell.overlay entry and the
//      `plugins.row.config` cell keyed "<package>#<row id>" the Plugins page
//      dispatches, plus the locale dictionary the `t` seat reads.
//   2. WHAT a save writes: one path op per changed field, never the
//      non-volatile `customModel` container, which the Host refuses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config } from '../src/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client/core.js'), 'utf8')

const EXPORTS = '{ apply, inject, settingsOps, PACKAGE_NAME, SETTINGS_NS, TranslatorSettings, SettingsForm, SettingsSummary, TranslatorRoot, I18N, CONFIG_PATHS, API_PROVIDER_IDS, failureDetail }'

/** The section the Host resolves for this entry: schema defaults with no override. */
const SAMPLE_VALUE = {
  engine: 'api',
  apiProvider: 'auto',
  primaryLanguage: 'zh-Hans',
  customModel: { provider: '', model: '' },
  reasoningEffort: 'low',
  timeoutMs: 30000,
  maxTokens: 1024,
  temperature: 0.3,
}

/** A `ConfigForm` as `ctx.configForms.get(ns)` hands it out. */
function makeForm(value = SAMPLE_VALUE) {
  const state = { status: 'ready', value, base: value, user: {}, revision: 3, writable: true, mode: 'host' }
  return { getSnapshot: () => state, subscribe: () => () => {}, mutate: async () => true, state }
}

/** Minimal React that records elements, so rendered text is assertable. */
function makeReact() {
  const seen = []
  return {
    seen,
    createElement(type, props, ...children) {
      const element = { type, props, children }
      seen.push(element)
      return element
    },
    createContext: value => ({ Provider: props => props.children, value }),
    useContext: () => ({}),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
}

/** Every string rendered under the recorded elements. */
function renderedText(react) {
  const walk = (child) => {
    if (typeof child === 'string') return [child]
    if (Array.isArray(child)) return child.flatMap(walk)
    if (child !== null && typeof child === 'object' && Array.isArray(child.children)) return child.children.flatMap(walk)
    return []
  }
  return react.seen.flatMap(element => element.children.flatMap(walk))
}

/** The `Translate` seat the slot framework hands a registration that declares `locale`. */
function seat(core, locale = 'en') {
  return key => core.I18N[locale][key]
}

/** A document stub that records style elements so disposal is observable. */
function fakeDocument() {
  const head = {
    children: [],
    appendChild(el) { this.children.push(el) },
  }
  return {
    head,
    body: { appendChild() {}, removeChild() {} },
    createElement: () => ({
      style: {},
      textContent: '',
      remove() {
        const index = head.children.indexOf(this)
        if (index >= 0) head.children.splice(index, 1)
      },
    }),
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    activeElement: null,
  }
}

/** Evaluate the bundle core with the stubs and hand back the named internals. */
function loadCore(documentStub, react = makeReact()) {
  // eslint-disable-next-line no-new-func -- the bundle core is a browser script body, not a module.
  const factory = new Function('require', 'document', 'window', `${source}\n;return ${EXPORTS}`)
  return factory(spec => spec === 'react' ? react : (() => { throw new Error('unexpected require: ' + spec) })(), documentStub, {})
}

test('client: injects slots + locale + configForms and contributes both seats', () => {
  const documentStub = fakeDocument()
  const core = loadCore(documentStub)
  assert.deepEqual([...core.inject].sort(), ['configForms', 'locale', 'slots'])

  const form = makeForm()
  const disposers = []
  const injections = []
  const registrations = []
  const dictionaries = []
  const watched = []
  const ctx = {
    effect: (fn) => { const dispose = fn(); disposers.push(dispose); return dispose },
    slots: {
      inject: (key, callback) => { injections.push(key); callback(); return () => {} },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
    locale: { register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} } },
    configForms: {
      get: (ns) => { assert.equal(ns, core.SETTINGS_NS); return form },
      whileServed: (namespaces, register) => { watched.push([...namespaces]); register(new Set(namespaces)); return () => {} },
    },
  }

  core.apply(ctx)

  assert.equal(documentStub.head.children.length, 1, 'one stylesheet is injected')
  assert.deepEqual([...injections].sort(), ['plugins.bundle.config', 'shell.overlay'])
  assert.deepEqual(dictionaries.map(entry => entry.ns), ['dsh-translator'])
  assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), ['en', 'zh'])
  // The page appears only while the Host serves the entry the form belongs to.
  assert.deepEqual(watched, [[core.SETTINGS_NS]])

  const bySlot = new Map(registrations.map(entry => [entry.options.name, entry]))
  assert.deepEqual(bySlot.get('shell.overlay').options, {
    name: 'shell.overlay', id: 'dsh-translator-overlay', locale: 'dsh-translator',
  })
  // One click from the Plugins list: the bundle's own page, keyed by its name.
  assert.deepEqual(bySlot.get('plugins.bundle.config').options, {
    name: 'plugins.bundle.config', key: core.PACKAGE_NAME, locale: 'dsh-translator',
  })
  assert.equal(core.PACKAGE_NAME, '@nicearrack/dsh-translator')
  for (const entry of registrations) assert.equal(typeof entry.component, 'function')
  // The registered component receives the shared entry form, since this seat
  // passes no `form` prop of its own.
  const bound = bySlot.get('plugins.bundle.config').component({ view: 'summary' })
  assert.equal(typeof bound, 'object')

  // Fiber teardown removes the stylesheet it injected.
  disposers[0]()
  assert.equal(documentStub.head.children.length, 0)
})

test('client: a save writes leaf paths, never the customModel container', () => {
  const core = loadCore(fakeDocument())
  const base = {
    engine: 'model',
    apiProvider: 'auto',
    primaryLanguage: 'zh-Hans',
    customModel: { provider: '', model: '' },
    reasoningEffort: 'low',
    timeoutMs: 30000,
    maxTokens: 1024,
    temperature: 0.3,
  }
  const value = JSON.parse(JSON.stringify(base))
  const draft = JSON.parse(JSON.stringify(base))
  draft.customModel = { provider: 'local', model: 'm1' }
  draft.maxTokens = 2048

  const ops = core.settingsOps(draft, value, base, {})
  assert.deepEqual(ops, [
    { op: 'set', path: ['customModel', 'provider'], value: 'local' },
    { op: 'set', path: ['customModel', 'model'], value: 'm1' },
    { op: 'set', path: ['maxTokens'], value: 2048 },
  ])
  assert.equal(ops.some(op => op.path.length === 1 && op.path[0] === 'customModel'), false)
})

test('client: resetting a field clears it back to its layer', () => {
  const core = loadCore(fakeDocument())
  const base = {
    engine: 'model',
    apiProvider: 'auto',
    primaryLanguage: 'zh-Hans',
    customModel: { provider: '', model: '' },
    reasoningEffort: 'low',
    timeoutMs: 30000,
    maxTokens: 1024,
    temperature: 0.3,
  }
  const value = JSON.parse(JSON.stringify(base))
  value.maxTokens = 4096
  value.reasoningEffort = 'max'
  // The draft is back at the layer for both fields.
  const ops = core.settingsOps(base, value, base, {})
  assert.deepEqual(ops, [
    { op: 'unset', path: ['reasoningEffort'] },
    { op: 'unset', path: ['maxTokens'] },
  ])
})

test('client: resetting the model clears both of its leaves', () => {
  const core = loadCore(fakeDocument())
  const base = {
    engine: 'model',
    apiProvider: 'auto',
    primaryLanguage: 'zh-Hans',
    customModel: { provider: '', model: '' },
    reasoningEffort: 'low',
    timeoutMs: 30000,
    maxTokens: 1024,
    temperature: 0.3,
  }
  const value = JSON.parse(JSON.stringify(base))
  value.customModel = { provider: 'local', model: 'm1' }
  const ops = core.settingsOps(base, value, base, {})
  assert.deepEqual(ops, [
    { op: 'unset', path: ['customModel', 'provider'] },
    { op: 'unset', path: ['customModel', 'model'] },
  ])
})

test('client: an unchanged field with a stale user entry is cleaned in the same write', () => {
  const core = loadCore(fakeDocument())
  const base = {
    engine: 'model',
    apiProvider: 'auto',
    primaryLanguage: 'zh-Hans',
    customModel: { provider: '', model: '' },
    reasoningEffort: 'low',
    timeoutMs: 30000,
    maxTokens: 1024,
    temperature: 0.3,
  }
  const value = JSON.parse(JSON.stringify(base))
  const ops = core.settingsOps(base, value, base, { temperature: 0.3, customModel: { model: '' } })
  assert.deepEqual(ops, [
    { op: 'unset', path: ['customModel', 'model'] },
    { op: 'unset', path: ['temperature'] },
  ])
  assert.deepEqual(core.settingsOps(base, value, base, {}), [], 'nothing to write when nothing is stale')
})

test('client: the fields the form writes are exactly the schema\'s volatile leaves', () => {
  // The Host's settings transport exposes an entry only when its Config has a
  // volatile field, and it accepts a write only under a volatile path. So the
  // form's paths and the schema's volatile leaves must be the same set — a
  // write to the `customModel` container, for one, would be refused.
  const core = loadCore(fakeDocument())
  const json = JSON.parse(JSON.stringify(Config.toJSON()))
  const leaves = []
  const visit = (node, path) => {
    if (typeof node === 'number') node = json.refs[String(node)]
    if (node === null || typeof node !== 'object') return
    if (node.meta && node.meta.volatile === true) { leaves.push(path.join('.')); return }
    for (const [key, child] of Object.entries(node.dict || {})) visit(child, [...path, key])
  }
  visit(json.uid, [])

  const written = core.CONFIG_PATHS.map(path => path.join('.'))
  assert.deepEqual([...written].sort(), [...leaves].sort())
  assert.equal(written.includes('customModel'), false, 'the container is not volatile')
})

/** The recorded options of the one select whose values match exactly. */
function selectOptions(react, values) {
  const wanted = values.join('|')
  for (const element of react.seen) {
    const options = element.props && element.props.options
    if (Array.isArray(options) && options.map(o => o.value).join('|') === wanted) return options
  }
  return null
}

test('client: the page view renders localized labels through the function seat', () => {
  // The framework hands a registration that declares `locale` a `Translate`
  // FUNCTION, not a dictionary: reading `t.model` instead of `t('model')`
  // would render nothing at all, which this test would catch.
  const react = makeReact()
  const core = loadCore(fakeDocument(), react)
  const form = makeForm()

  assert.doesNotThrow(() => core.SettingsForm({ view: 'page', form, t: seat(core, 'en') }))
  const texts = renderedText(react)
  for (const label of [
    'Engine', 'Primary language', 'Translation service', 'Timeout (ms)',
    'Save', 'Discard changes',
    'Public free endpoints — no key to enter. Selected text is sent to a third-party translation service.',
  ]) {
    assert.ok(texts.includes(label), `rendered label: ${label}`)
  }

  // The two selects the api engine owns carry the localized labels as options.
  const engineOptions = selectOptions(react, ['api', 'model'])
  assert.deepEqual(engineOptions.map(o => o.label), ['Free API (recommended)', 'Model'])
  const providerOptions = selectOptions(react, ['auto', 'tencent', 'bing', 'volcengine', 'mymemory'])
  assert.deepEqual(providerOptions.map(o => o.label), [
    'Automatic (recommended)', 'Tencent', 'Microsoft Bing', 'Volcengine', 'MyMemory',
  ])

  // The dispatcher and the overlay render with the same seat without throwing.
  assert.doesNotThrow(() => core.TranslatorSettings({ view: 'summary', form, t: seat(core, 'en') }))
  assert.doesNotThrow(() => core.TranslatorRoot({ t: seat(core, 'en') }))
  // A runtime that forwards no seat falls back to the built-in dictionary.
  assert.doesNotThrow(() => core.TranslatorRoot({}))
})

test('client: the api engine hides every model-only control', () => {
  const react = makeReact()
  const core = loadCore(fakeDocument(), react)
  core.SettingsForm({ view: 'page', form: makeForm(JSON.parse(JSON.stringify(SAMPLE_VALUE))), t: seat(core, 'en') })
  const texts = renderedText(react)

  // None of these is read on the free-API path, so none of them may appear.
  for (const label of ['Model', 'Reasoning effort', 'Max tokens', 'Temperature']) {
    assert.equal(texts.includes(label), false, `api mode must not render: ${label}`)
  }
  assert.equal(texts.includes('Session default'), false)
})

test('client: the model engine renders every model-only control', () => {
  const react = makeReact()
  const core = loadCore(fakeDocument(), react)
  const value = JSON.parse(JSON.stringify(SAMPLE_VALUE))
  value.engine = 'model'
  core.SettingsForm({ view: 'page', form: makeForm(value), t: seat(core, 'en') })
  const texts = renderedText(react)

  for (const label of [
    'Model', 'Reasoning effort', 'Max tokens', 'Timeout (ms)', 'Temperature',
    'Save', 'Discard changes', "Leave both empty to use the session's default model",
  ]) {
    assert.ok(texts.includes(label), `rendered label: ${label}`)
  }
  // The free-API-only control is gone in the other direction.
  assert.equal(texts.includes('Translation service'), false)
  assert.equal(selectOptions(react, ['auto', 'tencent', 'bing', 'volcengine', 'mymemory']), null)
})

test('client: switching the engine writes exactly one path', () => {
  const core = loadCore(fakeDocument())
  const base = { engine: 'api', apiProvider: 'auto', primaryLanguage: 'zh-Hans', customModel: { provider: '', model: '' }, reasoningEffort: 'low', timeoutMs: 30000, maxTokens: 1024, temperature: 0.3 }
  const draft = JSON.parse(JSON.stringify(base))
  draft.engine = 'model'
  assert.deepEqual(core.settingsOps(draft, base, base, {}), [
    { op: 'set', path: ['engine'], value: 'model' },
  ])
  // Choosing a specific provider is likewise one volatile leaf.
  const draft2 = JSON.parse(JSON.stringify(base))
  draft2.apiProvider = 'bing'
  assert.deepEqual(core.settingsOps(draft2, base, base, {}), [
    { op: 'set', path: ['apiProvider'], value: 'bing' },
  ])
})

test('client: every provider the form offers is one the Host schema accepts', () => {
  // The select's options and the schema's union are declared in two places.
  // A provider added to one and not the other would be offered by the form and
  // then refused on save, so the two lists are pinned to each other here.
  const core = loadCore(fakeDocument())
  assert.equal(core.API_PROVIDER_IDS[0], 'auto', 'Automatic is offered first')
  for (const id of core.API_PROVIDER_IDS) {
    assert.doesNotThrow(() => Config({ apiProvider: id }), `the Host accepts apiProvider=${id}`)
  }
  const defined = Object.keys(core.I18N.en).filter(key => key.startsWith('provider'))
  assert.deepEqual(
    defined.sort(),
    core.API_PROVIDER_IDS.map(id => 'provider' + id.charAt(0).toUpperCase() + id.slice(1)).sort(),
    'every offered provider has a localized label',
  )
})

/** The data-attribute names of the footer's rendered children, in DOM order. */
function footerMarks(react) {
  const footer = react.seen.find(el => el.props && el.props['data-dsh-translator-settings-footer'] !== undefined)
  assert.ok(footer, 'the settings footer rendered')
  return footer.children.map((child) => {
    if (child === null || typeof child !== 'object' || !child.props) return null
    if (child.props['data-dsh-translator-settings-discard'] !== undefined) return 'discard'
    if (child.props['data-dsh-translator-settings-save'] !== undefined) return 'save'
    if (child.props['data-dsh-translator-settings-status'] !== undefined) return 'status'
    return null
  }).filter(Boolean)
}

test('client: the footer leads with the actions and trails the status', () => {
  // The actions sit on the left, so they must come first in DOM order too:
  // visual order and tab order have to agree.
  const react = makeReact()
  const core = loadCore(fakeDocument(), react)
  core.SettingsForm({ view: 'page', form: makeForm(), t: seat(core, 'en') })
  assert.deepEqual(footerMarks(react), ['discard', 'save'])

  // When there is something to report it belongs after the buttons, on the
  // right. A read-only connection is the one status a fresh form shows.
  const roReact = makeReact()
  const roCore = loadCore(fakeDocument(), roReact)
  const roForm = makeForm()
  roForm.state.writable = false
  roCore.SettingsForm({ view: 'page', form: roForm, t: seat(roCore, 'en') })
  assert.deepEqual(footerMarks(roReact), ['discard', 'save', 'status'])
})

test('client: a Host that predates the engine field falls back to the model form', () => {
  // A `link:` install reads the Host half at instance startup. Updating the
  // bundle on disk and refreshing only the page leaves a new client talking to
  // an old schema, whose resolved section carries no `engine`. The form must
  // then show what that Host can actually store, not two blank selects whose
  // writes would be refused.
  const react = makeReact()
  const core = loadCore(fakeDocument(), react)
  const value = JSON.parse(JSON.stringify(SAMPLE_VALUE))
  delete value.engine
  delete value.apiProvider
  core.SettingsForm({ view: 'page', form: makeForm(value), t: seat(core, 'en') })
  const texts = renderedText(react)

  assert.equal(selectOptions(react, ['api', 'model']), null, 'no engine select')
  assert.equal(selectOptions(react, ['auto', 'tencent', 'bing', 'volcengine', 'mymemory']), null, 'no service select')
  assert.equal(texts.includes('Engine'), false)
  assert.equal(texts.includes('Translation service'), false)
  // The engine this Host does understand is shown, plus the reason.
  for (const label of ['Model', 'Reasoning effort', 'Max tokens', 'Temperature']) {
    assert.ok(texts.includes(label), `rendered label: ${label}`)
  }
  assert.ok(texts.some(text => text.includes('restart it')), 'the reason is stated')

  // The summary must not advertise an engine the Host cannot run either.
  const summary = makeReact()
  const summaryCore = loadCore(fakeDocument(), summary)
  summaryCore.SettingsSummary({ view: 'summary', form: makeForm(value), t: seat(summaryCore, 'en') })
  const summaryText = renderedText(summary).join(' ')
  assert.equal(summaryText.includes('Free API'), false)
  assert.ok(summaryText.includes('Session default'))
})

test('client: the summary names the engine that will actually run', () => {
  const api = makeReact()
  const apiCore = loadCore(fakeDocument(), api)
  apiCore.SettingsSummary({ view: 'summary', form: makeForm(), t: seat(apiCore, 'en') })
  assert.ok(renderedText(api).some(text => text.includes('Free API (recommended)')))
  assert.ok(renderedText(api).some(text => text.includes('Automatic (recommended)')))

  const model = makeReact()
  const modelCore = loadCore(fakeDocument(), model)
  const value = JSON.parse(JSON.stringify(SAMPLE_VALUE))
  value.engine = 'model'
  modelCore.SettingsSummary({ view: 'summary', form: makeForm(value), t: seat(modelCore, 'en') })
  // With no model chosen the model engine falls back to the session default.
  assert.ok(renderedText(model).some(text => text.includes('Session default')))
})

test('client: a failed chain is explained through the dictionary, not the provider text', () => {
  const core = loadCore(fakeDocument())
  const t = key => core.I18N.zh[key]

  // A fully benched chain is named outright: nothing was even asked, so the
  // generic "endpoints are unavailable" would be actively misleading.
  assert.equal(
    core.failureDetail(t, [
      { provider: 'tencent', reason: 'benched', error: 'benched after an earlier failure' },
      { provider: 'bing', reason: 'benched', error: 'benched after an earlier failure' },
    ]),
    core.I18N.zh.errorApiBenched,
  )

  // A mixed chain names each provider with a translated reason, and never
  // leaks the raw English `error` string the Host attached.
  const mixed = core.failureDetail(t, [
    { provider: 'tencent', reason: 'failed', error: 'tencent: HTTP 500' },
    { provider: 'mymemory', reason: 'too-long', error: 'text exceeds 500 bytes' },
  ])
  assert.match(mixed, /腾讯交互翻译: 请求失败/)
  assert.match(mixed, /MyMemory: 文本过长/)
  assert.equal(mixed.includes('HTTP 500'), false)

  // Anything that is not a per-attempt record yields no second line at all.
  assert.equal(core.failureDetail(t, undefined), null)
  assert.equal(core.failureDetail(t, 'provider exploded'), null)
  assert.equal(core.failureDetail(t, []), null)
})
