---
name: legado-reader
version: 1.0.0
display_name: 书源阅读器
display_name_en: Legado Book Source Reader
description: 部署一套基于 Legado 书源规则的网页版小说阅读站，手机、平板、电脑用浏览器直接读，不需要安装任何 App。当用户提出「搭一个在线阅读网站 / 部署小说阅读器 / 手机上看小说 / 用 Legado 书源 / 自建书源阅读器 / 不要 App 也想看小说」，或想把已有的本地小说站点上线给多设备访问时使用。
description_en: Deploy a self-hosted web reader that executes Legado book-source rules, readable in any mobile or desktop browser with no app installed. Use when the user wants to build an online reading site, host a novel reader, read on a phone without an app, or put an existing local reading setup online for multiple devices.
---

# 书源阅读器部署

一套开箱可跑的网页版小说阅读站：Node 后端负责执行 Legado 书源的 JS 规则并抓取源站，前端是手机优先的单页应用，加到主屏幕后是全屏 PWA。

**核心前提**：项目本身**不含任何书源和书籍内容**，只包含规则引擎与界面。书源由使用者在网页里自行导入。部署完是空书架 —— 这是正常状态，不要试图去补源。

上游仓库：`https://github.com/zuomeizuoyang/legado-reader`（MIT）

## 部署

### 1. 取代码并装依赖

```bash
git clone --depth 1 https://github.com/zuomeizuoyang/legado-reader.git <目标目录>
cd <目标目录>
npm ci --omit=dev
```

目标目录建议放在当前工作区下（例如 `./legado-reader`），方便后续发布与版本管理。

### 2. 启动

本机或局域网自己用，不需要口令：

```bash
DATA_DIR=./runtime-data PORT=<端口> node server.mjs
```

要对外提供访问，必须加口令：

```bash
DATA_DIR=./runtime-data ACCESS_KEY=<16 位以上随机串> PORT=<端口> node server.mjs
```

- 长驻进程用后台方式跑，不要阻塞当前回合。
- `PORT` 必须从环境变量读，托管平台会自己注入；不要写死。
- `DATA_DIR` 必须指向持久化路径。指向代码目录会导致升级/重装丢书架。
- `ACCESS_KEY` 不设就是完全开放：任何能访问到端口的人都能把宿主机当抓取代理。公网部署必须设，并把带 `?k=口令` 的完整链接给用户，否则页面会弹口令输入框。

### 3. 验收（必做）

```bash
curl -s http://127.0.0.1:<端口>/api/health
```

看返回里的 `needKey` 字段决定期望值：

| 部署方式 | needKey | `/api/state` 不带口令 |
| --- | --- | --- |
| 没设 ACCESS_KEY（默认） | `false` | 必须 200 |
| 设了 ACCESS_KEY | `true` | 必须 401，带 `?k=口令` 才 200 |

`needKey=true` 但这儿返回 200，说明口令没生效，**停下来检查环境变量**。

## 验收判定要点

- 部署成功后**书架是空的**，内置源列表也是空的。不要判定为失败。
- 单个源搜不到是常态（站点关停、改版、加验证）；只有「所有源都失败」才是问题。
- 搜索通但目录为空 → 该源目录规则不兼容，换源即可，不是部署故障。
- 全量搜索几百个源本来就要 2–5 分钟，不是卡死。

## 发布到公网（按需）

用平台的应用发布能力（`workbuddy_sites_deploy`，`language: "node"`）指向目标目录。发布后：

- 必须带上 `ACCESS_KEY`；
- 告诉用户完整地址，形如 `https://<域名>/?k=<口令>`，去掉 `?k=` 会 403。

## 常见问题

**起点、晋江这类源拿不到正文**：引擎不保存登录态，所有请求以游客身份发出，需要登录的内容拿不到。

**换设备书架空了**：书架和书源都存在服务端（`state.json` / `sources.json`），同一服务地址下自动对齐；换域名等于换环境。主屏 PWA 和浏览器标签页是两套本地存储，跨入口全靠服务端这份。
