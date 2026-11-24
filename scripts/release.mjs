// 只构建「package.json 里 version 变过」的模块，构建完发 Release，再把产物地址回写进 package.json。
//
//   node scripts/release.mjs             CI：构建 → 打 zip → 发 Release → 回写 artifact → 提交
//   node scripts/release.mjs --dry-run   本地：只构建和打包到 dist/，不发 Release、不提交

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MODULES = join(ROOT, 'modules')
const DIST = join(ROOT, 'dist')
const STATE_FILE = join(ROOT, '.aurabot', 'versions.json')
const DRY = process.argv.includes('--dry-run')
const REPO = process.env.GITHUB_REPOSITORY || ''

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })

/** 最小的 zip 写入：文件顺序、时间都固定，同样内容得到同样的字节。 */
function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, data] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const path = Buffer.from(name, 'utf8')
    const body = deflateRawSync(data, { level: 9 })
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6) // 文件名是 UTF-8
    head.writeUInt16LE(8, 8) // deflate
    head.writeUInt16LE(0x21, 12) // 1980-01-01
    head.writeUInt32LE(crc32(data), 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(path.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    head.copy(central, 6, 4, 30)
    central.writeUInt32LE(offset, 42)
    locals.push(head, path, body)
    centrals.push(central, path)
    offset += head.length + path.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.size, 8)
  end.writeUInt16LE(files.size, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

function walk(dir, base, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, base, out)
    else if (entry.isFile()) out.push(relative(base, path).split(sep).join('/'))
  }
  return out
}

/** 发布包里放什么：清单 + 文档 + 构建产物 + 面板 + 素材。 */
function collect(dir, main) {
  const names = []
  for (const name of ['package.json', 'README.md', 'LICENSE']) {
    if (existsSync(join(dir, name))) names.push(name)
  }
  for (const sub of ['lib', 'client', 'assets', 'docs']) {
    if (existsSync(join(dir, sub))) names.push(...walk(join(dir, sub), dir))
  }
  if (!names.includes(main)) throw new Error(`构建后找不到入口 ${main}，检查 package.json 的 main 和 tsconfig 的 outDir`)
  const files = new Map()
  for (const name of names) files.set(name, readFileSync(join(dir, name)))
  return files
}

function ensureRelease(tag, asset, sha256) {
  try {
    execFileSync('gh', ['release', 'view', tag], { stdio: 'ignore' })
    console.log(`  Release ${tag} 已存在，跳过发布`)
    return
  } catch {
    // 不存在就发
  }
  execFileSync('gh', ['release', 'create', tag, asset, '--title', tag, '--notes', `sha256: ${sha256}`], { stdio: 'inherit' })
}

function buildAndPackage(dir, pkg) {
  if (existsSync(join(dir, 'package-lock.json'))) run('npm', ['ci', '--ignore-scripts'], dir)
  else run('npm', ['install', '--ignore-scripts', '--no-package-lock'], dir)
  run('npm', ['run', 'build'], dir)

  const main = pkg.main || 'lib/index.js'
  const files = collect(dir, main)
  const buffer = makeZip(files)

  const tag = `${pkg.name.replace('/', '-')}-v${pkg.version}`
  const file = `${tag}.zip`
  mkdirSync(DIST, { recursive: true })
  writeFileSync(join(DIST, file), buffer)

  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const url = `https://github.com/${REPO}/releases/download/${tag}/${file}`
  if (!DRY) ensureRelease(tag, join(DIST, file), sha256)
  return { tag, file, url, sha256, size: buffer.length }
}

function main() {
  if (!DRY && !REPO) throw new Error('缺 GITHUB_REPOSITORY（CI 里才有），本地请加 --dry-run')

  const state = existsSync(STATE_FILE) ? readJson(STATE_FILE) : {}
  const seen = new Set()
  const published = []

  for (const entry of readdirSync(MODULES, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(MODULES, entry.name)
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue

    const pkg = readJson(pkgPath)
    seen.add(pkg.name)
    if (state[pkg.name] === pkg.version) {
      console.log(`- ${pkg.name}@${pkg.version} 没有变化，跳过`)
      continue
    }

    console.log(`+ 构建 ${pkg.name}@${pkg.version}`)
    const result = buildAndPackage(dir, pkg)
    pkg.aurabot = pkg.aurabot || {}
    pkg.aurabot.artifact = { url: result.url, sha256: result.sha256, size: result.size }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    state[pkg.name] = pkg.version
    published.push(`${pkg.name}@${pkg.version} → ${result.file}（${result.size} 字节）`)
  }

  // 模块被删掉后，状态里也不留
  for (const name of Object.keys(state)) if (!seen.has(name)) delete state[name]
  writeJson(STATE_FILE, state)

  if (!published.length) {
    console.log('没有需要发布的模块')
    return
  }
  console.log(published.join('\n'))

  if (DRY) {
    console.log('dry-run：产物在 dist/，没有发 Release、没有提交')
    return
  }

  run('git', ['add', '-A'], ROOT)
  try {
    run('git', ['commit', '-m', 'chore: 回写构建产物 [skip ci]'], ROOT)
  } catch {
    console.log('产物和上次一致，没有需要提交的回写')
    return
  }
  run('git', ['push'], ROOT)
}

main()
