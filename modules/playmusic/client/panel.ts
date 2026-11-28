declare const React: any
declare const h: any
declare const ui: any
declare const call: (path: string, body?: any) => Promise<any>

interface PanelProps {
  running?: boolean
  toast(message: string, kind?: string): void
}

export default function PlaymusicPanel(props: PanelProps) {
  var toast = props.toast;
  var state = React.useState(null);
  var info = state[0];
  var setInfo = state[1];
  var busyState = React.useState(false);
  var busy = busyState[0];
  var setBusy = busyState[1];

  function load() {
    setBusy(true);
    call('/status')
      .then(function (r) { setInfo(r || {}); setBusy(false); })
      .catch(function (e) { toast(e.message, 'err'); setBusy(false); });
  }

  React.useEffect(function () {
    if (props.running !== false) load();
  }, [props.running]);

  if (props.running === false) {
    return h(ui.Card, { title: '点歌状态' }, '插件已停用。可以先保存点歌配置，启用后在这里查看运行状态。');
  }

  var body;
  if (!info) {
    body = h(ui.Empty, { icon: '⏳', text: '加载中…' });
  } else {
    var ffmpegText = info.ffmpegOk ? (info.ffmpeg || '已找到') : '没找到（下载点歌会失败）';
    body = h('div', null,
      h(ui.Row, { label: 'ffmpeg' }, h('span', { style: { color: info.ffmpegOk ? '#2e7d32' : '#c62828' } }, ffmpegText)),
      h(ui.Row, { label: '搜索来源' }, h('span', null, info.sourceLabel || info.source || '—')),
      h(ui.Row, { label: '语音条上限' }, h('span', null, (info.targetMinutes || 0) + ' 分钟')),
      h(ui.Row, { label: '代理' }, h('span', null, info.proxyMode === 'direct' ? '直连' : info.proxy || '内置 apifox')),
      h(ui.Row, { label: '点歌指令' }, h('span', null, info.commandEnabled ? '/' + (info.commandName || 'music') : '未注册')));
  }

  var button = h(ui.Btn, { onClick: load, disabled: busy }, busy ? '读取中…' : '刷新');
  return h('div', { className: 'ab-grid' },
    h(ui.Card, { title: '点歌状态', desc: '只读。检查本机 ffmpeg 与当前搜索配置。', extra: button }, body));
}
