// Turns a collected chat into one self-contained HTML page. Pure: no Electron, no files, no network.
// Everything in the dump comes from other people's messages, so every value is escaped and every URL is checked here.

export type MediaKind = 'image' | 'sticker' | 'video' | 'audio' | 'file'
/** How to open a file TikTok stores encrypted. Used while downloading, never written to the export. */
export interface MediaSecret { key: string; user?: string; mint?: boolean }
export interface ExportMedia {
  kind: MediaKind
  src: string // original address on the page ('' when the page only had a data: or blob: source)
  alts?: { src: string; secret?: MediaSecret }[] // other copies of the same file, tried when the first one fails
  secret?: MediaSecret
  label?: string // the caption TikTok gives the file (sticker name, preview text)
  alt?: string
  width?: number
  height?: number
  data?: string // data: URL once the file is embedded
  file?: string // 'folder/name.ext' next to the page, for files too big to embed
  animated?: boolean // a sticker or GIF that plays on a loop, silent
  note?: string // why the file is not saved
}
/** One emoji under a message: how many, and who set it («вы», «собеседник»). `code` is the key of a reaction that is not an emoji. */
export interface ExportReaction { emoji: string; code?: string; count: number; who: string[]; when?: string }
export interface ExportMessage {
  side: 'me' | 'them' | 'unknown'
  author?: string // nickname printed next to the message, if known (group chats)
  time?: string // exactly as the page gives it (datetime attribute, tooltip or visible time)
  text: string
  links: { href: string; text: string }[]
  media: ExportMedia[]
  video?: { href?: string; text: string; cover?: ExportMedia; tag?: string } // a TikTok video sent into the chat
  reply?: string
  replyWho?: string // «Ответ: вы»
  replyTo?: number // number of the quoted message in this file
  reactions: ExportReaction[]
  rawText: string // everything visible in the message element, so nothing unrecognised is lost
  outline: string // tags and data-e2e names only, for diagnosing markup changes
  tag?: string // what kind of message this is, when its content does not show it
  service?: boolean // a line from TikTok in the middle of the chat
  deleted?: boolean
  unknown?: boolean // a type this exporter cannot show: the raw data is in the details
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
  text: 'Текст', sticker: 'Стикеры', image: 'Картинки', shared: 'Видео TikTok', video: 'Видео', audio: 'Голосовые', file: 'Файлы',
  reaction: 'С реакциями', deleted: 'Удалённые', service: 'Служебные', unknown: 'Неизвестные типы', other: 'Прочее'
}
const SIDE_LABEL = { me: 'Я', them: 'Собеседник', unknown: 'Не определено' }

/** What a message contains; drives the filters and the counters. */
export function kindsOf(m: ExportMessage): string[] {
  const k: string[] = []
  if (m.service) k.push('service')
  else if (m.deleted) k.push('deleted')
  else if (m.text) k.push('text')
  for (const x of m.media) if (!k.includes(x.kind)) k.push(x.kind)
  if (m.video) k.push('shared')
  if (m.unknown) k.push('unknown')
  if (!k.length) k.push('other')
  if (m.reactions.length) k.push('reaction')
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
  const label = { image: 'Изображение', sticker: 'Стикер', video: 'Видео', audio: 'Голосовое сообщение', file: 'Файл' }[m.kind]
  const caption = m.label ? ` «${esc(m.label)}»` : ''
  // a file a browser cannot draw by itself (Lottie JSON, unknown bytes) stays next to the page as a link
  if (file && !data && /\.(json|bin|amr)$/.test(m.file ?? '')) return `<a class="filecard" href="${esc(file)}" target="_blank" rel="noopener noreferrer">${label}${caption}: файл сохранён, браузер его не показывает</a>${m.note ? `<div class="missing">${esc(m.note)}</div>` : ''}`
  if (have && m.kind === 'file') return `<a class="filecard" href="${have}" target="_blank" rel="noopener noreferrer">${label}${caption}</a>`
  if (have && m.kind === 'audio') return `<audio class="media" controls preload="none" src="${have}"></audio>`
  if (have && m.kind === 'video' && m.animated) return `<video class="media sticker ${cls}" autoplay loop muted playsinline src="${have}"></video>`
  if (have && m.kind === 'video') return `<video class="media ${cls}" controls preload="metadata" src="${have}"></video>`
  if (have) return `<img class="media ${m.kind} ${cls}" loading="lazy" alt="${esc(m.alt || m.label || (m.kind === 'sticker' ? 'Стикер' : 'Изображение'))}" src="${have}"${m.kind === 'sticker' ? '' : dim}>`
  return `<div class="missing">${label}${caption}: файл не сохранён${m.note ? ` (${esc(m.note)})` : ''}.${open}</div>`
}

