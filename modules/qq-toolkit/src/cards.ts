import type { Ctx } from '@aurabot/plugin-api'
import { done, fail, resolve } from './shared.js'

const TYPES = ['share', 'music', 'location', 'contact', 'dice', 'rps']
type Args = Record<string, unknown>

export function cardSegment(args: Args): { error: string } | { type: string; data: Record<string, string> } {
  const type = String(args.type || '').trim()
  if (!TYPES.includes(type)) return { error: 'type 要填 share、music、location、contact、dice 或 rps' }
  const has = (key: string) => args[key] != null && String(args[key]).trim() !== ''
  for (const key of ['url', 'image', 'audio'])
    if (has(key) && !/^https?:\/\//i.test(String(args[key]).trim())) return { error: `${key} 要是 http 或 https 链接` }
  const data: Record<string, string> = {}
  const copy = (...keys: string[]) => keys.filter(has).forEach((key) => (data[key] = String(args[key]).trim()))
  const need = (...keys: string[]) => keys.filter((key) => !has(key))
  let missing: string[] = []
  if (type === 'share') {
    missing = need('url', 'title')
    copy('url', 'title', 'content', 'image')
  } else if (type === 'music') {
    missing = need('music_type')
    const custom = String(args.music_type || '').trim() === 'custom' || !has('id')
    data.type = String(args.music_type || '').trim()
    if (custom) {
      missing.push(...need('url', 'audio', 'title'))
      copy('url', 'audio', 'title', 'content', 'image')
    } else copy('id')
  } else if (type === 'location') {
    missing = need('lat', 'lon')
    const lat = Number(args.lat), lon = Number(args.lon)
    if (!missing.length && !(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return { error: '位置的 lat 或 lon 超出范围' }
    copy('lat', 'lon', 'title', 'content')
  } else if (type === 'contact') {
    missing = need('contact_type', 'id')
    const id = String(args.id ?? '')
    if (!missing.length && (!['qq', 'group'].includes(String(args.contact_type)) || !/^[1-9]\d{4,11}$/.test(id))) return { error: '联系人类型要填 qq 或 group，id 要填正整数' }
    data.type = String(args.contact_type || '')
    copy('id')
  }
  return missing.length ? { error: '缺参数：' + missing.join('、') } : { type, data }
}

const text = (description: string) => ({ type: 'string', description })

export function useCards(ctx: Ctx) {
  ctx.tool((context) => {
    const where = resolve(ctx, context)
    if (!where) return []
    return [{
      name: 'qq_send_card',
      description: '向当前聊天发送网页分享卡片、音乐、位置、联系人、骰子或猜拳。对方要的是图片时直接在回复里贴图。音乐的 music_type、联系人的 contact_type 对应卡片里的 type。',
      properties: {
        type: text('share / music / location / contact / dice / rps'),
        url: text('分享或自定义音乐的链接'), title: text('分享、音乐或位置的标题'),
        content: text('分享说明、音乐描述或位置地址'), image: text('分享或音乐的封面链接'),
        music_type: text('音乐平台类型；自定义音乐填 custom'), audio: text('自定义音乐的音频链接'),
        lat: { type: 'number', description: '位置纬度' }, lon: { type: 'number', description: '位置经度' },
        contact_type: text('联系人类型：qq 或 group'), id: text('平台音乐 ID、联系人 QQ 号或群号'),
      },
      required: ['type'],
      execute: async (args: Args) => {
        const card = cardSegment(args)
        if ('error' in card) return fail(card.error)
        if (!ctx.root.config.enabled) return fail('总开关关着，没发')
        const receipt = await ctx.sendTo(where.target, h('qq:card', card))
        return ctx.text.sent(receipt) ? done('卡片发出去了') : fail('卡片没发出去')
      },
    }]
  })
}
