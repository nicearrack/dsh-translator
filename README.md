# dsh-translator

Youdao-style word-selection translation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Select any text — a conversation message, the sidebar, an input field — and a floating **translate** button appears at the selection's top-right corner. Click it to get a translation card. Two engines, switchable on the Plugins page:

- **Free API** (default) — public translation endpoints that need **no account and no API key**. Nothing to configure: install it and translate. Requests walk a fallback chain, so one unavailable endpoint does not break the feature.
- **Model** — the harness's own LLM, exactly as in the 0.3 line: no third-party endpoint, your text stays inside the model pipeline you already configured.

| English | [中文 README](README.zh.md) |
|---|---|

## Requirements

DSH **0.2.1-alpha.1 or newer**. The plugin uses the current plugin contract: a
volatile `Config` the Host renders itself, an exact Fetch route on the
authenticated `/api` channel, and the Plugins page's own bundle-configuration
seat. On older DSH releases, stay on `dsh-translator@0.2.1`.

## Usage

Select text → click the floating **translate** button → the translation card appears. Drag the card by its header to move it, or pin it so it can't be dismissed by accident. Click the translation (or the source text, or an error message) to copy it. The card's footer shows the translation direction and which engine answered.

## Features

- Word-selection trigger anywhere in the app; floating button follows the selection, theme-aware (light/dark)
- Automatic direction: text in your configured **primary language** → English; anything else → the primary language
- Primary language configurable: 简体中文 / 繁體中文 / 日本語 / 한국어 / Русский (default 简体中文)
- Configuration on the Plugins page (sidebar **Plugins** → this bundle's card — the form is right there, no extra step). The **engine** decides what the rest of the form shows: choosing **Free API** renders only the primary language, the API service and the timeout — the model, reasoning effort, max-tokens and temperature controls are not shown at all, because nothing on that path reads them. Choosing **Model** swaps in the model controls. Each field shows "overridden / restore default", with staged edits and save/discard. Changes apply to the next translation without restarting anything.
- Free API service selectable: **Automatic** (recommended) or a specific endpoint — Tencent, Microsoft Bing, Volcengine, MyMemory
- Translation card: source, direction badge, result, retry on failure; the footer names the engine — the model, reasoning effort and tokens for **Model**, the endpoint that answered for **Free API**
- Click to copy: translation, source text, or error message — with a "已复制 / Copied" hint
- Draggable card: drag it by its header; it stays where you put it
- Pinnable card: locks drag, Esc and click-outside until you close it — one card at a time, no nesting
- Streaming-robust: works on live streaming output (no flicker), and the card stays put when the content scrolls

## The free API engine

The default engine reaches public endpoints run by Tencent, Microsoft, Volcengine and MyMemory. **None of them requires registration, an API key or a token** — the temporary signature Microsoft's endpoint wants is minted by the plugin on the fly and never stored. Requests go out from the DSH host process, not the browser, so there is no CORS negotiation and no ambient cookie is sent.

Automatic mode tries Tencent → Microsoft Bing → Volcengine → MyMemory and returns the first usable answer. A provider that fails is benched for five minutes so one dead endpoint cannot make every later translation wait out its timeout. An answer that merely echoes the input back is rejected rather than displayed: some endpoints reply HTTP 200 with the source text for a direction they cannot serve.

Worth knowing before you rely on it:

- These are **undocumented web endpoints, not official APIs**. They carry no SLA and can change or disappear without notice. That is exactly why the chain exists; if all of them are unavailable the card says so and suggests switching to the **Model** engine.
- **Your selected text leaves the machine** and is sent to whichever provider answers. If that is not acceptable, use the **Model** engine.
- Rate limits, daily quotas (MyMemory allows roughly 5000 characters a day anonymously) and per-request length caps belong to each provider and still apply. Translations are capped at 2000 characters client-side.
- Reaching some of these endpoints depends on your network. The chain was verified from a mainland-China network, where Google's endpoint is unreachable and is therefore not part of it.

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

> Git installs need **no build step and no pnpm `allowBuilds` entry**. The built
> Host and Client halves are committed, so the package is usable exactly as it is
> checked out — pnpm never has to run a script. (pnpm ≥ 10 refuses `prepare` on a
> git dependency unless `allowBuilds` lists it under a key containing the
> resolved URL *and commit hash*, which is why the build output is committed
> instead.)

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