function reactionsHtml(m: ExportMessage) {
  if (!m.reactions.length) return ''
  const one = (r: ExportReaction) => {
    const n = r.count > 1 ? `<i>×${r.count}</i>` : ''
    const who = r.who.length ? ` · ${esc([...new Set(r.who)].join(', '))}` : ''
    const code = r.code ? ` <code>${esc(r.code)}</code>` : ''
    return `<span class="rx"${r.when ? ` title="${esc(r.when)}"` : ''}><b>${esc(r.emoji)}</b>${code}${n}${who}</span>`
  }
  return `<div class="reactions">${m.reactions.map(one).join('')}</div>`
}

/** Letter for the round avatar of a message. */
const initials = (s: string) => ([...s.replace(/^@/, '').trim()][0] ?? '?').toUpperCase()

interface Place { n: number; first: boolean; last: boolean; showName: boolean }

function messageHtml(m: ExportMessage, at: Place, p: { partner: Person; owner: Person }) {
  const { n } = at
  const kinds = kindsOf(m)
  const who = m.author || (m.side === 'me' ? p.owner.name : m.side === 'them' ? p.partner.name : 'Не определено')
  const parts: string[] = []
  if (m.reply) {
    const head = m.replyWho ? `<b>${esc(m.replyWho)}</b>` : ''
    const inner = `${head}<span>${linkify(m.reply)}</span>`
    parts.push(m.replyTo ? `<blockquote class="reply"><a class="jump" href="#m${Math.round(m.replyTo)}">${head}<span>${esc(m.reply)}</span></a></blockquote>` : `<blockquote class="reply">${inner}</blockquote>`)
  }
  if (m.tag) parts.push(`<div class="tag${m.unknown ? ' bad' : ''}">${esc(m.tag)}</div>`)
  if (m.text) parts.push(`<div class="text${m.deleted ? ' gone' : ''}">${linkify(m.text)}</div>`)
  for (const x of m.media) parts.push(mediaHtml(x))
  if (m.video) {
    const h = safeHref(m.video.href)
    const cover = m.video.cover ? mediaHtml(m.video.cover, 'cover') : ''
    parts.push(
      `<div class="vcard"><div class="vtag">${esc(m.video.tag ?? 'Видео из TikTok')}</div>${cover}${m.video.text ? `<div class="vtext">${linkify(m.video.text)}</div>` : ''}${h ? `<a class="vlink" href="${esc(h)}" target="_blank" rel="noopener noreferrer">Открыть в TikTok</a>` : '<div class="muted">Ссылка на видео не найдена в разметке.</div>'}</div>`
    )
  }
  if (kinds[0] === 'other' || (m.unknown && !m.text && !m.media.length && !m.video)) parts.push(`<div class="other">Содержимое не распознано${m.rawText ? `: ${esc(m.rawText.slice(0, 400))}` : '.'}</div>`)

  const dl: [string, string][] = [
    ['Номер', String(n)],
    ['Автор', `${esc(who)} (${SIDE_LABEL[m.side]})`],
    ['Время', m.time ? esc(m.time) : 'не указано на странице'],
    ['Тип', kinds.map((k) => KIND_LABEL[k]).join(', ')]
  ]
  if (m.reactions.length) dl.push(['Реакции', m.reactions.map((r) => `${esc(r.emoji)}${r.code ? ` ${esc(r.code)}` : ''} × ${r.count}: ${esc(r.who.join(', '))}${r.when ? ` (${esc(r.when)})` : ''}`).join('<br>')])
  if (m.links.length) dl.push(['Ссылки', m.links.map((l) => `${esc(l.text) || '—'} → ${esc(l.href)}`).join('<br>')])
  const sources = [...m.media, ...(m.video?.cover ? [m.video.cover] : [])].filter((x) => x.src)
  if (sources.length) dl.push(['Исходные адреса', sources.map((x) => esc(x.src)).join('<br>')])
  if (m.rawText) dl.push(['Сырые данные', `<code>${esc(m.rawText)}</code>`])
  dl.push(['Разметка', `<code>${esc(m.outline)}</code>`])
  const tech = `<details class="tech${m.unknown ? ' open' : ''}"><summary>Подробности</summary><dl>${dl.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></details>`
  const time = m.time ? `<time>${esc(/^\d{1,2}:\d{2}:\d{2}$/.test(m.time) ? m.time.slice(0, -3) : m.time)}</time>` : ''
  const head = `<article class="msg ${m.side}${m.service ? ' svc' : ''}${at.first ? ' first' : ''}${at.last ? ' last' : ''}" id="m${n}" data-k="${kinds.join(' ')}">`

  if (m.service) return `${head}<div class="tip"><div class="c">${parts.join('')}</div>${time}${reactionsHtml(m)}${tech}</div></article>`
  // stickers and lone pictures sit on the page without a bubble, as in TikTok
  const bare = !m.text && !m.reply && !m.tag && !m.video && m.media.length === 1 && (m.media[0].data || m.media[0].file) && m.media[0].kind !== 'audio' ? ' bare' : ''
  const av = m.side === 'unknown' ? 'them' : m.side
  return `${head}<div class="av ${av}${at.last ? '' : ' none'}" data-i="${esc(initials(who))}" aria-hidden="true"></div><div class="col">${at.showName ? `<div class="who">${esc(who)}</div>` : ''}<div class="bubble${bare}"><div class="c">${parts.join('')}</div>${time}</div>${reactionsHtml(m)}${tech}</div></article>`
}

