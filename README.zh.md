# dsh-translator

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的有道风格划词翻译插件。

划选任意文本——会话消息、侧栏、输入框——选区右上角浮现悬浮 **「译」** 按钮，点击即弹出译文卡片。翻译由 **harness 自带的大模型**完成：无需 API key、不依赖第三方接口，选中的文本不会离开你已配置的模型管道。

| [English README](README.md) | 中文 |
|---|---|

## 使用

划选文本 → 点击选区右上角的「译」→ 译文卡片即出。就这么简单。

## 功能

- 任意位置划词，悬浮按钮跟随选区右上角，自动适配深色/浅色主题
- 中英互译方向自动判断（中文 → English，其余 → 简体中文）
- 译文卡片：原文、方向徽标、译文正文、失败重试；Esc / 点击空白 / 滚动均可关闭
- 走你当前配置的默认模型，零额外配置

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
