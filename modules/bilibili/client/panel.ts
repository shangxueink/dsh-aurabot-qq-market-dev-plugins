interface State {
  history: { bvid: string; part: number; title: string; thought: string }[]
  pending: { id: string; item: { title: string }; target: { platform: string; botId: string; id: string } }[]
  shots: { md5: string; bvid: string; title: string; second: number }[]
  lastRun: number
}
declare const React: {
  useState<T>(initial: T): [T, (next: T) => void]
  useEffect(effect: () => () => void, deps: unknown[]): void
}
declare const ui: { Card: unknown; Btn: unknown; Row: unknown }
declare const h: (type: unknown, props: object | null, ...children: unknown[]) => unknown
declare const call: <T>(path: string, body?: object) => Promise<T & { ok?: boolean; message?: string }>
export default function BilibiliPanel({ toast }: { toast(message: string, kind?: string): void }) {
  const [state, setState] = React.useState<State | null>(null)
  const [account, setAccount] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const read = () => call<State>('/state')
  React.useEffect(() => {
    let mounted = true
    read()
      .then((s) => {
        if (mounted) setState(s)
      })
      .catch((e) => {
        if (mounted) toast(String(e), 'err')
      })
    return () => {
      mounted = false
    }
  }, [])
  async function act(path: string, body?: object) {
    if (busy) return
    setBusy(true)
    try {
      const r = await call<{ loggedIn?: boolean; name?: string; uid?: string; count?: number }>(path, body)
      if (r.ok === false) throw Error(r.message || '操作失败')
      if (path === '/account') setAccount(r.loggedIn ? r.name + ' · ' + r.uid : '匿名浏览')
      if (path === '/browse') toast('本轮浏览 ' + (r.count || 0) + ' 个视频')
      setState(await read())
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    } finally {
      setBusy(false)
    }
  }
  const button = (label: string, fn: () => unknown) =>
    h(ui.Btn, { small: true, disabled: busy, onClick: fn }, label)
  return h(
    'div',
    { className: 'ab-grid' },
    h(
      ui.Card,
      { title: '账号与浏览', desc: account || undefined },
      button('检查登录', () => act('/account')),
      button('浏览一轮', () => act('/browse', {})),
      h('a', { href: 'https://passport.bilibili.com/login', target: '_blank', rel: 'noreferrer' }, '登录哔哩哔哩'),
    ),
    state &&
      h(
        ui.Card,
        { title: '待批分享' },
        state.pending.length
          ? state.pending.map((p) =>
              h(
                ui.Row,
                {
                  key: p.id,
                  label: p.item.title,
                  hint: [p.target.platform, p.target.botId, p.target.id].join(' / '),
                },
                button('同意发送', () => act('/decide', { id: p.id, accept: true })),
                button('跳过', () => act('/decide', { id: p.id, accept: false })),
              ),
            )
          : '暂无待批分享',
      ),
    state &&
      h(
        ui.Card,
        { title: '最近浏览' },
        state.history.length
          ? state.history
              .slice(0, 25)
              .map((v) =>
                h(
                  ui.Row,
                  { key: v.bvid + '/' + v.part, label: v.title, hint: v.thought },
                  h(
                    'a',
                    {
                      href: 'https://www.bilibili.com/video/' + encodeURIComponent(v.bvid) + '?p=' + v.part,
                      target: '_blank',
                      rel: 'noreferrer',
                    },
                    '查看视频',
                  ),
                ),
              )
          : '暂无记录',
      ),
    state?.shots.length
      ? h(
          ui.Card,
          { title: '视频帧' },
          state.shots.map((v) => h(ui.Row, { key: v.md5, label: v.title }, v.second + ' 秒')),
        )
      : null,
  )
}
