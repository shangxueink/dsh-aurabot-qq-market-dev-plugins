import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

test('自定义指令只允许主人修改当前账号的当前会话，卸载后失效', async () => {
  const bot = { id: 'account-two', platform: 'test-platform', selfId: 'self', status: 'online' }
  const target = { type: 'channel', platform: bot.platform, botId: bot.id, id: 'design' }
  const selected = { provider: 'local', model: 'test-model' }
  let run, dispose, owner = false
  const writes = []
  const model = { list: async () => [selected], set: (...args) => writes.push(args), get: () => null }
  const session = { bot, target, isPrivate: false, async send() {} }
  apply({ config: { command: '选模型', groupChats: true }, bots: { get: () => bot }, isOwner: () => owner,
    llm: { config: { model } }, effect(fn) { dispose = fn }, command(signature) {
      assert.equal(signature, '选模型 [choice:text]')
      return { alias() { return this }, action(fn) { run = fn } }
    },
  })
  await run({ session, args: '1' })
  assert.equal(writes.length, 0)
  owner = true
  await run({ session, args: '1' })
  await run({ session, args: '默认' })
  assert.deepEqual(writes, [[target, 'self', selected], [target, 'self', null]])
  dispose()
  await run({ session, args: '1' })
  assert.equal(writes.length, 2)
})

test('只回复序号也可以选择模型和该模型的思考强度', async () => {
  const bot = { id: 'second', platform: 'test', selfId: 'me', status: 'online' }
  const target = { platform: 'test', botId: 'second', type: 'group', id: 'room' }
  const row = { provider: 'local', model: 'example', reasoning: { efforts: ['low', 'high'] } }
  const writes = [], sent = [], answers = ['1', '2']
  const model = { get: () => null, list: async () => [row], set: (...args) => writes.push(args), setEffort: (...args) => writes.push(args) }
  let run
  apply({ config: { groupChats: true }, isOwner: () => true, bots: { get: () => bot },
    llm: { config: { model } }, effect() {}, command() { return { alias() { return this }, action(fn) { run = fn } } } })
  await run({ session: { bot, target, isPrivate: false, send: text => sent.push(text), prompt: () => answers.shift() }, args: '' })
  assert.equal(sent.length, 3)
  assert.deepEqual(writes, [[target, 'me', row], [target, 'me', row, 'high']])
})
