import { createAssets } from './media/assets.js'
import { createArchive } from './media/archive.js'
import type { Bot, Ctx } from '@aurabot/plugin-api'
import { account, chooseBot } from './account.js'
import { audience, createDiary } from './diary.js'
import { createSocial } from './social.js'

export { config } from './config.js'
export const name = 'QQ 空间'

export function apply(ctx: Ctx) {
  let active = true
  ctx.effect(() => {
    active = false
    current?.archive.dispose()
  })

  function connect(bot: Bot) {
    const selected = account(ctx, bot, () => active)
    return {
      bot,
      selfId: bot.selfId,
      selected,
      diary: createDiary(ctx, selected),
      archive: createArchive(ctx, selected),
      social: createSocial(ctx, selected),
    }
  }
  let current: ReturnType<typeof connect> | undefined
  function online() {
    const bot = chooseBot(ctx, ctx.config.botId)
    if (!bot || bot.status !== 'online' || !bot.selfId) return
    if (bot !== current?.bot || bot.selfId !== current.selfId) {
      current?.archive.dispose()
      current = connect(bot)
    }
    return current
  }
  function requireAccount() {
    const acct = online()
    if (!acct) throw Error('请选择一个在线的 QQ Bot 实例')
    return acct
  }

  if (ctx.config.middlewareEnabled !== false) ctx.middleware(async (session, next) => {
    const acct = online()
    if (acct && acct.bot === session.bot && session.content.trim())
      acct.diary.remember(session.userName || session.userId, session.content)
    return next()
  })
  ctx.setInterval(60_000, async () => {
    const acct = online()
    if (!acct || ctx.root.config.enabled === false) return
    await acct.diary.tick()
    await acct.social.tick()
  })
  if (ctx.config.commands)
    ctx
      .command('diary')
      .alias('日记')
      .action(async ({ session }) => {
        const acct = online()
        if (!acct || session.platform !== 'qq' || session.bot.id !== acct.bot.id || !ctx.isOwner(session))
          return
        await acct.diary.write(false)
        await session.send('空间日记已发布')
      })
  ctx.tool(({ target, level, sessionId }) => {
    const acct = online()
    if (!acct || !target || target.platform !== 'qq' || target.botId !== acct.bot.id || level !== 'full')
      return null
    return {
      name: 'qq_send_qzone',
      description: '在当前机器人的 QQ 空间发布一条说说。可见范围由空间设置决定，可收窄为仅自己。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          images: { type: 'array', items: { type: 'string' } },
          visibility: { type: 'string', enum: ['self'] },
        },
        required: ['content'],
      },
      async execute({ content, visibility, images }) {
        if (!ctx.turnFromOwner(sessionId)) return { ok: false, message: '只有主人能要求发布说说' }
        return acct.diary.post(
          String(content || ''),
          visibility,
          Array.isArray(images) ? images.filter((url): url is string => typeof url === 'string') : [],
        )
      },
    }
  })

  ctx.server.get('/state', () => {
    const acct = online()
    if (!acct) return { ok: true, online: false }
    return {
      ok: true,
      online: true,
      botId: acct.bot.id,
      history: acct.diary.history(),
      plan: acct.diary.plan(),
      social: acct.social.state(),
    }
  })
  ctx.setInterval(300_000, () => online()?.archive.collect())
  ctx.server.get('/archive', () => requireAccount().archive.state())
  ctx.server.post('/archive/collect', () => requireAccount().archive.collect())
  const assets = createAssets(ctx)
  ctx.server.get('/diary/image', (req, res) => {
    try {
      const bytes = assets.read(ctx.http.query(req).id)
      ctx.http.send(res, 200, bytes, ctx.media.inspect(bytes).mime)
    } catch {
      ctx.http.send(res, 404, '', 'text/plain')
    }
  })
  ctx.server.get('/privacy', () => ({ ok: true, ...audience(requireAccount().selected.settings()) }))
  ctx.server.get('/friends', async () => ({
    ok: true,
    friends: await requireAccount().selected.call('get_friend_list', {}),
  }))
  ctx.server.post('/diary/preview', () => requireAccount().diary.write(true))
  ctx.server.post('/diary/run', async (req) =>
    requireAccount().diary.write(false, (await ctx.http.body(req)).visibility),
  )
  ctx.server.post('/diary/delete', async (req) =>
    requireAccount().diary.remove(String((await ctx.http.body(req)).tid || '')),
  )
  ctx.server.post('/diary/sync', () => requireAccount().diary.syncHistory())
  ctx.server.post('/social/run', () => requireAccount().social.run())
}
