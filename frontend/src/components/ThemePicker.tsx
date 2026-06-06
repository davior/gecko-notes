import { createPortal } from 'react-dom'
import { Palette, Check, Globe } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import { useDropdown } from '@/hooks/useDropdown'

export default function ThemePicker() {
  const { themes, activeThemeId, sharedThemeId, activateTheme } = useSettingsStore()
  const { open, setOpen, triggerRef, dropdownRef, style } = useDropdown('right')

  const globalThemes = themes.filter((t) => t.is_global)
  const personalThemes = themes.filter((t) => !t.is_global)

  function swatchStyle(t: { bg_type: string; bg_color1: string; bg_color2: string | null }): React.CSSProperties {
    if (t.bg_type === 'gradient' && t.bg_color2) {
      return { background: `linear-gradient(135deg, ${t.bg_color1}, ${t.bg_color2})` }
    }
    return { background: t.bg_color1 }
  }

  return (
    <div ref={triggerRef}>
      <button
        className="btn-ghost p-2"
        title="Change theme"
        onClick={() => setOpen((o) => !o)}
      >
        <Palette className="w-5 h-5" />
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="z-50 w-60 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-lg overflow-hidden"
          style={style}
        >
          <div className="overflow-y-auto max-h-72">
            {/* Global themes */}
            {globalThemes.length > 0 && (
              <div className="p-1">
                <p className="px-3 pt-1.5 pb-1 text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">Global</p>
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
                      onClick={() => { activateTheme(t.id); setOpen(false) }}
                    >
                      <div className="w-5 h-5 rounded-full shrink-0 border border-black/10 dark:border-white/10" style={swatchStyle(t)} />
                      <span className="truncate flex-1">{t.name}</span>
                      <span className="text-xs text-gray-400 dark:text-gray-500 capitalize shrink-0">{t.mode}</span>
                      {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
                      {t.id === sharedThemeId && <span title="Default for shared notes"><Globe className="w-3 h-3 shrink-0 text-green-500" /></span>}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Personal themes */}
            {personalThemes.length > 0 && (
              <div className={`p-1 ${globalThemes.length > 0 ? 'border-t border-gray-100 dark:border-gray-700' : ''}`}>
                <p className="px-3 pt-1.5 pb-1 text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">My Themes</p>
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
                      onClick={() => { activateTheme(t.id); setOpen(false) }}
                    >
                      <div className="w-5 h-5 rounded-full shrink-0 border border-black/10 dark:border-white/10" style={swatchStyle(t)} />
                      <span className="truncate flex-1">{t.name}</span>
                      <span className="text-xs text-gray-400 dark:text-gray-500 capitalize shrink-0">{t.mode}</span>
                      {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
                      {t.id === sharedThemeId && <span title="Default for shared notes"><Globe className="w-3 h-3 shrink-0 text-green-500" /></span>}
                    </button>
                  )
                })}
              </div>
            )}

            {themes.length === 0 && (
              <p className="px-4 py-3 text-sm text-gray-400 dark:text-gray-500">No themes available.</p>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
