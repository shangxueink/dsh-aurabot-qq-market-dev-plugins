// src/*.ts → lib/（后台），client/*.ts → dist/（面板）。
// 面板在宿主里是 `new Function(body)` 跑的，所以 dist/panel.js 必须是「函数体 + return」而不是模块。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(TSC)) throw new Error('没装依赖：先在模块目录跑 npm install')

rmSync(join(ROOT, 'lib'), { recursive: true, force: true })
rmSync(join(ROOT, 'dist'), { recursive: true, force: true })

execFileSync(process.execPath, [TSC, '-p', join(ROOT, 'tsconfig.json')], { stdio: 'inherit' })

if (existsSync(join(ROOT, 'client', 'panel.ts'))) {
  execFileSync(process.execPath, [TSC, '-p', join(ROOT, 'tsconfig.client.json')], { stdio: 'inherit' })
  const out = join(ROOT, 'dist', 'panel.js')
  const code = readFileSync(out, 'utf8')
  if (!/^export default function /m.test(code)) {
    throw new Error('client/panel.ts 必须以 `export default function Panel(props) {...}` 的形式导出面板')
  }
  writeFileSync(out, code.replace(/^export default function /m, 'return function '))
}

console.log('[build] src → lib，client → dist 完成')
