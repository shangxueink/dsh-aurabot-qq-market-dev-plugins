import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function fixture(dir = mkdtempSync(join(tmpdir(), 'ab-tickets-'))) {
  const routes = new Map(), builders = [], sent = []
  const handlers = {}
  const owners = [{ platform: 'sandbox', botId: 'A', userId: 'owner' }, { platform: 'sandbox', botId: 'B', userId: 'owner' }]
  const ctx = { root: { config: { owners } }, config: {}, dataDir: () => dir, logger: { warn() {} },
    on: (e, fn) => handlers[e] = fn, command: () => ({ description: () => ({ action: fn => handlers.submit = fn }) }),
    tool: fn => builders.push(fn), defineTool: spec => spec, chat: { turnSenders: () => ['friend'] },
    isOwner: (id, platform, botId) => owners.some(o => o.platform === platform && o.botId === botId && o.userId === id),
    server: { get: (p, fn) => routes.set(p, fn), post: (p, fn) => routes.set(p, fn) },
    http: { body: async req => req }, text: { sent: Boolean }, updateConfig: patch => Object.assign(ctx.config, patch),
    sendTo: async (target, content) => { sent.push({ target, content }); return 'receipt' },
    media: { download: async () => Buffer.from([137, 80, 78, 71]) },
  }
  apply(ctx)
  const tools = target => Object.fromEntries(builders.flatMap(fn => fn({ target, sessionId: 's' })).map(t => [t.name.replace('shangxue_tell_owner','') || 'submit', t.execute]))
  const target = { platform: 'sandbox', botId: 'A', type: 'group', id: 'same-id' }
  const owner = { ...target, type: 'private', id: 'owner' }
  function receive(t = target, extra = {}) {
    const msg = { target: t, userId: 'friend', userName: '朋友', messageId: 'origin', content: '原话', elements: [], ...extra }
    handlers.message(msg)
    return msg
  }
  return {dir, ctx, sent, tools, target, owner, receive, routes, handlers}
}

test('一张工单始终由原账号转给主人、引用回复原频道；同平台同主人另一账号隔离', async () => {
  const { receive, target, owner, tools, sent, dir } = fixture()
  receive()
  const first = await tools(target).submit({ summary: '反馈内容' })
  assert.ok(first.ok)
  assert.deepEqual(sent[0].target, owner)
  const reopened = fixture(dir)
  assert.equal(reopened.tools(owner)._tickets_list().length, 1)
  const other = tools({ ...owner, botId: 'B' })
  assert.deepEqual(other._tickets_list(), [])
  assert.equal((await other._back({ ticketId: first.ticketId, replyText: '不应发出' })).ok, false)
  assert.equal((await tools(owner)._back({ ticketId: first.ticketId, replyText: '已处理' })).ok, true)
  assert.deepEqual(sent[1].target, target)
  assert.deepEqual(sent[1].content.map(x => x.type), ['quote','at','text'])
  assert.deepEqual(tools(owner)._tickets_list(), [])
})

test('群工具只接受本回合的唯一发起人', async () => {
  const { ctx, receive, target, tools, sent } = fixture()
  receive()
  for (const senders of [[], ['friend', 'other'], ['other']]) {
    ctx.chat.turnSenders = () => senders
    assert.equal((await tools(target).submit({ summary: '群反馈' })).ok, false)
  }
  assert.equal(sent.length, 0)
})

test('反馈指令把处理结果发回原会话', async () => {
  const {handlers,receive,sent} = fixture(); const replies = []
  await handlers.submit({session:{...receive(), send: text => replies.push(text)},args:'建议'})
  assert.equal(sent.length,1); assert.match(replies[0],/工单 #1/)
})

test('附件从入站元素读取；失败回滚；同一发起人限额按账号分开', async () => {
  const { ctx, receive, routes, tools, target, sent } = fixture()
  receive(target, { elements: [{ type:'image', attrs:{ src:'https://example.test/image' } }] })
  await routes.get('/set-limit')({perUserPerDay:1})
  const submit = () => tools(target).submit({summary:'附件'})
  const send = ctx.sendTo
  ctx.sendTo = async () => null
  assert.equal((await submit()).ok,false)
  ctx.sendTo = send
  assert.ok((await submit()).ok)
  assert.equal(sent[0].content[1].type,'image')
  assert.equal((await submit()).ok,false)
  receive({...target,botId:'B'})
  assert.ok((await tools({...target,botId:'B'}).submit({summary:'B'})).ok)
  const rows = (await routes.get('/board')()).rows
  assert.equal(rows.length,2)
  const a = rows.find(r=>JSON.parse(r.userId)[1]==='A')
  await routes.get('/reset')({userId:a.userId})
  assert.ok((await submit()).ok)
})

test('私聊开关、非主人权限和撤回范围', async () => {
  const { ctx, receive, target, owner, tools } = fixture()
  const dm = {...target,type:'private',id:'friend'}
  assert.equal(tools(owner).submit, undefined)
  ctx.config.privateEnabled = false
  assert.equal(tools(dm).submit, undefined)
  receive(); const result = await tools(target).submit({summary:'撤回测试'})
  assert.equal(tools(dm)._back, undefined)
  assert.equal(tools({...dm,id:'stranger'})._delete, undefined)
  assert.deepEqual(tools(dm)._delete({ids:[result.ticketId]}).deleted,[result.ticketId])
})
