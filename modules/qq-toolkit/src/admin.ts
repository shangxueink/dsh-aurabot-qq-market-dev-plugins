import type { Bot, Ctx } from '@aurabot/plugin-api'
import { done, fail, resolve, type Where } from './shared.js'

type Role = 'owner' | 'admin' | 'member' | ''
const ROLE_TTL = 10 * 60_000
const LABEL: Record<string, string> = { owner: '群主', admin: '管理员', member: '普通成员' }
export const canManage = (role: Role) => role === 'owner' || role === 'admin'

export function createRoles(ctx: Ctx) {
  const cache = new Map<string, { role: Role; at: number }>()
  const pending = new Map<string, Promise<Role>>()
  const key = (bot: Bot, groupId: string) => `${bot.id}:${groupId}`

  async function fetch(bot: Bot, groupId: string): Promise<Role> {
    const info = await bot.internal<{ role?: string }>('get_group_member_info', { group_id: Number(groupId), user_id: Number(bot.selfId), no_cache: true }, { timeoutMs: 8000 })
    const role = (['owner', 'admin', 'member'].includes(info?.role ?? '') ? info.role : 'member') as Role
    cache.set(key(bot, groupId), { role, at: Date.now() })
    return role
  }

  function get(bot: Bot, groupId: string, fresh = false): Promise<Role> {
    const id = key(bot, groupId)
    const hit = cache.get(id)
    if (!fresh && hit && Date.now() - hit.at < ROLE_TTL) return Promise.resolve(hit.role)
    if (!pending.has(id))
      pending.set(id, fetch(bot, groupId)
        .catch((error) => {
          ctx.logger.debug(`查群 ${groupId} 里的身份失败：`, error.message)
          return hit?.role ?? ''
        })
        .finally(() => pending.delete(id)))
    return pending.get(id)!
  }

  function peek(bot: Bot, groupId: string): Role {
    const hit = cache.get(key(bot, groupId))
    if (!hit || Date.now() - hit.at >= ROLE_TTL) void get(bot, groupId)
    return hit?.role ?? ''
  }

  return { get, peek, label: (role: Role) => LABEL[role] || '不清楚' }
}

type Roles = ReturnType<typeof createRoles>
const ACTIONS = ['ban', 'unban', 'whole_ban', 'whole_unban', 'kick', 'title', 'notice'] as const
type Action = (typeof ACTIONS)[number]
interface Args { action?: Action; group_id?: string; user_id?: string; minutes?: number; text?: string }

export async function runAdmin(ctx: Ctx, roles: Roles, where: Where, args: Args) {
  const { bot, target } = where
  if (!ctx.turnFromOwner(where.sessionId)) return fail('只有主人能让我做群管操作')
  const cfg = ctx.root.config
  const groupId = String(args.group_id || (target.type === 'group' ? target.id : '')).replace(/\D/g, '')
  if (!groupId) return fail('不知道是哪个群')
  if (!(cfg.allow?.groups || []).map(String).includes(groupId)) return fail('这个群不在白名单里')
  const action = args.action
  if (!action || !ACTIONS.includes(action)) return fail('不认识的操作')
  const userId = String(args.user_id || '').replace(/\D/g, '')
  const whole = action === 'whole_ban' || action === 'whole_unban'
  if (!whole && action !== 'notice' && !userId) return fail('要说清楚对谁（QQ 号）')
  if (userId && ctx.isOwner(userId, 'qq', bot.id) && action !== 'unban' && action !== 'title') return fail('不能对主人做这个')
  const role = await roles.get(bot, groupId, true)
  if (role && !canManage(role)) return fail('我在这个群只是普通成员，没有管理权限')
  if (role === 'admin' && action === 'title') return fail('改专属头衔要群主才行，我只是管理员')
  const group_id = Number(groupId)
  const user_id = Number(userId)
  const calls: Record<Action, [string, Record<string, unknown>]> = {
    ban: ['set_group_ban', { group_id, user_id, duration: Math.max(1, Number(args.minutes) || 10) * 60 }],
    unban: ['set_group_ban', { group_id, user_id, duration: 0 }],
    whole_ban: ['set_group_whole_ban', { group_id, enable: true }],
    whole_unban: ['set_group_whole_ban', { group_id, enable: false }],
    kick: ['set_group_kick', { group_id, user_id, reject_add_request: false }],
    title: ['set_group_special_title', { group_id, user_id, special_title: String(args.text || '') }],
    notice: ['_send_group_notice', { group_id, content: String(args.text || '') }],
  }
  await bot.internal(...calls[action])
  return done('做好了')
}

export function useAdmin(ctx: Ctx) {
  const roles = createRoles(ctx)
  ctx.prompt((context) => {
    const where = ctx.config.groupAdmin && resolve(ctx, context)
    if (!where || where.target.type !== 'group') return ''
    const role = roles.peek(where.bot, where.target.id)
    if (!role) return ''
    return canManage(role)
      ? `你在这个群是${roles.label(role)}，主人要求时可以用群管工具。`
      : '你在这个群只是普通成员，没有管理权限：禁言、踢人这些做不了，主人要求时直接说明。'
  })
  ctx.tool((context) => {
    const where = ctx.config.groupAdmin && resolve(ctx, context)
    if (!where || !(where.target.type === 'group' || where.owner)) return []
    return [{
      name: 'qq_group_admin',
      description: '群管理：禁言 / 解禁 / 全体禁言 / 解除全体禁言 / 踢人 / 改头衔 / 发群公告。只有主人要求时才能用；别人要求会被系统拒绝。',
      properties: {
        action: { type: 'string', enum: [...ACTIONS], description: 'ban 禁言某人，unban 解除禁言，whole_ban 全体禁言，whole_unban 解除全体禁言，kick 踢出，title 改专属头衔，notice 发公告' },
        group_id: { type: 'string', description: '群号；在群里用时可省略，默认当前群' },
        user_id: { type: 'string', description: '对象 QQ 号（notice、全体禁言不需要）' },
        minutes: { type: 'integer', description: '禁言分钟数，默认 10' },
        text: { type: 'string', description: '头衔内容或公告内容' },
      },
      required: ['action'],
      execute: (args: Args) => runAdmin(ctx, roles, where, args),
    }]
  })
  ctx.server.get('/roles', async () => {
    const bots = ctx.bots.list().filter((bot) => bot.platform === 'qq' && bot.status === 'online')
    const groups = (ctx.root.config.allow?.groups || []).map(String)
    const list = await Promise.all(bots.flatMap((bot) => groups.map(async (groupId: string) => {
      const role = await roles.get(bot, groupId, true)
      return { botId: bot.id, groupId, role, label: role ? roles.label(role) : '查不到', canManage: canManage(role) }
    })))
    return { ok: true, list }
  })
  return roles
}
