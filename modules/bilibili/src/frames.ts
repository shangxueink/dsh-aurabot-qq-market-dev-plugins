import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ctx } from '@aurabot/plugin-api'
import { mediaUrl, type Client } from './client.js'
import type { Watched } from './video.js'
interface Shot {
  md5: string
  bvid: string
  title: string
  at: number
  second: number
  path: string
  public: boolean
}
export function frames(ctx: Ctx, client: Client, signal: AbortSignal, accountKey: string) {
  const directory = ctx.dataDir('frames-' + accountKey)
  mkdirSync(directory, { recursive: true })
  const list = (): Shot[] =>
    readdirSync(directory)
      .filter((n) => /^[a-f0-9]{32}\.jpg\.json$/.test(n))
      .flatMap((n) => {
        const path = join(directory, n.slice(0, -5))
        if (!existsSync(path)) return []
        try {
          return [{ ...JSON.parse(readFileSync(path + '.json', 'utf8')), md5: n.slice(0, 32), path }]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.at - a.at)
  async function capture(v: Watched, share: boolean) {
    const ffmpeg = ctx.ffmpeg
    if (!ctx.config.vision || !ctx.config.shotLibrary || !ffmpeg?.path()) return []
    const result = await client.get<{
      dash?: { video?: { bandwidth: number; baseUrl?: string; base_url?: string }[] }
      durl?: { url: string }[]
    }>('/x/player/wbi/playurl', { bvid: v.bvid, cid: v.cid, qn: 32, fnval: 16 }, true)
    const stream = result.dash?.video?.sort((a, b) => a.bandwidth - b.bandwidth)[0]
    const url = mediaUrl(stream?.baseUrl || stream?.base_url || result.durl?.[0]?.url)
    if (!url) return []
    const bytes = await ctx.media.download(url, 48 * 1024 * 1024)
    signal.throwIfAborted()
    const temp = mkdtempSync(join(tmpdir(), 'aurabot-bili-')),
      input = join(temp, 'video.mp4')
    const count = Math.min(6, Math.max(1, Number(ctx.config.visionFrames) || 1))
    const selected: Shot[] = []
    try {
      writeFileSync(input, bytes)
      for (let i = 0; i < count; i++) {
        const second = Math.max(0, Math.floor(((i + 0.5) * v.duration) / count))
        const { stdout } = await ffmpeg.run(
          [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-protocol_whitelist',
            'file,pipe',
            '-f',
            'mov',
            '-ss',
            String(second),
            '-i',
            input,
            '-frames:v',
            '1',
            '-vf',
            'scale=512:-2',
            '-c:v',
            'mjpeg',
            '-f',
            'image2pipe',
            'pipe:1',
          ],
          { timeoutMs: 15000, signal },
        )
        if (!stdout.byteLength || stdout.byteLength > 2 * 1024 * 1024) continue
        const md5 = createHash('md5').update(stdout).digest('hex'),
          path = join(directory, md5 + '.jpg')
        const shot = { md5, path, bvid: v.bvid, title: v.title, at: v.at, second, public: share }
        writeFileSync(path, stdout)
        writeFileSync(path + '.json', JSON.stringify(shot))
        selected.push(shot)
      }
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
    for (const shot of list().slice(Math.max(0, Number(ctx.config.shotLibrary)))) {
      rmSync(shot.path, { force: true })
      rmSync(shot.path + '.json', { force: true })
    }
    return selected
  }
  async function describe(shots: Shot[]) {
    const images = shots
      .filter((s) => existsSync(s.path) && statSync(s.path).size <= 2 * 1024 * 1024)
      .map((s) => ({ data: readFileSync(s.path).toString('base64'), mediaType: 'image/jpeg' }))
    return images.length
      ? String(
          (await ctx.ask({
            system: '只描述截图中可见的场景、文字与动作。',
            text: '按时间顺序描述这些视频帧。',
            images,
            maxTokens: 500,
          })) || '',
        )
      : ''
  }
  return { list, capture, describe }
}
