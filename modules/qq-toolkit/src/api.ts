import type { Ctx } from '@aurabot/plugin-api'
import { QQ_API, paramsOf } from './actions.js'
import { clip, fail, resolve, textBlocks, type Where } from './shared.js'

const RESULT_CHARS = 3000
const USER_TARGET = new Set(['forward_friend_single_msg', 'send_private_forward_msg', 'send_forward_msg', 'send_custom_face', 'friend_poke', 'send_like', 'send_tuwen_ark', 'set_friend_remark', 'set_qzone_ban'])
const GROUP_TARGET = new Set(['forward_group_single_msg', 'send_group_forward_msg', 'send_forward_msg', 'send_custom_face', 'group_poke', 'send_tuwen_ark', 'set_group_remark', 'set_group_card', 'set_group_admin', 'set_group_kick_members', 'set_group_name', 'set_group_whole_ban'])
const FORWARD = ['messages', 'message', 'source', 'summary', 'prompt', 'news']

export const TEXT_FIELDS: Record<string, string[]> = {
  send_forward_msg: FORWARD,
  send_group_forward_msg: FORWARD,
  send_private_forward_msg: FORWARD,
  send_group_ai_record: ['text'],
  get_ai_record: ['text'],
  send_tuwen_ark: ['title', 'desc', 'summary', 'preview_url', 'jump_url'],
  set_group_name: ['group_name'],
  set_friend_remark: ['remark'],
  set_group_card: ['card'],
  set_group_remark: ['remark'],
}

type Params = Record<string, unknown>
type Global = { enabled?: boolean; allow?: { private?: unknown[]; groups?: unknown[] } }
const present = (value: unknown) => value !== undefined && value !== null && value !== ''

export function outboundRefusal(action: string, params: Params, cfg: Global) {
  const people = (cfg.allow?.private || []).map(String)
  const groups = (cfg.allow?.groups || []).map(String)
  const user = params.user_id ?? params.target_id
  if (USER_TARGET.has(action) && present(user) && !people.includes(String(user))) return '只能发给白名单里的好友'
  if (GROUP_TARGET.has(action) && present(params.group_id) && !groups.includes(String(params.group_id))) return '只能发给白名单里的群'
  return ''
}

export function refusal(action: string, params: Params, cfg: Global, owner: boolean, groupId?: string) {
  const entry = QQ_API[action]
  if (!entry) return '这个接口不开放'
  const missing = paramsOf(action).find((p) => p.required && !present(params[p.name]))
  if (missing) return `缺参数 ${missing.name}`
  if (owner) return entry[0] === 'owner' && !cfg.enabled ? '总开关关着，不真的执行' : outboundRefusal(action, params, cfg)
  if (entry[0] !== 'open') return '这个只有主人开口才能用'
  if (action !== 'translate_en2zh' && (!groupId || String(params.group_id) !== groupId)) return '只能查当前这个群'
  return ''
}

function scrub(value: unknown, clean: (text: string) => string): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        return JSON.stringify(scrub(JSON.parse(trimmed), clean))
      } catch {}
    }
    return clean(value)
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, clean))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'type' ? item : scrub(item, clean)]))
  return value
}

export function cleanParams(action: string, params: Params, clean: (text: string) => string) {
  const fields = TEXT_FIELDS[action]
  if (!fields) return { ok: true, params, changed: false }
  const out = { ...params }
  let changed = false
  for (const field of fields) {
    if (!Object.hasOwn(params, field)) continue
    const before = params[field]
    const after = scrub(before, (text) => String(clean(String(text ?? '')) ?? ''))
    if (typeof after === 'string' && !after.trim() && String(before ?? '').trim())
      return { ok: false, message: '内容里有工具调用文字或提示词复读，已拦下' }
    if (JSON.stringify(after) !== JSON.stringify(before)) changed = true
    out[field] = after
  }
  return { ok: true, params: out, changed }
}

export function pickParams(action: string, params: Params) {
  return Object.fromEntries(paramsOf(action).filter((p) => params[p.name] !== undefined).map((p) => [p.name, params[p.name]]))
}

function tools(ctx: Ctx, where: Where) {
  const { bot, target, owner } = where
  const groupId = target.type === 'group' ? target.id : undefined
  return [
    {
      name: 'qq_api_find',
      description: '检索本轮权限范围内可用的 QQ 接口（比如 精华、公告、撤回、荣誉、群文件），返回接口名、参数和说明。无匹配不代表 QQ 账号没有该功能，也不代表已查询好友关系或账号状态。',
      properties: { keyword: { type: 'string', description: '关键词，中文或接口名的一部分' } },
      required: ['keyword'],
      render: textBlocks,
      execute: async ({ keyword }: { keyword?: string }) => {
        const key = String(keyword || '').trim()
        const hits = Object.entries(QQ_API)
          .filter(([name, entry]) => (owner || entry[0] === 'open') && (name.includes(key) || entry[2].includes(key)))
          .slice(0, 12)
        if (!hits.length)
          return { ok: true, matched: false, message: '当前会话的可用接口中没有匹配项。这不是账号状态或功能是否存在的查询结果；同一需求不要反复换同义词重查，无法核实时如实说明。' }
        return { ok: true, message: hits.map(([name, entry]) => `${name}(${entry[1]})：${entry[2]}`).join('\n') }
      },
    },
    {
      name: 'qq_api_call',
      description: '调用 QQ 接口。先用 qq_api_find 查到接口名和参数。param 是 JSON 对象文字，比如 {"group_id":123456}。',
      properties: {
        action: { type: 'string', description: '接口名' },
        param: { type: 'string', description: '参数，JSON 对象文字' },
      },
      required: ['action'],
      render: textBlocks,
      execute: async ({ action, param }: { action?: string; param?: string }) => {
        let params: unknown
        try {
          params = JSON.parse(String(param || '{}'))
        } catch {
          return fail('param 不是合法的 JSON')
        }
        if (!params || typeof params !== 'object' || Array.isArray(params)) return fail('param 要是 JSON 对象')
        const name = String(action || '')
        const denied = refusal(name, params as Params, ctx.root.config, owner, groupId)
        if (denied) return fail(denied)
        const cleaned = cleanParams(name, pickParams(name, params as Params), (text) => ctx.text.clean(text, 'qq_api'))
        if (!cleaned.ok) return fail(cleaned.message!)
        if (ctx.bots.get(bot.id, 'qq') !== bot) return fail('机器人连接已经变化')
        ctx.logger.info(`qq_api：${target.type}:${target.id} 调用 ${name}`)
        const data = await bot.internal(name, cleaned.params, { timeoutMs: 15000 })
        return { ok: true, message: clip(JSON.stringify(data ?? null), RESULT_CHARS) }
      },
    },
  ]
}

export function useApi(ctx: Ctx) {
  ctx.tool((context) => {
    const where = ctx.config.api && resolve(ctx, context)
    return where ? tools(ctx, where) : []
  })
  ctx.rule((kind) =>
    ctx.config.api
      ? kind === 'social'
        ? '- 群公告、精华、荣誉、群文件这些，用 qq_api_find 查接口再用 qq_api_call 调；别人只能查当前这个群。'
        : '- QQ 上想做的事（撤回、设精华、改群名片、点赞、表情回应、查群公告等）没有专门工具时，用 qq_api_find 查接口再用 qq_api_call 调。'
      : '',
  )
}
