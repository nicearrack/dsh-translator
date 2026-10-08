# dsh-translator

Youdao-style word-selection translation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Select any text — a conversation message, the sidebar, an input field — and a floating **translate** button appears at the selection's top-right corner. Click it to get a translation card. Translations are produced by **the harness's own LLM**: no API keys, no third-party endpoints, your selected text never leaves the model pipeline you already configured.

| English | [中文 README](README.zh.md) |
|---|---|

## Requirements

DSH **0.2.1-alpha.1 or newer**. The plugin uses the current plugin contract: a
volatile `Config` the Host renders itself, an exact Fetch route on the
authenticated `/api` channel, and the Plugins page's own bundle-configuration
seat. On older DSH releases, stay on `dsh-translator@0.2.1`.

## Usage

Select text → click the floating **translate** button → the translation card appears. Drag the card by its header to move it, or pin it so it can't be dismissed by accident. Click the translation (or the source text, or an error message) to copy it. The card's footer shows the translation direction, the model, the reasoning effort, and the token consumption.

## Features

- Word-selection trigger anywhere in the app; floating button follows the selection, theme-aware (light/dark)
- Automatic direction: text in your configured **primary language** → English; anything else → the primary language
- Primary language configurable: 简体中文 / 繁體中文 / 日本語 / 한국어 / Русский (default 简体中文)
- Configuration on the Plugins page (sidebar **Plugins** → this bundle's card — the form is right there, no extra step): primary language, model (pick one, or leave it empty to follow the session default model), reasoning effort (off/low/high/max), timeout, max tokens, temperature — each field shows "overridden / restore default", with staged edits and save/discard. Changes apply to the next translation without restarting anything.
- Translation card: source, direction badge, result, retry on failure; the footer shows model · reasoning effort · tokens
- Click to copy: translation, source text, or error message — with a "已复制 / Copied" hint
- Draggable card: drag it by its header; it stays where you put it
- Pinnable card: locks drag, Esc and click-outside until you close it — one card at a time, no nesting
- Streaming-robust: works on live streaming output (no flicker), and the card stays put when the content scrolls

## Screenshots

Select text → the floating **translate** button appears at the selection's top-right corner:

![Selecting text and the floating translate button](screenshots/select-button.png)

Click it → the translation card opens (English → Chinese):

![Translation card EN → ZH](screenshots/en-zh.png)

Chinese → English direction is automatic:

![Translation card ZH → EN](screenshots/zh-en.png)


## Install

From npm:

```sh
dsh plugin --profile web add @nicearrack/dsh-translator@latest
```

From a local checkout:

```sh
dsh plugin --profile web add /path/to/dsh-translator
```

From git:

```sh
dsh plugin --profile web add github:nicearrack/dsh-translator
```

> Git installs run the package's `prepare` build script. pnpm ≥ 10 requires
> one-time authorization: add `allowBuilds: { "@nicearrack/dsh-translator": true }`
> to the profile's `pnpm-workspace.yaml` if the first install is refused.

## Update

```sh
# update to the newest release
dsh plugin --profile web update @nicearrack/dsh-translator

# or pin a specific version
dsh plugin --profile web update @nicearrack/dsh-translator@0.3.0
```

> **Fresh releases**: npm registry metadata can lag after a publish (a few
> minutes, occasionally longer). If `@latest` still resolves to an older
> version, pin the exact one — `@nicearrack/dsh-translator@0.3.0` — or check
> `npm view @nicearrack/dsh-translator versions`.
>
> After updating, restart the DSH instance (`dsh --profile web`) so the new
> host bundle loads; the client bundle picks up on the next page refresh.

## Uninstall

```sh
dsh plugin --profile web remove @nicearrack/dsh-translator
```

Restart the instance (`dsh --profile web`) for the removal to take effect.

## License

[MIT](LICENSE)
