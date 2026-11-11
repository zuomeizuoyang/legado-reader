# AGENTS.md

给 AI agent 的执行说明。人类用户读 [README.md](./README.md)。

## 这是什么

一个自托管的 Legado 书源阅读器：Node 单进程服务 + 无构建步骤的静态前端。

**仓库不含任何书源，也不含任何书籍内容。** 部署完成时书架和源列表都是空的，书源由使用者在网页里自行导入。这是刻意设计，不是缺文件 —— 不要试图去找、生成或补齐书源。

## 部署：选一条，不要两条都跑

### A. 宿主机直接跑（推荐；有 Node 18+ 就够）

```bash
git clone --depth 1 https://github.com/zuomeizuoyang/legado-reader.git
cd legado-reader
npm ci --omit=dev
DATA_DIR=./runtime-data PORT=8899 nohup node server.mjs > legado.log 2>&1 &
echo "访问地址: http://127.0.0.1:8899"
```

**默认不带口令**，打开即用。要给公网用就加 `ACCESS_KEY=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)`，并把带 `?k=口令` 的完整链接给用户，否则页面会弹口令输入框。

### B. Docker（宿主机有 docker 时）

```bash
docker run -d --name legado-reader \
  -p 8899:3000 \
  -v legado-data:/data \
  --restart unless-stopped \
  ghcr.io/zuomeizuoyang/legado-reader:latest
echo "访问地址: http://<host>:8899"
```

镜像拉取约 53MB，公开的，不用登录 ghcr。公网部署同样要加 `-e ACCESS_KEY=...`。

想自己构建就把 `docker compose` 里的 `build: .` 放开、`image:` 注释掉。

## 验收（必做）

```bash
curl -s http://127.0.0.1:8899/api/health
```

看返回里的 `needKey` 字段，据此判断该期望什么：

| 部署方式 | needKey | `/api/state` 不带口令 |
| --- | --- | --- |
| 没设 ACCESS_KEY（默认） | `false` | 必须 200 |
| 设了 ACCESS_KEY | `true` | 必须 401；带 `?k=口令` 才 200 |

```bash
curl -s -o /dev/null -w "no-key:%{http_code}\n" http://127.0.0.1:8899/api/state
```

`needKey=true` 时如果这条返回 200，说明 ACCESS_KEY 没生效（环境变量没传进容器），**立刻停下检查**。

再确认服务自报的数据目录：

```bash
docker logs legado-reader 2>&1 | grep 数据      # Docker 方式
grep 数据 legado.log                            # Node 方式
```

应当指向持久化位置（`/data` 或 `./runtime-data`），**不是代码目录**。指向代码目录意味着重启或升级会丢书架。

## 硬性约束

- **必须设 `ACCESS_KEY`。** 不设的话，任何能访问到端口的人都能把这台机器当成公共抓取代理，流量、封 IP、法律风险全算在部署者头上。启动时如果检测到「监听全部网卡但没设口令」，控制台会打印警告 —— 看到就当错误处理。
- **不要把书源写进仓库或镜像。** 使用者自己导入。fork 后往里塞源列表的 PR 应当被拒绝。
- **`DATA_DIR` 必须落在持久化路径上。** 这是书架、阅读进度、导入书源唯一的存储位置。
- **端口从环境变量读**（`PORT`），不要写死 3000 —— 托管平台会自己注入端口。

## 代码结构

| 路径 | 作用 |
| --- | --- |
| `server.mjs` | HTTP 入口：静态资源、API 路由、口令校验 |
| `src/jsengine.mjs` | `@js:` 规则的 vm 沙箱，模拟 Rhino 环境 |
| `src/rules.mjs` | Legado 书源规则解析（搜索/目录/正文） |
| `src/book.mjs`、`src/feed.mjs` | 书目与发现流 |
| `src/proxy.mjs`、`src/ssrf.mjs`、`src/syncfetch.mjs` | 出网抓取与内网地址拦截 |
| `public/index.html` | 前端单文件，无构建 |

## 验证改动

改完代码至少要跑通这一条链路：启动 → 拿到页面 → 带口令访问 API → 数据落在 `DATA_DIR`。

```bash
node --check server.mjs
DATA_DIR=/tmp/legado-check PORT=18900 ACCESS_KEY=t node server.mjs &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:18900/api/state?k=t"   # 200
ls /tmp/legado-check                                                              # 有 classic.json
```

## 许可

MIT。分发和修改都可以，保留版权声明即可。
