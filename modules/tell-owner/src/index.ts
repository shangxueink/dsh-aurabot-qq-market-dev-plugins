import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { h, roomKey, Schema, type Ctx, type Element, type Session, type Target } from '@aurabot/plugin-api'
import { TicketStore, submitterKey } from './tickets/store.js'
import { sniffMedia } from './media/media.js'
import { dayRange } from './utils/time.js'
import type { Ticket, TicketMedia } from './tickets/types.js'

export const name = '转告主人反馈'
export const config = Schema.object({
  privateEnabled: Schema.boolean().default(true).title('接受私聊反馈'),
  ownerPrivateEnabled: Schema.boolean().default(false).title('接受主人私聊测试'),
  forwardMode: Schema.union(['natural-sign', 'natural']).default('natural-sign').title('转发署名'),
  perUserPerDay: Schema.natural().min(1).max(10).default(2).title('每人每日上限'),
})
const sameAccount = (a: Target, b: Target) => a.platform === b.platform && a.botId === b.botId
const mediaKinds = new Set(['image', 'file', 'voice', 'video'])
const maxAttachment = 8 * 1024 * 1024
type Inbound = Pick<Session, 'target' | 'userId' | 'userName' | 'messageId' | 'content' | 'elements'>

export function apply(ctx: Ctx) {
  const store = new TicketStore({ dir: ctx.dataDir('tickets-v2') })
  const recent = new Map<string, Inbound>()
  const pending = new Set<string>()
  const key = (target: Target, user: string) => JSON.stringify([roomKey(target), user])
  const ownerOf = (t: Target) => {
    const owners: { platform: string; userId: string; botId?: string }[] = ctx.root.config.owners || []
    return owners.find(o => o.platform === t.platform && o.botId === t.botId) ||
      owners.find(o => o.platform === t.platform && !o.botId)
  }
  const isOwner = (t: Target) => t.type === 'private' && ctx.isOwner(t.id, t.platform, t.botId)
  const accepts = (t: Target) => t.type !== 'private' ||
    (isOwner(t) ? ctx.config.ownerPrivateEnabled === true : ctx.config.privateEnabled !== false)
  const limit = () => Math.max(1, Math.min(10, Number(ctx.config.perUserPerDay) || 2))
  ctx.on('message', session => {
    const k = key(session.target, session.userId)
    recent.delete(k)
    recent.set(k, { target: session.target, userId: session.userId, userName: session.userName,
      messageId: session.messageId, content: session.content.slice(0, 4000),
      elements: session.elements.filter(el => mediaKinds.has(el.type)).slice(0, 4)
        .filter(el => /^https?:\/\//i.test(String(el.attrs.src || el.attrs.url || ''))) })
    if (recent.size > 256) recent.delete(recent.keys().next().value!)
  })

  async function submit(msg: Inbound, summary: string) {
    const t = msg.target
    const owner = ownerOf(t)
    if (!owner || !accepts(t)) return { ok: false, message: '请检查此机器人的主人绑定和私聊反馈设置' }
    if (!summary.trim()) return { ok: false, message: '请填写反馈内容' }
    const user = submitterKey(t, msg.userId)
    const { start, end } = dayRange()
    if (pending.has(user) || store.countUserBetween(user, start, end) >= limit()) return { ok: false, message: '有反馈正在提交或已达到今日上限' }
    pending.add(user)
    let ticket: Ticket | undefined
    try {
      const attachments: Element[] = []
      const media: TicketMedia[] = []
      const blobs: { bytes: Buffer; file: string }[] = []
      for (const el of msg.elements.filter(el => mediaKinds.has(el.type)).slice(0, 4)) {
        const url = String(el.attrs.src || el.attrs.url || '')
        if (!/^https?:\/\//i.test(url)) throw new Error('附件缺少可读取的网络地址')
        const bytes = await ctx.media.download(url, maxAttachment)
        const { ext } = sniffMedia(bytes)
        const file = randomUUID() + (ext || '.bin')
        const label = basename(String(el.attrs.name || file)).slice(0, 120)
        blobs.push({ bytes, file })
        media.push({ file, kind: el.type, name: label, url: '' })
        attachments.push(h(el.type, { url: 'data:application/octet-stream;base64,' + bytes.toString('base64'), name: label }))
      }
      ticket = store.add({ target: t, chatId: roomKey(t), chatKind: t.type, groupId: t.type === 'private' ? '' : t.id,
        userId: msg.userId, nickname: msg.userName || msg.userId, messageId: msg.messageId || '',
        summary: summary.trim().slice(0, 3000), original: msg.content.slice(0, 4000), media })
      for (const b of blobs) if (!store.saveMedia(b.bytes, b.file)) throw new Error('附件未能保存')
      const sign = ctx.config.forwardMode === 'natural' ? '' : '\n' + ticket.nickname + ' · ' + t.platform + ' / ' + t.id
      const receipt = await ctx.sendTo({ ...t, type: 'private', id: owner.userId },
        [h.text('#' + ticket.id + ' ' + ticket.summary + sign), ...attachments])
      if (!ctx.text.sent(receipt)) throw new Error('接收机器人未确认送达')
      return { ok: true, ticketId: ticket.id, message: '已转告主人，工单 #' + ticket.id }
    } catch (error) {
      if (ticket) store.remove(ticket.id)
      return { ok: false, message: '转告失败：' + (error as Error).message }
    } finally { pending.delete(user) }
  }
  ctx.command('反馈 <内容:text>').description('把本条消息作为工单转告本机器人的主人').action(async ({ session, args }) =>
    session.send((await submit(session, args)).message))
  ctx.tool(({ target, sessionId }) => {
    if (!target) return []
    const actor = () => {
      if (target.type === 'private') return target.id
      const senders = ctx.chat.turnSenders(sessionId) ?? []
      return senders.length === 1 ? senders[0] : ''
    }
    const visible = (ticket: Ticket) => sameAccount(target, ticket.target)
    const tools = []
    if (accepts(target)) tools.push(ctx.defineTool({ name: 'shangxue_tell_owner', description: '把当前发言人的反馈及随消息收到的附件转告本账号的主人。', properties: { summary: { type: 'string' } }, required: ['summary'],
      execute: async args => {
        const msg = recent.get(key(target, actor()))
        if (!msg) return { ok: false, message: '无法确认原消息，请发言人使用 /反馈 内容 提交' }
        return submit(msg, String(args.summary || ''))
      } }))
    if (isOwner(target)) {
      tools.push(ctx.defineTool({ name: 'shangxue_tell_owner_tickets_list', description: '列出本机器人待处理的反馈。',
        execute: () => isOwner(target) ? store.open().filter(visible).map(t => ({ id: t.id, summary: t.summary, nickname: t.nickname })) : [] }))
      tools.push(ctx.defineTool({ name: 'shangxue_tell_owner_back', description: '回复本机器人的工单。', properties: { ticketId: { type: 'string' }, replyText: { type: 'string' } }, required: ['replyText'],
        execute: async args => {
          const ticket = args.ticketId ? store.get(String(args.ticketId)) : store.open().filter(visible).at(-1)
          const reply = String(args.replyText || '').trim()
          if (!isOwner(target) || !ticket || !visible(ticket) || ticket.status !== 'open' || !reply || pending.has('#' + ticket.id)) return { ok: false, message: '请检查工单编号、状态和回复内容' }
          pending.add('#' + ticket.id)
          try {
            const content = [...(ticket.messageId ? [h.quote(ticket.messageId)] : []), ...(ticket.target.type === 'private' ? [] : [h.at(ticket.userId)]), h.text(reply)]
            if (!ctx.text.sent(await ctx.sendTo(ticket.target, content))) return { ok: false, message: '回复未送达，工单仍待处理' }
            store.resolve(ticket.id, reply)
            return { ok: true, ticketId: ticket.id }
          } finally { pending.delete('#' + ticket.id) }
        } }))
    }
    if (isOwner(target) || store.all().some(t => visible(t) && t.userId === actor())) {
      tools.push(ctx.defineTool({ name: 'shangxue_tell_owner_delete', description: '按编号删除本账号的工单，发起人可撤回自己的工单。', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'],
        execute: args => {
          const caller = actor()
          const deleted: string[] = []
          for (const id of Array.isArray(args.ids) ? args.ids : []) {
            const t = store.get(String(id))
            if (t && visible(t) && !pending.has('#' + t.id) && (isOwner(target) || (caller && t.userId === caller))) {
              store.remove(t.id); deleted.push(t.id)
            }
          }
          return { ok: deleted.length > 0, deleted }
        } }))
    }
    return tools
  })
  ctx.server.get('/board', () => {
    const { start, end } = dayRange()
    return { ok: true, rows: store.userSummaries(start, end), perUserPerDay: limit(), minLimit: 1, maxLimit: 10 }
  })
  ctx.server.post('/set-limit', async req => {
    const n = Number((await ctx.http.body(req)).perUserPerDay)
    if (!Number.isInteger(n) || n < 1 || n > 10) return { ok: false, message: '请输入 1 至 10 的整数' }
    ctx.updateConfig({ perUserPerDay: n })
    return { ok: true, perUserPerDay: n }
  })
  ctx.server.post('/reset', async req => {
    const { userId } = await ctx.http.body(req)
    if (!store.all().some(t => submitterKey(t.target, t.userId) === userId)) return { ok: false, message: '找不到此账号下的发起人' }
    store.resetUser(userId)
    return { ok: true, message: '已重置今日次数' }
  })
}
