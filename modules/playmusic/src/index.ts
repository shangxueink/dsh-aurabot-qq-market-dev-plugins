// 语音点歌：搜原唱 → 主模型挑一首 → 下载 → 抽成 mp3 发语音条。

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { searchBili, resolveBili, downloadTo } from './providers/bilibili.js'
import { searchNetease, songUrlNetease } from './providers/netease.js'
import { findFfmpeg, extractAudio } from './audio/ffmpeg.js'
import { PlayCache, cacheKey, type PlaySource } from './cache/store.js'
import { resolveProxy } from './utils/fetch-race.js'

import { Schema, h, type Ctx, type Target } from '@aurabot/plugin-api'
import { readFile } from 'node:fs/promises'

interface Settings {
  enabled: boolean
  source: PlaySource
  targetMinutes: number
  proxy: string
  ownerOnly: boolean
  commandEnabled: boolean
  commandName: string
  prompt: string
}

/** 默认的「给 AI 的提示词」。{{变量}} 运行时替换；用户可在面板里自己改。 */
const DEFAULT_PROMPT = [
  '你会点歌（只点原唱，不做翻唱/变声），当前搜索来源：{{source}}。',
  '有人想听歌（说「点歌 xxx / 放一首 xxx / 来首 xxx」）时：',
  '① 先调用 {{searchTool}}，song 填歌名（可带歌手）；',
  '② 拿到一张或多张候选表格后，你判断最像「原唱」的那一条，判断维度包括时长、发布者、标题/歌名，',
  '   调用 {{sendTool}}，传 platform（bilibili 或 netease，用英文名）和它的 id（哔哩哔哩填 BV 号，网易云填歌曲数字 id）；',
  '③ 插件会自动下载、转码并发语音条，下载通常要几十秒，期间可告诉对方稍等。',
  '用户直接给了 BV 号或网易云歌曲 id 时，可跳过搜索而直接 {{sendTool}}。一次只点一首。',
].join('\n')

const DEFAULTS: Settings = {
  enabled: true,
  source: 'both',
  targetMinutes: 10,
  proxy: '',
  ownerOnly: false,
  commandEnabled: true,
  commandName: 'music',
  prompt: DEFAULT_PROMPT,
}

const SOURCE_LABEL: Record<PlaySource, string> = {
  bilibili: '仅哔哩哔哩',
  netease: '仅网易云',
  both: '哔哩哔哩 + 网易云',
}

/** mm:ss 展示。 */
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec || 0))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

