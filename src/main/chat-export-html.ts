// Turns a collected chat into one self-contained HTML page. Pure: no Electron, no files, no network.
// Everything in the dump comes from other people's messages, so every value is escaped and every URL is checked here.

export type MediaKind = 'image' | 'sticker' | 'video' | 'audio'
export interface ExportMedia {
  kind: MediaKind
  src: string // original address on the page ('' when the page only had a data: or blob: source)
  alt?: string
  width?: number
  height?: number
  data?: string // data: URL once the file is embedded
  file?: string // 'folder/name.ext' next to the page, for files too big to embed
  animated?: boolean // a sticker or GIF that arrived as a video: plays on a loop, silent
  note?: string // why the file is not saved
}
export interface ExportMessage {
  side: 'me' | 'them' | 'unknown'
  author?: string // nickname printed next to the message, if the page shows one (group chats)
  time?: string // exactly as the page gives it (datetime attribute, tooltip or visible time)
  text: string
  links: { href: string; text: string }[]
  media: ExportMedia[]
  video?: { href?: string; text: string; cover?: ExportMedia } // a TikTok video sent into the chat
  reply?: string
  reactions: string[]
  rawText: string // everything visible in the message element, so nothing unrecognised is lost
  outline: string // tags and data-e2e names only, for diagnosing markup changes
}
export type ExportEntry = { sep: string } | ExportMessage
export interface Person { name: string; handle?: string; avatar?: ExportMedia }
export interface ChatDump {
  partner: Person
  owner: Person
  entries: ExportEntry[]
  complete: boolean // the beginning of the conversation was reached
  warnings: string[]
  exportedAt: number
  appVersion: string
  filesFolder?: string // folder next to the page that holds the files too big to embed
}

const isMsg = (e: ExportEntry): e is ExportMessage => !('sep' in e)

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c])
const safeHref = (u?: string) => (u && /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : undefined)
const safeData = (d?: string) =>
  d && /^data:(image\/(png|jpeg|webp|gif|avif)|audio\/[a-z0-9.+-]+|video\/(mp4|webm));base64,[A-Za-z0-9+/=]+$/.test(d) ? d : undefined

/** 'folder/name.ext' as written by the exporter: one folder level, a plain file name; returned URL-encoded. */
function safeFile(f?: string) {
  const parts = (f ?? '').split('/')
  if (parts.length !== 2 || !parts[0] || parts[0].startsWith('.')) return undefined
  const bad = String.fromCharCode(92) + ':*?"<>|'
  for (const ch of parts[0]) if (bad.includes(ch) || ch.charCodeAt(0) < 32) return undefined
  return /^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(parts[1]) ? encodeURIComponent(parts[0]) + '/' + parts[1] : undefined
}

const KIND_LABEL: Record<string, string> = {
  text: 'Текст', sticker: 'Стикеры', image: 'Картинки', shared: 'Видео TikTok', video: 'Видео', audio: 'Голосовые', other: 'Прочее'
}
const SIDE_LABEL = { me: 'Я', them: 'Собеседник', unknown: 'Не определено' }

/** What a message contains; drives the filters and the counters. */
export function kindsOf(m: ExportMessage): string[] {
  const k: string[] = []
  if (m.text) k.push('text')
  for (const x of m.media) if (!k.includes(x.kind)) k.push(x.kind)
  if (m.video) k.push('shared')
  if (!k.length) k.push('other')
  return k
}

function linkify(t: string) {
  let out = ''
  let last = 0
  for (const m of t.matchAll(/https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/g)) {
    const h = safeHref(m[0])
    out += esc(t.slice(last, m.index))
    out += h ? `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(m[0])}</a>` : esc(m[0])
    last = m.index + m[0].length
  }
  return out + esc(t.slice(last))
}

