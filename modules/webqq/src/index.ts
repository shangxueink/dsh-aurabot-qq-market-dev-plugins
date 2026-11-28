import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { once } from 'node:events'
import { extname, join } from 'node:path'
import type { Ctx } from '@aurabot/plugin-api'

export const name = 'WebQQ'
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
}

async function staticFiles(root: string) {
  const files = new Map<string, string>()
  async function walk(prefix: string) {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const name = prefix + entry.name
      if (entry.isDirectory()) await walk(name + '/')
      else if (entry.isFile()) files.set('/' + name, join(root, name))
    }
  }
  await walk('')
  if (!files.has('/index.html')) throw new Error('WebQQ 安装包缺少静态首页')
  files.set('/', files.get('/index.html')!)
  return files
}

export async function apply(ctx: Ctx) {
  const files = await staticFiles(join(ctx.baseDir, 'dist'))
  let origin = ''
  const server = createServer(async (req, res) => {
    if (req.headers.host !== origin) { res.writeHead(403).end(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return }
    let path: string
    try { path = decodeURIComponent((req.url || '/').split('?')[0]) }
    catch { res.writeHead(400).end(); return }
    const file = files.get(path)
    if (!file) { res.writeHead(404).end(); return }
    try {
      const data = req.method === 'HEAD' ? undefined : await readFile(file)
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }).end(data)
    } catch { res.writeHead(500).end() }
  })
  for (let port = 5150; port < 5160; port++) {
    try {
      const listening = once(server, 'listening')
      server.listen(port, '127.0.0.1')
      await listening
      origin = '127.0.0.1:' + port
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 5159) throw error
    }
  }
  try {
    ctx.page({ path: '/webqq', name, group: 'platform', url: 'http://' + origin + '/' })
  } catch (error) { server.close(); throw error }
  return { dispose: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}
