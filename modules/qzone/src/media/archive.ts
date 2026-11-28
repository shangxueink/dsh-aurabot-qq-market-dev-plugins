import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import type { Ctx } from '@aurabot/plugin-api'
import type { Account } from '../account.js'
import { createAssets } from './assets.js'
import { collectSources, insideFolder, sourceId } from './sources.js'
interface ArchiveState {
  lastAt: number
  error: string
  items: { sourceId: string; hash: string; day: string; name: string; at: number }[]
}
export function archiveDate(at: number) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(at))
    .replaceAll('-', '')
}

function outputFolder(value: unknown) {
  const folder = String(value || '').trim()
  if (!folder || !isAbsolute(folder) || resolve(folder) === parse(resolve(folder)).root)
    throw new Error('请先指定归档文件夹的完整路径，不能使用磁盘根目录')
  const root = resolve(folder)
  let current = root
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error('归档路径不能包含目录链接')
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return root
}

export function createArchive(env: Ctx, account: Account) {
  const assets = createAssets(env)
  const settings = () => ({ enabled: account.settings().archive, folder: account.settings().archiveFolder })
  const file = () => 'archive-' + sourceId(settings().folder || '')
  const load = () => account.load<ArchiveState>(file(), () => ({ items: [], lastAt: 0, error: '' }))
  let busy = false
  let stopped = false
  function assertActive(folder: string) {
    const cfg = settings()
    if (
      stopped ||
      env.root.config.dryRun === true ||
      env.root.config.enabled === false ||
      !cfg.enabled ||
      cfg.folder !== folder
    )
      throw new Error('归档已停止或目录设置已变化，本次停止保存')
    return outputFolder(folder)
  }
  function state() {
    const saved = load()
    return {
      ok: true,
      busy,
      count: new Set(saved.items.map((item) => item.hash)).size,
      lastAt: saved.lastAt,
      error: saved.error,
      folder: settings().folder || '',
      enabled: settings().enabled === true,
    }
  }
  async function collect() {
    if (busy) return { ok: false, message: '上一轮图片还在归档' }
    const snapshot = { ...settings() }
    try {
      assertActive(snapshot.folder)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    busy = true
    let saved = 0
    let failed = 0
    try {
      const initial = load()
      const seen = new Set(initial.items.map((item) => item.sourceId))
      const pictures = collectSources(env, { browsing: true, stickers: false, local: false, folder: '' })
        .pictures.filter((picture) => picture.kind === 'browsing' && !seen.has(picture.id))
        .slice(0, 8)
      for (const picture of pictures) {
        try {
          const image = await assets.materialize(picture)
          const bytes = assets.read(image.id)
          const root = assertActive(snapshot.folder)
          const hash = createHash('sha256').update(bytes).digest('hex')
          const current = load()
          const duplicate = current.items.find((item) => item.hash === hash)
          if (duplicate) {
            current.items.unshift({ ...duplicate, sourceId: picture.id })
            current.items = current.items.slice(0, 3000)
            account.save(file(), current)
            continue
          }
          const day = archiveDate(picture.at)
          const dir = join(root, day)
          outputFolder(dir)
          mkdirSync(dir, { recursive: true })
          if (!insideFolder(realpathSync(root), realpathSync(dir))) throw new Error('归档目录越界')
          const name = '浏览图-' + hash.slice(0, 20) + '.' + image.id.split('.').pop()
          const dest = join(dir, name)
          if (existsSync(dest) || existsSync(dest + '.json')) continue
          const metadata = {
            schema: 1,
            kind: 'browsing',
            platform: image.platform,
            title: image.title,
            author: image.author,
            url: image.url,
            at: picture.at,
            collectedAt: Date.now(),
            hash,
          }
          writeFileSync(dest + '.json', JSON.stringify(metadata, null, 2), { flag: 'wx' })
          try {
            writeFileSync(dest, bytes, { flag: 'wx' })
          } catch (error) {
            unlinkSync(dest + '.json')
            throw error
          }
          current.items.unshift({ sourceId: picture.id, hash, day, name, at: Date.now() })
          current.items = current.items.slice(0, 3000)
          current.lastAt = Date.now()
          current.error = ''
          account.save(file(), current)
          saved++
        } catch (error) {
          assertActive(snapshot.folder)
          failed++
        }
      }
      const current = load()
      current.lastAt = Date.now()
      current.error = failed ? `${failed} 张浏览图未能保存，已保留已有图片；下次会重试。` : ''
      account.save(file(), current)
      return { ok: true, saved, failed, message: `已归档 ${saved} 张浏览图` }
    } catch (error) {
      return { ok: false, saved, message: error instanceof Error ? error.message : String(error) }
    } finally {
      busy = false
    }
  }
  return {
    collect,
    state,
    dispose: () => {
      stopped = true
    },
  }
}