function mediaHtml(m: ExportMedia, cls = '') {
  const data = safeData(m.data)
  const file = safeFile(m.file)
  const have = data ?? (file ? esc(file) : undefined) // a checked data: URL or a checked relative path, both safe inside an attribute
  const src = safeHref(m.src)
  const dim = m.width && m.height ? ` width="${Math.round(m.width)}" height="${Math.round(m.height)}"` : ''
  const open = src ? ` <a href="${esc(src)}" target="_blank" rel="noopener noreferrer">оригинал</a>` : ''
  if (have && m.kind === 'audio') return `<audio class="media" controls preload="none" src="${have}"></audio>`
  if (have && m.kind === 'video' && m.animated) return `<video class="media sticker ${cls}" autoplay loop muted playsinline src="${have}"></video>`
  if (have && m.kind === 'video') return `<video class="media ${cls}" controls preload="metadata" src="${have}"></video>`
  if (have) return `<img class="media ${m.kind} ${cls}" loading="lazy" alt="${esc(m.alt || (m.kind === 'sticker' ? 'Стикер' : 'Изображение'))}" src="${have}"${m.kind === 'sticker' ? '' : dim}>`
  const label = { image: 'Изображение', sticker: 'Стикер', video: 'Видео', audio: 'Голосовое сообщение' }[m.kind]
  return `<div class="missing">${label}: файл не сохранён${m.note ? ` (${esc(m.note)})` : ''}.${open}</div>`
}

function messageHtml(m: ExportMessage, n: number, p: { partner: Person; owner: Person }) {
  const kinds = kindsOf(m)
  const who = m.author || (m.side === 'me' ? p.owner.name : m.side === 'them' ? p.partner.name : 'Не определено')
  const parts: string[] = []
  if (m.reply) parts.push(`<blockquote class="reply">${linkify(m.reply)}</blockquote>`)
  if (m.text) parts.push(`<div class="text">${linkify(m.text)}</div>`)
  for (const x of m.media) parts.push(mediaHtml(x))
  if (m.video) {
    const h = safeHref(m.video.href)
    const cover = m.video.cover ? mediaHtml(m.video.cover, 'cover') : ''
    parts.push(
      `<div class="vcard"><div class="vtag">Видео из TikTok</div>${cover}${m.video.text ? `<div class="vtext">${linkify(m.video.text)}</div>` : ''}${h ? `<a class="vlink" href="${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(h)}</a>` : '<div class="muted">Ссылка на видео не найдена в разметке.</div>'}</div>`
    )
  }
  if (kinds[0] === 'other') parts.push(`<div class="other">Содержимое не распознано${m.rawText ? `: ${esc(m.rawText)}` : '.'}</div>`)
  if (m.reactions.length) parts.push(`<div class="reactions">${m.reactions.map((r) => `<span>${esc(r)}</span>`).join('')}</div>`)
  const dl: [string, string][] = [
    ['Номер', String(n)],
    ['Автор', `${esc(who)} (${SIDE_LABEL[m.side]})`],
    ['Время', m.time ? esc(m.time) : 'не указано на странице'],
    ['Тип', kinds.map((k) => KIND_LABEL[k]).join(', ')]
  ]
  if (m.links.length) dl.push(['Ссылки', m.links.map((l) => `${esc(l.text) || '—'} → ${esc(l.href)}`).join('<br>')])
  const sources = [...m.media, ...(m.video?.cover ? [m.video.cover] : [])].filter((x) => x.src)
  if (sources.length) dl.push(['Исходные адреса', sources.map((x) => esc(x.src)).join('<br>')])
  if (m.rawText) dl.push(['Текст элемента', esc(m.rawText)])
  dl.push(['Разметка', `<code>${esc(m.outline)}</code>`])
  const av = m.side === 'unknown' ? 'them' : m.side
  return `<article class="msg ${m.side}" data-k="${kinds.join(' ')}"><div class="av ${av}" aria-hidden="true"></div><div class="bubble"><div class="meta"><b>${esc(who)}</b>${m.time ? ` <time>${esc(m.time)}</time>` : ''}<span class="num">#${n}</span></div>${parts.join('')}<details class="tech"><summary>Подробности</summary><dl>${dl.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></details></div></article>`
}

const initials = (s: string) => ([...s.replace(/^@/, '').trim()][0] ?? '?').toUpperCase()

