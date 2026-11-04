import axios from 'axios'
import type { Theme } from '@/api/settings'
import { loadIdentity } from '@/hooks/useIdentity'

/**
 * Themes from Gecko Suite (M7, SN-8), used when the suite signs people in.
 *
 * The suite keeps the theme library and which theme each app wears; Notes' choice is
 * `notes`. The browser asks the suite directly, as the same person: Notes' token (the
 * suite verifies the same JWT). Its own axios instance, so a refusal from the suite never
 * reaches the shared client's 401 handling and signs anyone out of Notes.
 *
 * Answers in Notes' own `Theme` shape, so the Themes settings and `applyThemeToDom` work
 * unchanged: a shared theme is `is_global`.
 */

interface SuiteTheme extends Omit<Theme, 'is_global'> {
  scope: 'instance' | 'user'
  editable: boolean
}

const http = axios.create()

http.interceptors.request.use(async (config) => {
  const identity = await loadIdentity()
  config.baseURL = `${identity.url ?? ''}/api`
  const token = localStorage.getItem('auth_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

const asNotes = (t: SuiteTheme): Theme => ({ ...t, is_global: t.scope === 'instance' })

export const suiteThemesApi = {
  async list(): Promise<Theme[]> {
    const res = await http.get<{ data: SuiteTheme[] }>('/v1/themes')
    return res.data.data.map(asNotes)
  },
  async selected(): Promise<Theme | null> {
    const res = await http.get<{ data: { theme: SuiteTheme | null } }>('/v1/themes/selected/notes')
    return res.data.data.theme ? asNotes(res.data.data.theme) : null
  },
  async choose(themeId: string | null): Promise<Theme | null> {
    const res = await http.put<{ data: { theme: SuiteTheme | null } }>('/v1/themes/selected/notes', {
      theme_id: themeId,
    })
    return res.data.data.theme ? asNotes(res.data.data.theme) : null
  },
}

/** The last theme Notes wore, so a reload or a suite that is down still looks right. */
const CACHE_KEY = 'gecko_theme'

export function cachedTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as Theme) : null
  } catch {
    return null
  }
}

export function cacheTheme(theme: Theme | null): void {
  try {
    if (theme) localStorage.setItem(CACHE_KEY, JSON.stringify(theme))
    else localStorage.removeItem(CACHE_KEY)
  } catch {
    /* private mode: the next load asks the suite again */
  }
}
