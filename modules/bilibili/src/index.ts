import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Ctx, ToolSpec } from '@aurabot/plugin-api'
import { Client } from './client.js'
import { Library } from './video.js'
import { Journal } from './journal.js'
import { frames } from './frames.js'
import { sharing } from './share.js'
import { browse } from './browse.js'

export { config } from './settings.js'
export const name = '哔哩哔哩'
export function apply(ctx: Ctx) {
  const stop = new AbortController(),
    cookie = String(ctx.config.cookie || '')
  ctx.effect(() => stop.abort())
  const active = () =>
    !stop.signal.aborted && ctx.root.config.enabled !== false && cookie === String(ctx.config.cookie || '')
  const accountKey =
    /\bDedeUserID=(\d+)\b/.exec(cookie)?.[1] || /\bSESSDATA=([^;]+)/.exec(cookie)?.[1] || 'anonymous'
  const key = createHash('sha256').update(accountKey).digest('hex').slice(0, 24)
  const journal = new Journal(ctx.dataDir(key + '-browsing.json'))
  const api = new Client(() => cookie, fetch, stop.signal),
    videos = new Library(api)
  const shots = frames(ctx, api, stop.signal, key),
    share = sharing(ctx, journal, active)
  const duty = browse(ctx, videos, journal, shots, share, active)
  const state = () => ({
    history: ctx.config.shareHistory
      ? journal.data.history.filter(item => item.public !== false).map((item) => ({
          kind: 'watch',
          at: item.at,
          item: { bvid: item.bvid, title: item.title, author: item.author, cover: item.cover },
        }))
      : [],
  })
  ctx.provide('bilibili', {
    state,
    publicShots: () => (ctx.config.shareHistory ? shots.list().filter((s) => s.public) : []),
  })
  ctx.setInterval(
    60000,
    async () => {
      await duty.run()
    },
    '浏览 B 站',
  )
  ctx.tool(({ target }) => {
    if (!target || !active()) return null
    const field = (description: string) => ({ type: 'string', description })
    const video = field('视频地址或 BV 号，可带 ?p=2')
    const tools: ToolSpec[] = [
      {
        name: 'bili_watch',
        description: '查看 B 站视频资料、指定分 P、字幕和热评',
        properties: { link: video },
        required: ['link'],
        execute: ({ link }) => videos.watch(String(link)),
      },
      {
        name: 'bili_search',
        description: '搜索 B 站视频，可不填关键词查看热门',
        properties: { query: field('关键词') },
        execute: ({ query }) => videos.list(String(query || '')).then((list) => list.slice(0, 8)),
      },
    ]
    if (ctx.config.shareHistory && ctx.config.vision)
      tools.push({
        name: 'bili_send_shot',
        description: '在当前聊天发送一张已有的公开视频帧',
        properties: { query: field('视频名称或 BV 号') },
        async execute({ query }) {
          const item = shots
            .list()
            .find((s) => s.public && (s.title + ' ' + s.bvid).includes(String(query || '')))
          if (!item) return { ok: false, message: '没有匹配的视频帧' }
          const [receipt] = await ctx.broadcast(
            [target],
            ctx.h.image('data:image/jpeg;base64,' + readFileSync(item.path).toString('base64')),
          )
          return receipt
        },
      })
    return tools
  })
  ctx.server.get('/state', () => ({
    history: journal.data.history,
    pending: journal.pending(),
    counts: journal.data.counts,
    shots: shots.list().slice(0, 80).map(({ md5, bvid, title, second }) => ({ md5, bvid, title, second })),
    lastRun: journal.data.lastRun,
  }))
  ctx.server.get('/account', () => api.account())
  ctx.server.post('/browse', () => duty.run(true))
  ctx.server.post('/decide', async (req) => {
    const { id, accept } = await ctx.http.body(req)
    if (typeof accept !== 'boolean') throw Error('请选择同意或跳过')
    return share.decide(String(id), accept)
  })
}
