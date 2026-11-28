import type { Ctx, Session } from '@aurabot/plugin-api'
import { maxBytes, reverseGif } from './gif.js'

export const name = 'GIF 图片倒放'

async function readImage(ctx: Ctx, session: Session) {
  const image = ctx.h.select(session.elements, 'image')[0]
  const src = String(image?.attrs.url || image?.attrs.file || '')
  const inline = /^(?:data:image\/[\w.+-]+;base64,|base64:\/\/)/i.exec(src)
  if (inline) {
    if (Buffer.byteLength(src.slice(inline[0].length),'base64') > maxBytes) throw Error('GIF 超过 16 MB。')
    return Buffer.from(src.slice(inline[0].length), 'base64')
  }
  if (/^https?:\/\//i.test(src)) return ctx.media.download(src, maxBytes)
  throw Error('平台未提供可读取的原图，请重新发送 GIF 原图。')
}

export function apply(ctx: Ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => lifetime.abort())
  let rendering = 0
  ctx.command('倒放GIF').description('把下一条 GIF 动图倒放并以图片发回').action(async ({ session }) => {
    const service = ctx.ffmpeg
    if (!service?.path()) return session.send('请先在控制台启用并配置 FFmpeg。')
    await session.send('请发送动图')
    const reply = await session.promptMessage(60000, {
      signal: lifetime.signal,
      accept: message => ctx.h.select(message.elements, 'image').length > 0,
    })
    if (lifetime.signal.aborted) return
    if (!reply) return session.send('一分钟内没有收到动图，可以再次发送「倒放GIF」。')
    if (rendering >= 2) return reply.send('有动图正在处理，请稍后再试。')
    rendering++
    try {
      const input = await readImage(ctx, reply)
      const gif = await reverseGif(service, input, lifetime.signal)
      if (lifetime.signal.aborted) return
      await reply.send(ctx.h.image('data:image/gif;base64,' + gif.toString('base64'), { sticker: true }))
    } catch (error) {
      if (lifetime.signal.aborted) return
      const reason = error instanceof Error ? error.message : ''
      ctx.logger.warn('GIF 倒放失败', reason.slice(0, 300))
      await reply.send(/^(GIF 超过|这张 GIF|这是一张|图片不是|动图过大|平台未提供|暂不支持|输出帧数|FFmpeg 无法)/.test(reason)
        ? reason : '处理失败，请确认原图可以下载、FFmpeg 可以运行。')
    } finally { rendering-- }
  })
}
