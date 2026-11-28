import type { Ctx } from '@aurabot/plugin-api'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const maxBytes = 16 * 1024 * 1024
type Frame = { bytes: Buffer; delay: number; delayOffset: number }
type Movie = { header: Buffer; frames: Frame[]; extensions: Buffer[]; tail: Buffer; transparent: boolean }

function inspect(data: Buffer): Movie {
  const invalid = () => { throw Error('图片不是完整的 GIF 动图。') }
  if (data.length < 14 || !['GIF87a','GIF89a'].includes(data.toString('ascii', 0, 6))) invalid()
  const width = data.readUInt16LE(6), height = data.readUInt16LE(8)
  let pos = 13
  function take(size: number) {
    if (pos + size > data.length) invalid()
    const part = data.subarray(pos, pos + size)
    pos += size
    return part
  }
  function table(flags: number) { if (flags & 128) take(3 * (2 << (flags & 7))) }
  function blocks() {
    for (;;) { const size = take(1)[0]; if (!size) return; take(size) }
  }
  table(data[10])
  const header = data.subarray(0,pos), extensions: Buffer[] = [], frames: Frame[] = []
  let control: Buffer | undefined, transparent = false
  for (;;) {
    const start = pos, mark = take(1)[0]
    if (mark === 0x3b) {
      if (frames.length < 2) throw Error('这是一张静态图，请发送至少两帧的 GIF。')
      return { header, frames, extensions, tail: data.subarray(start), transparent }
    }
    if (mark === 0x21) {
      const label = take(1)[0]
      blocks()
      const ext = data.subarray(start,pos)
      if (label === 0xf9) {
        if (ext.length !== 8 || ext[2] !== 4) invalid()
        control = ext
        transparent ||= Boolean(ext[3] & 1)
      } else if (label === 0x01) throw Error('暂不支持带纯文本图层的 GIF。')
      else extensions.push(ext)
      continue
    }
    if (mark !== 0x2c) invalid()
    const rect = take(9)
    const w = rect.readUInt16LE(4), h = rect.readUInt16LE(6)
    if (!w || !h || rect.readUInt16LE(0) + w > width || rect.readUInt16LE(2) + h > height) invalid()
    table(rect[8]); take(1); blocks()
    const frame = data.subarray(start,pos)
    frames.push({bytes: control ? Buffer.concat([control, frame]) : frame,
      delay: control?.readUInt16LE(4) || 0, delayOffset: control ? 4 : -1 })
    control = undefined
    if (frames.length > 1000 || width * height * frames.length > 32_000_000) throw Error('动图过大，无法完整倒放。')
  }
}

export async function reverseGif(service: NonNullable<Ctx['ffmpeg']>, input: Buffer, signal: AbortSignal) {
  if (input.length > maxBytes) throw Error('GIF 超过 16 MB。')
  const source = inspect(input)
  const frames = source.frames.slice().reverse()
  const dir = await mkdtemp(join(tmpdir(), 'aurabot-gif-'))
  const run = (args: string[]) => service.run(['-hide_banner','-loglevel','error','-nostdin','-y',...args], { cwd: dir, timeoutMs: 45000, signal })
  const read = ['-ignore_loop','1','-min_delay','0','-i']
  async function hashes(file: string, filter: string) {
    const { stdout } = await run([...read,file,'-vf',filter,'-fps_mode','passthrough','-f','framemd5','-'])
    return Buffer.from(stdout).toString().split(/\r?\n/).filter(s => /^\s*0,/.test(s)).map(s => s.split(',').at(-1)!.trim())
  }
  try {
    await writeFile(join(dir,'input.gif'), input)
    const expected = await hashes('input.gif','reverse,format=rgba')
    if (expected.length !== frames.length) throw Error('FFmpeg 无法完整解读每一帧。')
    const exact = async () => {
      const actual = await hashes('output.gif','format=rgba')
      return actual.length === expected.length && actual.every((v,i) => v === expected[i])
    }
    const assemble = (header: Buffer, parts: Buffer[]) => Buffer.concat([header, ...source.extensions, ...parts, source.tail])
    const candidate = assemble(source.header, frames.map(f => f.bytes))
    await writeFile(join(dir,'output.gif'),candidate)
    if (await exact()) return candidate

    // 差分帧依赖前面的画布。先合成再反向，并为每一帧单独生成调色板。
    const palette = 'reverse,split[a][b];[a]palettegen=stats_mode=single:reserve_transparent=' + Number(source.transparent) +
      '[p];[b][p]paletteuse=new=1:dither=none'
    await run([...read,'input.gif','-filter_complex_threads','1','-filter_complex',palette,
      '-fps_mode','passthrough','-gifflags','0','-loop','-1','encoded.gif'])
    const encoded = inspect(await readFile(join(dir,'encoded.gif')))
    if (encoded.frames.length !== frames.length) throw Error('输出帧数与原动图不一致。')
    const parts = encoded.frames.map((frame,i) => {
      if (frame.delayOffset >= 0) {
        frame.bytes.writeUInt16LE(frames[i].delay, frame.delayOffset)
        return frame.bytes
      }
      const control = Buffer.from([0x21,0xf9,4,0,0,0,0,0])
      control.writeUInt16LE(frames[i].delay,4)
      return Buffer.concat([control,frame.bytes])
    })
    const result = assemble(encoded.header, parts)
    await writeFile(join(dir,'output.gif'),result)
    if (!await exact()) throw Error('这张 GIF 的合成帧无法无损倒放。')
    return result
  } finally { await rm(dir,{recursive:true,force:true}) }
}
