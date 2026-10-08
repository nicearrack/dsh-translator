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

const EXPORTS = '{ apply, inject, settingsOps, PACKAGE_NAME, SETTINGS_NS, TranslatorSettings, SettingsForm, SettingsSummary, TranslatorRoot, I18N, CONFIG_PATHS }'

/** The section the Host resolves for this entry: schema defaults with no override. */
const SAMPLE_VALUE = {
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
    'Primary language', 'Model', 'Reasoning effort', 'Max tokens', 'Timeout (ms)', 'Temperature',
    'Save', 'Discard changes', "Leave both empty to use the session's default model",
  ]) {
    assert.ok(texts.includes(label), `rendered label: ${label}`)
  }

  // The summary view carries the same seat and no form chrome.
  const summaryReact = makeReact()
  const summaryCore = loadCore(fakeDocument(), summaryReact)
  assert.doesNotThrow(() => summaryCore.SettingsSummary({ view: 'summary', form, t: seat(summaryCore, 'en') }))
  assert.ok(renderedText(summaryReact).some(text => text.includes('Session default')))

  // The dispatcher and the overlay render with the same seat without throwing.
  assert.doesNotThrow(() => summaryCore.TranslatorSettings({ view: 'summary', form, t: seat(summaryCore, 'en') }))
  assert.doesNotThrow(() => summaryCore.TranslatorRoot({ t: seat(summaryCore, 'en') }))
  // A runtime that forwards no seat falls back to the built-in dictionary.
  assert.doesNotThrow(() => summaryCore.TranslatorRoot({}))
})