const STYLE = `
:root{--bg:#f2f3f8;--panel:rgba(255,255,255,.78);--text:#171923;--muted:#6b7084;--line:rgba(20,22,40,.12);--me:#3b6cff;--me-text:#fff;--them:#fff;--accent:#3b6cff;--shadow:0 6px 24px rgba(30,40,90,.1)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0d0f1a;--panel:rgba(26,29,46,.8);--text:#eceef7;--muted:#9096ad;--line:rgba(255,255,255,.12);--them:#1f2236;--shadow:0 6px 24px rgba(0,0,0,.35)}}
:root[data-theme=dark]{--bg:#0d0f1a;--panel:rgba(26,29,46,.8);--text:#eceef7;--muted:#9096ad;--line:rgba(255,255,255,.12);--them:#1f2236;--shadow:0 6px 24px rgba(0,0,0,.35)}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:radial-gradient(900px 500px at 10% -10%,rgba(59,108,255,.22),transparent),radial-gradient(800px 500px at 100% 0,rgba(165,70,255,.18),transparent),var(--bg);background-attachment:fixed;color:var(--text);font:15px/1.5 'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:20px 16px 80px}
.glass{background:var(--panel);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);-webkit-backdrop-filter:blur(22px);backdrop-filter:blur(22px)}
header.top{display:flex;gap:16px;align-items:center;padding:18px 20px;margin-bottom:14px}
.big{width:64px;height:64px;border-radius:50%;flex:none}
.big,.av{background:linear-gradient(135deg,#3b6cff,#a546ff) center/cover no-repeat;display:grid;place-items:center;color:#fff;font-weight:700}
.big::after,.av::after{content:attr(data-i)}
header.top h1{margin:0;font-size:22px;line-height:1.2}
.muted{color:var(--muted)}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
.stat{padding:8px 14px;border-radius:16px;font-size:13px}.stat b{display:block;font-size:18px}
.warn{padding:12px 16px;border-radius:16px;margin-bottom:14px;background:rgba(255,170,40,.16);border:1px solid rgba(255,170,40,.4);font-size:14px}
.ok{padding:8px 14px;border-radius:16px;margin-bottom:14px;background:rgba(40,200,120,.14);border:1px solid rgba(40,200,120,.35);font-size:14px}
.controls{position:sticky;top:8px;z-index:5;padding:10px 12px;margin-bottom:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.controls input,.controls select,.controls button{font:inherit;color:var(--text);background:transparent;border:1px solid var(--line);border-radius:14px;padding:6px 12px}
.controls input{flex:1;min-width:160px}.controls option{color:#000}
.controls button{cursor:pointer}.controls button.on{background:var(--accent);color:#fff;border-color:transparent}
.chips{display:flex;flex-wrap:wrap;gap:6px;width:100%}
#cnt{font-size:13px;color:var(--muted);margin-left:auto}
.sep{text-align:center;margin:18px 0 8px;position:sticky;top:64px;z-index:2}
.sep span{display:inline-block;padding:3px 14px;border-radius:99px;font-size:12px;background:var(--panel);border:1px solid var(--line);color:var(--muted);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
.msg{display:flex;gap:8px;margin:6px 0;align-items:flex-end;content-visibility:auto;contain-intrinsic-size:auto 76px}.msg[hidden],.sep[hidden]{display:none}
.msg.me{flex-direction:row-reverse}
.av{width:32px;height:32px;border-radius:50%;flex:none;font-size:13px}
.bubble{max-width:min(78%,560px);padding:9px 13px;border-radius:20px;background:var(--them);border:1px solid var(--line);box-shadow:0 3px 12px rgba(0,0,0,.08);overflow-wrap:anywhere}
.msg.me .bubble{background:var(--me);color:var(--me-text);border-color:transparent;border-bottom-right-radius:6px}
.msg.them .bubble,.msg.unknown .bubble{border-bottom-left-radius:6px}
.msg.me a{color:#fff}a{color:var(--accent)}
.meta{font-size:12px;opacity:.75;display:flex;gap:8px;align-items:baseline;margin-bottom:2px}.meta .num{margin-left:auto;opacity:.6}
.text{white-space:pre-wrap}
.media{display:block;max-width:100%;max-height:420px;border-radius:14px;margin:6px 0;cursor:zoom-in}
.media.sticker{width:140px;height:auto;max-height:180px;background:none}
audio.media,video.media{cursor:auto}
.missing,.other{font-size:13px;opacity:.85;font-style:italic;margin:4px 0}
.reply{margin:2px 0 6px;padding:4px 10px;border-left:3px solid currentColor;opacity:.75;font-size:13px}
.vcard{margin:6px 0;padding:8px;border-radius:16px;background:rgba(127,127,160,.16);border:1px solid var(--line)}
.vtag{font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.7}
.vtext{margin:4px 0}.vlink{font-size:12px;word-break:break-all}
.reactions{margin-top:4px;display:flex;gap:4px}.reactions span{background:rgba(127,127,160,.2);border-radius:99px;padding:0 8px}
.tech{margin-top:4px;font-size:12px;opacity:.8}.tech summary{cursor:pointer;opacity:.6}
.tech dl{margin:6px 0 0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px}.tech dt{opacity:.7}.tech dd{margin:0;word-break:break-all}
.tech code{font-size:11px;white-space:pre-wrap}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.86);display:none;place-items:center;z-index:50;cursor:zoom-out}#lb.on{display:grid}#lb img{max-width:94vw;max-height:94vh;border-radius:12px}
footer{margin-top:30px;text-align:center;font-size:12px;color:var(--muted)}
@media (max-width:560px){.bubble{max-width:84%}.sep{top:112px}}
@media print{.controls,#lb{display:none}body{background:#fff}.msg[hidden]{display:flex}}
`

