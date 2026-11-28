import { Schema } from '@aurabot/plugin-api'
const toggle = (label: string, value = false) => Schema.boolean().default(value).description(label)
const limit = (label: string, value: number, max = 100) =>
  Schema.natural().max(max).default(value).description(label)
export const config = Schema.object({
  cookie: Schema.string().role('secret').default('').description('B 站账号 Cookie，匿名浏览可留空'),
  autoBrowse: toggle('自动浏览视频', true),
  intervalHours: limit('浏览间隔（小时）', 4, 168),
  maxRunsPerDay: limit('每天浏览轮数', 3),
  perRun: limit('每轮最多看几个视频', 3, 10),
  keywords: Schema.array(Schema.string()).default([]).description('感兴趣的话题'),
  minViews: limit('最低播放量', 5000, 1000000000),
  maxAgeDays: limit('视频最大发布天数，零表示不限', 60, 3650),
  offpeak: toggle('仅在北京时间谷时自动浏览'),
  vision: toggle('浏览时提取视频画面'),
  shotLibrary: limit('保留的视频帧数量', 120, 1000),
  visionFrames: limit('每个视频截取的帧数', 2, 6),
  destinations: Schema.array(
    Schema.object({
      platform: Schema.string(),
      botId: Schema.string(),
      type: Schema.union(['private', 'group', 'channel']),
      id: Schema.string(),
    }),
  )
    .default([])
    .description('分享目的地，每行绑定平台和 Bot 实例；群和频道需要主人审批'),
  shareLimit: limit('每天分享的目的地总数', 3),
  pendingHours: limit('审批有效期（小时）', 24, 168),
  queueLimit: limit('最多待批分享条数', 3, 30),
  shareHistory: toggle('允许日记等插件读取本插件的自主浏览记录和视频帧'),
})
