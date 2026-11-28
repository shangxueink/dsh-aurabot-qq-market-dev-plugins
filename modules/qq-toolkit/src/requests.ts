import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Bot, Ctx, PlatformNotice, ToolSpec } from '@aurabot/plugin-api'
import type { Config } from './config.js'
import { done, fail, permits, resolve, visible, type Where } from './shared.js'

const KEEP = 50
const UNKNOWN = '未知QQ（由QQ过滤）'

export interface FriendRequest { flag: string; userId: string; comment: string; at: number; via?: 'event' | 'doubt' }
export interface GroupRequest { flag: string; kind: 'add' | 'invite'; userId: string; groupId: string; comment: string; at: number }

export const isUnknown = (userId: unknown) => !userId || String(userId) === '0'
export const label = (userId: string) => (isUnknown(userId) ? UNKNOWN : `QQ ${userId}`)
export const cleanId = (value: unknown) => {
  const digits = String(value ?? '').replace(/\D/g, '')
  return /^\d{5,12}$/.test(digits) ? digits : ''
}
export const groupText = (request: GroupRequest) =>
  request.kind === 'add'
    ? `${request.userId ? `QQ ${request.userId}` : '未知用户'} 申请加入群 ${request.groupId || '未知'}`
    : `${request.userId ? `QQ ${request.userId}` : '有人'} 邀请我加入群 ${request.groupId || '未知'}`

export function pick<T extends { flag: string; userId: string }>(list: T[], query: { qq?: string; flag?: string; index?: number }) {
  if (query.flag) return list.find((item) => item.flag === query.flag)
  if (query.index) return list[query.index - 1]
  if (query.qq) return list.find((item) => item.userId === query.qq)
  return list.length === 1 ? list[0] : undefined
}

function store<T>(file: () => string, valid: (item: T) => boolean) {
  return {
    load(): T[] {
      try {
        if (!existsSync(file())) return []
        const data = JSON.parse(readFileSync(file(), 'utf8'))
        return Array.isArray(data) ? data.filter(valid) : []
      } catch {
        return []
      }
    },
    save(list: T[]) {
      writeFileSync(file(), JSON.stringify(list.slice(-KEEP)))
    },
  }
}

