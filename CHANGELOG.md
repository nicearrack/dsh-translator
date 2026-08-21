# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-08-21

The first released version — the exact package that passed the 17/17 automated
stability suite against the live DSH web GUI.

### Added

- **Word-selection trigger**: selecting any non-empty text (conversation,
  sidebar, inputs, textareas) surfaces a floating 「译」 button at the
  selection's top-right corner (viewport-clamped; flips below when there is no
  room above).
- **Translation card**: source text (3-line clamp), direction badge
  (→ 中文 / → English), translated result, loading state, error state with a
  retry button, and a close button. Esc, click-outside, and scrolling dismiss
  the UI.
- **Harness-native translation**: calls `ctx.llm.stream()` with the user's
  default model (`agentDefaultModel.currentSelection()`, with a fallback to the
  first registered provider/model). No API keys, no third-party endpoints.
- **Direction heuristic**: text containing CJK translates to English; anything
  else translates to Simplified Chinese.
- **Robustness**:
  - 30 s timeout (timer-break closes the stream), 1024 max tokens with a
    "possibly truncated" notice instead of a hard failure on `max-tokens`.
  - `translate-cancel` RPC (seq-matched) cancels in-flight model calls when the
    card is dismissed; stale responses are dropped client-side.
  - `inflight` bookkeeping is cleared on every path (including model-selection
    failures).
  - Selection inside the plugin's own UI never re-triggers the button.
- **Stability suite**: 17 automated Playwright scenarios against the live GUI
  (positioning, both directions, long text, input selection, rapid clicks,
  cancel-on-close, scroll hiding, in-card selection, empty selection, refresh
  recovery). See `stability/`.
- **Packaged bundle** (`@nicearrack/dsh-translator`): `dsh.bundle` +
  `dsh.client` manifest, `cordis.patch.yml` layer, packaged Host half
  (`src/index.js`, webServer HTTP API at `/translator/api`) and a
  client-modules bundle (`client/core.js` → `lib/client.js`, built by
  `scripts/build.js`, run as `prepare` on install). Installable via
  `dsh plugin --profile <name> add @nicearrack/dsh-translator` (npm / local
  checkout / git). Host route logic covered by `npm run test:host`.

### Fixed

- Card placed above the selection no longer leaves a large blank gap — the
  position is snapped to the measured height after render.
- Selecting text inside an input/textarea anchors the floating button to the
  selected text (mirror measurement), not the field's top-right corner.
- The floating button hides once the card opens (one-shot trigger) and
  returns when the card is closed while the selection is still alive.
- Packaged client: the style-injection effect now returns its disposer
  (previously removed the `<style>` element immediately, leaving the UI
  unstyled at the overlay's top-left corner).

### Known limitations (by design)

- Dynamic Cordis plugins are process-local: a DSH restart clears the plugin,
  and a page refresh unloads the Client half until the next dispatch (model
  `cordis_run` or the Cordis panel run control).
- Direct `ctx.llm.stream()` callers get a single attempt; transient model
  failures surface in the card with a retry button.
