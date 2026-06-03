import { useEffect, useState } from 'react'
import { History, RotateCcw, FilePlus, X } from 'lucide-react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import type { PartialBlock } from '@blocknote/core'
import { notesApi, type Note, type NoteVersion, type NoteVersionListItem } from '@/api/notes'
import { useSettingsStore } from '@/stores/settings'

const EMPTY_DOCUMENT: PartialBlock[] = [{ type: 'paragraph' }]

function parseNoteContent(content: string): PartialBlock[] {
  try {
    const blocks = JSON.parse(content)
    return Array.isArray(blocks) && blocks.length > 0 ? (blocks as PartialBlock[]) : EMPTY_DOCUMENT
  } catch {
    return EMPTY_DOCUMENT
  }
}

function formatTimestamp(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface Props {
  noteId: string
  onClose: () => void
  onRestored: (note: Note) => void
  onRecoveredToNew: (note: Note) => void
}

export default function NoteHistoryModal({ noteId, onClose, onRestored, onRecoveredToNew }: Props) {
  const [versions, setVersions] = useState<NoteVersionListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<NoteVersion | null>(null)
  const [busy, setBusy] = useState(false)

  const theme = useSettingsStore((s) => s.theme)
  const previewEditor = useCreateBlockNote()

  useEffect(() => {
    let active = true
    notesApi
      .listVersions(noteId)
      .then((res) => {
        if (!active) return
        setVersions(res.data)
        if (res.data.length > 0) setSelectedId(res.data[0].id)
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [noteId])

  useEffect(() => {
    if (!selectedId) {
      setSelected(null)
      return
    }
    let active = true
    notesApi.getVersion(noteId, selectedId).then((res) => {
      if (active) setSelected(res.data)
    })
    return () => {
      active = false
    }
  }, [noteId, selectedId])

  useEffect(() => {
    if (!previewEditor || !selected) return
    const blocks = parseNoteContent(selected.content)
    previewEditor.replaceBlocks(
      previewEditor.document,
      blocks as Parameters<typeof previewEditor.replaceBlocks>[1],
    )
  }, [previewEditor, selected])

  async function handleRestore(mode: 'in_place' | 'new_note') {
    if (!selectedId || busy) return
    setBusy(true)
    try {
      const res = await notesApi.restoreVersion(noteId, selectedId, mode)
      if (mode === 'new_note') onRecoveredToNew(res.data)
      else onRestored(res.data)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-4xl mx-4 shadow-xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <History className="w-5 h-5" /> Version History
          </h3>
          <button className="btn-ghost p-1.5" title="Close" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Version list */}
          <div className="w-64 shrink-0 border-r border-gray-100 dark:border-gray-700 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-sm text-gray-400">Loading…</div>
            ) : versions.length === 0 ? (
              <div className="p-4 text-sm text-gray-400">No saved versions yet.</div>
            ) : (
              versions.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setSelectedId(v.id)}
                  className={`w-full text-left px-4 py-2.5 border-b border-gray-50 dark:border-gray-700/50 transition-colors ${
                    selectedId === v.id
                      ? 'bg-blue-50 dark:bg-blue-900/30'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-700/40'
                  }`}
                >
                  <div className="text-xs font-medium text-gray-700 dark:text-gray-200">
                    {formatTimestamp(v.created_at)}
                  </div>
                  <div className="text-xs text-gray-400 truncate mt-0.5">
                    {v.content_preview || 'Empty'}
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Preview */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex-1 min-h-0 overflow-auto p-2">
              {selected ? (
                <BlockNoteView editor={previewEditor} editable={false} theme={theme} />
              ) : (
                <div className="p-4 text-sm text-gray-400">
                  {versions.length === 0 ? 'Versions are captured automatically as you edit.' : 'Select a version to preview.'}
                </div>
              )}
            </div>

            {selected && (
              <div className="shrink-0 flex gap-3 px-4 py-3 border-t border-gray-100 dark:border-gray-700">
                <button className="btn-secondary flex-1 inline-flex items-center justify-center gap-1.5" disabled={busy} onClick={() => handleRestore('in_place')}>
                  <RotateCcw className="w-4 h-4" /> Restore over this note
                </button>
                <button className="btn-primary flex-1 inline-flex items-center justify-center gap-1.5" disabled={busy} onClick={() => handleRestore('new_note')}>
                  <FilePlus className="w-4 h-4" /> Recover to new note
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
