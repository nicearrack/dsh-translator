# dsh-translator

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的有道风格划词翻译插件。

划选任意文本——会话消息、侧栏、输入框——选区右上角浮现悬浮 **「译」** 按钮，点击即弹出译文卡片。翻译由 **harness 自带的大模型**完成：无需 API key、不依赖第三方接口，选中的文本不会离开你已配置的模型管道。

| [English README](README.md) | 中文 |
|---|---|

## 使用

划选文本 → 点击选区右上角的「译」→ 译文卡片即出。按住卡片顶部可拖动；点「固定」可锁定它，避免被误关。点击译文（或原文、错误信息）即可复制。卡片底部显示翻译方向、所用模型、推理等级与 token 消耗。

## 功能

- 任意位置划词，悬浮按钮跟随选区右上角，自动适配深色/浅色主题
- 方向自动判断：选中的文字是配置的**主语言** → 翻译成英文；否则 → 翻译成主语言
- 主语言可配置：简体中文 / 繁體中文 / 日本語 / 한국어 / Русский（默认简体中文）
- 配置卡片（设置 → 插件 → 划词翻译）：主语言、模型（可指定，留空则跟随会话默认模型）、推理等级（off/low/high/max）、超时、最大输出 token、温度——每个字段带「已覆盖/恢复默认」，草稿式修改，保存/放弃修改
- 译文卡片：原文、方向、译文、失败重试；底部显示 模型 · 推理等级 · tokens
- 点击复制：译文、原文或错误信息，带「已复制」提示
- 可拖动卡片：按住卡片顶部拖走，松手停在那
- 可固定卡片：锁定后禁止拖动、Esc 与外部点击关闭，只能点关闭按钮；始终只有一张卡片，不会套娃
- 对流式输出稳定：不闪烁，卡片不随内容滚动而消失

## 截图

划选文本 → 选区右上角出现悬浮 **「译」** 按钮：

![划选文本与「译」按钮](screenshots/select-button.png)

点击 → 弹出译文卡片（英译中）：

![英译中译文卡片](screenshots/en-zh.png)

中译英方向自动判断：

![中译英译文卡片](screenshots/zh-en.png)

在 DSH 设置 → 插件 → 划词翻译 中配置：

![插件配置卡片](screenshots/config.png)

完整流程——划词、翻译、拖动、固定、关闭：

![演示录屏](recordings/demo.gif)

## 安装

从 npm：

```sh
dsh plugin --profile web add @nicearrack/dsh-translator@latest
```

从本地源码：

```sh
dsh plugin --profile web add /path/to/dsh-translator
```

从 git：

```sh
dsh plugin --profile web add github:nicearrack/dsh-translator
```

> git 安装会运行包的 `prepare` 构建脚本。pnpm ≥ 10 首次安装被拒时，需要在
> profile 的 `pnpm-workspace.yaml` 里加一次授权：
> `allowBuilds: { "@nicearrack/dsh-translator": true }`。

## 卸载

```sh
dsh plugin --profile web remove @nicearrack/dsh-translator
```

重启实例（`dsh --profile web`）后生效。

## License

[MIT](LICENSE)
