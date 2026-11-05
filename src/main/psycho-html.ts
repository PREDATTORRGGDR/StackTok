// Self-contained HTML presentation of a repost profile (pure: no Electron). Everything is escaped, nothing is loaded from outside.
import type { RepostItem, Report, Stats } from './psycho'

export interface DeckInput {
  owner: { name: string; handle?: string }
  report: Report
  stats: Stats
  items: RepostItem[]
  thumbs: Map<number, string> // 1-based video number → data: URI of a small cover
  warnings: string[]
  generatedAt: number
}

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const THUMB = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/
export const safeThumb = (u: string | undefined): string => (u && u.length < 60000 && THUMB.test(u) ? u : '')

const bar = (label: string, v: number, note = '') =>
  `<div class="bar"><div class="bl"><b>${esc(label)}</b><span>${Math.round(v)}${note ? '' : ''}</span></div><div class="bt"><i style="width:${Math.min(100, Math.max(0, v))}%"></i></div>${note ? `<p>${esc(note)}</p>` : ''}</div>`

const list = (xs: string[]) => (xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '')
const card = (h: string, body: string) => `<div class="card"><h3>${esc(h)}</h3>${body}</div>`
const day = (s?: number) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '')

function histogram(months: Stats['months']): string {
  const m = months.slice(-24)
  if (m.length < 2) return ''
  const max = Math.max(...m.map((x) => x.n))
  return `<div class="hist">${m.map((x) => `<div title="${esc(x.name)}: ${x.n}"><i style="height:${Math.max(4, Math.round((x.n / max) * 100))}%"></i><span>${esc(x.name.slice(2))}</span></div>`).join('')}</div>`
}