const STYLE = `
:root{--bg:#fff;--bar:rgba(255,255,255,.92);--text:#161823;--muted:rgba(22,24,35,.55);--line:rgba(22,24,35,.12);--them:#f1f1f2;--me:#2f7bf6;--me-text:#fff;--pill:#f1f1f2;--tint:rgba(22,24,35,.05);--accent:#fe2c55;--link:#0a64d6;--warn:#fff4e0;--warn-line:#f2c778;--ok:#e6f7ee;--ok-line:#9ad9b5;--shadow:0 1px 2px rgba(22,24,35,.08)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#121212;--bar:rgba(18,18,18,.92);--text:rgba(255,255,255,.92);--muted:rgba(255,255,255,.52);--line:rgba(255,255,255,.12);--them:#2a2a2d;--me:#2f7bf6;--pill:#2a2a2d;--tint:rgba(255,255,255,.07);--link:#6db1ff;--warn:#3a2d12;--warn-line:#7a5d22;--ok:#14301f;--ok-line:#2c6b47;--shadow:none}}
:root[data-theme=dark]{--bg:#121212;--bar:rgba(18,18,18,.92);--text:rgba(255,255,255,.92);--muted:rgba(255,255,255,.52);--line:rgba(255,255,255,.12);--them:#2a2a2d;--me:#2f7bf6;--pill:#2a2a2d;--tint:rgba(255,255,255,.07);--link:#6db1ff;--warn:#3a2d12;--warn-line:#7a5d22;--ok:#14301f;--ok-line:#2c6b47;--shadow:none}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.42 'TikTokFont',-apple-system,BlinkMacSystemFont,'Segoe UI Variable Text','Segoe UI',Roboto,system-ui,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.bar{position:sticky;top:0;z-index:6;background:var(--bar);border-bottom:1px solid var(--line);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px)}
.barin{max-width:780px;margin:0 auto;padding:10px 16px}
.head{display:flex;gap:12px;align-items:center;min-width:0}
.big{width:44px;height:44px;border-radius:50%;flex:none;font-size:18px}
.big,.av{background:#8a8b91 center/cover no-repeat;display:grid;place-items:center;color:#fff;font-weight:600}
.big::after,.av::after{content:attr(data-i)}
.who-box{min-width:0;flex:1}
.who-box h1{margin:0;font-size:17px;line-height:1.25;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.who-box div{font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tools{display:flex;gap:6px;flex:none}
.tools button,.controls input,.controls select,.chips button{font:inherit;font-size:13px;color:var(--text);background:var(--tint);border:0;border-radius:8px;padding:7px 10px;min-height:34px}
.tools button,.chips button{cursor:pointer}
.controls{display:flex;gap:6px;margin-top:8px;align-items:center}
.controls input{flex:1;min-width:0}
.controls select{max-width:170px}.controls option{color:#000}
#cnt{font-size:12px;color:var(--muted);white-space:nowrap}
.chips{display:flex;gap:6px;margin-top:8px;overflow-x:auto;scrollbar-width:none;padding-bottom:1px}
.chips::-webkit-scrollbar{display:none}
.chips button{flex:none;white-space:nowrap;min-height:30px;padding:4px 10px;font-size:12px}
.chips button.on{background:var(--accent);color:#fff}
.wrap{max-width:780px;margin:0 auto;padding:12px 16px 60px}
.muted{color:var(--muted)}
.info{margin:0 0 10px;font-size:13px;color:var(--muted)}.info summary{cursor:pointer;padding:4px 0}
.stats{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.stat{padding:6px 10px;border-radius:8px;background:var(--tint);font-size:12px;color:var(--muted)}.stat b{display:block;font-size:15px;color:var(--text);font-weight:600}
.warn,.ok{padding:8px 12px;border-radius:8px;margin:0 0 8px;font-size:13px;border:1px solid}
.warn{background:var(--warn);border-color:var(--warn-line)}.ok{background:var(--ok);border-color:var(--ok-line)}
.sep{text-align:center;margin:16px 0 8px;position:sticky;top:calc(var(--top,120px) + 6px);z-index:2}
.sep span{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;background:var(--bar);color:var(--muted)}
.msg{display:flex;gap:8px;margin:2px 0;align-items:flex-end;content-visibility:auto;contain-intrinsic-size:auto 52px;scroll-margin-top:calc(var(--top,120px) + 12px)}.msg[hidden],.sep[hidden]{display:none}
.msg.first{margin-top:10px}
.msg.me{flex-direction:row-reverse}
.msg.svc{justify-content:center;margin:10px 0}
.msg:target .bubble{outline:2px solid var(--accent);outline-offset:2px}
.av{width:32px;height:32px;border-radius:50%;flex:none;font-size:13px}.av.none{visibility:hidden}
.col{display:flex;flex-direction:column;align-items:flex-start;min-width:0;max-width:min(72%,520px)}
.msg.me .col{align-items:flex-end}
.who{font-size:12px;color:var(--muted);margin:0 0 2px 2px}
.bubble{position:relative;max-width:100%;padding:7px 11px;border-radius:16px;background:var(--them);overflow-wrap:anywhere;box-shadow:var(--shadow)}
.msg.them.last .bubble,.msg.unknown.last .bubble{border-bottom-left-radius:4px}
.msg.me .bubble{background:var(--me);color:var(--me-text)}.msg.me.last .bubble{border-bottom-right-radius:4px}
.msg.me .bubble a{color:inherit;text-decoration:underline}
.bubble.bare{background:none;padding:0;box-shadow:none}
.bubble time{display:block;text-align:right;font-size:11px;line-height:1.2;margin-top:2px;opacity:.65}
.bubble.bare time{color:var(--muted);opacity:1}
.text{white-space:pre-wrap}.text.gone{font-style:italic;opacity:.75}
.tag{font-size:12px;opacity:.75;margin-bottom:2px}.tag.bad{color:#d97a00;opacity:1;font-weight:600}
.media{display:block;max-width:100%;max-height:400px;border-radius:10px;margin:3px 0;cursor:zoom-in;height:auto}
.media.sticker{width:140px;max-height:180px;object-fit:contain;background:none;border-radius:6px}
audio.media{width:260px;max-width:100%;height:40px;cursor:auto}video.media{cursor:auto}
.filecard{display:block;padding:8px 10px;margin:3px 0;border-radius:10px;background:var(--tint);font-size:13px}
.missing,.other{font-size:13px;opacity:.85;font-style:italic;margin:3px 0}
.reply{margin:0 0 4px;padding:3px 8px;border-left:3px solid currentColor;border-radius:3px;opacity:.82;font-size:13px;background:var(--tint)}
.reply b{display:block;font-weight:600;font-size:12px}.reply span{display:block;max-height:3.9em;overflow:hidden}.reply .jump{color:inherit;text-decoration:none}
.vcard{margin:3px 0;padding:8px;border-radius:10px;background:var(--tint);min-width:180px}
.msg.me .vcard{background:rgba(255,255,255,.16)}
.vtag{font-size:12px;opacity:.75;margin-bottom:3px}.vtext{margin:3px 0}.vlink{font-size:13px}
.vcard .media{max-height:260px}
.reactions{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px}
.rx{display:inline-flex;gap:4px;align-items:center;padding:2px 9px;border-radius:99px;background:var(--pill);font-size:12px;color:var(--muted)}
.rx b{font-size:15px;font-weight:400;color:var(--text)}.rx i{font-style:normal;color:var(--text)}.rx code{font-size:11px}
.tip{max-width:min(86%,560px);text-align:center;font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.tip time{display:block;font-size:11px;opacity:.8}.tip .reactions{justify-content:center}
.tech{font-size:12px;color:var(--muted);max-width:100%}.tech summary{cursor:pointer;opacity:0;font-size:11px;padding:1px 2px;list-style:none}.tech summary::-webkit-details-marker{display:none}
.tech:not([open]):not(.open){height:0;position:relative;z-index:1}
.msg:hover .tech summary,.tech[open] summary,.tech.open summary,.tech summary:focus{opacity:.8}
@media (hover:none){.tech:not([open]):not(.open){height:auto}.tech summary{opacity:.55}}
.tech dl{margin:4px 0 6px;padding:8px;border-radius:8px;background:var(--tint);display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;text-align:left}.tech dt{opacity:.8}.tech dd{margin:0;overflow-wrap:anywhere}
.tech code{font-size:11px;white-space:pre-wrap}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.86);display:none;place-items:center;z-index:50;cursor:zoom-out}#lb.on{display:grid}#lb img{max-width:94vw;max-height:94vh;border-radius:8px}
footer{margin-top:26px;text-align:center;font-size:12px;color:var(--muted)}
@media (max-width:560px){.col{max-width:82%}.barin,.wrap{padding-left:10px;padding-right:10px}.big{width:36px;height:36px;font-size:15px}.who-box h1{font-size:15px}.tools button{padding:6px 8px}.controls{flex-wrap:wrap}.controls input{flex:1 1 100%}.controls select{flex:1;max-width:none}.av{width:26px;height:26px;font-size:11px}.media.sticker{width:120px}.sep{position:static}}
@media print{.bar,#lb,.tech{display:none}.msg[hidden]{display:flex}}
`

