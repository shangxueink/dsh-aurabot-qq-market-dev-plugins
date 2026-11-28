export interface SniffResult {
  /** 推断出的扩展名（含点），认不出返回 '' */
  ext: string
  /** 推断出的媒体类别 image/video/record/file */
  kind: string
}

/**
 * 读取文件头魔术字节，判断真实类型。
 * 用于「附件路径没有扩展名」（如对象存储哈希名）时补上正确后缀、判断图片/视频/语音。
 */
export function sniffMedia(buf: Buffer): SniffResult {
  if (!buf || buf.length < 4) return { ext: '', kind: 'file' }
  const b = buf
  const ascii = (o: number, n: number): string => b.toString('latin1', o, o + n)

  // 图片
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: '.png', kind: 'image' }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: '.jpg', kind: 'image' }
  if (ascii(0, 3) === 'GIF') return { ext: '.gif', kind: 'image' }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { ext: '.webp', kind: 'image' }
  if (b[0] === 0x42 && b[1] === 0x4d) return { ext: '.bmp', kind: 'image' }

  // 视频
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4).toLowerCase()
    if (brand.startsWith('qt')) return { ext: '.mov', kind: 'video' }
    if (brand === 'avif') return { ext: '.avif', kind: 'image' }
    return { ext: '.mp4', kind: 'video' }
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { ext: '.webm', kind: 'video' }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ') return { ext: '.avi', kind: 'video' }

  // 音频
  if (ascii(0, 3) === 'ID3') return { ext: '.mp3', kind: 'record' }
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { ext: '.mp3', kind: 'record' }
  if (ascii(0, 4) === 'fLaC') return { ext: '.flac', kind: 'record' }
  if (ascii(0, 4) === 'OggS') return { ext: '.ogg', kind: 'record' }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return { ext: '.wav', kind: 'record' }
  if (ascii(0, 2) === '#!') return { ext: '', kind: 'file' } // AMR 变体，少见，不猜测
  if (ascii(4, 4) === 'AMR' || ascii(0, 5) === '#!AMR') return { ext: '.amr', kind: 'record' }

  // 文档
  if (ascii(0, 4) === '%PDF') return { ext: '.pdf', kind: 'file' }
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return { ext: '.zip', kind: 'file' }

  return { ext: '', kind: 'file' }
}
