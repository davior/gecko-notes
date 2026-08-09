import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  Check, ChevronDown, LogOut, Settings, Palette, Boxes, Bot, Type, Image as ImageIcon,
  type LucideIcon,
} from 'lucide-react'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'
import { useDropdown } from '@/hooks/useDropdown'
import { settingsApi, type ImageSettings } from '@/api/settings'

type Section = 'theme' | 'model' | 'agent'
type ModelGroup = 'text' | 'image'

function swatchStyle(t: { bg_type: string; bg_color1: string; bg_color2: string | null }): React.CSSProperties {
  if (t.bg_type === 'gradient' && t.bg_color2) {
    return { background: `linear-gradient(135deg, ${t.bg_color1}, ${t.bg_color2})` }
  }
  return { background: t.bg_color1 }
}

// A collapsed top-level (or nested) category row: icon + name on the left, the
// current selection as a muted hint on the right, and a chevron that flips when open.
function CategoryButton({ icon: Icon, label, hint, expanded, onClick }: {
  icon: LucideIcon
  label: string
  hint?: string
  expanded: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-expanded={expanded}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-700"
    >
      <Icon className="w-4 h-4 shrink-0 text-gray-400 dark:text-gray-500" />
      <span className="text-sm font-medium text-gray-700 dark:text-gray-200 shrink-0">{label}</span>
      <span className="flex-1 min-w-0 text-right text-xs text-gray-400 dark:text-gray-500 truncate">{hint ?? ''}</span>
      <ChevronDown className={`w-4 h-4 shrink-0 text-gray-400 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
    </button>
  )
}

// A single selectable option inside an expanded category.
function OptionButton({ active, onClick, children }: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-colors ${
        active
          ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium'
          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
      }`}
    >
      {children}
    </button>
  )
}

