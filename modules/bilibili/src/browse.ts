import type { Ctx } from '@aurabot/plugin-api'
import type { frames } from './frames.js'
import type { Journal, Entry } from './journal.js'
import type { sharing } from './share.js'
import { Library, link } from './video.js'

function peak(now: Date) {
  const day = new Date(+now + 8 * 3600000).getUTCDay(),
    h = now.getUTCHours()
  return day > 0 && day < 6 && ((h >= 1 && h < 4) || (h >= 6 && h < 10))
}
interface Memory {
  addEvent(entry: { text: string; tags: string[]; kind: string }): unknown
}
export function browse(
  ctx: Ctx,
  videos: Library,
  journal: Journal,
  shots: ReturnType<typeof frames>,
  share: ReturnType<typeof sharing>,
  active: () => boolean,
) {
  const think = (prompt: string) =>
    ctx.think(prompt, { key: 'bilibili', title: '浏览 B 站', timeoutMs: 120000, noTools: true })
  let running = false
  async function run(manual = false) {
    if (running || !active()) return { count: 0 }
    const cfg = ctx.config,
      now = Date.now()
    if (
      !manual &&
      (!cfg.autoBrowse ||
        (cfg.offpeak && peak(new Date(now))) ||
        ctx.thinkCooldown('bilibili') ||
        now - journal.data.lastRun < Math.max(1, cfg.intervalHours) * 3600000)
    )
      return { count: 0 }
    if (!journal.take('browse', Number(cfg.maxRunsPerDay))) return { count: 0 }
    running = true
    journal.data.lastRun = now
    journal.save()
    try {
      const interests: string[] = Array.isArray(cfg.keywords)
        ? cfg.keywords.filter((v: unknown) => typeof v === 'string')
        : []
      let terms = interests.slice(0, 3)
      const recent = journal.data.history.slice(0, 6).map((v) => v.title)
      const answer = await think(
        '根据你的人格、兴趣 ' +
          interests.join('、') +
          ' 和最近看过的视频 ' +
          recent.join('、') +
          '，选择这次想看的三个话题，每行一个，仅输出关键词。',
      )
      if (!ctx.text.isSilence(answer)) {
        const words = answer
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && s.length <= 40)
        if (words.length) terms = words.slice(0, 3)
      }
      const groups = await Promise.allSettled(terms.map((v) => videos.list(v)))
      const candidates = groups.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
      if (!candidates.length) candidates.push(...(await videos.list()))
      const seen = new Set(journal.data.history.map((v) => v.bvid))
      const processed: Entry[] = []
      for (const v of candidates) {
        if (!active() || processed.length >= Math.min(10, Number(cfg.perRun))) break
        if (
          seen.has(v.bvid) ||
          v.views < cfg.minViews ||
          (cfg.maxAgeDays && now - v.published > cfg.maxAgeDays * 86400000)
        )
          continue
        seen.add(v.bvid)
        const viewed = await videos.watch(link(v))
        const images = await shots.capture(viewed, true).catch((e) => {
          ctx.logger.debug('视频抽帧', e.message)
          return []
        })
        const visual = await shots.describe(images).catch(() => '')
        if (!active()) break
        const draft = await think(
          '刚浏览了一个视频。以下是视频的公开资料。写一句自己的观后感，想保持沉默就写 [SILENT]。\n' +
            JSON.stringify({
              标题: viewed.title,
              简介: viewed.desc,
              字幕: viewed.subtitle,
              热评: viewed.comments,
              画面: visual,
            }),
        )
        if (!active()) break
        const thought = ctx.text.isSilence(draft) ? '' : ctx.text.clean(draft, 'B 站观后感').slice(0, 500)
        const entry = { ...v, cover: viewed.cover, part: viewed.part, at: viewed.at, thought }
        journal.remember(entry)
        processed.push(entry)
        if (!thought) continue
        ctx
          .get<Memory>('memory')
          ?.addEvent({ text: '浏览《' + entry.title + '》：' + thought, tags: ['B站'], kind: 'event' })
        await share.offer(entry)
      }
      return { count: processed.length, items: processed }
    } finally {
      running = false
    }
  }
  return { run }
}
