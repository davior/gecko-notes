import { useState, useRef } from 'react'
import { Plus, Pencil, Trash2, Globe, Lock, CheckCircle2, Upload, Loader2 } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import { useAuthStore } from '@/stores/auth'
import { mediaApi } from '@/api/media'
import type { Theme, ThemeCreate, ThemeUpdate } from '@/api/settings'

interface ThemeForm {
  name: string
  mode: 'light' | 'dark'
  bg_type: 'flat' | 'gradient' | 'image'
  bg_color1: string
  bg_color2: string
  bg_image_url: string
  bg_image_mode: 'repeat' | 'stretch' | 'fill'
  bg_blur: number
  glass_opacity: number
  glass_blur: number
  shadow_size: number
  shadow_blur: number
  is_global: boolean
}

function emptyForm(): ThemeForm {
  return {
    name: '',
    mode: 'light',
    bg_type: 'flat',
    bg_color1: '#e0f2fe',
    bg_color2: '#bfdbfe',
    bg_image_url: '',
    bg_image_mode: 'fill',
    bg_blur: 0,
    glass_opacity: 0.3,
    glass_blur: 12,
    shadow_size: 4,
    shadow_blur: 12,
    is_global: false,
  }
}

function formFromTheme(t: Theme): ThemeForm {
  return {
    name: t.name,
    mode: t.mode,
    bg_type: t.bg_type,
    bg_color1: t.bg_color1,
    bg_color2: t.bg_color2 ?? '#bfdbfe',
    bg_image_url: t.bg_image_url ?? '',
    bg_image_mode: t.bg_image_mode,
    bg_blur: t.bg_blur,
    glass_opacity: t.glass_opacity,
    glass_blur: t.glass_blur,
    shadow_size: t.shadow_size,
    shadow_blur: t.shadow_blur,
    is_global: t.is_global,
  }
}

function PreviewCard({ form }: { form: ThemeForm }) {
  const glassRgb = form.mode === 'dark' ? '0,0,0' : '255,255,255'
  const glassOpacity = form.glass_opacity
  const glassBlur = `${form.glass_blur}px`
  const shadowColor = form.mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.25)'
  const textColor = form.mode === 'dark' ? '#f1f5f9' : '#1a1a2e'
  const subTextColor = form.mode === 'dark' ? '#94a3b8' : '#64748b'

  let bg = form.bg_color1
  if (form.bg_type === 'gradient' && form.bg_color2) {
    bg = `linear-gradient(135deg, ${form.bg_color1}, ${form.bg_color2})`
  } else if (form.bg_type === 'image' && form.bg_image_url) {
    bg = `url(${form.bg_image_url})`
  }

  const panelStyle: React.CSSProperties = {
    background: `rgba(${glassRgb}, ${glassOpacity})`,
    backdropFilter: `blur(${glassBlur})`,
    WebkitBackdropFilter: `blur(${glassBlur})`,
    border: `1px solid rgba(${glassRgb}, ${glassOpacity * 1.5})`,
    boxShadow: `0 ${form.shadow_size}px ${form.shadow_blur}px ${shadowColor}`,
  }

  const btnStyle: React.CSSProperties = {
    background: `rgba(${glassRgb}, ${glassOpacity})`,
    backdropFilter: `blur(${glassBlur})`,
    WebkitBackdropFilter: `blur(${glassBlur})`,
    border: `1px solid rgba(${glassRgb}, ${glassOpacity * 1.5})`,
    boxShadow: `0 ${form.shadow_size * 0.5}px ${form.shadow_blur * 0.5}px ${shadowColor}`,
    color: textColor,
    fontSize: '10px',
    padding: '3px 8px',
    borderRadius: '6px',
    cursor: 'default',
  }

  return (
    <div
      className="rounded-xl overflow-hidden relative flex items-center justify-center"
      style={{ height: 120, background: bg, backgroundSize: 'cover', backgroundPosition: 'center', filter: form.bg_blur > 0 ? undefined : undefined }}
    >
      <div className="absolute inset-0" style={{ backdropFilter: form.bg_blur > 0 ? `blur(${form.bg_blur}px)` : undefined }} />
      <div className="relative z-10 rounded-lg p-3 w-40" style={panelStyle}>
        <p className="text-xs font-semibold mb-1" style={{ color: textColor, fontSize: '11px' }}>{form.name || 'My Theme'}</p>
        <p className="mb-2" style={{ color: subTextColor, fontSize: '9px' }}>Glass preview panel</p>
        <div className="flex gap-1">
          <span style={btnStyle}>Button</span>
          <span style={{ ...btnStyle, background: '#3b82f6', border: '1px solid #2563eb', color: '#fff', boxShadow: btnStyle.boxShadow }}>Primary</span>
        </div>
      </div>
    </div>
  )
}

