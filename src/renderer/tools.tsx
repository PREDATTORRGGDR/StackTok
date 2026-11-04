import { ReactNode } from 'react'
import { Clapperboard, Download, FileDown, MessageCircle, Repeat2, Sparkles } from 'lucide-react'
import { AccountView } from '@shared/types'
import { AppState, call, toast } from './api'
import type { Dialog } from './Dialogs'
import type { Page } from './App'

/** Everything a tool may need when it is started from the Tools page. */
export interface ToolCtx { s: AppState; acct?: AccountView; go: (p: Page) => void; openDialog: (d: Dialog) => void }

/** Sections of the Tools page, in the order they appear. A new feature = one more entry in TOOLS under one of these. */
export const GROUPS = ['Анализ', 'Чистка аккаунта', 'Чаты', 'Файлы'] as const

export interface Tool {
  id: string
  group: (typeof GROUPS)[number]
  title: string
  desc: string
  icon: ReactNode
  /** Why the tool can't start right now (shown on the card), or null when it can. */
  blocked?: (c: ToolCtx) => string | null
  /** True while the tool is already running. */
  busy?: (c: ToolCtx) => boolean
  run: (c: ToolCtx) => void
}

const needLogin = (c: ToolCtx) => (!c.acct ? 'Выберите аккаунт' : c.acct.session !== 'logged_in' ? 'Сначала войдите в аккаунт' : null)

export const TOOLS: Tool[] = [
  {
    id: 'psy', group: 'Анализ', title: 'Психопортрет по репостам', icon: <Sparkles size={20} />,
    desc: 'Любой профиль по @имени или ссылке (вход не нужен) или свой аккаунт: нейросеть читает обложки и подписи репостов и собирает презентацию: черты, настроение, мысли, чувства, интересы.',
    blocked: (c) => (!c.acct ? 'Нужен хотя бы один аккаунт в приложении (входить в него не обязательно)' : c.s.hasPsyKey ? null : 'Нужен ключ API в «Настройках»'),
    busy: (c) => c.s.psy?.status === 'running',
    run: (c) => c.openDialog({ kind: 'psy', acct: c.acct! })
  },
  {
    id: 'reposts', group: 'Чистка аккаунта', title: 'Удалить все репосты', icon: <Repeat2 size={20} />,
    desc: 'Убирает репосты аккаунта любой давности. Свои видео, лайки и подписки не трогает.',
    blocked: needLogin,
    busy: (c) => c.s.job?.status === 'running',
    run: (c) => c.openDialog({ kind: 'reposts', acct: c.acct! })
  },
  {
    id: 'chats', group: 'Чаты', title: 'Открыть сообщения', icon: <MessageCircle size={20} />,
    desc: 'Страница сообщений аккаунта с обоями и стеклом. Оформление настраивается на странице «Настройки».',
    blocked: needLogin,
    run: (c) => { call('account:page', { id: c.acct!.id, value: 'chats' }); c.go('browse') }
  },
  {
    id: 'chat-export', group: 'Чаты', title: 'Экспорт чата в HTML', icon: <FileDown size={20} />,
    desc: 'Сохраняет открытый диалог целиком: сообщения, время, видео, стикеры и картинки. Сначала откройте нужный чат.',
    blocked: needLogin,
    busy: (c) => !!c.s.chatExport,
    run: async (c) => {
      c.go('browse')
      const r = await call<{ messages: number; complete: boolean } | null>('chat:export')
      if (r) toast(`Чат сохранён: ${r.messages} сообщений. ${r.complete ? 'История загружена полностью.' : 'История неполная, подробности в файле.'}`, !r.complete)
    }
  },
  {
    id: 'studio', group: 'Файлы', title: 'TikTok Studio', icon: <Clapperboard size={20} />,
    desc: 'Управление своими видео: загрузка, аналитика, комментарии.',
    blocked: needLogin,
    run: (c) => { call('account:page', { id: c.acct!.id, value: 'studio' }); c.go('browse') }
  },
  {
    id: 'downloader', group: 'Файлы', title: 'Загрузчик видео', icon: <Download size={20} />,
    desc: 'Скачивание видео TikTok по ссылке через встроенный сайт-загрузчик.',
    run: (c) => c.go('downloader')
  }
]