const SCRIPT = String.raw`
(function(){
var $=function(s){return document.querySelector(s)},all=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))};
var msgs=all('.msg'),chat=$('#chat'),q=$('#q'),side=$('#side'),cnt=$('#cnt'),active={},cache=new WeakMap();
function text(m){var t=cache.get(m);if(t===undefined){t=m.textContent.toLowerCase();cache.set(m,t)}return t}
function apply(){
  var t=q.value.trim().toLowerCase(),kinds=Object.keys(active),n=0,sep=null,seen=false;
  for(var i=0;i<chat.children.length;i++){
    var el=chat.children[i];
    if(el.classList.contains('sep')){if(sep)sep.hidden=!seen;sep=el;seen=false;continue}
    var ok=(!t||text(el).indexOf(t)>-1)&&(side.value==='all'||el.classList.contains(side.value))&&(!kinds.length||el.dataset.k.split(' ').some(function(k){return active[k]}));
    el.hidden=!ok;if(ok){n++;seen=true}
  }
  if(sep)sep.hidden=!seen;
  cnt.textContent=n+' из '+msgs.length;
}
q.addEventListener('input',apply);side.addEventListener('change',apply);
all('.chips button').forEach(function(b){b.addEventListener('click',function(){var k=b.dataset.k;if(active[k]){delete active[k];b.classList.remove('on')}else{active[k]=1;b.classList.add('on')}apply()})});
var jump=$('#jump');if(jump)jump.addEventListener('change',function(){var e=document.getElementById(jump.value);if(e){e.hidden=false;e.scrollIntoView({block:'start'})}jump.selectedIndex=0});
$('#theme').addEventListener('click',function(){var r=document.documentElement,dark=r.dataset.theme==='dark'||(!r.dataset.theme&&matchMedia('(prefers-color-scheme: dark)').matches);r.dataset.theme=dark?'light':'dark'});
$('#json').addEventListener('click',function(){var b=new Blob([document.getElementById('export-data').textContent],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='tiktok-chat.json';document.body.appendChild(a);a.click();a.remove()});
var lb=$('#lb');document.addEventListener('click',function(e){var t=e.target;if(t.tagName==='IMG'&&t.classList.contains('media')){lb.firstChild.src=t.src;lb.classList.add('on')}else if(lb.contains(t)||t===lb)lb.classList.remove('on')});
document.addEventListener('keydown',function(e){if(e.key==='Escape')lb.classList.remove('on')});
window.scrollTo(0,document.body.scrollHeight);
})();
`

/** The same data as JSON, without the embedded files, safe to place inside a script tag. */
function jsonBlock(d: ChatDump) {
  const strip = (m?: ExportMedia) => (m ? { ...m, data: undefined, embedded: !!m.data } : undefined)
  const entries = d.entries.map((e) =>
    isMsg(e) ? { ...e, media: e.media.map(strip), video: e.video ? { ...e.video, cover: strip(e.video.cover) } : undefined } : e
  )
  const out = { ...d, partner: { ...d.partner, avatar: strip(d.partner.avatar) }, owner: { ...d.owner, avatar: strip(d.owner.avatar) }, entries }
  return JSON.stringify(out).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16))
}

const fmt = (t: number) => new Date(t).toLocaleString('ru-RU')

