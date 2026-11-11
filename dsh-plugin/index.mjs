/**
 * DSH 插件：给 agent 一个「部署书源阅读器」的工具。
 *
 * 为什么是工具而不是命令：agent 需要的是「给我一个能用的阅读站地址」，
 * 而不是让人去敲命令。所以这里注册 legado_deploy，返回结构化结果。
 *
 * 只做三件事：确认环境 → 取代码装依赖 → 起服务并验收。
 * 不碰书源（仓库本来就不带），不改宿主已有的数据目录。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

const run = promisify(execFile)

export const name = 'legado-reader'
export const inject = ['tools']

const REPO = 'zuomeizuoyang/legado-reader'

async function sh(cmd, args, opts = {}) {
  return run(cmd, args, { timeout: 180000, maxBuffer: 16 * 1024 * 1024, ...opts })
}

async function nodeMajor() {
  const { stdout } = await sh(process.execPath, ['-p', 'process.versions.node.split(".")[0]'])
  return Number(stdout.trim())
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'legado_deploy',
    description:
      'Deploy a self-hosted Legado book-source reader (a web novel reader that executes Legado book-source rules) on this machine. ' +
      'Returns the access URL with its access key. The deployed instance starts with an EMPTY shelf and NO book sources — ' +
      'the user must import book sources themselves in the web UI. Do not attempt to supply book sources.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Directory to install into, e.g. "~/.legado-reader". Must be persistent, not a temp dir.',
      },
      port: { type: 'number', description: 'Port to listen on. Default 8899.' },
      accessKey: {
        type: 'string',
        description: 'Access key for the instance. Omit to auto-generate a 24-char random key — strongly recommended.',
      },
      start: {
        type: 'boolean',
        description: 'Whether to start the server after installing. Default true.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          port: { type: 'number' },
          dir: { type: 'string' },
          dataDir: { type: 'string' },
          started: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: v.started
          ? `书源阅读器已启动：${v.url}\n数据目录：${v.dataDir}\n（书架和书源都是空的，需要在网页里自行导入书源）`
          : `已安装到 ${v.dir}，未启动。数据目录：${v.dataDir}`,
      }],
    },
    async execute(args, exec) {
      if (process.platform === 'win32') {
        throw new Error('Windows 暂不支持本工具，请改用 Docker 或手动部署（见仓库 AGENTS.md）')
      }
      if (!(await nodeMajor() >= 18)) throw new Error('需要 Node.js 18 或更高版本')

      const dir = path.resolve(args.dir.replace(/^~(?=$|\/)/, os.homedir()))
      const port = args.port ?? 8899
      const accessKey = args.accessKey ?? randomBytes(12).toString('hex')
      const shouldStart = args.start !== false
      const dataDir = path.join(dir, 'runtime-data')

      fs.mkdirSync(path.dirname(dir), { recursive: true })

      if (!fs.existsSync(path.join(dir, 'server.mjs'))) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legado-'))
        const tarball = path.join(tmp, 'src.tar.gz')
        await sh('curl', ['-fsSL', `https://github.com/${REPO}/archive/refs/heads/main.tar.gz`, '-o', tarball])
        await sh('tar', ['xzf', tarball, '-C', tmp])
        const extracted = fs.readdirSync(tmp).find(d => d.includes('legado-reader'))
        if (!extracted) throw new Error('下载的压缩包结构不符，未找到源码目录')
        fs.cpSync(path.join(tmp, extracted), dir, { recursive: true })
        fs.rmSync(tmp, { recursive: true, force: true })
      }

      await sh('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir })
        .catch(() => sh('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir }))

      fs.mkdirSync(dataDir, { recursive: true })

      if (!shouldStart) {
        return { url: '', port, dir, dataDir, started: false, note: 'installed only' }
      }

      const child = execFile(process.execPath, ['server.mjs'], {
        cwd: dir,
        env: { ...process.env, DATA_DIR: dataDir, ACCESS_KEY: accessKey, PORT: String(port) },
        detached: true,
      })
      child.unref()

      let ok = false
      for (let i = 0; i < 30 && !ok; i++) {
        await new Promise(r => setTimeout(r, 500))
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/state?k=${accessKey}`, { signal: exec.signal })
          ok = res.status === 200
        } catch { /* 还没起来 */ }
      }
      if (!ok) throw new Error(`服务未在 15 秒内就绪，检查端口 ${port} 是否被占用，或查看 ${dir} 下的运行日志`)

      return {
        url: `http://127.0.0.1:${port}/?k=${accessKey}`,
        port,
        dir,
        dataDir,
        started: true,
        note: 'shelf and sources are empty by design; the user imports book sources in the web UI',
      }
    },
  }))
}
