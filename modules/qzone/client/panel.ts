type Setter<T> = (value: T) => void
declare const React: {
  useState<T>(initial: T): [T, Setter<T>]
  useEffect(fn: () => void | (() => void), deps: unknown[]): void
}
declare const h: (type: unknown, props: object | null, ...children: unknown[]) => unknown
declare const ui: { Card: unknown; Btn: unknown; Row: unknown }
interface Picture {
  id: string
  caption: string
}
interface Diary {
  at: number
  tid: string
  text: string
  deletedAt?: number
  visibility: string
}
interface Result {
  ok: boolean
  message?: string
  text?: string
  media?: Picture[]
  warnings?: string[]
}
interface State extends Result {
  online: boolean
  botId?: string
  history?: Diary[]
  social?: { count: number; history: { at: number; kind: string; who: string; text: string }[] }
}
declare const call: <T extends Result = Result>(path: string, body?: object) => Promise<T>
interface Props {
  toast(message: string, kind?: string): void
  id?: string
  module?: { id: string }
}

export default function QzonePanel({ toast }: Props) {
  const [state, setState] = React.useState<State | null>(null)
  const [draft, setDraft] = React.useState<Result | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [pending, setPending] = React.useState('')
  const load = async () => setState(await call<State>('/state'))
  React.useEffect(() => {
    let active = true
    call<State>('/state')
      .then((s) => {
        if (active) setState(s)
      })
      .catch((e) => toast(String(e), 'err'))
    return () => {
      active = false
    }
  }, [])
  async function act(path: string, body: object = {}) {
    if (busy) return
    setBusy(true)
    try {
      const r = await call(path, body)
      if (!r.ok) throw Error(r.message || '操作失败')
      if (path === '/diary/preview') setDraft(r)
      else setDraft(null)
      await load()
      if (r.message) toast(r.message)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    } finally {
      setPending('')
      setBusy(false)
    }
  }
  const btn = (label: string, fn: () => unknown) =>
    h(ui.Btn, { small: true, onClick: fn, disabled: busy }, label)
  if (!state?.online)
    return h(ui.Card, { title: 'QQ 空间' }, state ? '等待所选 QQ Bot 上线' : '正在读取账号状态…')
  return h(
    'div',
    { className: 'ab-grid' },
    h(
      ui.Card,
      { title: '空间日记', desc: state.botId },
      btn('生成预览', () => act('/diary/preview')),
      btn('写一篇并发布', () => act('/diary/run')),
      btn('核对历史', () => act('/diary/sync')),
      draft
        ? h(
            'div',
            null,
            h('p', null, draft.text),
            ...(draft.media || []).map((p) => h('span', { key: p.id }, p.caption)),
            ...(draft.warnings || []).map((w) => h('p', { key: w }, w)),
          )
        : null,
      ...(state.history || []).map((d) =>
        h(
          ui.Row,
          { key: d.tid || d.at, label: new Date(d.at).toLocaleString() },
          h('span', null, d.text),
          d.deletedAt
            ? '已删除'
            : d.tid
              ? pending === d.tid
                ? h(
                    'span',
                    null,
                    btn('确认删除', () => act('/diary/delete', { tid: d.tid })),
                    btn('取消', () => setPending('')),
                  )
                : btn('删除', () => setPending(d.tid))
              : null,
        ),
      ),
    ),
    h(
      ui.Card,
      { title: '空间互动', desc: '今天已评论 ' + (state.social?.count || 0) + ' 次' },
      btn('逛一次空间', () => act('/social/run')),
      ...(state.social?.history || []).map((r, i) =>
        h(ui.Row, { key: r.at + '-' + i, label: r.who }, r.text || '点赞'),
      ),
    ),
    h(
      ui.Card,
      { title: '浏览图归档' },
      btn('归档公开浏览图', () => act('/archive/collect')),
    ),
  )
}
