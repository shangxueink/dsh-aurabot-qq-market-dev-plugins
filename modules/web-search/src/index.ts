import { Schema, type Ctx, type ManagedBrowser, type ToolSpec } from '@aurabot/plugin-api'

export const name = '网页搜索'
export const config = Schema.object({
  bing: Schema.boolean().default(true).title('必应搜索'),
  bilibili: Schema.boolean().default(false).title('B站搜索'),
  google: Schema.boolean().default(false).title('谷歌搜索'),
})

const engines = {
  bing: { name: '必应搜索', tool: 'bing_search', url: 'https://cn.bing.com/search', param: 'q', ready: '#b_results .b_algo h2 a' },
  bilibili: { name: 'B站搜索', tool: 'bilibili_video_search', url: 'https://search.bilibili.com/video', param: 'keyword', ready: '.bili-video-card h3, .video-list h3, .video-item .title' },
  google: { name: '谷歌搜索', tool: 'google_search', url: 'https://www.google.com/search', param: 'q', ready: '#search a h3, #rso a h3' },
}
type Engine = keyof typeof engines
type Browser = Omit<ManagedBrowser, 'newPage'> & {
  newPage(): Promise<Awaited<ReturnType<ManagedBrowser['newPage']>> & {
    waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>
  }>
}

function readResults() {
  const found: Array<{ title: string; url: string; snippet: string }> = []
  const seen = new Set<string>()
  const host = location.hostname
  const bili = /(^|\.)bilibili\.com$/.test(host)
  const bing = /(^|\.)bing\.com$/.test(host)
  const google = /(^|\.)google\.com$/.test(host)
  if (!bili && !bing && !google) return found
  if (bing && /xml/.test(document.contentType)) {
    for (const item of document.querySelectorAll('channel > item')) {
      const title = item.querySelector('title')?.textContent?.trim()
      const url = item.querySelector('link')?.textContent?.trim()
      if (!title || !url || !/^https?:\/\//i.test(url) || seen.has(url)) continue
      found.push({ title: title.slice(0,200), url, snippet: (item.querySelector('description')?.textContent || '').trim().slice(0,450) })
      seen.add(url)
      if (found.length === 8) break
    }
    return found
  }
  const selector = bing ? '#b_results .b_algo h2 a' : bili ? '.bili-video-card h3, .video-list h3, .video-item .title' : '#search a h3, #rso a h3'
  for (const heading of document.querySelectorAll<HTMLElement>(selector)) {
    const card = heading.closest(bing ? '.b_algo' : bili ? '.bili-video-card,.video-item' : 'div.MjjYud,div.g,div[data-snc]')
    const anchor = heading.closest<HTMLAnchorElement>('a[href]') || card?.querySelector<HTMLAnchorElement>('a[href*="/video/"]')
    if (!anchor) continue
    let url = new URL(anchor.href)
    if (bing && url.pathname === '/ck/a') {
      const target = url.searchParams.get('u')
      if (target?.startsWith('a1')) {
        try { url = new URL(new TextDecoder().decode(Uint8Array.from(atob(target.slice(2).replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0)))) } catch {}
      }
    }
    if (!['https:', 'http:'].includes(url.protocol) || seen.has(url.href)) continue
    const title = (heading.title || heading.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200)
    if (!title) continue
    const snippet = card?.querySelector<HTMLElement>(bing ? '.b_caption p, p' : bili ? '.bili-video-card__info--bottom,.up-name' : '.VwiC3b,.yXK7lf,[data-sncf]')?.innerText || ''
    found.push({ title, url: url.href, snippet: snippet.trim().replace(/\s+/g, ' ').slice(0, 450) })
    seen.add(url.href)
    if (found.length === 8) break
  }
  return found
}

export function apply(ctx: Ctx) {
  const active = new Set<Browser>()
  let disposed = false
  ctx.effect(async () => {
    disposed = true
    await Promise.allSettled([...active].map(browser => browser.close()))
  })

  async function run(engine: Engine, query: unknown) {
    const keyword = typeof query === 'string' ? query.trim() : ''
    if (!keyword || keyword.length > 300) return { ok: false, message: '请输入 1 到 300 字的搜索关键词。' }
    const service = ctx.puppeteer
    if (!service || disposed) return { ok: false, message: '浏览器服务未启用。' }
    const source = engines[engine]
    const url = new URL(source.url)
    url.searchParams.set(source.param, keyword)
    let browser: Browser | undefined
    try {
      browser = await service.launch<Browser>({ headless: true })
      if (disposed) return { ok: false, message: '搜索已取消。' }
      active.add(browser)
      const page = await browser.newPage()
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForSelector(source.ready, { timeout: 7000 }).catch(() => {})
      let results = await page.evaluate(readResults)
      if (!results.length) {
        const verification = await page.evaluate(() => !!document.querySelector('form[action*="/sorry/"], #b_captcha, #captcha-form, iframe[src*="recaptcha/api2/bframe"]') ||
          /verify you are human|unusual traffic|检测到异常流量|验证你是人类/i.test(document.body?.innerText || ''))
        if (verification) return { ok: false, message: source.name + '要求人工验证，本次没有取得搜索结果。' }
        if (engine === 'bing') {
          url.searchParams.set('format','rss')
          await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 12000 })
          results = await page.evaluate(readResults)
        }
      }
      if (!results.length) return { ok: false, message: source.name + '未返回可读取的结果，页面可能为空或需要验证。', query: keyword }
      const message = results.map((r,i) => (i + 1) + '. ' + r.title + '\n' + r.url + (r.snippet ? '\n' + r.snippet : '')).join('\n\n')
      return { ok: true, source: source.name, query: keyword, results, message }
    } catch (error) {
      ctx.logger.warn(source.name + '请求失败', error instanceof Error ? error.message : String(error))
      return { ok: false, message: source.name + '暂时不可用，请检查浏览器服务与站点连接。' }
    } finally {
      if (browser) { active.delete(browser); await browser.close().catch(() => {}) }
    }
  }

  ctx.tool(() => (Object.keys(engines) as Engine[])
    .filter(engine => ctx.config[engine] ?? engine === 'bing')
    .map((engine): ToolSpec => ({
      name: engines[engine].tool,
      description: engines[engine].name + '。使用浏览器按关键词检索，返回结果标题、网页摘要和来源链接。',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
      execute: ({ query }) => run(engine, query),
    })))
}
