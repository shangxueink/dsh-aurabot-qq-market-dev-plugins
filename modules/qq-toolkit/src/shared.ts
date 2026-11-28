import type { Bot, Ctx, Target, ToolContext } from '@aurabot/plugin-api'
import type { Config, Permission } from './config.js'

export interface Where extends ToolContext {
  target: Target
  bot: Bot
  owner: boolean
}

export function resolve(ctx: Ctx, where: ToolContext): Where | undefined {
  const target = where.target
  if (target?.platform !== 'qq') return
  const bot = ctx.bots.get(target.botId, 'qq')
  if (!bot || bot.status !== 'online') return
  return { ...where, target, bot, owner: ctx.turnFromOwner(where.sessionId) }
}

export function visible(ctx: Ctx, where: Where, key: Permission) {
  const level = (ctx.config as Config)[key]
  if (level === 'all') return true
  return level === 'owner' && where.target.type === 'private' && ctx.isOwner(where.target.id, 'qq', where.bot.id)
}

export function permits(ctx: Ctx, where: Where, key: Permission) {
  const level = (ctx.config as Config)[key]
  if (level === 'off') return '这个操作在插件设置里关掉了'
  if (!visible(ctx, where, key)) return '这里不能做这个操作'
  if (level === 'owner' && !ctx.turnFromOwner(where.sessionId)) return '只有主人私聊让我改才行'
  return ''
}

export const fail = (message: string) => ({ ok: false, message })
export const done = (message: string) => ({ ok: true, message })
export const textBlocks = (_args: unknown, value: unknown) => [{ type: 'text', text: (value as { message?: string })?.message || '' }]
export const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) + '…' : text)