/** 把文本里的 | 和换行处理掉，避免撑坏 Markdown 表格。 */
function esc(text: string): string {
  return String(text == null ? '' : text)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

export const name = '语音点歌'
export const config = Schema.object({
  enabled: Schema.boolean().default(true).title('启用点歌'),
  source: Schema.union(['both', 'bilibili', 'netease']).default('both').title('搜索来源'),
  targetMinutes: Schema.natural().min(4).max(30).default(10).title('最长时长（分钟）'),
  proxy: Schema.string().default('').title('搜索代理'),
  ownerOnly: Schema.boolean().default(false).title('仅主人可用'),
  commandEnabled: Schema.boolean().default(true).title('注册点歌指令'),
  commandName: Schema.string().default('music').title('指令名'),
  prompt: Schema.string().role('textarea').default(DEFAULT_PROMPT).title('点歌提示词'),
})

export function apply(ctx: Ctx) {
  const log = ctx.logger
  const s = (): Settings => ({ ...DEFAULTS, ...ctx.config })
  const cache = new PlayCache(ctx.dataDir())
  const toolAllowed = (target?: Target): target is Target => Boolean(target && s().enabled &&
    (!s().ownerOnly || (target.type === 'private' && ctx.isOwner(target.id, target.platform, target.botId))))

  /** 校验并取当前生效的参数（会夹到合法范围）。 */
  function effective(): { source: PlaySource; targetSec: number; proxy: string } {
    const st = s()
    const source: PlaySource = (['bilibili', 'netease', 'both'] as PlaySource[]).includes(st.source)
      ? st.source
      : 'both'
    const minutes = Math.max(4, Math.min(30, Math.round(Number(st.targetMinutes) || 10)))
    const targetSec = minutes * 60
    const proxy = String(st.proxy || '').trim()
    return { source, targetSec, proxy }
  }

  const PER_LIMIT = 5

  /** 按来源搜候选，分平台收集，方便各自渲染成一张表。 */
  async function searchAll(song: string): Promise<{
    bili: Awaited<ReturnType<typeof searchBili>>
    netease: Awaited<ReturnType<typeof searchNetease>>
    errors: string[]
  }> {
    const { source, proxy } = effective()
    const errors: string[] = []
    let bili: Awaited<ReturnType<typeof searchBili>> = []
    let netease: Awaited<ReturnType<typeof searchNetease>> = []
    const wantBili = source === 'bilibili' || source === 'both'
    const wantNetease = source === 'netease' || source === 'both'
    // 两个平台同时搜，每个平台内部再由 fetch-race 竞速直连与代理。
    const jobs: Array<Promise<void>> = []
    if (wantBili) {
      jobs.push(
        searchBili(song, { limit: PER_LIMIT, proxy }).then(
          (rows) => {
            bili = rows
          },
          (error) => {
            errors.push('哔哩：' + ((error && (error as Error).message) || error))
          },
        ),
      )
    }
    if (wantNetease) {
      jobs.push(
        searchNetease(song, { limit: PER_LIMIT, proxy }).then(
          (rows) => {
            netease = rows
          },
          (error) => {
            errors.push('网易云：' + ((error && (error as Error).message) || error))
          },
        ),
      )
    }
    await Promise.all(jobs)
    return { bili, netease, errors }
  }

  /** 把候选渲染成 Markdown 表格（哔哩：视频名称/UP主/时长/BV号；网易云：歌曲名称/作者/时长/id）。 */
  function renderBiliTable(rows: Awaited<ReturnType<typeof searchBili>>): string {
    const head = '| # | 视频名称 | UP主 | 时长 | BV号 |\n|---|---|---|---|---|'
    const body = rows
      .map((r, i) => `| ${i + 1} | ${esc(r.title)} | ${esc(r.author)} | ${fmtDur(r.duration)} | ${r.bvid} |`)
      .join('\n')
    return `${head}\n${body}`
  }

  function renderNeteaseTable(rows: Awaited<ReturnType<typeof searchNetease>>): string {
    const head = '| # | 歌曲名称 | 作者 | 时长 | id |\n|---|---|---|---|---|'
    const body = rows
      .map(
        (r, i) =>
          `| ${i + 1} | ${esc(r.name + (r.alias ? `（${r.alias}）` : ''))} | ${esc(r.artists)} | ${fmtDur(r.durationSec)} | ${r.id} |`,
      )
      .join('\n')
    return `${head}\n${body}`
  }

  /** 用 {{变量}} 替换用户可编辑的提示词。 */
  function renderPrompt(): string {
    const st = s()
    const tpl = String(st.prompt || DEFAULT_PROMPT)
    const src = SOURCE_LABEL[effective().source]
    return tpl
      .replace(/\{\{\s*source\s*\}\}/g, src)
      .replace(/\{\{\s*searchTool\s*\}\}/g, 'shangxue_playmusic_search')
      .replace(/\{\{\s*sendTool\s*\}\}/g, 'shangxue_playmusic_sendsong')
      .replace(/\{\{\s*perLimit\s*\}\}/g, String(PER_LIMIT))
  }

  if (!findFfmpeg()) {
    log.warn('[点歌] 没找到 ffmpeg，点歌会失败。设 PLAYMUSIC_FFMPEG 环境变量或把 ffmpeg 放进 PATH')
  }
  log.info('[点歌] 已启动，缓存目录：' + cache.dir)

  ctx.tool(({ target }) => {
    if (!toolAllowed(target)) return []
    return ctx.defineTool({
      name: 'shangxue_playmusic_search',
      description:
        '点歌第一步：按「歌名（可带歌手）」去配置好的平台（哔哩哔哩 / 网易云）搜原唱候选，只搜不下载。' +
        '每个平台最多返回 5 条，「哔哩+网易云」合计最多 10 条，以 Markdown 表格返回（哔哩：视频名称/UP主/时长/BV号；网易云：歌曲名称/作者/时长/id）。' +
        '拿到表格后，你判断最像用户想听的「原唱」那一条，调用 shangxue_playmusic_sendsong，传 platform（bilibili 或 netease）和它的 id（BV号 / 网易云歌曲id）去下载。' +
        '如果用户直接给了 BV 号（BV 开头）或网易云歌曲 id，可以跳过本工具，直接 sendsong。',
      properties: {
        song: { type: 'string', description: '歌名，可带歌手，例如「多幸运 韩雪」' },
      },
      required: ['song'],
      execute: async (args: any) => {
        const song = String((args && args.song) || '').trim()
        if (!song) return { ok: false, message: '没给歌名' }
        const { bili, netease, errors } = await searchAll(song)
        const total = bili.length + netease.length
        if (!total) {
          return {
            ok: false,
            message: `没搜到「${song}」的原唱候选` + (errors.length ? '（' + errors.join('；') + '）' : ''),
            errors,
          }
        }
        const parts: string[] = [`为「${song}」找到以下候选，挑最像原唱的那一条，把 platform 和它的 id 传给 shangxue_playmusic_sendsong：`]
        if (bili.length) {
          parts.push(`\n【哔哩哔哩】platform=bilibili（id 用 BV号）\n${renderBiliTable(bili)}`)
        }
        if (netease.length) {
          parts.push(`\n【网易云】platform=netease（id 用歌曲数字id）\n${renderNeteaseTable(netease)}`)
        }
        if (errors.length) parts.push(`\n（部分来源失败：${errors.join('；')}）`)
        return {
          ok: true,
          message: parts.join('\n'),
          bilibili: bili.length ? renderBiliTable(bili) : '',
          netease: netease.length ? renderNeteaseTable(netease) : '',
          errors,
        }
      },
    })
  })

  ctx.tool(({ target }) => {
    if (!toolAllowed(target)) return []
    return ctx.defineTool({
      name: 'shangxue_playmusic_sendsong',
      description:
        '点歌第二步：按 platform + id 下载这首歌（哔哩哔哩传 BV 号，网易云传歌曲数字 id），抽成 mp3 当语音条发到当前聊天。' +
        '一般先用 shangxue_playmusic_search 搜到候选、挑最合适的再把它的 platform 和 id 传进来。' +
        '下载+转换通常要几十秒。成功会返回歌名/歌手，并且语音条已经发到聊天里。',
      properties: {
        platform: { type: 'string', enum: ['bilibili', 'netease'], description: '哪个平台：bilibili 或 netease（英文名）' },
        id: { type: 'string', description: '哔哩哔哩填 BV 号（BV 开头）；网易云填歌曲数字 id' },
        title: { type: 'string', description: '可选，展示用歌名（不传就用解析出来的标题）' },
      },
      required: ['platform', 'id'],
      execute: async (args: any) => {
        const platform = String((args && args.platform) || '').trim() as 'bilibili' | 'netease'
        let key = String((args && args.id) || '').trim()
        if (platform !== 'bilibili' && platform !== 'netease') {
          return { ok: false, message: 'platform 只能是 bilibili 或 netease' }
        }
        if (!key) return { ok: false, message: '没给 id（BV 号 / 网易云歌曲 id）' }
        if (platform === 'bilibili') {
          const m = key.match(/BV[0-9A-Za-z]{10}/)
          if (m) key = m[0]
        }
        return playSong(ctx, cache, target, platform, key, String((args && args.title) || ''), effective)
      },
    })
  })

  const command = String(s().commandName || 'music').trim().replace(/^[/／]/, '')
  if (s().commandEnabled && /^[\w-]+$/.test(command)) {
    ctx.command(command + ' [song:text]').description('搜索歌曲并发送语音').action(async ({ session, args }) => {
      if (!s().enabled || (s().ownerOnly && !ctx.isOwner(session))) return
      const song = args.trim()
      if (!song) return session.send('点歌用法：/' + command + ' 歌名（可带歌手）')
      await session.send('正在找《' + song + '》的原唱…')
      const { bili, netease } = await searchAll(song)
      const pick = bili[0] || netease[0]
      if (!pick) return session.send('没找到《' + song + '》的原唱')
      const result = bili[0]
        ? await playSong(ctx, cache, session.target, 'bilibili', bili[0].bvid, bili[0].title, effective)
        : await playSong(ctx, cache, session.target, 'netease', String(netease[0].id), netease[0].name, effective)
      if (!result.ok) await session.send(result.message)
    })
  }
  ctx.rule(kind => !s().enabled || (kind === 'social' && s().ownerOnly) ? '' : renderPrompt())

  ctx.server.get('/status', async () => {
      const bin = findFfmpeg()
      const eff = effective()
      return {
        ok: true,
        ffmpeg: bin || null,
        ffmpegOk: Boolean(bin),
        source: eff.source,
        sourceLabel: SOURCE_LABEL[eff.source],
        targetSec: eff.targetSec,
        targetMinutes: Math.round(eff.targetSec / 60),
        proxy: eff.proxy || null,
        proxyMode: resolveProxy(eff.proxy).kind,
        proxyChannels: resolveProxy(eff.proxy).channels,
        commandEnabled: Boolean(s().commandEnabled),
        commandName: String(s().commandName || 'music'),
      }
    })
  return {
    /** 供测试 / 调试 */
    _cache: cache,
  }
}

async function playSong(
  ctx: Ctx,
  cache: PlayCache,
  target: Target,
  platform: 'bilibili' | 'netease',
  key: string,
  title: string,
  effective: () => { source: PlaySource; targetSec: number; proxy: string },
): Promise<any> {
  if (!ctx.bots.get(target.botId, target.platform)?.supports('voice')) return { ok: false, message: '该机器人不支持发送语音' }
  const { targetSec, proxy } = effective()
  const ck = cacheKey({ platform, key, targetSec, startSec: 0 })
  const hit = cache.get(ck)
  if (hit) {
    const sent = await sendVoice(ctx, target, hit, title)
    if (sent) return { ok: true, file: hit, cached: true, platform, key, title: title || '', message: '这首歌之前点过，直接发给你了' }
    return { ok: false, message: '语音条没发出去（可能网关没连上）' }
  }

  const out = cache.pathFor(ck)
  const { mkdirSync } = await import('node:fs')
  try {
    mkdirSync(join(out, '..'), { recursive: true })
  } catch {
    /* ignore */
  }
  const work = join(tmpdir(), 'shangxue-playmusic', randomUUID())
  try {
    let downloadUrl: string
    let resolvedTitle = String(title || '').trim()
    if (platform === 'bilibili') {
      const info = await resolveBili(key, { proxy })
      downloadUrl = info.url
      resolvedTitle = resolvedTitle || info.title
    } else {
      const info = await songUrlNetease(key)
      if (!info.url) {
        return { ok: false, message: '没拿到网易云的下载地址（完整音源的 Meting 后端暂时都不可用，稍后再试）' }
      }
      downloadUrl = info.url
    }
    const ext = platform === 'netease' ? '.mp3' : '.mp4'
    const srcFile = join(work, key.replace(/[^0-9A-Za-z]/g, '') + ext)
    await downloadTo(downloadUrl, srcFile)
    await extractAudio(srcFile, out, { startSec: 0, targetSec })
    const sent = await sendVoice(ctx, target, out, resolvedTitle)
    if (!sent) return { ok: false, message: '下载好了但语音条没发出去（可能网关没连上）' }
    return {
      ok: true,
      file: out,
      platform,
      key,
      title: resolvedTitle,
      message: `点歌成功：${resolvedTitle || key}，语音条已发到聊天`,
    }
  } catch (error) {
    return { ok: false, message: '点歌失败：' + ((error && (error as Error).message) || error) }
  } finally {
    try {
      rmSync(work, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

async function sendVoice(ctx: Ctx, target: Target, file: string, title?: string) {
  const bytes = await readFile(file)
  const receipt = await ctx.sendTo(target, h.voice('data:audio/mpeg;base64,' + bytes.toString('base64'), { name: title || '点歌' }))
  return ctx.text.sent(receipt)
}
