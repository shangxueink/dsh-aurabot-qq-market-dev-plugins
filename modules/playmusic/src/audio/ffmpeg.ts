import { existsSync } from 'node:fs'
import type { Ctx } from '@aurabot/plugin-api'

export interface ExtractOptions {
  /** 从第几秒开始截（跳过片头口播），默认 0 */
  startSec?: number
  /** 截断到多少秒，默认 240 */
  targetSec?: number
}

/**
 * 把一个视频/音频文件抽成单声道 mp3（44100Hz / 128kbps）。
 * @returns 产出文件路径（即 output）
 */
export async function extractAudio(service: Ctx['ffmpeg'], input: string, output: string, opts: ExtractOptions = {}): Promise<string> {
  if (!service?.path()) throw Error('请先在 FFmpeg 服务页配置可用的 FFmpeg')
  const startSec = Math.max(0, Number(opts.startSec || 0))
  const targetSec = Math.max(10, Math.min(600, Number(opts.targetSec || 240)))
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  if (startSec > 0) args.push('-ss', String(startSec))
  args.push('-t', String(targetSec), '-i', input, '-vn', '-ac', '1', '-ar', '44100', '-b:a', '128k', output)
  await service.run(args, { timeoutMs: 300000 })
  if (!existsSync(output)) throw new Error('ffmpeg 没有产出音频')
  return output
}