const SCRIPT = String.raw`
(function(){
var $=function(s){return document.querySelector(s)},all=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))};
var msgs=all('.msg'),chat=$('#chat'),q=$('#q'),side=$('#side'),cnt=$('#cnt'),active={},cache=new WeakMap();
function text(m){var t=cache.get(m);if(t===undefined){var c=m.querySelector('.c'),r=m.querySelector('.reactions');t=((c?c.textContent:'')+' '+(r?r.textContent:'')).toLowerCase();cache.set(m,t)}return t}
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
var jump=$('#jump');if(jump)jump.addEventListener('change',function(){var e=document.getElementById(jump.value);if(e){e.hidden=false;e.scrollIntoView({block:'start'});window.scrollBy(0,-document.querySelector('.bar').offsetHeight)}jump.selectedIndex=0});
$('#theme').addEventListener('click',function(){var r=document.documentElement,dark=r.dataset.theme==='dark'||(!r.dataset.theme&&matchMedia('(prefers-color-scheme: dark)').matches);r.dataset.theme=dark?'light':'dark'});
$('#json').addEventListener('click',function(){var b=new Blob([document.getElementById('export-data').textContent],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='tiktok-chat.json';document.body.appendChild(a);a.click();a.remove()});
var lb=$('#lb');document.addEventListener('click',function(e){var t=e.target;if(t.tagName==='IMG'&&t.classList.contains('media')){lb.firstChild.src=t.src;lb.classList.add('on')}else if(lb.contains(t)||t===lb)lb.classList.remove('on');var j=t.closest&&t.closest('a.jump');if(j){var m=document.getElementById(j.getAttribute('href').slice(1));if(m)m.hidden=false}});
document.addEventListener('keydown',function(e){if(e.key==='Escape')lb.classList.remove('on')});
function bar(){document.documentElement.style.setProperty('--top',$('.bar').offsetHeight+'px')}
bar();addEventListener('resize',bar);
if(!location.hash)window.scrollTo(0,document.body.scrollHeight);
})();
`

