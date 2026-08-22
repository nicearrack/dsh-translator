# dsh-translator

Youdao-style word-selection translation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Select any text — a conversation message, the sidebar, an input field — and a floating **「译」** button appears at the selection's top-right corner. Click it to get a translation card. Translations are produced by **the harness's own LLM**: no API keys, no third-party endpoints, your selected text never leaves the model pipeline you already configured.

| English | [中文 README](README.zh.md) |
|---|---|

## Usage

Select text → click the **「译」** button at the selection's top-right corner → the translation card appears. Drag the card by its header to move it, or pin it so it can't be dismissed by accident.

## Features

- Word-selection trigger anywhere in the app; floating button follows the selection, theme-aware (light/dark)
- Automatic direction detection (Chinese → English, everything else → Simplified Chinese)
- Translation card with source, direction badge, result, and retry on failure; dismiss with Esc / click-outside
- Draggable card: drag it by its header to move it out of the way — it stays where you put it
- Pinnable card: lock it in place (drag / Esc / click-outside disabled) until you close it — only one card at a time, so no nesting
- Streaming-robust: works on live streaming output (no flicker), and the card stays put when the content scrolls
- Uses your configured default model — zero extra configuration

## Screenshots

Select text → the floating **「译」** button appears at the selection's top-right corner:

![Selecting text and the 译 button](screenshots/select-button.png)

Click it → the translation card opens (English → Chinese):

![Translation card EN → ZH](screenshots/en-zh.png)

Chinese → English direction is automatic:

![Translation card ZH → EN](screenshots/zh-en.png)

Full workflow — select, translate, drag, pin, close:

![Demo recording](recordings/demo.gif)

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

## Uninstall

```sh
dsh plugin --profile web remove @nicearrack/dsh-translator
```

Restart the instance (`dsh --profile web`) for the removal to take effect.

## License

[MIT](LICENSE)
