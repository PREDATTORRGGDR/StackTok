import { ReactNode, useEffect, useState } from 'react'
import { Bookmark, Calendar, Clapperboard, Eye, Heart, MessageCircle, Repeat2, Send, ThumbsUp, Trophy, UserCheck, UserPlus, Users } from 'lucide-react'
import { AccountStats, AccountView, RepostCount, VideoTotals } from '@shared/types'
import { call } from './api'
import { Avatar, Modal } from './ui'

const fmt = (n: number | null | undefined) => (typeof n === 'number' ? n.toLocaleString('ru-RU') : '—')
const regionName = (code?: string) => {
  try { return code ? new Intl.DisplayNames(['ru'], { type: 'region' }).of(code) ?? code : undefined } catch { return code }
}

function Tile({ icon, label, value, wait }: { icon: ReactNode; label: string; value: ReactNode; wait?: boolean }) {
  return <div className="stat"><div className="stat-l">{icon}<span>{label}</span></div><div className={'stat-v' + (wait ? ' wait' : '')}>{wait ? '…' : value}</div></div>
}

/** Account numbers. Profile and repost count are asked separately, so the window fills in as each answer arrives. */
export function StatsDialog({ acct, close }: { acct: AccountView; close: () => void }) {
  const [st, setSt] = useState<AccountStats | null>()
  const [reposts, setReposts] = useState<RepostCount | null>()
  const [vids, setVids] = useState<VideoTotals | null>()
  useEffect(() => {
    let on = true
    call<AccountStats>('stats:profile', { id: acct.id }).then((r) => { if (on) setSt(r ?? null) })
    call<RepostCount>('stats:reposts', { id: acct.id }).then((r) => { if (on) setReposts(r ?? null) })
    call<VideoTotals | null>('stats:videos', { id: acct.id }, true).then((r) => { if (on) setVids(r ?? null) })
    return () => { on = false; call('stats:stop', { id: acct.id }, true) }
  }, [acct.id])
  const wait = st === undefined
  const noCounts = st === null || (st && st.followers === undefined)
  const day = (t?: number) => (t ? new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '')
  const facts = st ? [
    st.verified ? 'Подтверждённый аккаунт' : '',
    st.favoritesOpen === undefined ? '' : st.favoritesOpen ? 'Избранное открыто всем' : 'Избранное скрыто',
    st.organization ? 'Организация' : '',
    st.seller ? 'Продавец TikTok Shop' : '',
    st.nameChangedAt ? '@имя менялось ' + day(st.nameChangedAt) : '',
    st.nickChangedAt ? 'Ник менялся ' + day(st.nickChangedAt) : ''
  ].filter(Boolean) : []
  return (
    <Modal onClose={close} wide>
      <div className="stats-head">
        <Avatar a={acct} size={56} />
        <div className="stats-who">
          <h3>{st?.nickname ?? acct.label}</h3>
          <div className="muted small">@{st?.username ?? acct.username ?? '…'}{st?.privateAccount ? ' · закрытый аккаунт' : ''}{st?.region ? ' · ' + regionName(st.region) : ''}</div>
          {st?.signature && <div className="faint small stats-bio">{st.signature}</div>}
        </div>
      </div>
      <div className="stats-since">
        <Calendar size={16} />
        {wait ? <span className="muted">Собираю…</span> : st?.createdAt
          ? <span>В TikTok с {new Date(st.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}<span className="muted"> · {st.age}</span></span>
          : <span className="muted">Дата создания неизвестна</span>}
      </div>
      <div className="stats-grid">
        <Tile icon={<Users size={14} />} label="Подписчики" value={fmt(st?.followers)} wait={wait} />
        <Tile icon={<UserPlus size={14} />} label="Подписки" value={fmt(st?.following)} wait={wait} />
        <Tile icon={<UserCheck size={14} />} label="Друзья" value={fmt(st?.friends)} wait={wait} />
        <Tile icon={<Heart size={14} />} label="Лайков получено" value={fmt(st?.likes)} wait={wait} />
        <Tile icon={<ThumbsUp size={14} />} label="Лайков поставлено" value={fmt(st?.liked)} wait={wait} />
        <Tile icon={<Clapperboard size={14} />} label="Видео" value={fmt(st?.videos)} wait={wait} />
        <Tile icon={<Repeat2 size={14} />} label="Репосты" value={reposts ? (reposts.complete ? '' : 'от ') + fmt(reposts.visible) : '—'} wait={reposts === undefined} />
        <Tile icon={<Bookmark size={14} />} label="В избранном" value={fmt(st?.saved)} wait={wait} />
        {vids !== null && <>
          <Tile icon={<Eye size={14} />} label="Просмотры видео" value={fmt(vids?.views)} wait={vids === undefined} />
          <Tile icon={<Trophy size={14} />} label="Лучшее видео" value={fmt(vids?.best)} wait={vids === undefined} />
          <Tile icon={<MessageCircle size={14} />} label="Комментарии" value={fmt(vids?.comments)} wait={vids === undefined} />
          <Tile icon={<Send size={14} />} label="Поделились" value={fmt(vids?.shares)} wait={vids === undefined} />
        </>}
      </div>
      {st && (st.likedPerDay !== undefined || st.likesPerVideo !== undefined || st.followRatio !== undefined) && (
        <div className="stats-fun">
          {st.days !== undefined && <div><b>{fmt(st.days)}</b><span>дней в TikTok</span></div>}
          {st.likedPerDay !== undefined && <div><b>{fmt(st.likedPerDay)}</b><span>лайков в день</span></div>}
          {st.likesPerVideo !== undefined && <div><b>{fmt(st.likesPerVideo)}</b><span>лайков на видео</span></div>}
          {st.followRatio !== undefined && <div><b>{fmt(st.followRatio)}</b><span>подписчиков на подписку</span></div>}
        </div>
      )}
      {facts.length > 0 && <div className="stats-facts">{facts.map((f) => <span key={f}>{f}</span>)}</div>}
      {reposts && reposts.complete && reposts.entries > reposts.visible + 30 && <p className="muted small" style={{ margin: 0 }}>Репосты: сейчас доступно {fmt(reposts.visible)} видео. В списке TikTok около {fmt(reposts.entries)} записей, остальные видео удалены или скрыты, TikTok их не отдаёт.</p>}
      {reposts && !reposts.complete && <p className="muted small" style={{ margin: 0 }}>Репосты посчитаны не до конца: TikTok перестал отвечать. Попробуйте позже.</p>}
      {vids && !vids.complete && <p className="muted small" style={{ margin: 0 }}>Просмотры посчитаны по {fmt(vids.count)} видео: дальше TikTok не отдал.</p>}
      {noCounts && <p className="muted small" style={{ margin: 0 }}>TikTok сейчас не отдал счётчики профиля. Попробуйте открыть окно ещё раз чуть позже.</p>}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="faint small">{st ? `Собрано за ${(st.ms / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с` : ''}</span>
        <button className="btn" onClick={close}>Закрыть</button>
      </div>
    </Modal>
  )
}
