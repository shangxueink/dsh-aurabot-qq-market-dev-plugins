import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Target } from '@aurabot/plugin-api'
import type { Video } from './video.js'

export type Quota = 'browse' | 'share'
export interface Entry extends Video {
  public?: boolean
  part: number
  at: number
  thought: string
}
export interface Pending {
  selfId?: string
  id: string
  item: Entry
  target: Target
  expires: number
}
interface JournalData {
  history: Entry[]
  pending: Pending[]
  day: string
  counts: Partial<Record<Quota, number>>
  lastRun: number
}
export class Journal {
  readonly data: JournalData
  constructor(private readonly file: string) {
    const empty: JournalData = { history: [], pending: [], day: '', counts: {}, lastRun: 0 }
    try {
      this.data = { ...empty, ...JSON.parse(readFileSync(file, 'utf8')) }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      this.data = empty
    }
  }
  save() {
    const tmp = this.file + '.' + randomUUID() + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data))
    renameSync(tmp, this.file)
  }
  take(key: Quota, limit: number) {
    const day = new Date().toLocaleDateString('sv-SE')
    if (this.data.day !== day) {
      this.data.day = day
      this.data.counts = {}
    }
    const count = this.data.counts[key] || 0
    if (!(count < limit)) return false
    this.data.counts[key] = count + 1
    this.save()
    return true
  }
  remember(item: Entry) {
    this.data.history = [
      item,
      ...this.data.history.filter((v) => v.bvid !== item.bvid || v.part !== item.part),
    ].slice(0, 200)
    this.save()
  }
  pending() {
    const list = this.data.pending.filter((p) => p.expires > Date.now())
    if (list.length !== this.data.pending.length) {
      this.data.pending = list
      this.save()
    }
    return [...list]
  }
  remove(id: string) {
    this.data.pending = this.data.pending.filter((p) => p.id !== id)
    this.save()
  }
}
