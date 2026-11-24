# auramod 示例插件仓库

两个可用的 AuraBot 插件，顺便当作插件市场的接入样例：一个仓库放多个插件，push 之后 Actions 自动构建、发 Release、把产物地址回写到 `package.json`。

## 收录了什么

| 模块 | 作用 |
| --- | --- |
| `modules/tell-owner` | 转告主人反馈：托话记成工单送达主人，主人回复时自动引用原消息回群 |
| `modules/playmusic` | 语音点歌：哔哩哔哩 / 网易云搜原唱，下载抽成 mp3 发语音条，不需要任何 Cookie |

两个都在市场的收录表里：

```
https://raw.githubusercontent.com/shangxueink/dsh-aurabot-qq-market-dev-plugins/main/modules/tell-owner/package.json
https://raw.githubusercontent.com/shangxueink/dsh-aurabot-qq-market-dev-plugins/main/modules/playmusic/package.json
```

## 目录约定

```
.github/workflows/release.yml   # push 后构建 + 发 Release + 回写 artifact
scripts/release.mjs             # workflow 调用的脚本
modules/<name>/
├─ package.json      # 唯一清单：name(=scope/name) / version / aurabot 段
├─ tsconfig.json     # NodeNext，src → lib
├─ src/index.ts      # 入口，默认导出插件对象
├─ client/panel.js   # 面板（aurabot.panel 默认路径）
├─ test/             # 不进发布包
├─ README.md
└─ LICENSE
```

`package.json` 的 `name` 必须是 `你的GitHub用户名/模块名`，不带 `@`；`type` 必须是 `module`。市场只认这两条规则加上 `aurabot` 段。

## 加自己的插件

1. 复制 `modules/tell-owner` 整个目录，改名
2. 改 `package.json` 的 `name`、`version`、`description`、`aurabot.*`
3. push，Actions 会构建并发布
4. 想进市场：把 `https://raw.githubusercontent.com/<你>/<仓库>/main/modules/<模块>/package.json` 提交到插件市场的收录表

## 本地开发

```bash
cd modules/playmusic
npm install
npm run build      # tsc → lib/
npm test
```

## 发版

改 `modules/<name>/package.json` 的 `version`，push 即可。脚本只构建版本号变过的模块，产物地址写在 `aurabot.artifact` 里，不要手改；`.aurabot/versions.json` 由首次构建生成并提交，别加进 `.gitignore`。
