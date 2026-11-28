import type { Ctx } from '@aurabot/plugin-api'
import { today, type Account } from './account.js'
interface Comment {
  comment_id?: string
  uin: string | number
  time: number
  name: string
  content: string
  replies?: Comment[]
}
interface Feed {
  appid: number
  uin: string | number
  key: string
  time: number
  html?: string
  nickname: string
}
interface Post {
  tid: string
  time: number
  content: string
  comment_num: number
  images?: unknown[]
}
interface Detail {
  comments?: Comment[]
  content?: string
}
interface Interaction {
  kind: 'reply' | 'comment' | 'like'
  who: string
  post: string
  text: string
}
interface State {
  day: string
  count: number
  lastRun: number
  replied: Record<string, string[]>
  seen: string[]
  history: (Interaction & { at: number })[]
}
interface SummaryOptions {
  selfId: string
  isOwner: (id: string | number) => boolean
  ownerName: string
  exclude?: string
  max?: number
}
interface Memory {
  addEvent(event: {
    text: string
    about: string
    aboutName: string
    tags: string[]
    importance?: number
  }): unknown
}

export function pendingInThread(comment: Comment, selfId: string, handled = new Set<string>()) {
  const cid = String(comment.comment_id ?? `${comment.uin}-${comment.time}`)
  const thread = [
    { ...comment, id: cid },
    ...(comment.replies || []).map((r) => ({ ...r, id: `${cid}/${r.comment_id ?? `${r.uin}-${r.time}`}` })),
  ].sort((a, b) => Number(a.time || 0) - Number(b.time || 0))
  let lastMine = -1
  thread.forEach((x, i) => {
    if (String(x.uin) === String(selfId)) lastMine = i
  })
  const pending = thread
    .slice(lastMine + 1)
    .filter((x) => String(x.uin) !== String(selfId) && !handled.has(x.id))
  return { thread, pending }
}

export function summarizeComments(
  comments: Comment[] | undefined,
  { selfId, isOwner, ownerName, exclude = '', max = 8 }: SummaryOptions,
) {
  const who = (u: Comment) =>
    String(u.uin) === String(selfId)
      ? '你'
      : `${u.name || u.uin}${isOwner(u.uin) ? `（你的${ownerName}）` : ''}`
  const lines = []
  for (const c of comments || []) {
    if (String(c.comment_id ?? '') === String(exclude)) continue
    lines.push(`${who(c)}：${String(c.content).slice(0, 80)}`)
    for (const r of c.replies || []) lines.push(`  └ ${who(r)}：${String(r.content).slice(0, 80)}`)
  }
  return lines.length > max ? [...lines.slice(0, max), `……还有 ${lines.length - max} 条`] : lines
}

export function pickFeeds(feeds: Feed[] | undefined, selfId: string, now = Date.now()) {
  return (feeds || []).filter(
    (f) =>
      f &&
      f.appid === 311 &&
      Number(f.uin) > 0 &&
      String(f.uin) !== String(selfId) &&
      f.key &&
      now / 1000 - Number(f.time || 0) < 86400,
  )
}

