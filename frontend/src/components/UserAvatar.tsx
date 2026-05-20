import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Check, LogOut } from 'lucide-react'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'
import { useDropdown } from '@/hooks/useDropdown'

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  custom: 'Custom',
}

export default function UserAvatar() {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const navigate = useNavigate()
  const { open, setOpen, triggerRef, dropdownRef, style } = useDropdown('right')

  const themes = useSettingsStore((s) => s.themes)
  const activeThemeId = useSettingsStore((s) => s.activeThemeId)
  const activateTheme = useSettingsStore((s) => s.activateTheme)
  const deactivateTheme = useSettingsStore((s) => s.deactivateTheme)
  const aiProviders = useSettingsStore((s) => s.aiProviders)
  const activeProvider = useSettingsStore((s) => s.activeProvider)
  const activateAIProvider = useSettingsStore((s) => s.activateAIProvider)

  if (!user) return null

  const initial = user.username.charAt(0).toUpperCase()
  const enabledProviders = aiProviders.filter((p) => p.enabled)
  const globalThemes = themes.filter((t) => t.is_global)
  const personalThemes = themes.filter((t) => !t.is_global)

  function swatchStyle(t: { bg_type: string; bg_color1: string; bg_color2: string | null }): React.CSSProperties {
    if (t.bg_type === 'gradient' && t.bg_color2) {
      return { background: `linear-gradient(135deg, ${t.bg_color1}, ${t.bg_color2})` }
    }
    return { background: t.bg_color1 }
  }

  function handleLogout() {
    setOpen(false)
    logout()
    navigate('/login')
  }

  const avatarEl = user.avatar_url ? (
    <img
      src={user.avatar_url}
      alt={user.username}
      className="w-8 h-8 rounded-full object-cover ring-2 ring-gray-200 dark:ring-gray-600 hover:ring-blue-400 transition-all"
    />
  ) : (
    <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-semibold ring-2 ring-gray-200 dark:ring-gray-600 hover:ring-blue-400 transition-all select-none">
      {initial}
    </div>
  )

  return (
    <div ref={triggerRef} className="shrink-0">
      <button
        title={`Profile: ${user.username}`}
        onClick={() => setOpen((o) => !o)}
        className="shrink-0"
      >
        {avatarEl}
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="z-50 w-64 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-lg overflow-hidden"
          style={style}
        >
          {/* Profile row */}
          <button
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors text-left border-b border-gray-100 dark:border-gray-700"
            onClick={() => { navigate('/settings/profile'); setOpen(false) }}
          >
            {user.avatar_url ? (
              <img src={user.avatar_url} alt={user.username} className="w-9 h-9 rounded-full object-cover shrink-0" />
            ) : (
              <div className="w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-semibold shrink-0 select-none">
                {initial}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{user.username}</p>
              {'email' in user && user.email && (
                <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{user.email as string}</p>
              )}
            </div>
          </button>

          <div className="overflow-y-auto max-h-[70vh]">
            {/* Theme section */}
            <div className="p-1 border-b border-gray-100 dark:border-gray-700">
              <p className="px-3 pt-2 pb-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">Theme</p>
              <button
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                  !activeThemeId
                    ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
                onClick={() => { void deactivateTheme(); setOpen(false) }}
              >
                <div className="w-4 h-4 rounded-full border-2 border-gray-300 dark:border-gray-500 flex items-center justify-center shrink-0">
                  {!activeThemeId && <Check className="w-2.5 h-2.5" />}
                </div>
                <span>Default</span>
              </button>
              {globalThemes.map((t) => {
                const isActive = t.id === activeThemeId
                return (
                  <button
                    key={t.id}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                      isActive
                        ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium'
                        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }`}
                    onClick={() => { void activateTheme(t.id); setOpen(false) }}
                  >
                    <div className="w-4 h-4 rounded-full shrink-0 border border-black/10 dark:border-white/10" style={swatchStyle(t)} />
                    <span className="truncate flex-1">{t.name}</span>
                    <span className="text-xs text-gray-400 dark:text-gray-500 capitalize shrink-0">{t.mode}</span>
                    {isActive && <Check className="w-3 h-3 shrink-0" />}
                  </button>
                )
              })}
              {personalThemes.map((t) => {
                const isActive = t.id === activeThemeId
                return (
                  <button
                    key={t.id}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                      isActive
                        ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium'
                        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }`}
                    onClick={() => { void activateTheme(t.id); setOpen(false) }}
                  >
                    <div className="w-4 h-4 rounded-full shrink-0 border border-black/10 dark:border-white/10" style={swatchStyle(t)} />
                    <span className="truncate flex-1">{t.name}</span>
                    <span className="text-xs text-gray-400 dark:text-gray-500 capitalize shrink-0">{t.mode}</span>
                    {isActive && <Check className="w-3 h-3 shrink-0" />}
                  </button>
                )
              })}
              {themes.length === 0 && (
                <p className="px-3 py-2 text-sm text-gray-400 dark:text-gray-500">No themes available.</p>
              )}
            </div>

            {/* AI Provider section */}
            <div className="p-1 border-b border-gray-100 dark:border-gray-700">
              <p className="px-3 pt-2 pb-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">AI Provider</p>
              {enabledProviders.length === 0 ? (
                <p className="px-3 py-2 text-sm text-gray-400 dark:text-gray-500">No providers configured.</p>
              ) : (
                enabledProviders.map((p) => {
                  const isActive = p.id === activeProvider?.id
                  return (
                    <button
                      key={p.id}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                        isActive
                          ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium'
                          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                      }`}
                      onClick={() => { void activateAIProvider(p.id); setOpen(false) }}
                    >
                      <span className="truncate flex-1">{p.name}</span>
                      <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                        {PROVIDER_LABELS[p.provider_type] ?? p.provider_type}
                      </span>
                      {isActive && <Check className="w-3 h-3 shrink-0" />}
                    </button>
                  )
                })
              )}
            </div>

            {/* Sign out */}
            <div className="p-1">
              <button
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-left"
                onClick={handleLogout}
              >
                <LogOut className="w-4 h-4 shrink-0" />
                <span>Sign out</span>
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