export function renderChatHtml(d: ChatDump): string {
  const people = { partner: d.partner, owner: d.owner }
  const messages = d.entries.filter(isMsg)
  const count = (f: (m: ExportMessage) => boolean) => messages.filter(f).length
  const kindTotals: Record<string, number> = {}
  for (const m of messages) for (const k of kindsOf(m)) kindTotals[k] = (kindTotals[k] ?? 0) + 1
  const ms = messages.flatMap((m) => [...m.media, ...(m.video?.cover ? [m.video.cover] : [])])
  const folderFiles = ms.filter((x) => safeFile(x.file)).length
  const seps = d.entries.flatMap((e, i) => ('sep' in e ? [{ i, text: e.sep }] : []))

  let n = 0
  let sepNo = 0
  const body = d.entries
    .map((e) => (isMsg(e) ? messageHtml(e, ++n, people) : `<div class="sep" id="d${sepNo++}"><span>${esc(e.sep)}</span></div>`))
    .join('\n')

  const avatarCss = (cls: string, p: Person) => {
    const a = safeData(p.avatar?.data)
    return a ? `.av.${cls}{background-image:url("${a}")}.av.${cls}::after{content:none}` : ''
  }
  const bigAv = safeData(d.partner.avatar?.data)
  const title = `Чат с ${d.partner.name || 'собеседником'}`
  const chips = Object.keys(KIND_LABEL).filter((k) => kindTotals[k]).map((k) => `<button type="button" data-k="${k}">${KIND_LABEL[k]} · ${kindTotals[k]}</button>`).join('')
  const stat = (label: string, v: number | string) => `<div class="glass stat">${esc(label)}<b>${esc(v)}</b></div>`

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: file:; media-src data: file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${esc(title)}</title>
<style>${STYLE}${avatarCss('me', d.owner)}${avatarCss('them', d.partner)}</style>
</head>
<body>
<div class="wrap">
<header class="top glass">
<div class="big" data-i="${esc(initials(d.partner.name))}"${bigAv ? ` style="background-image:url('${bigAv}')"` : ''}></div>
<div><h1>${esc(title)}</h1><div class="muted">${esc(d.partner.handle ?? '')}${d.partner.handle ? ' · ' : ''}аккаунт «${esc(d.owner.name)}»${d.owner.handle ? ' (@' + esc(d.owner.handle.replace(/^@/, '')) + ')' : ''}</div><div class="muted">Экспортировано ${esc(fmt(d.exportedAt))} · StackTok ${esc(d.appVersion)}</div></div>
</header>
${d.complete ? '<div class="ok">Переписка загружена с самого начала.</div>' : ''}${folderFiles && d.filesFolder ? `<div class="ok">Крупные файлы (${folderFiles}) лежат в папке «${esc(d.filesFolder)}» рядом с этой страницей: храните их вместе.</div>` : ''}${d.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
<div class="stats">${stat('Сообщений', messages.length)}${stat(d.owner.name, count((m) => m.side === 'me'))}${stat(d.partner.name || 'Собеседник', count((m) => m.side === 'them'))}${count((m) => m.side === 'unknown') ? stat('Не определено', count((m) => m.side === 'unknown')) : ''}${ms.length ? stat('Вложений сохранено', `${ms.filter((x) => x.data || x.file).length} из ${ms.length}`) : ''}${seps.length ? stat('Начало', seps[0].text) : ''}${seps.length > 1 ? stat('Конец', seps[seps.length - 1].text) : ''}</div>
<div class="glass controls">
<input id="q" type="search" placeholder="Поиск по сообщениям…" aria-label="Поиск">
<select id="side" aria-label="Автор"><option value="all">Все авторы</option><option value="me">${esc(d.owner.name)}</option><option value="them">${esc(d.partner.name || 'Собеседник')}</option></select>
${seps.length ? `<select id="jump" aria-label="К дате"><option>К дате…</option>${seps.map((s, i) => `<option value="d${i}">${esc(s.text)}</option>`).join('')}</select>` : ''}
<button id="theme" type="button">Тема</button><button id="json" type="button">Скачать JSON</button><span id="cnt"></span>
<div class="chips">${chips}</div>
</div>
<main id="chat">
${body}
</main>
<footer>Этот файл создан локально приложением StackTok и никуда не отправлялся.</footer>
</div>
<div id="lb"><img alt=""></div>
<script type="application/json" id="export-data">${jsonBlock(d)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`
}
