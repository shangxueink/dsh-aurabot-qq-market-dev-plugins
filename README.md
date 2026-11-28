# AuraBot 社区插件

本仓库开发并发布以下模块。市场以各模块目录下的 package.json 收录发行版本。

- 哔哩哔哩 · bilibili
- QQ 空间 · qzone
- QQ 工具箱 · qq-toolkit
- WebQQ · webqq
- 语音点歌 · playmusic
- 转告主人反馈 · tell-owner
- 指令切换模型 · model-switch
- 网页搜索 · web-search
- GIF 图片倒放 · reverse-gif

## 目录约定

```
.github/workflows/release.yml   # push 后构建 + 发 Release + 回写 artifact
scripts/release.mjs             # workflow 调用的脚本
modules/<name>/
├─ package.json      # 唯一清单：name(包名本身) / version / aurabot 段
├─ tsconfig.json     # 后台：NodeNext，src → lib
├─ tsconfig.client.json  # 面板：client → dist
├─ src/index.ts      # 入口，默认导出插件对象
├─ client/panel.ts   # 面板源码，编译成 dist/panel.js
├─ test/             # 不进发布包
├─ README.md
└─ LICENSE
```

`package.json` 的 `name` 只写包名本身（小写字母/数字/`-`），**不要加用户名前缀、不要带 @**——市场构建时用仓库 owner 拼成 `owner/name`。`type` 必须是 `module`。

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
