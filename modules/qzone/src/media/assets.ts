import type { Ctx } from '@aurabot/plugin-api'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Picture, CachedPicture } from './types.js'
import { insideFolder } from './sources.js'

const limit = 8 * 1024 * 1024
const extension: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

export function createAssets(ctx: Ctx) {
  const dir = ctx.dataDir('images')
  function path(id: string) {
    if (!/^[0-9a-f]{64}\.(jpg|png|gif|webp)$/.test(id)) throw Error('图片编号无效')
    return join(dir, id)
  }
  function local(root: string, file: string) {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > limit || !insideFolder(realpathSync(root), realpathSync(file)))
      throw Error('文件超出授权目录或大小限制')
    return readFileSync(file)
  }
  async function materialize(picture: Picture): Promise<CachedPicture> {
    const bytes = picture.root
      ? local(picture.root, picture.src)
      : await ctx.media.download(picture.src, limit)
    const { mime, width, height } = ctx.media.inspect(bytes)
    if (!width || !height || !extension[mime] || bytes.length > limit) throw Error('配图格式或大小不受支持')
    const id = createHash('sha256').update(bytes).digest('hex') + '.' + extension[mime]
    mkdirSync(dir, { recursive: true })
    if (!existsSync(path(id))) writeFileSync(path(id), bytes, { flag: 'wx' })
    return {
      id,
      sourceId: picture.id,
      kind: picture.kind,
      caption: picture.caption,
      sourceKind: picture.sourceKind || '',
      platform: picture.platform || '',
      title: picture.title || '',
      author: picture.author || '',
      url: picture.url || '',
    }
  }
  return { materialize, read: (id: string) => readFileSync(path(id)) }
}