export function renderDeck(d: DeckInput): string {
  const r = d.report
  const who = d.owner.handle ? `@${d.owner.handle}` : d.owner.name
  const slides: string[] = []
  const add = (cls: string, html: string) => slides.push(`<section class="slide ${cls}">${html}</section>`)

  add('title', `<p class="kick">Психопортрет по репостам</p><h1>${esc(r.title)}</h1><p class="sub">${esc(who)} · ${d.stats.total} репостов · ${esc(day(d.generatedAt / 1000))}</p><p class="hint">Стрелки ← → или клик · F — во весь экран</p>`)
  add('arch', `<p class="kick">Образ</p><h2>${esc(r.archetype.name)}</h2><p class="tag">${esc(r.archetype.tagline)}</p><p class="big">${esc(r.archetype.description)}</p>`)
  add('sum', `<p class="kick">Главное</p><h2>Коротко</h2><p class="big">${esc(r.summary)}</p><div class="nums"><div><b>${d.stats.total}</b><span>репостов</span></div><div><b>${d.stats.authors.length ? '@' + esc(d.stats.authors[0].name) : '—'}</b><span>чаще всех</span></div><div><b>${esc(day(d.stats.from).slice(0, 4) || '—')}–${esc(day(d.stats.to).slice(0, 4) || '—')}</b><span>годы оригиналов</span></div></div>`)
  if (r.traits.length) add('traits', `<p class="kick">Черты</p><h2>Какой человек по ленте</h2><div class="grid2">${r.traits.map((t) => bar(t.name, t.score, t.why)).join('')}</div>`)
  if (r.interests.length) add('interests', `<p class="kick">Интересы</p><h2>О чём лента</h2><div class="grid2">${r.interests.map((t) => bar(t.name, t.share, t.note)).join('')}</div>${d.stats.tags.length ? `<div class="chips">${d.stats.tags.slice(0, 14).map((t) => `<span>#${esc(t.name)} <b>${t.n}</b></span>`).join('')}</div>` : ''}`)
  add('mood', `<p class="kick">Настроение и юмор</p><h2>${esc(r.mood.dominant || 'Настроение')}</h2><p class="big">${esc(r.mood.note)}</p>${r.mood.spectrum.length ? `<div class="grid2">${r.mood.spectrum.map((s) => bar(s.label, s.share)).join('')}</div>` : ''}${r.humor.style ? card('Юмор: ' + r.humor.style, `<p>${esc(r.humor.note)}</p>`) : ''}`)
  if (r.onMind.length) add('mind', `<p class="kick">В голове</p><h2>О чём он, похоже, думает</h2><div class="grid2">${r.onMind.map((m) => card(m.theme, `<p>${esc(m.note)}</p>`)).join('')}</div>`)
  if (r.romance) add('romance', `<p class="kick">Чувства</p><h2>Любовь, тоска и отношения</h2><p class="big">${esc(r.romance)}</p>`)
  if (r.communication || r.aesthetic) add('style', `<p class="kick">Манера</p><h2>Общение и вкус</h2><div class="grid2">${r.communication ? card('Как общается', `<p>${esc(r.communication)}</p>`) : ''}${r.aesthetic ? card('Эстетика и среда', `<p>${esc(r.aesthetic)}</p>`) : ''}</div>`)
  if (r.motivations.length) add('motiv', `<p class="kick">Мотивы</p><h2>Что он ищет</h2><div class="grid2">${r.motivations.map((m) => card(m.name, `<p>${esc(m.note)}</p>`)).join('')}</div>`)
  add('three', `<p class="kick">Люди и ценности</p><h2>Как человек себя подаёт</h2><div class="grid3">${card('Самообраз', `<p>${esc(r.selfImage)}</p>`)}${card('Близость и общение', `<p>${esc(r.relationships)}</p>`)}${card('Ценности', list(r.values))}</div>`)
  const ev = r.evidence.filter((e) => e.i >= 1 && e.i <= d.items.length)
  if (ev.length) {
    add('evidence', `<p class="kick">Улики</p><h2>На чём это основано</h2><div class="evs">${ev.slice(0, 6).map((e) => {
      const it = d.items[e.i - 1], t = safeThumb(d.thumbs.get(e.i))
      return `<div class="ev">${t ? `<img src="${t}" alt="">` : '<div class="ph"></div>'}<div><p class="q">«${esc(e.quote)}»</p><p>${esc(e.meaning)}</p><span>${it?.author ? '@' + esc(it.author) : ''}</span></div></div>`
    }).join('')}</div>`)
  }
  const mosaic = [...d.thumbs].map(([i, u]) => safeThumb(u)).filter(Boolean).slice(0, 60)
  if (mosaic.length >= 12) add('mosaic', `<p class="kick">Лента</p><h2>Так выглядит</h2><div class="mos">${mosaic.map((u) => `<img src="${u}" alt="">`).join('')}</div>`)
  if (r.timeline.length || d.stats.months.length > 1) add('time', `<p class="kick">Время</p><h2>Как менялась лента</h2>${histogram(d.stats.months)}<p class="faint">Месяц публикации оригиналов. Когда сделан сам репост, TikTok не сообщает.</p>${r.timeline.length ? `<div class="grid2">${r.timeline.map((t) => card(t.period, `<p>${esc(t.shift)}</p>`)).join('')}</div>` : ''}`)
  if (r.forYou) add('foryou', `<p class="kick">Для вас</p><h2>${r.forYou.who ? 'Что он(а) к вам чувствует: ' + esc(r.forYou.who) : 'Что он(а) к вам чувствует'}</h2><p class="big">${esc(r.forYou.feelings)}</p><div class="grid2">${r.forYou.signs.length ? card('По чему это видно', list(r.forYou.signs)) : ''}${r.forYou.nextSteps.length ? card('Что делать дальше', list(r.forYou.nextSteps)) : ''}${r.forYou.avoid.length ? card('Чего лучше не делать', list(r.forYou.avoid)) : ''}</div>`)
  add('sb', `<p class="kick">Баланс</p><h2>Сильные стороны и слепые зоны</h2><div class="grid2">${card('Сильные стороны', list(r.strengths))}${card('Слепые зоны', list(r.blindspots))}</div>`)
  add('end', `<p class="kick">В конце</p><h2>Что с этим делать</h2>${list(r.advice)}<p class="note">${esc(r.caveat)}</p>${d.warnings.length ? `<p class="faint">${d.warnings.map(esc).join(' ')}</p>` : ''}<p class="faint">Составлено нейросетью по обложкам, подписям и кадрам. Это гипотезы для развлечения, не диагноз.</p>`)

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.title)}</title>
<style>
:root{--bg:#0b0d1a;--ink:#f1f3fb;--mut:#a4abc4;--card:rgba(255,255,255,.07);--line:rgba(255,255,255,.14);--a:#6ea0ff;--b:#b27bff}
@media (prefers-color-scheme:light){:root{--bg:#eef1fb;--ink:#14172a;--mut:#555d7a;--card:rgba(255,255,255,.7);--line:rgba(20,23,42,.14);--a:#2f5bff;--b:#8a3dff}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.55 system-ui,'Segoe UI',sans-serif;-webkit-text-size-adjust:100%}
html.deckmode,html.deckmode body{height:100%;overflow:hidden}
body:before{content:"";position:fixed;inset:0;background:radial-gradient(60vmax 60vmax at 15% 10%,color-mix(in srgb,var(--a) 35%,transparent),transparent 60%),radial-gradient(55vmax 55vmax at 90% 90%,color-mix(in srgb,var(--b) 32%,transparent),transparent 60%);z-index:-1}
.deck{height:100%;position:relative}
.slide{padding:36px 18px;display:flex;flex-direction:column;gap:14px;border-bottom:1px solid var(--line);max-width:1100px;margin:0 auto;overflow-wrap:anywhere}
.nav,.arrows{display:none}
.deckmode .deck{height:100%;position:relative}
.deckmode .slide{position:absolute;inset:0;max-width:none;margin:0;border:0;padding:6vh 8vw 9vh;justify-content:center;opacity:0;transform:translateX(40px);pointer-events:none;transition:opacity .35s,transform .35s;overflow:auto}
.deckmode .slide.on{opacity:1;transform:none;pointer-events:auto}.deckmode .slide.past{transform:translateX(-40px)}
.kick{margin:0;letter-spacing:.14em;text-transform:uppercase;font-size:12px;color:var(--a);font-weight:700}
h1{font-size:clamp(34px,6vw,72px);line-height:1.05;margin:0;background:linear-gradient(90deg,var(--a),var(--b));-webkit-background-clip:text;background-clip:text;color:transparent}
h2{font-size:clamp(26px,4vw,48px);margin:0;line-height:1.1}h3{margin:0 0 6px;font-size:17px}
.sub,.tag{font-size:clamp(17px,2vw,24px);color:var(--mut);margin:0}.big{font-size:clamp(17px,2vw,23px);max-width:62em;margin:0}
.hint,.faint{color:var(--mut);font-size:13px;margin:0}.note{font-size:15px;margin:0;padding:12px 16px;border-left:3px solid var(--a);background:var(--card);border-radius:0 12px 12px 0}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px 28px}.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px 18px}.card p,.card li{font-size:15px;margin:0}.card ul,ul{margin:0;padding-left:20px}li{margin:4px 0}
.bar .bl{display:flex;justify-content:space-between}.bar p{margin:4px 0 0;font-size:13.5px;color:var(--mut)}.bt{height:9px;border-radius:9px;background:var(--line);overflow:hidden;margin-top:5px}.bt i{display:block;height:100%;border-radius:9px;background:linear-gradient(90deg,var(--a),var(--b))}
.nums{display:flex;flex-wrap:wrap;gap:14px}.nums div{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px 18px;display:flex;flex-direction:column}.nums b{font-size:22px}.nums span{color:var(--mut);font-size:12.5px}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chips span{border:1px solid var(--line);border-radius:99px;padding:3px 12px;font-size:13.5px;background:var(--card)}.chips b{color:var(--a)}
.evs{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.ev{display:flex;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:10px}.ev img,.ev .ph{width:84px;height:112px;object-fit:cover;border-radius:10px;flex:none;background:var(--line)}.ev p{margin:0 0 4px;font-size:14px}.ev .q{font-weight:600}.ev span{color:var(--mut);font-size:12.5px}
.mos{display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:6px}.mos img{width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:8px}
.hist{display:flex;align-items:flex-end;gap:4px;height:150px}.hist div{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px;font-size:10px;color:var(--mut)}.hist i{width:100%;border-radius:5px 5px 0 0;background:linear-gradient(var(--b),var(--a))}
.deckmode .nav{position:fixed;left:0;right:0;bottom:0;padding:12px 4vw;display:flex;gap:6px;align-items:center;justify-content:center}.nav button{border:0;width:9px;height:9px;padding:0;border-radius:9px;background:var(--line);cursor:pointer}.nav button.on{width:26px;background:var(--a)}
.deckmode .arrows{display:block}.arrows button{position:fixed;top:50%;margin-top:-24px;width:48px;height:48px;border-radius:50%;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:22px;cursor:pointer;z-index:5}.arrows .pv{left:14px}.arrows .nx{right:14px}
@media (max-width:820px){.grid2,.grid3,.evs{grid-template-columns:1fr}.hist{overflow-x:auto}.ev img,.ev .ph{width:64px;height:86px}}
@media print{html.deckmode,html.deckmode body{overflow:visible;height:auto}.deckmode .slide{position:static;opacity:1;transform:none;break-after:page;min-height:100vh}.nav,.arrows{display:none!important}body:before{display:none}}
</style></head><body>
<div class="deck" id="deck">${slides.join('\n')}</div><div class="nav" id="nav"></div><div class="arrows"><button class="pv" id="pv" aria-label="Назад">‹</button><button class="nx" id="nx" aria-label="Дальше">›</button></div>
<script>
(function(){var root=document.documentElement,mq=window.matchMedia?matchMedia('(min-width:821px)'):{matches:true};function mode(){root.className=mq.matches?'deckmode':''}mode();if(mq.addEventListener)mq.addEventListener('change',mode);
var s=[].slice.call(document.querySelectorAll('.slide')),n=document.getElementById('nav'),i=0,dots=s.map(function(_,k){var b=document.createElement('button');b.setAttribute('aria-label','Слайд '+(k+1));b.onclick=function(e){e.stopPropagation();go(k)};n.appendChild(b);return b});
function go(k){i=Math.max(0,Math.min(s.length-1,k));s.forEach(function(x,j){x.className=x.className.replace(/ ?(on|past)/g,'')+(j===i?' on':j<i?' past':'')});dots.forEach(function(b,j){b.className=j===i?'on':''});try{history.replaceState(null,'','#'+(i+1))}catch(e){}}
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown')go(i+1);else if(e.key==='ArrowLeft'||e.key==='PageUp')go(i-1);else if(e.key==='Home')go(0);else if(e.key==='End')go(s.length-1);else if(e.key==='f'||e.key==='F'){if(document.fullscreenElement)document.exitFullscreen();else document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen()}});
document.getElementById('pv').onclick=function(){go(i-1)};document.getElementById('nx').onclick=function(){go(i+1)};
document.getElementById('deck').addEventListener('click',function(e){if(!mq.matches||e.target.closest('a,button')||String(getSelection()))return;go(e.clientX<innerWidth*0.3?i-1:i+1)});
var wt=0;document.addEventListener('wheel',function(e){if(!mq.matches)return;var el=s[i],d=e.deltaY||e.deltaX;if(!d||Date.now()-wt<500)return;if((d>0&&el.scrollTop+el.clientHeight<el.scrollHeight-4)||(d<0&&el.scrollTop>4))return;wt=Date.now();go(d>0?i+1:i-1)},{passive:true});
var x0=null;document.addEventListener('touchstart',function(e){x0=e.touches[0].clientX},{passive:true});document.addEventListener('touchend',function(e){if(x0==null||!mq.matches)return;var dx=e.changedTouches[0].clientX-x0;if(Math.abs(dx)>50)go(dx<0?i+1:i-1);x0=null});
go(Math.max(0,(parseInt(location.hash.slice(1),10)||1)-1))})();
</script></body></html>`
}