export function useRequests(ctx: Ctx) {
  const settings = () => ctx.config as Config
  const scoped = (bot: Bot, name: string) => () => ctx.dataDir(`${bot.id}-${name}.json`)
  const friends = (bot: Bot) => store<FriendRequest>(scoped(bot, 'friend-requests'), (item) => Boolean(item?.flag))
  const groups = (bot: Bot) => store<GroupRequest>(scoped(bot, 'group-requests'), (item) => Boolean(item?.flag))
  const busy = new Set<string>()

  function notify(bot: Bot, text: string) {
    if (!settings().notifyRequests || settings().requests === 'off') return
    const owners = (ctx.root.config.owners || []) as Array<{ platform?: string; userId?: string; botId?: string }>
    const owner = owners.find((item) => item.platform === 'qq' && (!item.botId || item.botId === bot.id))
    if (owner?.userId)
      ctx.sendTo({ platform: 'qq', botId: bot.id, type: 'private', id: String(owner.userId) }, text)
        .catch((error) => ctx.logger.warn('发送申请通知失败', error.message))
  }

  const comment = (notice: PlatformNotice) => String((notice.data.message as { content?: string })?.content ?? '').slice(0, 80)
  const flag = (notice: PlatformNotice) => String(notice.messageId ?? '')

  ctx.on('friend-request', (notice: PlatformNotice) => {
    if (notice.platform !== 'qq' || !flag(notice)) return
    const box = friends(notice.bot)
    const list = box.load()
    if (list.some((item) => item.flag === flag(notice))) return
    const request = { flag: flag(notice), userId: String(notice.userId || '0'), comment: comment(notice), at: Date.now() }
    box.save([...list, request])
    const note = request.comment ? `，验证消息：「${request.comment}」` : ''
    const how = isUnknown(request.userId) ? `它是第 ${list.length + 1} 个待处理申请，跟我说「通过第 ${list.length + 1} 个」或「拒绝」就行。` : `要通过就跟我说「通过 ${request.userId}」。`
    notify(notice.bot, `有人想加我好友：${label(request.userId)}${note}。${how}`)
  })

  const onGroup = (kind: GroupRequest['kind']) => (notice: PlatformNotice) => {
    if (notice.platform !== 'qq' || !flag(notice)) return
    const box = groups(notice.bot)
    const list = box.load()
    if (list.some((item) => item.flag === flag(notice))) return
    const request = { flag: flag(notice), kind, userId: String(notice.userId || ''), groupId: String(notice.guildId || ''), comment: comment(notice), at: Date.now() }
    box.save([...list, request])
    notify(notice.bot, `${groupText(request)}${request.comment ? `，验证消息：「${request.comment}」` : ''}。可以让我列出待处理的加群申请再处理。`)
  }
  ctx.on('guild-member-request', onGroup('add'))
  ctx.on('guild-request', onGroup('invite'))

  async function doubtful(bot: Bot, known: FriendRequest[]) {
    let rows: unknown
    try {
      rows = await bot.internal('get_doubt_friends_add_request', { count: 50 }, { timeoutMs: 15000 })
    } catch {
      return []
    }
    const seen = new Set(known.map((item) => item.flag))
    const out: FriendRequest[] = []
    for (const row of Array.isArray(rows) ? rows : []) {
      const uid = row?.uid == null ? '' : String(row.uid)
      if (!uid || seen.has(uid)) continue
      seen.add(uid)
      out.push({ via: 'doubt', flag: uid, userId: isUnknown(row.user_id) ? '0' : String(row.user_id), comment: String(row.msg || row.message || '').slice(0, 80), at: 0 })
    }
    return out
  }

  async function allFriends(bot: Bot) {
    const events = friends(bot).load().map((item) => ({ ...item, via: 'event' as const }))
    return [...events, ...(await doubtful(bot, events))]
  }

  const guard = <A>(where: Where, run: (args: A) => Promise<unknown>) => (args: A) => {
    const denied = permits(ctx, where, 'requests')
    return denied ? fail(denied) : run(args)
  }

  ctx.tool((context) => {
    const where = resolve(ctx, context)
    if (!where || !visible(ctx, where, 'requests')) return []
    const { bot, target } = where
    const tools: ToolSpec[] = [
      {
        name: 'qq_list_friend_requests',
        description: '列出收到过、尚未处理的好友申请（包括 QQ 号未知、被 QQ 过滤的申请），处理时使用列表里的序号或 flag。',
        execute: guard(where, async () => {
          const list = await allFriends(bot)
          return done(list.length
            ? list.map((item, index) => `${index + 1}. ${label(item.userId)}${item.comment ? `，验证消息：「${item.comment}」` : ''}（flag: ${item.flag}）`).join('\n')
            : '现在没有待处理的好友申请')
        }),
      },
      {
        name: 'qq_handle_friend_request',
        description: '通过或拒绝别人加你为好友的申请。用 qq、flag 或 index（从 1 开始）指定其一；只有一个待处理申请时可不填。你不能主动加别人为好友。',
        properties: {
          qq: { type: 'string', description: '申请人的 QQ 号，可不填' },
          flag: { type: 'string', description: '待处理列表里的原样 flag，可不填' },
          index: { type: 'integer', description: '待处理列表里的序号，可不填' },
          approve: { type: 'boolean', description: 'true 通过，false 拒绝' },
        },
        required: ['approve'],
        execute: guard(where, async ({ qq, flag, index, approve }: { qq?: string; flag?: string; index?: number; approve?: boolean }) => {
          if (typeof approve !== 'boolean') return fail('approve 要写 true（通过）或 false（拒绝）')
          const wantQq = qq ? cleanId(qq) : ''
          if (qq && !wantQq) return fail('QQ 号不对：要 5~12 位数字')
          const wantIndex = index == null ? 0 : Number(index)
          if (!Number.isInteger(wantIndex) || wantIndex < 0) return fail('序号要写从 1 开始的整数')
          const query = { qq: wantQq, flag: String(flag ?? '').trim(), index: wantIndex }
          if ([query.qq, query.flag, query.index].filter(Boolean).length > 1) return fail('qq、flag、序号只填一个就行')
          const list = await allFriends(bot)
          const request = pick(list, query)
          if (!request) return fail(list.length > 1 && !query.qq && !query.flag && !query.index
            ? `有 ${list.length} 个待处理的申请：${list.map((item) => label(item.userId)).join('、')}。说清楚是哪个`
            : '没找到这条好友申请')
          const verb = approve ? '通过' : '拒绝'
          try {
            await bot.internal(request.via === 'doubt' ? 'set_doubt_friends_add_request' : 'set_friend_add_request', { flag: request.flag, approve }, { timeoutMs: 15000 })
          } catch (error) {
            return fail(`${verb} ${label(request.userId)} 的好友申请没成功：${(error as Error).message}`)
          }
          const box = friends(bot)
          box.save(box.load().filter((item) => item.flag !== request.flag))
          return done(`已${verb} ${label(request.userId)} 的好友申请`)
        }),
      },
    ]
    if (target.type === 'private' && ctx.isOwner(target.id, 'qq', bot.id)) tools.push(
      {
        name: 'qq_list_group_requests',
        description: '列出收到过、尚未处理的加群申请和邀请，处理时使用列表中的 flag。',
        execute: guard(where, async () => {
          const list = groups(bot).load()
          return done(list.length ? list.map((item) => `${groupText(item)}${item.comment ? `，验证消息：「${item.comment}」` : ''}（flag: ${item.flag}）`).join('\n') : '现在没有待处理的加群申请或邀请')
        }),
      },
      {
        name: 'qq_handle_group_request',
        description: '通过或拒绝收到过的加群申请或邀请。flag 从待处理列表原样取得，只有一条时可不填；拒绝时可填 reason。',
        properties: {
          flag: { type: 'string', description: '待处理列表里的 flag，可不填' },
          approve: { type: 'boolean', description: 'true 通过，false 拒绝' },
          reason: { type: 'string', description: '拒绝原因，可不填' },
        },
        required: ['approve'],
        execute: guard(where, async ({ flag, approve, reason }: { flag?: string; approve?: boolean; reason?: string }) => {
          if (typeof approve !== 'boolean') return fail('approve 要写 true（通过）或 false（拒绝）')
          if (!ctx.turnFromOwner(where.sessionId)) return fail('只有主人私聊才能处理加群申请')
          const box = groups(bot)
          const list = box.load()
          if (!flag && list.length > 1) return fail('有多条待处理的加群申请，请先列出并指定 flag')
          const request = flag ? list.find((item) => item.flag === String(flag)) : list[0]
          if (!request) return fail('没找到这条待处理的加群申请或邀请')
          if (busy.has(request.flag)) return fail('这条申请正在处理')
          busy.add(request.flag)
          const verb = approve ? '通过' : '拒绝'
          try {
            await bot.internal('set_group_add_request', { flag: request.flag, sub_type: request.kind, approve, ...(reason && !approve ? { reason: String(reason) } : {}) }, { timeoutMs: 15000 })
            box.save(box.load().filter((item) => item.flag !== request.flag))
            return done(`已${verb}「${groupText(request)}」`)
          } catch (error) {
            return fail(`${verb}「${groupText(request)}」没成功：${(error as Error).message}`)
          } finally {
            busy.delete(request.flag)
          }
        }),
      },
    )
    return tools
  })
}
