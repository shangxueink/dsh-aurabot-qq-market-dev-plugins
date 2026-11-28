export interface Item {
  id?: string | null
  bvid?: string
  title?: string
  author?: string
  cover?: string
  images?: string[]
}
export interface BrowsingLog extends Item {
  at: number
  kind: string
  ok?: boolean
  note?: Item
  item?: Item
  items?: Item[]
}
interface Sticker {
  file: string
  md5: string
  at: number
  name?: string
  tags?: string[]
}
export interface StickerLibrary {
  library(): { items: Sticker[] }
  stickerPath(item: Sticker): string
}
export interface ShotLibrary {
  publicShots(): (Item & { md5: string; at: number; path: string })[]
}
export interface Picture {
  id: string
  kind: 'sticker' | 'local' | 'browsing'
  src: string
  caption: string
  at: number
  root?: string
  recent?: boolean
  sourceKind?: string
  localShot?: boolean
  platform?: string
  title?: string
  author?: string
  url?: string
}
export interface MediaSettings {
  stickers: boolean
  browsing: boolean
  local: boolean
  folder: string
}
export interface CachedPicture {
  id: string
  sourceId: string
  kind: Picture['kind']
  sourceKind: string
  caption: string
  platform: string
  title: string
  author: string
  url: string
}