function SliderField({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="flex justify-between mb-1">
        <label className="label mb-0">{label}</label>
        <span className="text-xs text-gray-500 dark:text-gray-400">{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-600"
      />
    </div>
  )
}

export default function ThemeManager() {
  const { themes, activeThemeId, sharedThemeId, createTheme, updateTheme, deleteTheme, activateTheme, deactivateTheme, setSharedTheme } = useSettingsStore()
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.is_admin ?? false

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ThemeForm>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [toastMsg, setToastMsg] = useState('')
  const [toastError, setToastError] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function showToast(msg: string, isError = false) {
    setToastMsg(msg); setToastError(isError)
    setTimeout(() => setToastMsg(''), 3000)
  }

  function set<K extends keyof ThemeForm>(key: K, value: ThemeForm[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function startAddNew() {
    setEditingId(null); setForm(emptyForm()); setShowForm(true)
  }

  function startEdit(t: Theme) {
    setEditingId(t.id); setForm(formFromTheme(t)); setShowForm(true)
  }

  function cancelForm() { setShowForm(false); setEditingId(null) }

  async function saveForm() {
    if (!form.name.trim()) { showToast('Name is required', true); return }
    setSaving(true)
    const shared = {
      mode: form.mode,
      bg_type: form.bg_type,
      bg_color1: form.bg_color1,
      bg_color2: form.bg_type === 'gradient' ? form.bg_color2 || null : null,
      bg_image_url: form.bg_type === 'image' ? form.bg_image_url || null : null,
      bg_image_mode: form.bg_image_mode,
      bg_blur: form.bg_blur,
      glass_opacity: form.glass_opacity,
      glass_blur: form.glass_blur,
      shadow_size: form.shadow_size,
      shadow_blur: form.shadow_blur,
      is_global: isAdmin ? form.is_global : false,
    }
    try {
      if (editingId) {
        await updateTheme(editingId, { name: form.name.trim(), ...shared })
      } else {
        await createTheme({ name: form.name.trim(), ...shared })
      }
      setShowForm(false); setEditingId(null); showToast('Theme saved')
    } catch { showToast('Failed to save theme', true) }
    finally { setSaving(false) }
  }

  async function handleActivate(id: string) {
    try {
      if (activeThemeId === id) { await deactivateTheme(); showToast('Theme removed') }
      else { await activateTheme(id); showToast('Theme applied') }
    } catch { showToast('Failed to apply theme', true) }
  }

  async function handleSetSharedDefault(id: string) {
    try {
      if (sharedThemeId === id) { await setSharedTheme(null); showToast('Removed as shared note default') }
      else { await setSharedTheme(id); showToast('Set as shared note default') }
    } catch { showToast('Failed to update shared default', true) }
  }

  async function handleDelete(id: string) {
    try { await deleteTheme(id); setConfirmDelete(null); showToast('Theme deleted') }
    catch { showToast('Failed to delete theme', true) }
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const result = await mediaApi.upload(file)
      set('bg_image_url', result.data.url)
      set('bg_type', 'image')
    } catch { showToast('Image upload failed', true) }
    finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = '' }
  }

  const globalThemes = themes.filter((t) => t.is_global)
  const personalThemes = themes.filter((t) => !t.is_global)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Themes</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Customise the Glass look of the app.</p>
        </div>
        {!showForm && (
          <button className="btn btn-primary" onClick={startAddNew}>
            <Plus className="w-4 h-4" /> New Theme
          </button>
        )}
      </div>

      {/* Inline form */}
      {showForm && (
        <div className="card p-5 border-2 border-blue-200 dark:border-blue-700 space-y-4">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
            {editingId ? 'Edit Theme' : 'New Theme'}
          </h3>

          {/* Preview */}
          <PreviewCard form={form} />

          {/* Name */}
          <div>
            <label className="label">Name</label>
            <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="My Theme" />
          </div>

          {/* Mode */}
          <div>
            <label className="label">Mode</label>
            <div className="flex gap-3">
              {(['light', 'dark'] as const).map((m) => (
                <label key={m} className="flex items-center gap-2 cursor-pointer text-sm text-gray-700 dark:text-gray-300">
                  <input type="radio" name="mode" value={m} checked={form.mode === m} onChange={() => set('mode', m)} className="accent-blue-600" />
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </label>
              ))}
            </div>
          </div>

          {/* Background type */}
          <div>
            <label className="label">Background</label>
            <div className="flex gap-3 flex-wrap">
              {(['flat', 'gradient', 'image'] as const).map((bt) => (
                <label key={bt} className="flex items-center gap-2 cursor-pointer text-sm text-gray-700 dark:text-gray-300">
                  <input type="radio" name="bg_type" value={bt} checked={form.bg_type === bt} onChange={() => set('bg_type', bt)} className="accent-blue-600" />
                  {bt.charAt(0).toUpperCase() + bt.slice(1)}
                </label>
              ))}
            </div>
          </div>

          {/* Color inputs */}
          {(form.bg_type === 'flat' || form.bg_type === 'gradient') && (
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="label">{form.bg_type === 'gradient' ? 'Color 1' : 'Color'}</label>
                <div className="flex gap-2 items-center">
                  <input type="color" value={form.bg_color1} onChange={(e) => set('bg_color1', e.target.value)} className="w-10 h-9 rounded border border-gray-300 dark:border-gray-600 cursor-pointer p-0.5 bg-white dark:bg-gray-700" />
                  <input className="input" value={form.bg_color1} onChange={(e) => set('bg_color1', e.target.value)} placeholder="#f0f4ff" />
                </div>
              </div>
              {form.bg_type === 'gradient' && (
                <div className="flex-1">
                  <label className="label">Color 2</label>
                  <div className="flex gap-2 items-center">
                    <input type="color" value={form.bg_color2} onChange={(e) => set('bg_color2', e.target.value)} className="w-10 h-9 rounded border border-gray-300 dark:border-gray-600 cursor-pointer p-0.5 bg-white dark:bg-gray-700" />
                    <input className="input" value={form.bg_color2} onChange={(e) => set('bg_color2', e.target.value)} placeholder="#bfdbfe" />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Image upload */}
          {form.bg_type === 'image' && (
            <div className="space-y-3">
              <div>
                <label className="label">Background Image</label>
                <div className="flex gap-2 items-center">
                  <input className="input flex-1 text-xs" value={form.bg_image_url} onChange={(e) => set('bg_image_url', e.target.value)} placeholder="https://... or upload below" />
                  <button className="btn btn-secondary shrink-0" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                    {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    Upload
                  </button>
                  <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                </div>
                {form.bg_image_url && (
                  <img src={form.bg_image_url} alt="Background preview" className="mt-2 rounded-lg h-16 w-full object-cover" />
                )}
              </div>
              <div>
                <label className="label">Image Size</label>
                <select className="input" value={form.bg_image_mode} onChange={(e) => set('bg_image_mode', e.target.value as ThemeForm['bg_image_mode'])}>
                  <option value="fill">Fill (cover)</option>
                  <option value="stretch">Stretch</option>
                  <option value="repeat">Repeat (tile)</option>
                </select>
              </div>
            </div>
          )}

          <SliderField label="Background Blur" value={form.bg_blur} min={0} max={20} step={0.5} unit="px" onChange={(v) => set('bg_blur', v)} />
          <SliderField label="Glass Opacity" value={Math.round(form.glass_opacity * 100)} min={0} max={80} step={1} unit="%" onChange={(v) => set('glass_opacity', v / 100)} />
          <SliderField label="Glass Blur" value={form.glass_blur} min={0} max={30} step={0.5} unit="px" onChange={(v) => set('glass_blur', v)} />
          <SliderField label="Element Shadow Size" value={form.shadow_size} min={0} max={20} step={0.5} unit="px" onChange={(v) => set('shadow_size', v)} />
          <SliderField label="Element Shadow Blur" value={form.shadow_blur} min={0} max={40} step={1} unit="px" onChange={(v) => set('shadow_blur', v)} />

          {isAdmin && (
            <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={form.is_global} onChange={(e) => set('is_global', e.target.checked)} className="accent-blue-600" />
              Make this a Global Theme (visible to all users)
            </label>
          )}

          <div className="flex gap-2 pt-1">
            <button className="btn btn-primary" onClick={saveForm} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {saving ? 'Saving…' : 'Save Theme'}
            </button>
            <button className="btn btn-secondary" onClick={cancelForm}>Cancel</button>
          </div>
        </div>
      )}

      {/* Global themes */}
      {globalThemes.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3 flex items-center gap-2">
            <Globe className="w-3.5 h-3.5" /> Global Themes
          </h3>
          <div className="space-y-2">
            {globalThemes.map((t) => (
              <ThemeRow
                key={t.id}
                theme={t}
                isActive={t.id === activeThemeId}
                isSharedDefault={t.id === sharedThemeId}
                canEdit={isAdmin}
                canDelete={isAdmin}
                onEdit={() => startEdit(t)}
                onDelete={() => setConfirmDelete(t.id)}
                onActivate={() => handleActivate(t.id)}
                onSetSharedDefault={() => handleSetSharedDefault(t.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Personal themes */}
      <div>
        {personalThemes.length > 0 && (
          <>
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3 flex items-center gap-2">
              <Lock className="w-3.5 h-3.5" /> My Themes
            </h3>
            <div className="space-y-2">
              {personalThemes.map((t) => (
                <ThemeRow
                  key={t.id}
                  theme={t}
                  isActive={t.id === activeThemeId}
                  isSharedDefault={t.id === sharedThemeId}
                  canEdit
                  canDelete
                  onEdit={() => startEdit(t)}
                  onDelete={() => setConfirmDelete(t.id)}
                  onActivate={() => handleActivate(t.id)}
                  onSetSharedDefault={() => handleSetSharedDefault(t.id)}
                />
              ))}
            </div>
          </>
        )}
        {personalThemes.length === 0 && !showForm && (
          <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">
            No personal themes yet. Create one above.
          </p>
        )}
      </div>

      {/* Delete confirm modal */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card p-6 w-full max-w-sm shadow-xl space-y-4">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Delete Theme?</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">This cannot be undone.</p>
            <div className="flex gap-2">
              <button className="btn btn-danger flex-1" onClick={() => handleDelete(confirmDelete)}>Delete</button>
              <button className="btn btn-secondary flex-1" onClick={() => setConfirmDelete(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toastMsg && (
        <div className={`fixed bottom-4 right-4 z-50 px-4 py-2 rounded-lg text-sm text-white shadow-lg ${toastError ? 'bg-red-600' : 'bg-gray-800 dark:bg-gray-100 dark:text-gray-900'}`}>
          {toastMsg}
        </div>
      )}
    </div>
  )
}

function ThemeRow({ theme, isActive, isSharedDefault, canEdit, canDelete, onEdit, onDelete, onActivate, onSetSharedDefault }: {
  theme: Theme
  isActive: boolean
  isSharedDefault: boolean
  canEdit: boolean
  canDelete: boolean
  onEdit: () => void
  onDelete: () => void
  onActivate: () => void
  onSetSharedDefault: () => void
}) {
  let bgPreview: React.CSSProperties = { background: theme.bg_color1 }
  if (theme.bg_type === 'gradient' && theme.bg_color2) {
    bgPreview = { background: `linear-gradient(135deg, ${theme.bg_color1}, ${theme.bg_color2})` }
  } else if (theme.bg_type === 'image' && theme.bg_image_url) {
    bgPreview = { backgroundImage: `url(${theme.bg_image_url})`, backgroundSize: 'cover', backgroundPosition: 'center' }
  }

  return (
    <div className={`card p-3 flex items-center gap-3 ${isActive ? 'ring-2 ring-blue-500' : ''}`}>
      <div className="w-10 h-10 rounded-lg shrink-0 border border-white/30" style={bgPreview} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{theme.name}</span>
          {isActive && <span className="text-xs px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 rounded-full font-medium">Active</span>}
          {isSharedDefault && <span className="text-xs px-1.5 py-0.5 bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 rounded-full font-medium flex items-center gap-1"><Globe className="w-2.5 h-2.5" />Shared</span>}
          {theme.is_global && <span className="text-xs px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-full font-medium">Global</span>}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 capitalize">{theme.mode} · {theme.bg_type} · {Math.round(theme.glass_opacity * 100)}% opacity</p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onActivate}
          className={`btn text-xs px-3 py-1.5 ${isActive ? 'btn-secondary' : 'btn-primary'}`}
        >
          {isActive ? 'Remove' : 'Apply'}
        </button>
        <button
          onClick={onSetSharedDefault}
          className={`btn-ghost p-2 rounded-lg ${isSharedDefault ? 'text-green-500' : 'text-gray-400 hover:text-green-500'}`}
          title={isSharedDefault ? 'Remove as shared note default' : 'Use for shared notes'}
        >
          <Globe className="w-4 h-4" />
        </button>
        {canEdit && (
          <button onClick={onEdit} className="btn-ghost p-2 rounded-lg" title="Edit">
            <Pencil className="w-4 h-4" />
          </button>
        )}
        {canDelete && (
          <button onClick={onDelete} className="btn-ghost p-2 rounded-lg text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" title="Delete">
            <Trash2 className="w-4 h-4" />
          </button>
        )}
        {isActive && <CheckCircle2 className="w-4 h-4 text-blue-500 shrink-0" />}
      </div>
    </div>
  )
}
