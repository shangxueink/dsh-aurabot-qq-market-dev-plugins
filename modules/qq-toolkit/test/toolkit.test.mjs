import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cleanParams, refusal } from '../lib/api.js'
import { config } from '../lib/config.js'
import { apply } from '../lib/index.js'
import { pick } from '../lib/requests.js'

globalThis.h = { select: () => [], image: (url) => ({ type: 'image', attrs: { url } }) }
const strip = (text) => text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')

function host({ owner = true, settings = {}, calls = [], sent = [] } = {}) {
  const listeners = {}
  const factories = []
  const bot = {
    id: 'qq-a', platform: 'qq', selfId: '10001', status: 'online',
    internal: async (action, params) => {
      calls.push([action, params])
      return action === 'get_group_member_info' ? { role: 'admin' } : action === 'get_doubt_friends_add_request' ? [] : {}
    },
  }
  const dir = mkdtempSync(join(tmpdir(), 'qq-toolkit-'))
  const ctx = {
    config: { ...config.defaults(), ...settings },
    root: { config: { enabled: true, owners: [{ platform: 'qq', userId: '1' }], allow: { private: ['1', '2'], groups: ['9'] } } },
    bots: { get: (id, platform) => (id === bot.id && platform === 'qq' ? bot : undefined), list: () => [bot] },
    turnFromOwner: () => owner,
    isOwner: (id) => String(id) === '1',
    text: { clean: strip, sent: (receipt) => Boolean(receipt) },
    tool: (fn) => factories.push(fn),
    prompt() {}, rule() {}, middleware() {},
    on: (name, fn) => { listeners[name] = fn },
    server: { get() {} },
    sendTo: async (target, content) => { sent.push([target, content]); return { id: 'm' } },
    dataDir: (name) => join(dir, name),
    media: { download: async () => Buffer.from('x'), inspect: () => ({ mime: 'image/png' }) },
    logger: { info() {}, warn() {}, debug() {} },
  }
  apply(ctx)
  const tools = (target, sessionId = 's') => factories.flatMap((fn) => fn({ sessionId, level: 'full', target: { platform: 'qq', botId: 'qq-a', ...target } }) || [])
  const tool = (target, name) => tools(target).find((item) => item.name === name)
  return { ctx, listeners, tools, tool, calls, sent, bot }
}

test('qq_api_call 的外显文本先清洗，整段违规时拒绝', () => {
  const block = '<tool_call>x</tool_call>'
  const messages = JSON.stringify([{ type: 'node', data: { content: [{ type: 'text', data: { text: `前${block}后` } }] } }])
  const cleaned = cleanParams('send_group_forward_msg', { group_id: 9, messages }, strip)
  assert.equal(cleaned.ok, true)
  assert.match(cleaned.params.messages, /前后/)
  assert.equal(cleanParams('send_tuwen_ark', { title: block }, strip).ok, false)
  assert.equal(cleanParams('delete_msg', { message_id: 1 }, strip).changed, false)
})

test('非主人只能调 open 接口且只查当前群；主人也不能发到白名单外', () => {
  const cfg = { enabled: true, allow: { private: ['1'], groups: ['9'] } }
  assert.equal(refusal('get_cookies', {}, cfg, true), '这个接口不开放')
  assert.equal(refusal('delete_msg', { message_id: 1 }, cfg, false, '9'), '这个只有主人开口才能用')
  assert.equal(refusal('_get_group_notice', { group_id: 8 }, cfg, false, '9'), '只能查当前这个群')
  assert.equal(refusal('_get_group_notice', { group_id: 9 }, cfg, false, '9'), '')
  assert.equal(refusal('send_like', { user_id: 5 }, cfg, true), '只能发给白名单里的好友')
})

