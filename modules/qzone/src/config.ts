import { Schema } from '@aurabot/plugin-api'

export const config = Schema.object({
  attachImage: Schema.boolean().default(true).description('普通日记附带今天的画作或表情'),
  rich: Schema.boolean().default(false).description('根据公开浏览素材生成图文日记'),
  browsing: Schema.boolean().default(false).description('选用公开浏览作品和视频帧'),
  stickers: Schema.boolean().default(false).description('选用表情库图片'),
  local: Schema.boolean().default(false).description('选用指定目录的图片'),
  folder: Schema.string().default('').description('授权的日记图片目录'),
  maxImages: Schema.natural().min(1).max(4).default(2).description('每篇图文日记最多配图数'),
  archive: Schema.boolean().default(false).description('按日期归档公开浏览图'),
  archiveFolder: Schema.string().default('').description('公开浏览图的归档目录'),
  middlewareEnabled: Schema.boolean().default(true).description('解析消息并记录日记素材'),
  commands: Schema.boolean().default(false).description('启用主人日记指令'),
  botId: Schema.string().default('').description('QQ Bot 实例，多账号时指定'),
  diary: Schema.boolean().default(true).description('自动写日记'),
  timesPerDay: Schema.natural().max(48).default(2).description('每天篇数'),
  windowStart: Schema.string().default('10:00').description('最早发布时间'),
  windowEnd: Schema.string().default('23:30').description('最晚发布时间'),
  minGapMinutes: Schema.natural().default(180).description('两篇日记最小间隔（分钟）'),
  minChars: Schema.natural().min(1).default(60).description('期望最少字数'),
  maxChars: Schema.natural().min(1).default(140).description('期望最多字数'),
  visibility: Schema.union(['all', 'friends', 'selected', 'self', 'excluded'])
    .default('all')
    .description('说说可见范围'),
  audienceQQs: Schema.string().default('').description('部分好友可见或排除的 QQ 号，用逗号分隔'),
  social: Schema.boolean().default(true).description('定时浏览空间'),
  replyOwn: Schema.boolean().default(true).description('回复自己说说下的新评论'),
  commentFriends: Schema.boolean().default(true).description('浏览好友动态并评论'),
  like: Schema.boolean().default(true).description('互动时点赞'),
  friendChance: Schema.percent().default(0.3).description('好友动态互动概率'),
  ownerChance: Schema.percent().default(0.7).description('主人动态互动概率'),
  maxPerDay: Schema.natural().max(100).default(8).description('每天最多评论数'),
  intervalMin: Schema.natural().min(1).default(30).description('互动间隔（分钟）'),
  awakeFrom: Schema.natural().max(24).default(8).description('开始互动的小时'),
  awakeTo: Schema.natural().max(24).default(23).description('结束互动的小时'),
})

export interface Config {
  attachImage: boolean
  rich: boolean
  browsing: boolean
  stickers: boolean
  local: boolean
  folder: string
  maxImages: number
  archive: boolean
  archiveFolder: string
  middlewareEnabled: boolean
  commands: boolean
  botId: string
  diary: boolean
  timesPerDay: number
  windowStart: string
  windowEnd: string
  minGapMinutes: number
  minChars: number
  maxChars: number
  visibility: 'all' | 'friends' | 'selected' | 'self' | 'excluded'
  audienceQQs: string
  social: boolean
  replyOwn: boolean
  commentFriends: boolean
  like: boolean
  friendChance: number
  ownerChance: number
  maxPerDay: number
  intervalMin: number
  awakeFrom: number
  awakeTo: number
}
