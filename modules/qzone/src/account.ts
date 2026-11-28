import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Bot, Ctx } from '@aurabot/plugin-api'
import type { Config } from './config.js'

export interface Account {
  bot: Bot
  settings(): Config
  call<T>(action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>
  load<T>(key: string, initial: () => T): T
  save<T>(key: string, value: T): void
}

export function chooseBot(ctx: Ctx, id: string) {
  if (id) return ctx.bots.get(id, 'qq')
  const bots = ctx.bots.list().filter((bot) => bot.platform === 'qq')
  return bots.length === 1 ? bots[0] : undefined
}

export function account(ctx: Ctx, bot: Bot, active: () => boolean): Account {
  const selfId = bot.selfId
  const key = createHash('sha256')
    .update(JSON.stringify([bot.id, selfId]))
    .digest('hex')
  const file = (name: string) => ctx.dataDir(key + '-' + name + '.json')
  const settings = () => ctx.config as Config
  return {
    bot,
    settings,
    call(action, params, timeoutMs = 20_000) {
      if (
        !active() ||
        ctx.root.config.enabled === false ||
        bot.status !== 'online' ||
        bot.selfId !== selfId ||
        chooseBot(ctx, settings().botId) !== bot
      )
        throw Error('QQ 账号或插件状态已变化')
      return bot.internal(action, params, { timeoutMs })
    },
    load<T>(name: string, initial: () => T) {
      try {
        return JSON.parse(readFileSync(file(name), 'utf8')) as T
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initial()
        throw error
      }
    },
    save(name, value) {
      if (!active()) return
      const path = file(name)
      const tmp = path + '.' + randomUUID()
      writeFileSync(tmp, JSON.stringify(value))
      renameSync(tmp, path)
    },
  }
}

export function today() {
  const date = new Date()
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}