/** The same data as JSON, without the embedded files and without anything that opens them, safe to place inside a script tag. */
function jsonBlock(d: ChatDump) {
  const strip = (m?: ExportMedia) => (m ? { ...m, data: undefined, secret: undefined, alts: m.alts?.map((a) => a.src), embedded: !!m.data } : undefined)
  const entries = d.entries.map((e) =>
    isMsg(e) ? { ...e, media: e.media.map(strip), video: e.video ? { ...e.video, cover: strip(e.video.cover) } : undefined } : e
  )
  const out = { ...d, partner: { ...d.partner, avatar: strip(d.partner.avatar) }, owner: { ...d.owner, avatar: strip(d.owner.avatar) }, entries }
  return JSON.stringify(out).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16))
}

const fmt = (t: number) => new Date(t).toLocaleString('ru-RU')

/** Numbers every message and works out which ones start and end a run from one person, as the page groups them. */
function layout(entries: ExportEntry[]): (Place | undefined)[] {
  let n = 0
  const owner = (m: ExportMessage) => (m.service ? '' : `${m.side}|${m.author ?? ''}`)
  return entries.map((e, i) => {
    if (!isMsg(e)) return undefined
    n++
    const prev = entries[i - 1], next = entries[i + 1]
    const first = !prev || !isMsg(prev) || owner(prev) !== owner(e) || !owner(e)
    const last = !next || !isMsg(next) || owner(next) !== owner(e) || !owner(e)
    return { n, first, last, showName: first && !!e.author && e.side !== 'me' }
  })
}

