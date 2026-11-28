import assert from 'node:assert/strict'
import test from 'node:test'
import { audience, createDiary, schedule } from '../lib/diary.js'
import { config } from '../lib/config.js'
import { createSocial, pendingInThread } from '../lib/social.js'
import { clip } from '../lib/media/sources.js'
import { parseDraft, reselectPictures, withCredits } from '../lib/media/draft.js'
import { archiveDate } from '../lib/media/archive.js'

function fixture(settings = {}, handler = () => ({})) {
  const cfg = { ...config.defaults(), ...settings }
  const records = new Map()
  const calls = [],
    memory = []
  const account = {
    bot: { id: 'qq-a', selfId: '123456' },
    settings: () => cfg,
    call: async (action, params) => {
      calls.push({ action, params })
      return handler(action, params)
    },
    load: (key, init) => structuredClone(records.get(key) ?? init()),
    save: (key, value) => records.set(key, structuredClone(value)),
  }
  const ctx = {
    root: { config: { enabled: true } },
    text: { clean: (s) => String(s).trim(), isSilence: (s) => s === '[沉默]' },
    get: (id) => (id === 'memory' ? { add: (e) => memory.push(e), addEvent: (e) => memory.push(e) } : null),
    think: async () => '一阵晚风',
    dataDir: () => '.',
    logger: { info() {}, warn() {}, debug() {} },
    chatLog: { append() {} },
    isOwner: () => false,
  }
  return { cfg, records, calls, memory, account, ctx, diary: createDiary(ctx, account) }
}

test('五种可见范围、好友名单和跨夜排期', () => {
  const { cfg } = fixture()
  for (const [mode, right] of Object.entries({ all: 1, friends: 4, selected: 16, self: 64, excluded: 128 })) {
    const conf = { ...cfg, visibility: mode, audienceQQs: '12345，23456\n12345' }
    assert.equal(audience(conf, 'all').ugc_right, right)
    assert.equal(audience(conf, 'self').ugc_right, 64)
    if (mode === 'selected' || mode === 'excluded') {
      assert.deepEqual(audience(conf).target_uins, [12345, 23456])
      assert.throws(() => audience({ ...conf, audienceQQs: '' }))
    }
  }
  const slots = schedule(
    { ...cfg, windowStart: '23:00', windowEnd: '01:00', timesPerDay: 3, minGapMinutes: 20 },
    () => 0.5,
  )
  assert.equal(new Set(slots).size, 3)
  assert(slots.every((m) => m >= 1380 || m < 60))
})

test('部分远端历史不判删除，并发同步只读取一份列表', async () => {
  let page = { total: 2, msglist: [{ tid: 'a' }] }
  const f = fixture({}, () => page)
  f.records.set('diary', [
    { tid: 'a', at: 1 },
    { tid: 'b', at: 1 },
  ])
  const [first, second] = await Promise.all([f.diary.syncHistory(), f.diary.syncHistory()])
  assert.equal(first.ok, false)
  assert.deepEqual(second, first)
  assert.equal(f.calls.length, 2)
  assert(!f.diary.history().some((row) => row.deletedAt))
  page = { total: 1, msglist: [{ tid: 'a' }] }
  await f.diary.syncHistory()
  assert(f.diary.history()[1].deletedAt)
})

test('补图只从候选中选择并保留出处', () => {
  assert.equal(clip('午🌙夜', 2), '午🌙')
  const a = { id: 'a', caption: '晚风', at: 1 }
  const d = parseDraft('{"text":"晚风","imageIds":["外部文件"]}', [a], 80)
  assert.deepEqual(reselectPictures(d, [a], 1), [a])
  assert.deepEqual(reselectPictures({ ...d, unmatchedCount: 0 }, [a], 1), [])
  const pic = {
    kind: 'browsing',
    title: '夜景',
    platform: 'B站',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
  }
  assert.match(withCredits(d.text, [pic, pic]), /配图摘自B站《夜景》/)
  assert.equal(archiveDate(Date.parse('2026-11-26T17:00:00Z')), '20261127')
})

test('空间评论线程去重，发布成功才计入日额度', async () => {
  const comment = { comment_id: 'c', name: '朋友', uin: 12345, time: Date.now() / 1000, content: '晚上好' }
  assert.equal(pendingInThread(comment, '10002', new Set(['c'])).pending.length, 0)
  const f = fixture({ commentFriends: false }, (action) =>
    action === 'get_qzone_msg_list'
      ? { msglist: [{ tid: 'post', time: Date.now() / 1000, comment_num: 1, content: '今天' }] }
      : action === 'get_qzone_msg_detail'
        ? { comments: [comment] }
        : {},
  )
  const social = createSocial(f.ctx, f.account)
  assert.equal((await social.run()).replies, 1)
  assert.equal((await social.run()).replies, 0)
  assert.equal(social.state().count, 1)
  assert.equal(f.calls.filter((c) => c.action === 'comment_qzone').length, 1)
})

test('日记预览不写历史和记忆，发送才记入对应账号', async () => {
  const f = fixture({ visibility: 'self', attachImage: false }, () => ({ tid: 'published' }))
  const preview = await f.diary.write(true, 'all')
  assert.equal(preview.preview, true)
  assert.equal(f.calls.length, 0)
  await f.diary.write(false, 'all')
  assert.equal(f.calls[0].params.ugc_right, 64)
  assert.equal(f.diary.history()[0].tid, 'published')
  assert.equal(f.memory[0].source, 'diary')
})
