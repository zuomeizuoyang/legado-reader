# dsh-plugin-legado-reader

给 [DeepSeek Harness](https://www.deepseek.com/harness/) 的插件：注册一个 `legado_deploy` 工具，agent 调用它就能在宿主机上装好并启动一套自托管的书源阅读器。

> **状态：未在真实 dsh 环境里跑过。** dsh 仍是 developer preview，`dsh.bundle` 与 `cordis.patch.yml` 的具体格式请以官方 `docs/cookbook/adding-a-package.md` 为准。工具本体（`defineTool` + `ctx.tools.register`）严格按官方 *adding-a-tool* 参考实现编写。

## 它做什么

```
legado_deploy({ dir: "~/.legado-reader" })
```

→ 检查 Node 18+ → 拉 GitHub tarball → `npm ci` → 生成随机口令 → 后台启动 → 轮询验收 → 返回带口令的访问地址。

**不做什么**：不导入书源、不改动宿主已有的数据目录、不在 Windows 上跑。

## 为什么不直接看 AGENTS.md

这个仓库根目录的 `AGENTS.md` 已经能让 dsh 的 agent 自己完成部署 —— dsh 会把仓库根的 AGENTS.md 作为 system prompt 的一个 section 读取。

插件的价值在别处：**把部署变成一个返回结构化结果的工具调用**，而不是让模型去组合一串 shell 命令。前者可复现、有 schema、失败能返回明确错误；后者每次都得靠模型即兴发挥。

## 安装

```bash
cd dsh-plugin
npm install
npm publish --access public        # 包名若被占，改成 @<你的scope>/dsh-plugin-legado-reader
```

然后按 dsh 的 profile 机制挂上：

```bash
dsh --profile web --dump-config    # 确认插件真的被加载
```

仓库需要打上 GitHub Topic `dsh-plugin` 才能被官方插件生态发现。

## 权限

这个插件会：读写指定安装目录、跑 `npm`、启动一个长驻 Node 进程、监听一个端口。没有别的。

书源导入、抓取的出网行为发生在服务内部，由使用者自己控制。
