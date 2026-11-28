import { Schema, type Ctx, type Session } from '@aurabot/plugin-api'

export const name = '指令切换模型'
export const description = '按当前会话选择下一轮对话使用的模型'
export const config = Schema.object({
  command: Schema.string().default('model').title('指令名称'),
  privateChats: Schema.boolean().default(true).description('允许在私聊中切换'),
  groupChats: Schema.boolean().default(true).description('允许在群组和频道中切换'),
})

export function apply(ctx: Ctx) {
  let active = true
  ctx.effect(() => { active = false })
  function permitted(session: Session) {
    if (!(session.isPrivate ? ctx.config.privateChats : ctx.config.groupChats)) return false
    return ctx.isOwner(session)
  }
  const command = String(ctx.config.command ?? 'model').trim()
  if (!/^[\p{L}\p{N}_-]+$/u.test(command)) throw Error('指令名称只接受文字、数字、下划线和连字符')
  ctx.command(command + ' [choice:text]').alias('模型', '换模型').action(async ({ session, args }) => {
    const { bot, target } = session
    const selfId = bot.selfId
    const current = () => active && ctx.bots.get(bot.id, bot.platform) === bot && bot.selfId === selfId && bot.status === 'online'
    if (!current()) return
    if (!permitted(session)) return session.send('当前会话没有切换模型的权限。')
    const model = ctx.llm.config.model
    const input = args.trim()
    if (/^(默认|跟随|default|auto)$/i.test(input)) {
      model.set(target, selfId, null)
      return session.send('已恢复跟随面板，下一轮生效。')
    }
    const list = await model.list()
    if (!current() || ctx.llm.config.model !== model) return
    if (!permitted(session)) return session.send('模型切换权限已变更。')
    if (!input) {
      const selected = model.get(target, selfId)
      const rows = list.slice(0, 50).map((m, i) => (i + 1) + '. ' + m.provider + '/' + m.model)
      return session.send(['当前会话模型为' + (selected ? selected.provider + '/' + selected.model : '面板默认') + '。', ...rows, '使用 /' + command + ' 序号 或 /' + command + ' 供应商/模型 切换。'].join('\n'))
    }
    const matches = /^\d+$/.test(input) ? list.slice(Number(input) - 1, Number(input)) :
      list.filter(m => [m.provider + '/' + m.model, m.model, m.name].some(value => value?.toLowerCase() === input.toLowerCase()))
    if (matches.length !== 1) return session.send(matches.length ? '有多个同名模型，请填写供应商/模型。' : '未找到该模型，使用 /' + command + ' 查看列表。')
    const selected = matches[0]
    model.set(target, selfId, selected)
    return session.send('当前会话已切换到 ' + selected.provider + '/' + selected.model + '，下一轮生效。')
  })
}
