import { randomUUID } from 'node:crypto'
import type { Ctx, Target, RoomTimeline, RoomMemory, PersonaService } from '@aurabot/plugin-api'
import { Journal, type Entry } from './journal.js'
import { link } from './video.js'

const same = (a: Target, b: Target) =>
  a.platform === b.platform && a.botId === b.botId && a.type === b.type && a.id === b.id
function destination(value: unknown): value is Target {
  if (!value || typeof value !== 'object') return false
  const target = value as Partial<Target>
  return !!(
    typeof target.botId === 'string' &&
    target.botId &&
    typeof target.id === 'string' &&
    target.id &&
    typeof target.platform === 'string' &&
    target.platform &&
    ['private', 'group', 'channel'].includes(String(target.type))
  )
}
export function sharing(ctx: Ctx, journal: Journal, active: () => boolean) {
  const targets = (): Target[] =>
    Array.isArray(ctx.config.destinations) ? ctx.config.destinations.filter(destination) : []
  async function send(target: Target, item: Entry, selfId?: string) {
    if (!active() || !targets().some((t) => same(t, target))) throw Error('分享目标已变更')
    const bot = ctx.bots
      .list()
      .find((b) => b.id === target.botId && b.platform === target.platform && b.status === 'online')
    if (!bot) throw Error('目标 Bot 未上线')
    if (selfId && bot.selfId !== selfId) throw Error('原分享账号已变更，请重新提议')
    if (!journal.take('share', Number(ctx.config.shareLimit))) throw Error('已达每日分享上限')
    const message = [
      ctx.h('text', { content: [item.thought, item.title, link(item)].filter(Boolean).join('\n') }),
    ]
    if (item.cover) message.push(ctx.h.image(item.cover))
    const [receipt] = await ctx.broadcast([target], message)
    if (!receipt?.ok) throw Error(receipt?.error || '发送失败')
    try {
      const card = ctx.get<PersonaService>('persona')?.current(target)
      const timeline = ctx.get<RoomTimeline>('room-timeline')
      if (!card || !timeline?.enabled()) return
      const text = '向会话分享了《' + item.title.slice(0, 120) + '》 ' + link(item)
      const { room } = timeline.read(target, bot.selfId, card.id)
      timeline.record(target, bot.selfId, card.id, { role: 'assistant', speaker: card.name, text, at: Date.now() })
      ctx.get<RoomMemory>('room-memory')?.remember({ room, persona: card.id, user: target.type === 'private' ? target.id : bot.selfId }, text)
    } catch (error) {
      ctx.logger.warn('分享已送达，记录记忆失败', error)
    }
  }
  async function offer(item: Entry) {
    for (const target of targets()) {
      if (!active()) return
      if (target.type === 'private') {
        if (ctx.isOwner(target.id, target.platform, target.botId)) await send(target, item)
        continue
      }
      const queue = journal.pending()
      if (
        queue.length >= Number(ctx.config.queueLimit) ||
        queue.some((p) => p.item.bvid === item.bvid && same(p.target, target))
      )
        continue
      const id = randomUUID().slice(0, 8)
      journal.data.pending.push({
        id,
        item,
        target,
        expires: Date.now() + Math.max(1, Number(ctx.config.pendingHours)) * 3600000,
      })
      journal.save()
      for (const owner of targets().filter(
        (t) => t.type === 'private' && ctx.isOwner(t.id, t.platform, t.botId),
      )) {
        await ctx.broadcast(
          [owner],
          '待批分享 ' +
            id +
            ' · ' +
            item.title +
            ' → ' +
            target.platform +
            '/' +
            target.botId +
            '/' +
            target.id +
            '\n同意请回复「分享 ' +
            id +
            '」，取消请回复「跳过 ' +
            id +
            '」。',
        )
      }
    }
  }
  async function decide(id: string, accept: boolean) {
    const entry = journal.pending().find((p) => p.id === id)
    if (!entry) throw Error('审批已处理或过期')
    journal.remove(id)
    if (accept) await send(entry.target, entry.item, entry.selfId)
    return { ok: true }
  }
  ctx.middleware(async (session, next) => {
    const match = /^(分享|跳过)\s+([a-f\d]{8})$/i.exec(session.content.trim())
    if (!match || session.type !== 'private' || !ctx.isOwner(session)) return next()
    try {
      await decide(match[2], match[1] === '分享')
      await session.send('已处理 ' + match[2])
    } catch (e) {
      await session.send(e instanceof Error ? e.message : '处理失败')
    }
  })
  return { offer, decide }
}
