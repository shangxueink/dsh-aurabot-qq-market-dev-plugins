import type { Ctx } from '@aurabot/plugin-api'
import { useAdmin } from './admin.js'
import { useApi } from './api.js'
import { useCards } from './cards.js'
import { useProfile } from './profile.js'
import { useRequests } from './requests.js'

export { config } from './config.js'
export const name = 'QQ 工具箱'

export function apply(ctx: Ctx) {
  useApi(ctx)
  useAdmin(ctx)
  useCards(ctx)
  useProfile(ctx)
  useRequests(ctx)
}
