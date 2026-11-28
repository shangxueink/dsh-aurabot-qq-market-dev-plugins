import { Schema, type Ctx, type Session } from '@aurabot/plugin-api'

export const name = '指令切换模型'
export const description = '按当前会话选择下一轮对话使用的模型'
export const config = Schema.object({
  command: Schema.string().default('model').title('指令名称'),
  privateChats: Schema.boolean().default(true).description('允许在私聊中切换'),
  groupChats: Schema.boolean().default(true).description('允许在群组和频道中切换'),
})

export function apply(ctx: Ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => lifetime.abort())
  function permitted(session: Session) {
    if (!(session.isPrivate ? ctx.config.privateChats : ctx.config.groupChats)) return false
    return ctx.isOwner(session)
  }
  const command = String(ctx.config.command ?? 'model').trim()
  if (!/^[\p{L}\p{N}_-]+$/u.test(command)) throw Error('指令名称只接受文字、数字、下划线和连字符')
  ctx.command(command + ' [choice:text]').alias('模型', '换模型').action(async ({ session, args }) => {
    const { bot, target } = session
    const selfId = bot.selfId
    const current = () => !lifetime.signal.aborted && ctx.bots.get(bot.id, bot.platform) === bot && bot.selfId === selfId && bot.status === 'online'
    if (!current()) return
    if (!permitted(session)) return session.send('当前会话没有切换模型的权限。')
    const model = ctx.llm.config.model
    let input = args.trim()
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
      if (!rows.length) return session.send('没有可用模型，请先在全局设置中配置模型。')
      await session.send(['请选择当前' + (session.isPrivate ? '私聊' : '群组或频道') + '的模型。',
        '当前使用 ' + (selected ? selected.provider + '/' + selected.model : '面板默认') + '。', ...rows,
        '请在一分钟内回复序号。'].join('\n'))
      input = (await session.prompt(60000, { signal: lifetime.signal }))?.trim() || ''
      if (!current() || !permitted(session) || ctx.llm.config.model !== model) return
      if (!input) return session.send('选择已结束。')

    }
    const matches = /^\d+$/.test(input) ? list.slice(Number(input) - 1, Number(input)) :
      list.filter(m => [m.provider + '/' + m.model, m.model, m.name].some(value => value?.toLowerCase() === input.toLowerCase()))
    if (matches.length !== 1) return session.send(matches.length ? '有多个同名模型，请填写供应商/模型。' : '未找到该模型，使用 /' + command + ' 查看列表。')
    const selected = matches[0]
    const efforts = selected.reasoning?.efforts ?? []
    let effort = ''
    if (efforts.length) {
      await session.send(['请选择 ' + selected.model + ' 的思考强度。', ...efforts.map((v, i) => (i + 1) + '. ' + v), '请在一分钟内回复序号。'].join('\n'))
      const reply = (await session.prompt(60000, { signal: lifetime.signal }))?.trim()
      if (!current() || !permitted(session) || ctx.llm.config.model !== model) return
      if (!reply) return session.send('选择已结束。')
      effort = /^[1-9]\d*$/.test(reply) ? efforts[Number(reply) - 1] : efforts.find(v => v === reply) || ''
      if (!effort) return session.send('序号无效，原会话设置已保留。')
    }
    model.set(target, selfId, selected)
    if (effort) model.setEffort(target, selfId, selected, effort)
    return session.send('当前会话已切换到 ' + selected.provider + '/' + selected.model + (effort ? ' · ' + effort : '') + '，下一轮生效。')
  })
}
