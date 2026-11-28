import { Client, mediaUrl } from './client.js'

interface RawVideo {
  bvid: string
  aid: number
  title: string
  author?: string
  owner?: { name: string }
  stat?: { view: number }
  play?: number
  pubdate: number
  desc?: string
  description?: string
  pic?: string
}
interface Part {
  cid: number
  page: number
  part: string
  duration: number
}
interface Detail extends RawVideo {
  pages: Part[]
}
interface Reply {
  content?: { message: string }
  member?: { uname: string }
}
interface Subtitle {
  subtitle_url: string
  lan: string
}
export interface Video {
  bvid: string
  aid: number
  title: string
  author: string
  views: number
  published: number
  desc: string
  cover: string
}
export interface Watched extends Video {
  cid: number
  part: number
  partTitle: string
  duration: number
  subtitle: string
  comments: string[]
  at: number
}

const text = (s: string | undefined) =>
  String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
const video = (v: RawVideo): Video => ({
  bvid: v.bvid,
  aid: v.aid,
  title: text(v.title),
  author: v.owner?.name || v.author || '',
  views: Number(v.stat?.view ?? v.play) || 0,
  published: v.pubdate * 1000,
  desc: text(v.desc || v.description).slice(0, 800),
  cover: mediaUrl(v.pic) || '',
})
export const link = (v: { bvid: string; part?: number }) =>
  'https://www.bilibili.com/video/' + v.bvid + (v.part && v.part > 1 ? '?p=' + v.part : '')
export function parseVideo(input: string) {
  const id = input.match(/\b(BV[\da-zA-Z]{10}|av\d+)\b/i)?.[1]
  if (!id) throw Error('请提供 BV 号、av 号或视频链接')
  const part = Number(/[?&]p=(\d+)/.exec(input)?.[1] || 1)
  const query: Record<string, string> = /^av/i.test(id) ? { aid: id.slice(2) } : { bvid: id }
  return { query, part }
}
export class Library {
  constructor(readonly client: Client) {}
  async list(keyword = '') {
    if (!keyword.trim()) {
      const data = await this.client.get<{ list: RawVideo[] }>('/x/web-interface/popular', { ps: 20, pn: 1 })
      return (data.list || []).map(video)
    }
    const data = await this.client.get<{ result?: RawVideo[] }>(
      '/x/web-interface/wbi/search/type',
      { keyword: keyword.trim().slice(0, 100), search_type: 'video', page: 1 },
      true,
    )
    return (data.result || []).filter((v) => /^BV[\da-zA-Z]{10}$/.test(v.bvid)).map(video)
  }
  async resolve(input: string) {
    const short = input.match(/https?:\/\/b23\.tv\/([\da-zA-Z]+)/i)
    if (!short) return parseVideo(input)
    const res = await this.client.fetcher('https://b23.tv/' + short[1], {
      redirect: 'manual',
      signal: this.client.signal(),
    })
    const location = new URL(res.headers.get('location') || '/', 'https://b23.tv')
    if (!/(^|\.)bilibili\.com$/.test(location.hostname)) throw Error('短链没有指向 B 站视频')
    return parseVideo(location.href)
  }
  async detail(input: string) {
    const { query, part } = await this.resolve(input)
    const data = await this.client.get<Detail>('/x/web-interface/view', query)
    const page = data.pages?.find((p) => p.page === part)
    if (!page) throw Error('找不到第 ' + part + ' P')
    return { ...video(data), cid: page.cid, part, partTitle: page.part, duration: page.duration }
  }
  async subtitles(bvid: string, cid: number) {
    const data = await this.client.get<{ subtitle?: { subtitles: Subtitle[] } }>(
      '/x/player/wbi/v2',
      { bvid, cid },
      true,
    )
    const list = data.subtitle?.subtitles || []
    const url = mediaUrl((list.find((s) => s.lan.includes('zh')) || list[0])?.subtitle_url)
    if (!url) return ''
    const res = await this.client.fetcher(url, { redirect: 'error', signal: this.client.signal() })
    if (!res.ok) return ''
    const body = (await res.json()) as { body?: { content: string }[] }
    return (body.body || [])
      .map((s) => s.content)
      .join(' ')
      .slice(0, 4200)
  }
  async watch(input: string): Promise<Watched> {
    const v = await this.detail(input)
    const [subtitle, comments] = await Promise.all([
      this.subtitles(v.bvid, v.cid).catch(() => ''),
      this.client
        .get<{ replies?: Reply[] }>('/x/v2/reply/wbi/main', { type: 1, oid: v.aid, mode: 3, plat: 1 }, true)
        .then((data) => (data.replies || []).slice(0, 10).map((r) => text(r.content?.message).slice(0, 180)))
        .catch(() => []),
    ])
    return { ...v, subtitle, comments, at: Date.now() }
  }
}
