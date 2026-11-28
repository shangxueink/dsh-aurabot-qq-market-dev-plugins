import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '../lib/client.js'
import { Library } from '../lib/video.js'
import { Journal } from '../lib/journal.js'
import { sharing } from '../lib/share.js'

const bvid = 'BV1234567890'
const detail = {
  bvid,
  aid: 123,
  cid: 5,
  title: '三月',
  owner: { name: '山' },
  pages: [
    { page: 1, cid: 5, part: '上', duration: 100 },
    { page: 2, cid: 8, part: '下', duration: 25 },
  ],
}
const journal = () => new Journal(join(mkdtempSync(join(tmpdir(), 'bili-spec-')), 'journal.json'))

test('短链解析与字幕 CDN 不携带账号凭据，读取指定分 P 且只访问只读接口', async () => {
  const requests = []
  const fetcher = async (input, init) => {
    const url = new URL(input)
    requests.push({ url, init })
    const json = (data) => Response.json({ code: 0, data })
    switch (url.pathname) {
      case '/v':
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://www.bilibili.com/video/' + bvid + '?p=2' },
        })
      case '/x/web-interface/view':
        return json(detail)
      case '/x/web-interface/nav':
        return json({
          isLogin: true,
          wbi_img: {
            img_url: 'https://i.hdslb.com/' + 'a'.repeat(32) + '.png',
            sub_url: 'https://i.hdslb.com/' + 'b'.repeat(32) + '.png',
          },
        })
      case '/x/player/wbi/v2':
        assert.equal(url.searchParams.get('cid'), '8')
        return json({ subtitle: { subtitles: [{ lan: 'zh', subtitle_url: 'https://i.hdslb.com/sub' }] } })
      case '/sub':
        return Response.json({ body: [{ content: '山色' }] })
      case '/x/v2/reply/wbi/main':
        return json({ replies: [] })
      default:
        throw Error(url.pathname)
    }
  }
  const videos = new Library(new Client(() => 'SESSDATA=test-value', fetcher))
  const viewed = await videos.watch('https://b23.tv/v')
  assert.equal(viewed.part, 2)
  assert.equal(viewed.subtitle, '山色')
  assert.equal(requests.some(r => r.init.method === 'POST'), false)
  for (const { url, init } of requests)
    if (url.hostname !== 'api.bilibili.com') assert.equal(init.headers?.cookie, undefined)
})

test('同号跨平台投递与审批重放', async () => {
  const target = { platform: 'discord', botId: 'same', type: 'channel', id: '42' }
  const owner = { platform: 'telegram', botId: 'same', type: 'private', id: '42' }
  const facts = [], lines = []
  const log = [],
    state = journal()
  let middleware
  const ctx = {
    logger: { warn: assert.fail },
    get: service => ({ persona: { current: target => ({ id: 'card-' + target.platform, name: 'test' }) },
      'room-timeline': { enabled: () => true, read: target => ({room: target.platform + ':' + target.id}), record: (...args) => lines.push(args) },
      'room-memory': { remember: (...args) => facts.push(args) } }[service]),
    config: { destinations: [target, owner], shareLimit: 4, queueLimit: 2, pendingHours: 24 },
    bots: { list: () => [target, owner].map((t) => ({ ...t, id: t.botId, selfId: 'bot-user', status: 'online' })) },
    isOwner: (user, platform) =>
      typeof user === 'object' ? user.platform === owner.platform : platform === owner.platform,
    broadcast: async ([to], message) => {
      log.push([to, message])
      return [{ ok: true }]
    },
    middleware: (fn) => {
      middleware = fn
    },
    h: (type, attrs) => ({ type, attrs }),
  }
  const share = sharing(ctx, state, () => true)
  await share.offer({ bvid, title: '春', part: 2, cover: '', at: Date.now() })
  assert.equal(facts.length, 1)
  assert.deepEqual(facts[0][0], { room: 'telegram:42', persona: 'card-telegram', user: '42' })
  assert(facts[0][1].includes(bvid))
  assert(lines[0][3].text.includes(bvid))
  assert(log.every(([to]) => to.platform === 'telegram'))
  const [{ id }] = state.pending()
  let passed = false
  await middleware({ platform: 'discord', type: 'private', content: '分享 ' + id }, () => {
    passed = true
  })
  assert(passed)
  assert.equal(state.pending().length, 1)
  await middleware(
    { platform: 'telegram', type: 'private', content: '分享 ' + id, send: async () => {} },
    () => {},
  )
  assert.deepEqual(log.at(-1)[0], target)
  await assert.rejects(() => share.decide(id, true), /过期/)
  assert.equal(log.filter(([to]) => to.platform === 'discord').length, 1)
})