export function renderChatHtml(d: ChatDump): string {
  const people = { partner: d.partner, owner: d.owner }
  const messages = d.entries.filter(isMsg)
  const count = (f: (m: ExportMessage) => boolean) => messages.filter(f).length
  const kindTotals: Record<string, number> = {}
  for (const m of messages) for (const k of kindsOf(m)) kindTotals[k] = (kindTotals[k] ?? 0) + 1
  const ms = messages.flatMap((m) => [...m.media, ...(m.video?.cover ? [m.video.cover] : [])])
  const folderFiles = ms.filter((x) => safeFile(x.file)).length
  const seps = d.entries.flatMap((e, i) => ('sep' in e ? [{ i, text: e.sep }] : []))
  const unknown = count((m) => !!m.unknown)
  const lost = ms.filter((x) => !x.data && !x.file)

  const places = layout(d.entries)
  let sepNo = 0
  const body = d.entries
    .map((e, i) => (isMsg(e) ? messageHtml(e, places[i]!, people) : `<div class="sep" id="d${sepNo++}"><span>${esc(e.sep)}</span></div>`))
    .join('\n')

  const avatarCss = (cls: string, p: Person) => {
    const a = safeData(p.avatar?.data)
    return a ? `.av.${cls}{background-image:url("${a}")}.av.${cls}::after{content:none}` : ''
  }
  const bigAv = safeData(d.partner.avatar?.data)
  const title = `Чат с ${d.partner.name || 'собеседником'}`
  const chips = Object.keys(KIND_LABEL).filter((k) => kindTotals[k]).map((k) => `<button type="button" data-k="${k}">${KIND_LABEL[k]} · ${kindTotals[k]}</button>`).join('')
  const stat = (label: string, v: number | string) => `<div class="stat">${esc(label)}<b>${esc(v)}</b></div>`
  const notes = [
    ...(unknown ? [`Неизвестных типов сообщений: ${unknown}. Они помечены в чате, сырые данные лежат в «Подробностях».`] : []),
    ...(lost.length ? [`Вложений без файла: ${lost.length} из ${ms.length}. Причина и исходная ссылка указаны у каждого сообщения.`] : [])
  ]

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
<div class="bar"><div class="barin">
<header class="head">
<div class="big" data-i="${esc(initials(d.partner.name))}"${bigAv ? ` style="background-image:url('${bigAv}')"` : ''}></div>
<div class="who-box"><h1>${esc(title)}</h1><div>${esc(d.partner.handle ?? '')}${d.partner.handle ? ' · ' : ''}аккаунт «${esc(d.owner.name)}»${d.owner.handle ? ' (@' + esc(d.owner.handle.replace(/^@/, '')) + ')' : ''}</div></div>
<div class="tools"><button id="theme" type="button">Тема</button><button id="json" type="button">JSON</button></div>
</header>
<div class="controls">
<input id="q" type="search" placeholder="Поиск по сообщениям…" aria-label="Поиск">
<select id="side" aria-label="Автор"><option value="all">Все авторы</option><option value="me">${esc(d.owner.name)}</option><option value="them">${esc(d.partner.name || 'Собеседник')}</option></select>
${seps.length ? `<select id="jump" aria-label="К дате"><option>К дате…</option>${seps.map((s, i) => `<option value="d${i}">${esc(s.text)}</option>`).join('')}</select>` : ''}
<span id="cnt"></span>
</div>
<div class="chips">${chips}</div>
</div></div>
<div class="wrap">
${d.complete ? '<div class="ok">Переписка загружена с самого начала.</div>' : ''}${folderFiles && d.filesFolder ? `<div class="ok">Крупные файлы (${folderFiles}) лежат в папке «${esc(d.filesFolder)}» рядом с этой страницей: храните их вместе.</div>` : ''}${[...d.warnings, ...notes].map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
<details class="info"><summary>Сведения об экспорте</summary>
<div class="stats">${stat('Сообщений', messages.length)}${stat(d.owner.name, count((m) => m.side === 'me'))}${stat(d.partner.name || 'Собеседник', count((m) => m.side === 'them'))}${count((m) => m.side === 'unknown') ? stat('Не определено', count((m) => m.side === 'unknown')) : ''}${ms.length ? stat('Вложений сохранено', `${ms.filter((x) => x.data || x.file).length} из ${ms.length}`) : ''}${seps.length ? stat('Начало', seps[0].text) : ''}${seps.length > 1 ? stat('Конец', seps[seps.length - 1].text) : ''}</div>
<div>Экспортировано ${esc(fmt(d.exportedAt))} · StackTok ${esc(d.appVersion)}</div>
</details>
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
