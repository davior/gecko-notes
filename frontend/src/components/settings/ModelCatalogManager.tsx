import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown, Loader2 } from 'lucide-react'
import { modelCatalogApi, type CatalogKind, type ModelCatalogEntry, type ModelCatalogEntryCreate } from '@/api/modelCatalog'

const KIND_TABS: { key: CatalogKind; label: string }[] = [
  { key: 'image', label: 'Image' },
  { key: 'tts', label: 'TTS' },
  { key: 'stt', label: 'STT' },
]

interface EntryForm {
  model_id: string
  label: string
  maker_note: string
  voices: string
  text_field: string
  voice_field: string
  extra_params: string
}

function emptyForm(): EntryForm {
  return { model_id: '', label: '', maker_note: '', voices: '', text_field: '', voice_field: '', extra_params: '' }
}

function formFromEntry(e: ModelCatalogEntry): EntryForm {
  return {
    model_id: e.model_id,
    label: e.label,
    maker_note: e.maker_note ?? '',
    voices: (e.voices ?? []).join(', '),
    text_field: e.text_field ?? '',
    voice_field: e.voice_field ?? '',
    extra_params: e.extra_params ? JSON.stringify(e.extra_params) : '',
  }
}

export default function ModelCatalogManager() {
  const [activeKind, setActiveKind] = useState<CatalogKind>('image')
  const [entries, setEntries] = useState<ModelCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<EntryForm>(emptyForm())
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [toastMsg, setToastMsg] = useState('')
  const [toastError, setToastError] = useState(false)

  function showToast(msg: string, isError = false) {
    setToastMsg(msg); setToastError(isError)
    setTimeout(() => setToastMsg(''), 3000)
  }

  async function load() {
    setLoading(true)
    try {
      const res = await modelCatalogApi.list()
      setEntries(res.data)
    } catch {
      showToast('Failed to load model catalog', true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  function set<K extends keyof EntryForm>(key: K, value: EntryForm[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function startAddNew() {
    setEditingId(null); setForm(emptyForm()); setFormError(null); setShowForm(true)
  }

  function startEdit(e: ModelCatalogEntry) {
    setEditingId(e.id); setForm(formFromEntry(e)); setFormError(null); setShowForm(true)
  }

  function cancelForm() { setShowForm(false); setEditingId(null); setFormError(null) }

  async function saveForm() {
    if (!form.model_id.trim() || !form.label.trim()) {
      setFormError('Model ID and label are required')
      return
    }
    let extraParams: Record<string, unknown> | undefined
    if (activeKind === 'tts' && form.extra_params.trim()) {
      try {
        extraParams = JSON.parse(form.extra_params)
      } catch {
        setFormError('Extra params must be valid JSON')
        return
      }
    }
    const voices = activeKind === 'tts'
      ? form.voices.split(/[,\n]+/).map((v) => v.trim()).filter(Boolean)
      : undefined

    setSaving(true)
    setFormError(null)
    try {
      if (editingId) {
        await modelCatalogApi.update(editingId, {
          label: form.label.trim(),
          maker_note: form.maker_note.trim() || null,
          ...(activeKind === 'tts' && {
            voices: voices && voices.length > 0 ? voices : null,
            text_field: form.text_field.trim() || null,
            voice_field: form.voice_field.trim() || null,
            extra_params: extraParams ?? null,
          }),
        })
      } else {
        const payload: ModelCatalogEntryCreate = {
          kind: activeKind,
          model_id: form.model_id.trim(),
          label: form.label.trim(),
          maker_note: form.maker_note.trim() || null,
          sort_order: entries.filter((e) => e.kind === activeKind).length,
        }
        if (activeKind === 'tts') {
          payload.voices = voices && voices.length > 0 ? voices : null
          payload.text_field = form.text_field.trim() || null
          payload.voice_field = form.voice_field.trim() || null
          payload.extra_params = extraParams ?? null
        }
        await modelCatalogApi.create(payload)
      }
      setShowForm(false); setEditingId(null)
      showToast('Model saved')
      await load()
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: { message?: string } } } })?.response?.data?.detail
      setFormError(detail?.message ?? 'Failed to save model')
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(e: ModelCatalogEntry) {
    try {
      await modelCatalogApi.update(e.id, { is_active: !e.is_active })
      await load()
    } catch { showToast('Failed to update model', true) }
  }

  async function move(e: ModelCatalogEntry, direction: -1 | 1) {
    const kindEntries = entries.filter((x) => x.kind === e.kind).sort((a, b) => a.sort_order - b.sort_order)
    const idx = kindEntries.findIndex((x) => x.id === e.id)
    const swapWith = kindEntries[idx + direction]
    if (!swapWith) return
    try {
      await Promise.all([
        modelCatalogApi.update(e.id, { sort_order: swapWith.sort_order }),
        modelCatalogApi.update(swapWith.id, { sort_order: e.sort_order }),
      ])
      await load()
    } catch { showToast('Failed to reorder', true) }
  }

  async function handleDelete(id: string) {
    try {
      await modelCatalogApi.remove(id)
      setConfirmDelete(null)
      showToast('Model removed')
      await load()
    } catch { showToast('Failed to delete model', true) }
  }

  const visibleEntries = entries
    .filter((e) => e.kind === activeKind)
    .sort((a, b) => a.sort_order - b.sort_order)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Model Catalog</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Manage the fal.ai models offered in the image, TTS, and STT dropdowns for all users.
          </p>
        </div>
        {!showForm && (
          <button className="btn btn-primary" onClick={startAddNew}>
            <Plus className="w-4 h-4" /> Add Model
          </button>
        )}
      </div>

      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="flex gap-1 -mb-px">
          {KIND_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => { setActiveKind(t.key); setShowForm(false) }}
              className={`px-4 py-2 text-sm border-b-2 whitespace-nowrap transition-colors ${
                activeKind === t.key
                  ? 'border-blue-600 text-blue-700 dark:text-blue-400 font-medium'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {showForm && (
        <div className="card p-5 border-2 border-blue-200 dark:border-blue-700 space-y-4">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
            {editingId ? 'Edit Model' : `New ${KIND_TABS.find((t) => t.key === activeKind)?.label} Model`}
          </h3>

          <div>
            <label className="label">Model ID (fal.ai endpoint)</label>
            <input
              className="input"
              value={form.model_id}
              onChange={(e) => set('model_id', e.target.value)}
              placeholder="e.g. fal-ai/flux/dev"
              disabled={!!editingId}
            />
          </div>
          <div>
            <label className="label">Label</label>
            <input className="input" value={form.label} onChange={(e) => set('label', e.target.value)} placeholder="e.g. FLUX.1 [dev]" />
          </div>
          <div>
            <label className="label">Maker / pitch</label>
            <input className="input" value={form.maker_note} onChange={(e) => set('maker_note', e.target.value)} placeholder="e.g. Black Forest Labs — high quality" />
          </div>

          {activeKind === 'tts' && (
            <div className="space-y-3 pt-2 border-t border-gray-100 dark:border-gray-700">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Advanced overrides</p>
              <div>
                <label className="label">Voices (comma or newline separated)</label>
                <textarea className="input" rows={3} value={form.voices} onChange={(e) => set('voices', e.target.value)} placeholder="Aria, Roger, Sarah" />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="label">Text field override</label>
                  <input className="input" value={form.text_field} onChange={(e) => set('text_field', e.target.value)} placeholder="text" />
                </div>
                <div className="flex-1">
                  <label className="label">Voice field override</label>
                  <input className="input" value={form.voice_field} onChange={(e) => set('voice_field', e.target.value)} placeholder="voice" />
                </div>
              </div>
              <div>
                <label className="label">Extra params (JSON)</label>
                <textarea className="input font-mono text-xs" rows={2} value={form.extra_params} onChange={(e) => set('extra_params', e.target.value)} placeholder='{"language": "auto"}' />
              </div>
            </div>
          )}

          {formError && <p className="text-sm text-red-500">{formError}</p>}

          <div className="flex gap-2 pt-1">
            <button className="btn btn-primary" onClick={saveForm} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {saving ? 'Saving…' : 'Save Model'}
            </button>
            <button className="btn btn-secondary" onClick={cancelForm}>Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-8">Loading…</p>
      ) : visibleEntries.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-8">No models yet.</p>
      ) : (
        <div className="space-y-2">
          {visibleEntries.map((e, i) => (
            <div key={e.id} className={`card p-3 flex items-center gap-3 ${!e.is_active ? 'opacity-60' : ''}`}>
              <div className="flex flex-col shrink-0">
                <button className="btn-ghost p-0.5 disabled:opacity-30" onClick={() => move(e, -1)} disabled={i === 0} title="Move up">
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
                <button className="btn-ghost p-0.5 disabled:opacity-30" onClick={() => move(e, 1)} disabled={i === visibleEntries.length - 1} title="Move down">
                  <ArrowDown className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{e.label}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                    e.is_active
                      ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                  }`}>
                    {e.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <code className="text-xs text-gray-500 dark:text-gray-400">{e.model_id}</code>
                {e.maker_note && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{e.maker_note}</p>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => toggleActive(e)}
                  className="btn text-xs px-3 py-1.5 btn-secondary"
                >
                  {e.is_active ? 'Deactivate' : 'Activate'}
                </button>
                <button onClick={() => startEdit(e)} className="btn-ghost p-2 rounded-lg" title="Edit">
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={() => setConfirmDelete(e.id)} className="btn-ghost p-2 rounded-lg text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" title="Delete">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card p-6 w-full max-w-sm shadow-xl space-y-4">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Delete Model?</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">This cannot be undone.</p>
            <div className="flex gap-2">
              <button className="btn btn-danger flex-1" onClick={() => handleDelete(confirmDelete)}>Delete</button>
              <button className="btn btn-secondary flex-1" onClick={() => setConfirmDelete(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {toastMsg && (
        <div className={`fixed bottom-4 right-4 z-50 px-4 py-2 rounded-lg text-sm text-white shadow-lg ${toastError ? 'bg-red-600' : 'bg-gray-800 dark:bg-gray-100 dark:text-gray-900'}`}>
          {toastMsg}
        </div>
      )}
    </div>
  )
}