// Right-aligned "Manage" link that jumps to the relevant full settings panel.
function ManageBar({ onManage }: { onManage: () => void }) {
  return (
    <div className="flex justify-end px-2 pb-0.5">
      <button
        className="text-xs font-medium text-blue-500 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
        onClick={onManage}
      >
        Manage
      </button>
    </div>
  )
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">{children}</p>
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
  const systemPrompts = useSettingsStore((s) => s.systemPrompts)
  const activeSystemPrompt = useSettingsStore((s) => s.activeSystemPrompt)
  const activateSystemPrompt = useSettingsStore((s) => s.activateSystemPrompt)

  // Only one category is open at a time — keeps the menu compact on every screen.
  const [openSection, setOpenSection] = useState<Section | null>(null)
  const [openModelGroup, setOpenModelGroup] = useState<ModelGroup | null>(null)
  // Image models aren't in the settings store; fetch them lazily the first time the
  // AI Models category is opened, then switch the default in place.
  const [imageSettings, setImageSettings] = useState<ImageSettings | null>(null)
  const [imageLoading, setImageLoading] = useState(false)

  // Reset the accordion each time the menu closes so it reopens tidy.
  useEffect(() => {
    if (!open) {
      setOpenSection(null)
      setOpenModelGroup(null)
    }
  }, [open])

  // Load image models on demand (only when the AI Models category is first opened).
  useEffect(() => {
    if (open && openSection === 'model' && imageSettings === null && !imageLoading) {
      setImageLoading(true)
      settingsApi
        .getImageSettings()
        .then(setImageSettings)
        .catch(() => {})
        .finally(() => setImageLoading(false))
    }
  }, [open, openSection, imageSettings, imageLoading])

  if (!user) return null

  const initial = user.username.charAt(0).toUpperCase()
  const enabledProviders = aiProviders.filter((p) => p.enabled)
  const orderedThemes = [...themes.filter((t) => t.is_global), ...themes.filter((t) => !t.is_global)]
  const activeTheme = themes.find((t) => t.id === activeThemeId) ?? null
  const imageModelOptions = imageSettings
    ? [...imageSettings.curated_models, ...imageSettings.custom_models.map((id) => ({ id, label: id }))]
    : []
  const activeImageModel = imageModelOptions.find((m) => m.id === imageSettings?.default_model)

  function toggleSection(s: Section) {
    setOpenSection((cur) => (cur === s ? null : s))
    setOpenModelGroup(null)
  }

  function toggleModelGroup(g: ModelGroup) {
    setOpenModelGroup((cur) => (cur === g ? null : g))
  }

  function manage(path: string) {
    navigate(path)
    setOpen(false)
  }

  async function activateImageModel(id: string) {
    if (!imageSettings) return
    const prev = imageSettings
    setImageSettings({ ...imageSettings, default_model: id }) // optimistic
    try {
      setImageSettings(await settingsApi.updateImageSettings({ default_model: id }))
    } catch {
      setImageSettings(prev)
    }
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
        aria-expanded={open}
        aria-label="Profile menu"
        className="shrink-0"
      >
        {avatarEl}
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="z-50 w-[18rem] max-w-[calc(100vw-1.5rem)] bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-lg overflow-hidden"
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
            {/* Category accordion */}
            <div className="p-1 border-b border-gray-100 dark:border-gray-700">
              {/* Themes */}
              <CategoryButton
                icon={Palette}
                label="Themes"
                hint={activeTheme?.name ?? 'Default'}
                expanded={openSection === 'theme'}
                onClick={() => toggleSection('theme')}
              />
              {openSection === 'theme' && (
                <div className="mt-0.5 mb-1 ml-3 pl-1 border-l border-gray-100 dark:border-gray-700 space-y-0.5">
                  <ManageBar onManage={() => manage('/settings/themes')} />
                  <OptionButton active={!activeThemeId} onClick={() => void deactivateTheme()}>
                    <div className="w-4 h-4 rounded-full border-2 border-gray-300 dark:border-gray-500 shrink-0" />
                    <span className="flex-1">Default</span>
                    {!activeThemeId && <Check className="w-3.5 h-3.5 shrink-0" />}
                  </OptionButton>
                  {orderedThemes.map((t) => {
                    const isActive = t.id === activeThemeId
                    return (
                      <OptionButton key={t.id} active={isActive} onClick={() => void activateTheme(t.id)}>
                        <div className="w-4 h-4 rounded-full shrink-0 border border-black/10 dark:border-white/10" style={swatchStyle(t)} />
                        <span className="truncate flex-1">{t.name}</span>
                        <span className="text-xs text-gray-400 dark:text-gray-500 capitalize shrink-0">{t.mode}</span>
                        {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
                      </OptionButton>
                    )
                  })}
                </div>
              )}

              {/* AI Models — Text + Image sub-menus */}
              <CategoryButton
                icon={Boxes}
                label="AI Models"
                hint={activeProvider?.model || undefined}
                expanded={openSection === 'model'}
                onClick={() => toggleSection('model')}
              />
              {openSection === 'model' && (
                <div className="mt-0.5 mb-1 ml-3 pl-1 border-l border-gray-100 dark:border-gray-700">
                  {/* Text Models */}
                  <CategoryButton
                    icon={Type}
                    label="Text Models"
                    hint={activeProvider?.model || undefined}
                    expanded={openModelGroup === 'text'}
                    onClick={() => toggleModelGroup('text')}
                  />
                  {openModelGroup === 'text' && (
                    <div className="mt-0.5 mb-1 ml-3 pl-1 border-l border-gray-100 dark:border-gray-700 space-y-0.5">
                      <ManageBar onManage={() => manage('/settings/ai/providers')} />
                      {enabledProviders.length === 0 ? (
                        <EmptyNote>No providers configured.</EmptyNote>
                      ) : (
                        enabledProviders.map((p) => {
                          const isActive = p.id === activeProvider?.id
                          return (
                            <OptionButton key={p.id} active={isActive} onClick={() => void activateAIProvider(p.id)}>
                              <div className="min-w-0 flex-1">
                                <div className="truncate">{p.name}</div>
                                <div className="text-xs text-gray-400 dark:text-gray-500 truncate font-normal">{p.model || '—'}</div>
                              </div>
                              {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
                            </OptionButton>
                          )
                        })
                      )}
                    </div>
                  )}

                  {/* Image Models */}
                  <CategoryButton
                    icon={ImageIcon}
                    label="Image Models"
                    hint={activeImageModel?.label ?? (imageLoading ? 'Loading…' : undefined)}
                    expanded={openModelGroup === 'image'}
                    onClick={() => toggleModelGroup('image')}
                  />
                  {openModelGroup === 'image' && (
                    <div className="mt-0.5 mb-1 ml-3 pl-1 border-l border-gray-100 dark:border-gray-700 space-y-0.5">
                      <ManageBar onManage={() => manage('/settings/ai/images')} />
                      {imageLoading && !imageSettings ? (
                        <EmptyNote>Loading…</EmptyNote>
                      ) : imageModelOptions.length === 0 ? (
                        <EmptyNote>No image models available.</EmptyNote>
                      ) : (
                        imageModelOptions.map((m) => {
                          const isActive = m.id === imageSettings?.default_model
                          return (
                            <OptionButton key={m.id} active={isActive} onClick={() => void activateImageModel(m.id)}>
                              <span className="truncate flex-1">{m.label}</span>
                              {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
                            </OptionButton>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* AI Agents */}
              <CategoryButton
                icon={Bot}
                label="AI Agents"
                hint={activeSystemPrompt?.name ?? 'None'}
                expanded={openSection === 'agent'}
                onClick={() => toggleSection('agent')}
              />
              {openSection === 'agent' && (
                <div className="mt-0.5 mb-1 ml-3 pl-1 border-l border-gray-100 dark:border-gray-700 space-y-0.5">
                  <ManageBar onManage={() => manage('/settings/ai/assistant')} />
                  {systemPrompts.length === 0 ? (
                    <EmptyNote>No agents yet.</EmptyNote>
                  ) : (
                    [...systemPrompts]
                      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
                      .map((p) => (
                        <OptionButton key={p.id} active={p.is_active} onClick={() => void activateSystemPrompt(p.id)}>
                          <span className="truncate flex-1">{p.name}</span>
                          {p.is_active && <Check className="w-3.5 h-3.5 shrink-0" />}
                        </OptionButton>
                      ))
                  )}
                </div>
              )}
            </div>

            {/* Settings + Sign out */}
            <div className="p-1">
              <button
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors text-left"
                onClick={() => { navigate('/settings'); setOpen(false) }}
              >
                <Settings className="w-4 h-4 shrink-0" />
                <span>Settings</span>
              </button>
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
