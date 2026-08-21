# dsh-translator

Youdao-style word-selection translation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Select any text — a conversation message, the sidebar, an input field — and a floating **「译」** button appears at the selection's top-right corner. Click it to get a translation card. Translations are produced by **the harness's own LLM**: no API keys, no third-party endpoints, your selected text never leaves the model pipeline you already configured.

| English | [中文 README](README.zh.md) |
|---|---|

## Usage

Select text → click the **「译」** button at the selection's top-right corner → the translation card appears. That's it.

## Features

- Word-selection trigger anywhere in the app; floating button follows the selection, theme-aware (light/dark)
- Automatic direction detection (Chinese → English, everything else → Simplified Chinese)
- Translation card with source, direction badge, result, and retry on failure; dismiss with Esc / click-outside / scroll
- Uses your configured default model — zero extra configuration

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