test('接口工具只挂在在线的 QQ 实例上，并真正调用网关', async () => {
  const { tools, tool, calls } = host()
  assert.deepEqual(tools({ botId: 'other', type: 'group', id: '9' }), [])
  const result = await tool({ type: 'group', id: '9' }, 'qq_api_call').execute({ action: 'delete_msg', param: '{"message_id":3}' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.at(-1), ['delete_msg', { message_id: 3 }])
})

test('群管只听主人，不能对主人下手，管理员不能改头衔', async () => {
  const stranger = host({ owner: false })
  assert.equal((await stranger.tool({ type: 'group', id: '9' }, 'qq_group_admin').execute({ action: 'ban', user_id: '2' })).ok, false)
  const { tool, calls } = host()
  const admin = tool({ type: 'group', id: '9' }, 'qq_group_admin')
  assert.equal((await admin.execute({ action: 'kick', user_id: '1' })).message, '不能对主人做这个')
  assert.equal((await admin.execute({ action: 'title', user_id: '2', text: 'x' })).ok, false)
  assert.equal((await admin.execute({ action: 'ban', user_id: '2', minutes: 5 })).ok, true)
  assert.deepEqual(calls.at(-1), ['set_group_ban', { group_id: 9, user_id: 2, duration: 300 }])
  assert.equal((await admin.execute({ action: 'ban', group_id: '8', user_id: '2' })).message, '这个群不在白名单里')
})

test('好友申请来自标准 friend-request 事件，主人私聊里处理', async () => {
  const { listeners, tool, calls, sent, bot } = host()
  listeners['friend-request']({ platform: 'qq', bot, userId: '23456', messageId: 'f1', data: { message: { content: '你好' } } })
  listeners['friend-request']({ platform: 'qq', bot, userId: '23456', messageId: 'f1', data: {} })
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0][0], { platform: 'qq', botId: 'qq-a', type: 'private', id: '1' })
  const owner = { type: 'private', id: '1' }
  assert.match((await tool(owner, 'qq_list_friend_requests').execute({})).message, /QQ 23456.*f1/)
  assert.equal((await tool(owner, 'qq_handle_friend_request').execute({ approve: true })).ok, true)
  assert.deepEqual(calls.at(-1), ['set_friend_add_request', { flag: 'f1', approve: true }])
  assert.match((await tool(owner, 'qq_list_friend_requests').execute({})).message, /没有/)
  assert.equal(tool({ type: 'private', id: '2' }, 'qq_list_friend_requests'), undefined)
})

test('加群申请与邀请分别走 guild-member-request 和 guild-request', async () => {
  const { listeners, tool, calls, bot } = host()
  listeners['guild-member-request']({ platform: 'qq', bot, userId: '23456', guildId: '9', messageId: 'g1', data: {} })
  listeners['guild-request']({ platform: 'qq', bot, userId: '34567', guildId: '7', messageId: 'g2', data: {} })
  const owner = { type: 'private', id: '1' }
  const listed = (await tool(owner, 'qq_list_group_requests').execute({})).message
  assert.match(listed, /申请加入群 9/)
  assert.match(listed, /邀请我加入群 7/)
  assert.equal((await tool(owner, 'qq_handle_group_request').execute({ approve: true })).ok, false)
  assert.equal((await tool(owner, 'qq_handle_group_request').execute({ flag: 'g2', approve: false, reason: '不认识' })).ok, true)
  assert.deepEqual(calls.at(-1), ['set_group_add_request', { flag: 'g2', sub_type: 'invite', approve: false, reason: '不认识' }])
})

test('资料权限按插件设置分级', async () => {
  const off = host({ settings: { nickname: 'off' } })
  assert.equal(off.tool({ type: 'private', id: '1' }, 'qq_set_nickname'), undefined)
  const all = host({ owner: false, settings: { signature: 'all' } })
  assert.ok(all.tool({ type: 'group', id: '9' }, 'qq_set_signature'))
  assert.equal(all.tool({ type: 'group', id: '9' }, 'qq_set_nickname'), undefined)
  const { tool, calls } = host()
  assert.equal((await tool({ type: 'private', id: '1' }, 'qq_set_nickname').execute({ name: '小光' })).ok, true)
  assert.deepEqual(calls.at(-1), ['set_qq_profile', { nickname: '小光' }])
  assert.equal((await tool({ type: 'private', id: '1' }, 'qq_set_avatar').execute({ image: 'C:/a.png' })).ok, false)
})

test('申请按序号、flag、QQ 号挑选', () => {
  const list = [{ flag: 'a', userId: '0' }, { flag: 'b', userId: '23456' }]
  assert.equal(pick(list, { index: 2 }).flag, 'b')
  assert.equal(pick(list, { qq: '23456' }).flag, 'b')
  assert.equal(pick(list, { flag: 'a' }).userId, '0')
  assert.equal(pick(list, {}), undefined)
})
