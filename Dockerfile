# 书源阅读 · 自托管镜像
#
# 服务端是纯 JS（jsdom / linkedom / iconv-lite 都不带原生模块），用 alpine 底座，
# 拉取约 53MB。运行期只依赖 Node 本身和 59 个 npm 包。

FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

# 时区数据只影响日志时间戳。服务端做三件事：抓 HTML、跑规则、按字符集解码，
# 全程不做页面渲染，所以运行期只需要 Node 运行时本身。
RUN apk add --no-cache tzdata

WORKDIR /app

# 先只拷依赖清单，让这一层能复用缓存：改代码不用重装依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs ./
COPY src ./src
COPY public ./public
# 内置书源文件（本仓库里是空数组）。保留这个文件是为了首次启动时能在 /data 里落一份占位，
# 用户导入的源之后也写在这个位置。项目本身不附带任何书源。
COPY data/classic.json ./data/classic.json

# 只给数据目录写权限。代码目录保持 root 属主、只读 —— node 用户读 644 文件不需要属主，
# 对 /app 做 chown -R 会触发 overlayfs copy-up，把整个 node_modules 复制进新层，白白多几 MB。
RUN mkdir -p /data && chown node:node /data
USER node

VOLUME ["/data"]
EXPOSE 3000

# 探活走内置源版本接口：它不触发抓取，只读文件头，几十毫秒返回
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/preset/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
