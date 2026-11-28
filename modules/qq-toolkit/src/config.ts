import { Schema } from '@aurabot/plugin-api'

const level = (label: string) =>
  Schema.union(['off', 'owner', 'all'] as const).default('owner').description(label)

export const config = Schema.object({
  api: Schema.boolean().default(true).description('开放协议扩展接口（qq_api_find / qq_api_call）'),
  groupAdmin: Schema.boolean().default(true).description('主人要求时可以禁言、踢人、改头衔、发公告'),
  nickname: level('修改 QQ 昵称'),
  signature: level('修改个性签名'),
  avatar: level('修改头像'),
  requests: level('处理好友与加群申请'),
  notifyRequests: Schema.boolean().default(true).description('收到申请时私聊通知主人'),
})

export interface Config {
  api: boolean
  groupAdmin: boolean
  nickname: Level
  signature: Level
  avatar: Level
  requests: Level
  notifyRequests: boolean
}

export type Level = 'off' | 'owner' | 'all'
export type Permission = 'nickname' | 'signature' | 'avatar' | 'requests'
