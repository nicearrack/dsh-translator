# dsh-translator

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的有道风格划词翻译插件。

划选任意文本——会话消息、侧栏、输入框——选区右上角浮现悬浮**翻译**按钮，点击即弹出译文卡片。翻译由 **harness 自带的大模型**完成：无需 API key、不依赖第三方接口，选中的文本不会离开你已配置的模型管道。

| [English README](README.md) | 中文 |
|---|---|

## 环境要求

需要 DSH **0.2.1-alpha.1 或更新版本**。本插件使用当前的插件规范：可热更新的
volatile `Config`（设置界面由 Host 渲染）、注册在受认证 `/api` 通道上的 exact
Fetch 路由，以及插件页自带的 bundle 配置席位。旧版 DSH 请继续使用
`dsh-translator@0.2.1`。

## 使用

划选文本 → 点击选区右上角的翻译按钮 → 译文卡片即出。按住卡片顶部可拖动；点「固定」可锁定它，避免被误关。点击译文（或原文、错误信息）即可复制。卡片底部显示翻译方向、所用模型、推理等级与 token 消耗。

## 功能

- 任意位置划词，悬浮按钮跟随选区右上角，自动适配深色/浅色主题
- 方向自动判断：选中的文字是配置的**主语言** → 翻译成英文；否则 → 翻译成主语言
- 主语言可配置：简体中文 / 繁體中文 / 日本語 / 한국어 / Русский（默认简体中文）
- 配置入口在插件页（侧栏 **插件** → 本 bundle 的卡片，进去即可设置，无需再进一层）：主语言、模型（可指定，留空则跟随会话默认模型）、推理等级（off/low/high/max）、超时、最大输出 token、温度——每个字段带「已覆盖/恢复默认」，草稿式修改，保存/放弃修改；改动对下一次翻译立即生效，无需重启
- 译文卡片：原文、方向、译文、失败重试；底部显示 模型 · 推理等级 · tokens
- 点击复制：译文、原文或错误信息，带「已复制」提示
- 可拖动卡片：按住卡片顶部拖走，松手停在那
- 可固定卡片：锁定后禁止拖动、Esc 与外部点击关闭，只能点关闭按钮；始终只有一张卡片，不会套娃
- 对流式输出稳定：不闪烁，卡片不随内容滚动而消失

## 截图

划选文本 → 选区右上角出现悬浮**翻译**按钮：

![划选文本与翻译按钮](screenshots/select-button.png)

点击 → 弹出译文卡片（英译中）：

![英译中译文卡片](screenshots/en-zh.png)

中译英方向自动判断：

![中译英译文卡片](screenshots/zh-en.png)


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

## 更新

```sh
# 更新到最新版
dsh plugin --profile web update @nicearrack/dsh-translator

# 或指定版本
dsh plugin --profile web update @nicearrack/dsh-translator@0.3.0
```

> **刚发布的版本**：npm 元数据在发布后有一定的传播延迟（几分钟到更久）。若
> `@latest` 仍解析到旧版本，请钉住具体版本（`@nicearrack/dsh-translator@0.3.0`），
> 也可用 `npm view @nicearrack/dsh-translator versions` 查看可用版本。
>
> 更新后请重启 DSH 实例（`dsh --profile web`）以加载新的 host 包；客户端包在
> 下次刷新页面时生效。

## 卸载

```sh
dsh plugin --profile web remove @nicearrack/dsh-translator
```

重启实例（`dsh --profile web`）后生效。

## License

[MIT](LICENSE)
