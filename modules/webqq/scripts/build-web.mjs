import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'

const release = 'https://github.com/Stapxs/Stapxs-QQ-Lite-2.0/releases/download/v3.5.2/Stapxs.QQ.Lite-3.5.2-web.zip'
const digest = 'a1e36827313601ce21b2d6abcc8d716b0fb37ce6157164d00daed906c111aee7'
async function download() {
  const response = await fetch(release)
  if (!response.ok) throw new Error('下载 WebQQ 失败 HTTP ' + response.status)
  return Buffer.from(await response.arrayBuffer())
}
const bytes = process.env.WEBQQ_ARCHIVE ? await readFile(process.env.WEBQQ_ARCHIVE) : await download()
if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('WebQQ 发行包校验失败')
const root = resolve('dist')
for (const [name, data] of Object.entries(unzipSync(bytes))) {
  if (name.endsWith('/')) continue
  const path = resolve(name)
  if (!path.startsWith(root + sep)) throw new Error('无效的发行包路径')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
}
