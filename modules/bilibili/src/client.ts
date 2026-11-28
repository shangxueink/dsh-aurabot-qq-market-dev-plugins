import { createHash } from 'node:crypto'

type Query = Record<string, string | number>
interface Envelope<T> {
  code: number
  message?: string
  data: T
}
interface Navigation {
  isLogin?: boolean
  uname?: string
  mid?: number
  wbi_img?: { img_url: string; sub_url: string }
}

const apiOrigin = 'https://api.bilibili.com'
const mix = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
]

function signed(query: Query, key: string) {
  const values: Query = { ...query, wts: Math.floor(Date.now() / 1000) }
  const encoded = Object.keys(values)
    .sort()
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(values[k]).replace(/[!'()*]/g, '')))
    .join('&')
  return (
    encoded +
    '&w_rid=' +
    createHash('md5')
      .update(encoded + key)
      .digest('hex')
  )
}

export function mediaUrl(raw: string | undefined) {
  if (!raw) return
  let url: URL
  try {
    url = new URL(raw, 'https://www.bilibili.com')
  } catch {
    return
  }
  if (url.protocol === 'http:') url.protocol = 'https:'
  if (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    /(?:^|\.)(?:hdslb\.com|bilibili\.com|bilivideo\.(?:com|cn)|biliimg\.com)$/.test(url.hostname)
  )
    return url.href
}

export class Client {
  private key?: { value: string; expires: number }
  constructor(
    private readonly credentials: () => string,
    readonly fetcher: typeof fetch = fetch,
    private readonly stop?: AbortSignal,
  ) {}
  signal() {
    const timeout = AbortSignal.timeout(18000)
    return this.stop ? AbortSignal.any([this.stop, timeout]) : timeout
  }
  private cookies() {
    return this.credentials()
      .split(';')
      .map((s) => s.trim())
      .filter((s) => /^(?:SESSDATA|DedeUserID|buvid3|buvid4)=[^;\s\p{Cc}]+$/u.test(s))
  }
  private async request<T>(path: string, init: RequestInit = {}) {
    const url = new URL(path, apiOrigin)
    if (url.origin !== apiOrigin) throw Error('B 站接口地址无效')
    const res = await this.fetcher(url, {
      ...init,
      headers: { cookie: this.cookies().join('; '), referer: 'https://www.bilibili.com/' },
      redirect: 'error',
      signal: this.signal(),
    })
    if (!res.ok) throw Error('B 站 HTTP ' + res.status)
    return (await res.json()) as Envelope<T>
  }
  async account() {
    const body = await this.request<Navigation>('/x/web-interface/nav')
    if (body.code !== 0 && body.code !== -101) throw Error('账号状态读取失败 ' + body.code)
    const info = body.data
    if (info?.wbi_img) {
      const name = (url: string) => new URL(url).pathname.split('/').pop()!.split('.')[0]
      const source = name(info.wbi_img.img_url) + name(info.wbi_img.sub_url)
      this.key = {
        value: mix
          .map((i) => source[i])
          .join('')
          .slice(0, 32),
        expires: Date.now() + 6 * 3600000,
      }
    }
    return { loggedIn: !!info?.isLogin, name: info?.uname || '', uid: String(info?.mid || '') }
  }
  async get<T>(path: string, query: Query = {}, withSignature = false) {
    if (withSignature && (!this.key || this.key.expires < Date.now())) await this.account()
    if (withSignature && !this.key) throw Error('B 站未提供签名密钥')
    const params = withSignature
      ? signed(query, this.key!.value)
      : new URLSearchParams(
          Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]),
        ).toString()
    return this.unwrap(await this.request<T>(path + '?' + params))
  }
  private unwrap<T>(body: Envelope<T>) {
    if (body.code !== 0)
      throw Object.assign(Error('B 站返回 ' + body.code + ' ' + String(body.message || '').slice(0, 120)), {
        code: body.code,
      })
    return body.data
  }
}
