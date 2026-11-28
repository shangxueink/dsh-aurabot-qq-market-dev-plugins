import type { Ctx, Element, ToolSpec } from '@aurabot/plugin-api'
import { done, fail, permits, resolve, visible, type Where } from './shared.js'

const NICK_MAX = 36
const SIGN_MAX = 80
const AVATAR_BYTES = 2 * 1024 * 1024
const RECENT_MS = 30 * 60_000

const field = (data: Record<string, unknown> | undefined, keys: string[]) => {
  for (const key of keys) if (typeof data?.[key] === 'string') return data[key] as string
  return null
}

export function avatarUrl(selfId: string) {
  return `https://q1.qlogo.cn/g?b=qq&nk=${selfId}&s=640&t=${Date.now()}`
}

export function useProfile(ctx: Ctx) {
  const recent = new Map<string, { url: string; at: number }>()
  const room = (where: Pick<Where, 'bot' | 'target'>) => `${where.bot.id}:${where.target.type}:${where.target.id}`

  ctx.middleware((session, next) => {
    if (session.platform === 'qq') {
      const image = h.select(session.elements, 'image').at(-1) as Element | undefined
      const url = String(image?.attrs.src ?? image?.attrs.url ?? '')
      if (/^https?:\/\//i.test(url)) recent.set(`${session.bot.id}:${session.target.type}:${session.target.id}`, { url, at: Date.now() })
    }
    return next()
  })

  async function read(where: Where) {
    const { bot } = where
    let nickname: string | null = null
    let signature: string | null = null
    try {
      const info = await bot.internal('get_stranger_info', { user_id: Number(bot.selfId), no_cache: true }, { timeoutMs: 8000 })
      if (info?.user_id != null && String(info.user_id) !== bot.selfId) return fail('网关返回的账号与机器人不一致，本次资料未采用')
      nickname = field(info, ['nickname'])
      signature = field(info, ['long_nick', 'longNick'])?.trim() ?? null
    } catch {}
    if (nickname === null)
      try {
        nickname = field(await bot.internal('get_login_info', {}, { timeoutMs: 8000 }), ['nickname'])
      } catch {}
    const lines = [
      `QQ 昵称：${nickname === null ? '（未能获取）' : nickname || '（空）'}`,
      `个性签名：${signature === null ? '（未能获取）' : signature || '（未设置）'}`,
      `当前头像地址：${avatarUrl(bot.selfId)}`,
    ]
    return { ok: nickname !== null || signature !== null, message: lines.join('\n'), profile: { user_id: bot.selfId, nickname, signature } }
  }

  async function setAvatar(where: Where, source: string) {
    const raw = source.trim()
    const hit = recent.get(room(where))
    const url = /^https?:\/\//i.test(raw) ? raw : !raw || /^(last|刚才|上一张|最近)/i.test(raw) ? (hit && Date.now() - hit.at < RECENT_MS ? hit.url : '') : null
    if (url === null) return fail('头像只能用网址图片，或者「刚才那张图」')
    if (!url) return fail('最近半小时这个聊天里没人发过图片，先把图发过来')
    let bytes: Buffer
    try {
      bytes = await ctx.media.download(url, AVATAR_BYTES)
    } catch (error) {
      return fail('这张图我拿不到：' + (error as Error).message)
    }
    if (!ctx.media.inspect(bytes).mime.startsWith('image/')) return fail('这不是图片')
    try {
      await where.bot.internal('set_qq_avatar', { file: 'base64://' + bytes.toString('base64') }, { timeoutMs: 30000 })
    } catch (error) {
      return fail('换头像失败：' + (error as Error).message)
    }
    return done('QQ 头像换好了')
  }

  const guard = <A>(where: Where, key: 'nickname' | 'signature' | 'avatar', run: (args: A) => Promise<unknown>) => (args: A) => {
    const denied = permits(ctx, where, key)
    return denied ? fail(denied) : run(args)
  }

  ctx.rule((kind) => kind === 'private'
    ? '主人谈到你自己的 QQ 昵称、个性签名或头像时，可以主动用 qq_get_profile 查看当前资料；主人明确要你发当前头像时用 qq_send_avatar，只有工具报告 sent=true 才能说发出去了。'
    : '')

  ctx.tool((context) => {
    const where = resolve(ctx, context)
    if (!where) return []
    const { bot, target } = where
    const ownerChat = target.type === 'private' && ctx.isOwner(target.id, 'qq', bot.id)
    const tools: ToolSpec[] = []
    if (ownerChat) tools.push(
      {
        name: 'qq_get_profile',
        description: '查看你自己的当前 QQ 昵称、个性签名和头像地址。只读，不发送图片或修改资料。',
        execute: () => ctx.turnFromOwner(where.sessionId) ? read(where) : fail('只有主人私聊时才能查看我的 QQ 资料'),
      },
      {
        name: 'qq_send_avatar',
        description: '主人明确要求发你的当前头像时，把你自己的 QQ 头像图片发到本次主人私聊。发送成功后不要再重复发图。',
        execute: async () => {
          if (!ctx.turnFromOwner(where.sessionId)) return { ok: false, sent: false, message: '只有主人私聊时才能发送我的头像' }
          try {
            const bytes = await ctx.media.download(avatarUrl(bot.selfId), AVATAR_BYTES)
            const receipt = await ctx.sendTo(target, h.image('base64://' + bytes.toString('base64')))
            if (!ctx.text.sent(receipt)) return { ok: false, sent: false, message: '没有收到发送确认，请检查连接；不要重复发送' }
            return { ok: true, sent: true, message: '当前头像已发给主人，不要再用链接或 Markdown 重复发图' }
          } catch (error) {
            return { ok: false, sent: false, message: (error as Error).message }
          }
        },
      },
    )
    if (visible(ctx, where, 'nickname')) tools.push({
      name: 'qq_set_nickname',
      description: `改你自己的 QQ 昵称（最多 ${NICK_MAX} 字）。`,
      properties: { name: { type: 'string', description: '新昵称' } },
      required: ['name'],
      execute: guard(where, 'nickname', async ({ name }: { name?: string }) => {
        const nick = String(name || '').trim()
        if (!nick) return fail('昵称不能是空的')
        if ([...nick].length > NICK_MAX) return fail(`昵称最多 ${NICK_MAX} 个字`)
        await bot.internal('set_qq_profile', { nickname: nick }, { timeoutMs: 15000 })
        return done(`QQ 昵称改好了：${nick}`)
      }),
    })
    if (visible(ctx, where, 'signature')) tools.push({
      name: 'qq_set_signature',
      description: `改你自己的 QQ 个性签名（最多 ${SIGN_MAX} 字）。`,
      properties: { text: { type: 'string', description: '新签名' } },
      required: ['text'],
      execute: guard(where, 'signature', async ({ text }: { text?: string }) => {
        const sign = String(text || '').trim()
        if (!sign) return fail('签名不能是空的')
        if ([...sign].length > SIGN_MAX) return fail(`签名最多 ${SIGN_MAX} 个字`)
        await bot.internal('set_self_longnick', { longNick: sign }, { timeoutMs: 15000 })
        return done(`QQ 签名改好了：${sign}`)
      }),
    })
    if (visible(ctx, where, 'avatar')) tools.push({
      name: 'qq_set_avatar',
      description: '换你自己的 QQ 头像。image 填图片网址；要用聊天里刚收到的图时填 last。图片不能超过 2MB。',
      properties: { image: { type: 'string', description: '图片网址（http/https）或 last' } },
      required: ['image'],
      execute: guard(where, 'avatar', ({ image }: { image?: string }) => setAvatar(where, String(image || ''))),
    })
    return tools
  })
}