export function createSocial(ctx: Ctx, account: Account) {
  const { bot, settings } = account
  const log = ctx.logger
  const self = () => bot.selfId
  const owner = () => String(ctx.root.config.ownerName || '主人')
  const ownerId = (id: number | string) => ctx.isOwner(id, 'qq', bot.id)
  const remember = (who: string, uid: string | number, text: string) =>
    ctx.chatLog.append({ platform: bot.platform, botId: bot.id, type: 'channel', id: 'qzone/' + bot.selfId }, who, text, String(uid))
  const load = () =>
    account.load<State>('social', () => ({
      day: '',
      count: 0,
      lastRun: 0,
      replied: {},
      seen: [],
      history: [],
    }))
  const save = (s: State) => account.save('social', s)
  let busy = false

  async function write(prompt: string) {
    const out = await ctx.think(prompt + '\n只输出一两句评论正文，不想评论就只回 [沉默]。', {
      key: 'qzone-social/' + bot.id,
      title: '空间互动',
      timeoutMs: 120000,
      noTools: true,
    })
    const text = ctx.text
      .clean(out, '空间评论')
      .replace(/\|\|\|/g, ' ')
      .replace(/<[^>]+>/g, '')
      .trim()
    return ctx.text.isSilence(text)
      ? ''
      : text.split(/\n+/).filter(Boolean).slice(0, 2).join(' ').slice(0, 60)
  }
  function record(s: State, item: Interaction, counts = true) {
    s.history.unshift({ at: Date.now(), ...item })
    s.history = s.history.slice(0, 30)
    if (counts) s.count++ // 只有评论算进每天的上限，点赞不算
  }

  async function sendComment(tid: string, content: string, targetUin?: string | number) {
    await account.call(
      'comment_qzone',
      { tid, content, ...(targetUin ? { target_uin: Number(targetUin) } : {}) },
      30000,
    )
    log.info(`空间评论（${targetUin || '自己的说说'}）：${content}`)
    return true
  }

  async function replyOwn(s: State, budget: number) {
    let done = 0
    const list = await account.call<{ msglist?: Post[] }>('get_qzone_msg_list', { num: 5 }, 20000)
    for (const m of list?.msglist || []) {
      if (done >= budget) break
      if (!(m.comment_num > 0) || Date.now() / 1000 - m.time > 3 * 86400) continue
      const d = await account.call<Detail>('get_qzone_msg_detail', { tid: m.tid, num: 30 }, 20000)
      const handled = new Set(s.replied[m.tid] || [])
      for (const c of d?.comments || []) {
        if (done >= budget) break
        const t = pendingInThread(c, self(), handled)
        if (!t.pending.length) continue
        for (const id of t.pending.map((x) => x.id)) handled.add(id) // 这一串新消息只回一次，回不回都不再看
        for (const x of t.pending)
          remember(
            x.name,
            x.uin,
            `在你的说说「${String(m.content).slice(0, 30)}」下面说：${String(x.content).slice(0, 200)}`,
          )
        const last = t.pending[t.pending.length - 1]
        const name = (u: Comment) =>
          String(u.uin) === self() ? '你' : u.name + (ownerId(u.uin) ? `（你的${owner()}）` : '')
        const thread = t.thread.map((x) => `${name(x)}：${String(x.content).slice(0, 150)}`).join('\n')

        const others = summarizeComments(d.comments, {
          selfId: self(),
          isOwner: ownerId,
          ownerName: owner(),
          exclude: c.comment_id,
          max: 6,
        })
        const text = await write(
          `你在 QQ 空间发过一条说说：「${String(m.content).slice(0, 200)}」${m.images?.length ? `（配了 ${m.images.length} 张图）` : ''}\n` +
            (others.length ? `这条说说下面大家的评论：\n${others.join('\n')}\n\n` : '') +
            `你要回的是这一串：\n${thread}\n\n${last.name} 刚刚说了新的话，结合说说内容和上面的评论，用你的口气接着回 TA 一句。`,
        )
        if (!text) continue
        await sendComment(m.tid, `回复 ${last.name}：${text}`)
        s.replied[m.tid] = [...handled].slice(-200)
        save(s)
        ctx.get<Memory>('memory')?.addEvent({
          text: `在空间回复了${last.name}的评论：${text}`,
          about: String(last.uin),
          aboutName: last.name,
          tags: ['空间'],
          importance: 0.35,
        })
        record(s, { kind: 'reply', who: last.name, post: String(m.content).slice(0, 30), text })
        done++
      }
      s.replied[m.tid] = [...handled].slice(-200)
    }

    const keep = new Set((list?.msglist || []).map((m) => m.tid))
    for (const tid of Object.keys(s.replied)) if (!keep.has(tid)) delete s.replied[tid]
    return done
  }

  async function browseFriends(s: State, budget: number) {
    const c = settings()
    let done = 0
    const res = await account.call<{ feeds?: Feed[] }>('get_qzone_feeds', { count: 15 }, 20000)
    const seen = new Set(s.seen)
    for (const f of pickFeeds(res?.feeds, self())) {
      if (done >= budget) break
      if (seen.has(f.key)) continue
      seen.add(f.key)
      const brief = String(f.html || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      remember(f.nickname, f.uin, '发了说说：' + brief.slice(0, 300))
      const isOwner = ownerId(f.uin)
      const chance = isOwner ? Math.max(c.friendChance, c.ownerChance) : c.friendChance
      if (Math.random() >= chance) continue
      let content = ''
      let images = 0
      let existing: string[] = []
      try {
        const d = await account.call<Detail>(
          'get_qzone_msg_detail',
          { tid: f.key, target_uin: Number(f.uin), num: 10 },
          20000,
        )
        content = String(d?.content || '')
        existing = summarizeComments(d?.comments, {
          selfId: self(),
          isOwner: ownerId,
          ownerName: owner(),
          max: 8,
        })
      } catch (error) {
        content = String(f.html || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      }
      images = (String(f.html || '').match(/<img/g) || []).length
      let liked = false
      if (c.like) {
        try {
          await account.call(
            'like_qzone',
            { tid: f.key, target_uin: Number(f.uin), abstime: Number(f.time) || 0 },
            20000,
          )
          liked = true
        } catch (error) {
          log.debug('点赞失败：', error instanceof Error ? error.message : String(error))
        }
      }
      const text = await write(
        `你在刷 QQ 空间，看到${isOwner ? `你的${owner()}` : `好友 ${f.nickname}`}发的说说：「${content.slice(0, 300) || '（只有图片）'}」${images ? `（配了图）` : ''}\n` +
          (existing.length ? `下面已经有这些评论：\n${existing.join('\n')}\n\n` : '') +
          `想评论的话，结合说说内容${existing.length ? '和下面大家在聊的（别重复别人说过的话，可以接大家的梗）' : ''}，用你的口气评一句（像朋友之间随手评论那样）。`,
      )
      if (!text) {
        if (liked) record(s, { kind: 'like', who: f.nickname, post: content.slice(0, 30), text: '' }, false)
        continue
      }
      await sendComment(f.key, text, f.uin)
      s.seen = [...seen].slice(-300)
      save(s)
      ctx.get<Memory>('memory')?.addEvent({
        text: `在空间评论了${isOwner ? owner() : f.nickname}的说说「${content.slice(0, 24)}」：${text}`,
        about: String(f.uin),
        aboutName: f.nickname,
        tags: ['空间'],
      })
      record(s, { kind: 'comment', who: f.nickname, post: content.slice(0, 30), text })
      done++
    }
    s.seen = [...seen].slice(-300)
    return done
  }

  async function run() {
    const c = settings()
    if (busy) return { ok: false, message: '正在逛空间' }
    if (ctx.root.config.enabled === false || !c.social) return { ok: false, message: '没打开' }
    const s = load()
    busy = true
    if (s.day !== today()) Object.assign(s, { day: today(), count: 0 })
    s.lastRun = Date.now()
    try {
      const left = Math.max(0, c.maxPerDay - s.count)
      if (!left) return { ok: true, message: '今天互动够多了', replies: 0, comments: 0 }
      const replies = c.replyOwn ? await replyOwn(s, Math.min(3, left)) : 0
      const comments = c.commentFriends
        ? await browseFriends(s, Math.min(2, Math.max(0, c.maxPerDay - s.count)))
        : 0
      return { ok: true, message: `回了 ${replies} 条评论，评了 ${comments} 条好友说说`, replies, comments }
    } catch (error) {
      log.warn('逛空间出错：', error instanceof Error ? error.message : String(error))
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      try {
        save(s)
      } finally {
        busy = false
      }
    }
  }

  async function tick() {
    const c = settings()
    if (ctx.root.config.enabled === false || !c.social) return
    const hour = new Date().getHours()
    const start = c.awakeFrom % 24
    const end = c.awakeTo % 24
    if (start < end ? hour < start || hour >= end : start > end && hour >= end && hour < start) return
    if (Date.now() - load().lastRun < c.intervalMin * 60_000) return
    await run()
  }

  return {
    run,
    tick,
    state: () => {
      const s = load()
      return { count: s.day === today() ? s.count : 0, lastRun: s.lastRun, history: s.history.slice(0, 15) }
    },
  }
}
