# dsh-translator

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的有道风格划词翻译插件。

划选任意文本——会话消息、侧栏、输入框——选区右上角浮现悬浮**翻译**按钮，点击即弹出译文卡片。插件提供两个引擎，可在插件页随时切换：

- **免费 API**（默认）——公共翻译接口，**不需要账号、不需要 API key**，装完直接就能用；请求按降级链依次尝试，某一家不可用不会让功能失效。
- **大模型**——harness 自带的大模型，与 0.3 版行为一致：不依赖第三方接口，选中的文本不会离开你已配置的模型管道。

| [English README](README.md) | 中文 |
|---|---|

## 环境要求

需要 DSH **0.2.1-alpha.1 或更新版本**。本插件使用当前的插件规范：可热更新的
volatile `Config`（设置界面由 Host 渲染）、注册在受认证 `/api` 通道上的 exact
Fetch 路由，以及插件页自带的 bundle 配置席位。旧版 DSH 请继续使用
`dsh-translator@0.2.1`。

## 使用

划选文本 → 点击选区右上角的翻译按钮 → 译文卡片即出。按住卡片顶部可拖动；点「固定」可锁定它，避免被误关。点击译文（或原文、错误信息）即可复制。卡片底部显示翻译方向与本次实际使用的引擎。

## 功能

- 任意位置划词，悬浮按钮跟随选区右上角，自动适配深色/浅色主题
- 方向自动判断：选中的文字是配置的**主语言** → 翻译成英文；否则 → 翻译成主语言
- 主语言可配置：简体中文 / 繁體中文 / 日本語 / 한국어 / Русский（默认简体中文）
- 配置入口在插件页（侧栏 **插件** → 本 bundle 的卡片，进去即可设置，无需再进一层）。**引擎**决定表单显示哪些字段：选「免费 API」时只渲染主语言、API 服务与超时——模型、推理等级、最大输出 token、温度这些控件**完全不显示**，因为这条路径根本不读它们；选「大模型」时才换成模型相关控件。每个字段带「已覆盖/恢复默认」，草稿式修改，保存/放弃修改；改动对下一次翻译立即生效，无需重启
- 免费 API 服务可选：**自动（推荐）**，或指定某一家——腾讯交互翻译 / 微软 Bing / 火山翻译 / MyMemory
- 译文卡片：原文、方向、译文、失败重试；底部按引擎显示不同信息——「大模型」显示 模型 · 推理等级 · tokens，「免费 API」显示实际应答的那家服务
- 点击复制：译文、原文或错误信息，带「已复制」提示
- 可拖动卡片：按住卡片顶部拖走，松手停在那
- 可固定卡片：锁定后禁止拖动、Esc 与外部点击关闭，只能点关闭按钮；始终只有一张卡片，不会套娃
- 对流式输出稳定：不闪烁，卡片不随内容滚动而消失

## 关于「免费 API」引擎

默认引擎调用腾讯、微软、火山、MyMemory 的公共接口。它们**都不需要注册、API key 或 token**——微软接口要的临时签名由插件即时生成，不落盘、不复用用户凭据。请求由 DSH 的 Host 进程（Node）发出，不走浏览器，因此没有 CORS 协商，也不会带上任何浏览器 Cookie。

自动模式依次尝试 腾讯 → 微软 Bing → 火山 → MyMemory，返回第一个可用结果。失败的 provider 会被冷却 5 分钟，避免一个挂掉的接口让之后每次翻译都白等超时。**把原文回显当译文的结果会被丢弃**：实测有些接口对不支持的方向仍返回 HTTP 200，正文却是原文本身。

依赖它之前需要知道：

- 这些是**厂商网页端的内部接口，不是有文档、有 SLA 的官方 API**，可能随时变更或失效。降级链正是为此存在；全部不可用时卡片会明确提示，并建议切换到「大模型」引擎。
- **划选的文本会离开本机**，发送到实际应答的那家服务。若不可接受，请使用「大模型」引擎。
- 各家的限流、每日额度（MyMemory 匿名约 5000 字符/天）与单次长度上限依然生效；插件侧另把待翻译文本截断到 2000 字符。
- 可用性取决于你的网络。本插件的降级链是在中国大陆网络下实测确定的——Google 的接口在该网络下不可达，因此不在链中。

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

> git 安装**不需要任何构建步骤，也不需要 pnpm 的 `allowBuilds` 授权**。构建好的
> Host / Client 两半已随仓库提交，检出即可用——pnpm 完全不需要执行脚本。（pnpm ≥ 10
> 会拒绝 git 依赖的 `prepare`，除非 `allowBuilds` 里列出包含**解析后 URL 与 commit
> 哈希**的完整键——所以才改成直接提交构建产物。）

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

## 开发

`npm test` 跑的是 Node 套件（`tests/host.test.mjs`、`tests/client.test.mjs`）—— 不用浏览器、不联网，两秒内跑完。它们用 mock 的 `fetch` 驱动打包后的 Host 半边走真实的 `/api` 路由，并用一个**假 React** 求值 `client/core.js`。

这个「假 React」就是它的边界：它只记录 element，**从不调用嵌套组件**，所以看不到真实渲染、划选 → 按钮 → 卡片的交互、拖拽/固定、CSS，也走不了真正的认证往返。这一层由 `tests/client.smoke.mjs` 在真实浏览器里覆盖。它是**按需运行**的，因为它需要一些 `npm test` 不该依赖的东西：

```sh
npm i -D playwright && npx playwright install chromium

# 另开一个加载了本插件的 DSH 实例，例如
pnpm dsh web --patch /path/to/dsh-translator/dev.patch.yml --port 3210 --no-open

npm run test:smoke -- "http://127.0.0.1:3210/?token=XXXX"
```

它是只读的：不保存、不切语言、不写设置 —— 只会往草稿里输入以观察「已覆盖」标记的实时反应，然后关掉页面。

`npm run screenshots -- "<带 token 的 url>"` 用于重新生成 `screenshots/*.png`，它针对一个名为「截图专用」的会话；需要同样的 playwright 前置条件。

## License

[MIT](LICENSE)
