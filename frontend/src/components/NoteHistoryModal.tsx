import { useEffect, useState } from 'react'
import { History, RotateCcw, FilePlus, X } from 'lucide-react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import type { PartialBlock } from '@blocknote/core'
import { noteSchema } from '@/blocks/childNoteBlock'
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

// Extract plain-text lines from BlockNote JSON (one entry per block).
function extractLines(content: string): string[] {
  const blocks = parseNoteContent(content)
  return blocks.map((block) => {
    const b = block as Record<string, unknown>
    const inlines = Array.isArray(b.content) ? (b.content as Array<Record<string, unknown>>) : []
    return inlines
      .filter((s) => s.type === 'text' && typeof s.text === 'string')
      .map((s) => s.text as string)
      .join('')
  }).filter((line) => line.length > 0)
}

type DiffLine = { type: 'add' | 'remove' | 'same'; text: string }

function diffLines(a: string[], b: string[]): DiffLine[] {
  // LCS-based diff (Myers algorithm approximation via DP table).
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1]
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }
  const result: DiffLine[] = []
  let i = 0, j = 0
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      result.push({ type: 'same', text: a[i] })
      i++; j++
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      result.push({ type: 'add', text: b[j] })
      j++
    } else {
      result.push({ type: 'remove', text: a[i] })
      i++
    }
  }
  return result
}

interface Props {
  noteId: string
  currentContent: string
  onClose: () => void
  onRestored: (note: Note) => void
  onRecoveredToNew: (note: Note) => void
}

export default function NoteHistoryModal({ noteId, currentContent, onClose, onRestored, onRecoveredToNew }: Props) {
  const [versions, setVersions] = useState<NoteVersionListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<NoteVersion | null>(null)
  const [busy, setBusy] = useState(false)
  const [showDiff, setShowDiff] = useState(false)

  const theme = useSettingsStore((s) => s.theme)
  const themes = useSettingsStore((s) => s.themes)
  const activeThemeId = useSettingsStore((s) => s.activeThemeId)
  const activeTheme = activeThemeId ? themes.find((t) => t.id === activeThemeId) : null
  const previewEditor = useCreateBlockNote({ schema: noteSchema })

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
    // Clear immediately so the previously-loaded version can't render against
    // the newly-selected row while the fetch is in flight.
    setSelected(null)
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

  // Only treat the loaded version as current once its id matches the highlighted
  // selection — guards against out-of-order fetch resolution.
  const activeVersion = selected && selected.id === selectedId ? selected : null
  const diffResult = activeVersion ? diffLines(extractLines(activeVersion.content), extractLines(currentContent)) : []

  const glassRgb = activeTheme?.mode === 'dark' ? '0,0,0' : '255,255,255'
  const glassOpacity = activeTheme?.glass_opacity ?? 0.3
  const glassBlur = activeTheme?.glass_blur ?? 12
  const glassStyle: React.CSSProperties = {
    background: `rgba(${glassRgb}, ${glassOpacity})`,
    backdropFilter: `blur(${glassBlur}px)`,
    WebkitBackdropFilter: `blur(${glassBlur}px)`,
    border: `1px solid rgba(${glassRgb}, ${glassOpacity * 1.5})`,
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="rounded-xl w-full max-w-4xl mx-4 shadow-xl flex flex-col max-h-[85vh]"
        style={glassStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: `rgba(${glassRgb}, ${glassOpacity * 1.5})` }}>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <History className="w-5 h-5" /> Version History
          </h3>
          <button className="btn-ghost p-1.5" title="Close" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Version list */}
          <div className="w-64 shrink-0 border-r overflow-y-auto" style={{ borderColor: `rgba(${glassRgb}, ${glassOpacity * 1.5})`, background: `rgba(${glassRgb}, ${Math.max(glassOpacity * 0.5, 0.1)})` }}>
            {loading ? (
              <div className="p-4 text-sm text-gray-400">Loading…</div>
            ) : versions.length === 0 ? (
              <div className="p-4 text-sm text-gray-400">No saved versions yet.</div>
            ) : (
              versions.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setSelectedId(v.id)}
                  className={`w-full text-left px-4 py-2.5 transition-colors ${
                    selectedId === v.id
                      ? 'bg-blue-50 dark:bg-blue-900/30'
                      : 'hover:bg-white/20 dark:hover:bg-white/10'
                  }`}
                  style={{ borderBottom: `1px solid rgba(${glassRgb}, ${glassOpacity * 0.8})` }}
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

          {/* Preview / Diff */}
          <div className="flex-1 min-w-0 flex flex-col">
            {/* Toggle bar */}
            {activeVersion && (
              <div className="shrink-0 flex gap-1 px-4 pt-2">
                <button
                  className={`text-xs px-3 py-1 rounded-full transition-colors ${!showDiff ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium' : 'btn-ghost'}`}
                  onClick={() => setShowDiff(false)}
                >
                  Preview
                </button>
                <button
                  className={`text-xs px-3 py-1 rounded-full transition-colors ${showDiff ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium' : 'btn-ghost'}`}
                  onClick={() => setShowDiff(true)}
                >
                  Diff vs. current
                </button>
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-auto p-2">
              {activeVersion ? (
                showDiff ? (
                  <div className="font-mono text-xs leading-5 select-text">
                    {diffResult.length === 0 ? (
                      <div className="p-4 text-gray-400">No differences — content is identical to current note.</div>
                    ) : (
                      diffResult.map((line, i) => (
                        <div
                          key={i}
                          className={
                            line.type === 'add'
                              ? 'bg-green-50 dark:bg-green-900/30 text-green-800 dark:text-green-200 px-2'
                              : line.type === 'remove'
                                ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 px-2'
                                : 'text-gray-600 dark:text-gray-400 px-2'
                          }
                        >
                          <span className="select-none mr-1 opacity-50">
                            {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                          </span>
                          {line.text || <span className="opacity-30">(empty line)</span>}
                        </div>
                      ))
                    )}
                  </div>
                ) : (
                  <div style={{ background: 'transparent' }}>
                    <BlockNoteView editor={previewEditor} editable={false} theme={theme} />
                  </div>
                )
              ) : (
                <div className="p-4 text-sm text-gray-400">
                  {selectedId ? 'Loading…' : versions.length === 0 ? 'Versions are captured automatically as you edit.' : 'Select a version to preview.'}
                </div>
              )}
            </div>

            {activeVersion && (
              <div className="shrink-0 flex gap-3 px-4 py-3 border-t" style={{ borderColor: `rgba(${glassRgb}, ${glassOpacity * 1.5})` }}>
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
