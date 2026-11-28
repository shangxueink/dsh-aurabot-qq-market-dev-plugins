import type { Ctx } from '@aurabot/plugin-api'
import type { Picture, BrowsingLog, Item, StickerLibrary, ShotLibrary, MediaSettings } from './types.js'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync, readFileSync } from 'node:fs'
import { dirname, basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
export function clip(value: unknown, max = 160) {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
  return [...text]
    .filter((char) => !/^[\uD800-\uDFFF]$/.test(char))
    .slice(0, max)
    .join('')
}
export const sourceId = (value: unknown) =>
  createHash('sha256').update(String(value)).digest('hex').slice(0, 28)
export const publicText = (value: unknown) =>
  !/(?:cookie|sessionid|access.token|验证码|身份证|银行卡|密码|手机号|住址|病历|私聊原文|\b\d{7,}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(
    String(value),
  )

export function imageFolder(value: unknown) {
  const folder = String(value || '').trim()
  if (!folder) return ''
  if (!isAbsolute(folder)) throw new Error('请填写图片文件夹的完整路径')
  const path = resolve(folder)
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())
    throw new Error('图片目录不能是链接，且必须是文件夹')
  return realpathSync(path)
}

export function insideFolder(root: string, file: string) {
  const rel = relative(root, file)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function archiveMetadata(file: string): Partial<Picture> {
  try {
    const sidecar = file + '.json'
    const stat = lstatSync(sidecar)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return {}
    const metadata = JSON.parse(readFileSync(sidecar, 'utf8'))
    if (metadata.schema !== 1 || metadata.kind !== 'browsing') return {}
    const url = new URL(metadata.url)
    let id: string | null | undefined = ''
    if (metadata.platform === 'B站') id = /^\/video\/(BV\w{10})\/?$/.exec(url.pathname)?.[1]
    if (metadata.platform === '抖音') id = /^\/(?:video|note)\/(\d{5,25})\/?$/.exec(url.pathname)?.[1]
    if (metadata.platform === '小红书') id = /^\/explore\/([a-f0-9]{24})\/?$/i.exec(url.pathname)?.[1]
    if (metadata.platform === '触站') id = /^\/draw\/(\d{1,15})\/?$/.exec(url.pathname)?.[1]
    if (metadata.platform === '淘宝') id = url.searchParams.get('id')
    const canonical = sourceLink(metadata.platform, { id })
    if (!canonical || new URL(canonical).hostname !== url.hostname) return {}
    const title = clip(metadata.title, 70)
    const author = clip(metadata.author, 40)
    if (!title || !publicText(title + author)) return {}
    return {
      sourceKind: 'browsing',
      platform: metadata.platform,
      title,
      author,
      url: canonical,
      caption: '浏览归档：' + metadata.platform + '《' + title + '》',
    }
  } catch (error) {
    return {}
  }
}

export function localPictures(folder: string): Picture[] {
  const root = imageFolder(folder)
  if (!root) return []
  const queue = [{ dir: root, depth: 0 }]
  const files: Picture[] = []
  let entries = 0
  while (queue.length && entries < 1500) {
    const { dir, depth } = queue.shift()!
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      continue
    }
    for (const item of items) {
      if (++entries > 1500) break
      if (item.isSymbolicLink()) continue
      const file = join(dir, item.name)
      try {
        const stat = lstatSync(file)
        if (stat.isSymbolicLink() || !insideFolder(root, realpathSync(file))) continue
        if (stat.isDirectory() && depth < 3) queue.push({ dir: file, depth: depth + 1 })
        if (
          !stat.isFile() ||
          !/\.(png|jpe?g|gif|webp)$/i.test(file) ||
          stat.size <= 0 ||
          stat.size > 8 * 1024 * 1024
        )
          continue
        const caption = clip(basename(file, extname(file)), 60)
        if (!publicText(caption)) continue
        files.push({
          id: 'local:' + sourceId(file),
          kind: 'local',
          src: file,
          root,
          caption,
          at: stat.mtimeMs,
          ...archiveMetadata(file),
        })
      } catch (error) {
        /* 文件被移动或无法读取时跳过。 */
      }
    }
  }
  return files.sort((a, b) => b.at - a.at).slice(0, 60)
}

function remoteImage(value: unknown) {
  try {
    const url = new URL(String(value))
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch (error) {
    return ''
  }
}

function sourceLink(platform: string, item: Item) {
  const id = String(item.id || item.bvid || '')
  if (platform === 'B站' && /^BV[\w]{10}$/.test(id)) return 'https://www.bilibili.com/video/' + id
  if (platform === '抖音' && /^\d{5,25}$/.test(id)) return 'https://www.douyin.com/video/' + id
  if (platform === '小红书' && /^[a-f0-9]{24}$/i.test(id)) return 'https://www.xiaohongshu.com/explore/' + id
  if (platform === '淘宝' && /^\d{5,25}$/.test(id)) return 'https://item.taobao.com/item.htm?id=' + id
  if (platform === '触站' && /^\d{1,15}$/.test(id)) return 'https://www.huashi6.com/draw/' + id
  return ''
}

export function collectSources(
  env: Ctx,
  settings: MediaSettings,
  used = new Set<string>(),
  now = Date.now(),
) {
  const events: { id: string; text: string; at: number }[] = []
  const pictures: Picture[] = []
  const seen = new Set()
  const add = (picture: Picture) => {
    if (!picture.src || seen.has(picture.src)) return
    seen.add(picture.src)
    pictures.push({ ...picture, recent: used.has(picture.id) })
  }
  if (settings.browsing) {
    const platforms: [string, string, string[]][] = [
      ['bili', 'B站', ['watch', 'share']],
      ['xhs', '小红书', ['read', 'share']],
      ['douyin', '抖音', ['read', 'share']],
      ['taobao', '淘宝', ['select', 'share']],
      ['huashi6', '触站', ['read', 'share']],
    ]
    for (const [id, platform, kinds] of platforms) {
      let rows: BrowsingLog[] = []
      try {
        rows =
          (
            env.get<{ state(): { history: BrowsingLog[] } }>(id === 'bili' ? 'bilibili' : id) ||
            env.get<{ state(): { history: BrowsingLog[] } }>(id)
          )?.state?.()?.history || []
      } catch (error) {
        continue
      }
      if (!Array.isArray(rows)) continue
      for (const row of rows.slice(0, 80)) {
        if (!row || typeof row !== 'object') continue
        if (
          !kinds.includes(row.kind) ||
          row.ok === false ||
          !(row.at >= now - 48 * 3600_000 && row.at <= now)
        )
          continue
        const items = row.note
          ? [row.note]
          : row.item
            ? [row.item]
            : Array.isArray(row.items)
              ? row.items.slice(0, 2)
              : [row]
        for (const item of items) {
          if (!item || typeof item !== 'object') continue
          const title = clip(item.title || row.title, 70)
          const author = clip(item.author, 40)
          const url = sourceLink(platform, item)
          if (!title || !url || !publicText(title + author)) continue
          const key = id + ':' + sourceId(url)
          if (events.some((event) => event.id === key)) continue
          events.push({ id: key, text: `浏览了${platform}的公开作品《${title}》`, at: Number(row.at) })
          add({
            id: key,
            kind: 'browsing',
            src: remoteImage(item.cover || item.images?.[0]),
            caption: platform + '《' + title + '》',
            title,
            author,
            platform,
            url,
            at: Number(row.at),
          })
        }
      }
    }
    // 只读已有 B 站视频抽帧，不调用会裁剪图库的 panel()，也不抓取桌面。
    const shots = env.get<ShotLibrary>('bilibili')
    for (const item of shots?.publicShots?.().slice(0, 40) || []) {
      const title = clip(item.title, 70)
      const url = sourceLink('B站', item)
      if (!url || !title || !publicText(title) || !(item.at >= now - 48 * 3600_000 && item.at <= now))
        continue
      add({
        id: 'bili-shot:' + item.md5,
        kind: 'browsing',
        localShot: true,
        src: item.path,
        root: dirname(item.path),
        caption: 'B站视频抽帧《' + title + '》',
        title,
        platform: 'B站',
        url,
        at: item.at,
      })
    }
  }
  if (settings.stickers) {
    const stickers = env.get<StickerLibrary>('stickers')
    let items: ReturnType<StickerLibrary['library']>['items'] = []
    try {
      items = stickers?.library()?.items || []
    } catch (error) {}
    if (!Array.isArray(items)) items = []
    for (const item of items.slice(-300)) {
      if (
        !item ||
        typeof item.file !== 'string' ||
        basename(item.file) !== item.file ||
        /[\\/]/.test(item.file) ||
        !/\.(png|jpe?g|gif|webp)$/i.test(item.file)
      )
        continue
      const caption = clip(
        [item.name, ...(Array.isArray(item.tags) ? item.tags : [])].filter(Boolean).join(' · '),
        100,
      )
      if (!caption || !publicText(caption)) continue
      const src = stickers?.stickerPath(item)
      if (src)
        add({
          id: 'sticker:' + item.md5,
          kind: 'sticker',
          src,
          root: dirname(src),
          caption,
          at: item.at || 0,
        })
    }
  }
  let folderError = ''
  if (settings.local && settings.folder) {
    try {
      localPictures(settings.folder).forEach(add)
    } catch (error) {
      folderError = '指定的图片目录无法读取，请检查路径和权限。'
    }
  }
  return { events: events.slice(0, 18), pictures, folderError }
}
