import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, FileText, FileDown, Code, ChevronDown, FileArchive } from 'lucide-react'
import { notesApi } from '@/api/notes'
import { exportNotesToZip, type BulkExportFormat } from '@/utils/export'
import { useDropdown } from '@/hooks/useDropdown'

interface Props {
  noteIds: string[]
  onToast: (msg: string) => void
}

// Bulk export of the currently selected notes into a single ZIP. Markdown/HTML share
// one assets/ folder with relative paths; PDF/Word are self-contained files. Mirrors
// the single-note ExportMenu (same dropdown pattern) but operates on a selection.
export default function BulkExportMenu({ noteIds, onToast }: Props) {
  const { open, setOpen, triggerRef, dropdownRef, style } = useDropdown('right')
  const [loading, setLoading] = useState<BulkExportFormat | null>(null)

  const items: { key: BulkExportFormat; label: string; icon: React.ElementType }[] = [
    { key: 'pdf', label: 'PDF', icon: FileDown },
    { key: 'word', label: 'Word', icon: FileText },
    { key: 'md', label: 'Markdown (ZIP)', icon: FileArchive },
    { key: 'html', label: 'HTML (ZIP)', icon: Code },
  ]

  async function handleExport(format: BulkExportFormat) {
    if (noteIds.length === 0) return
    setOpen(false)
    setLoading(format)
    try {
      // The list holds NoteListItem (no full content), so fetch each note in full first.
      const notes = await Promise.all(noteIds.map((id) => notesApi.get(id).then((r) => r.data)))
      await exportNotesToZip(notes, format)
      onToast(`Exported ${notes.length} note${notes.length === 1 ? '' : 's'}`)
    } catch {
      onToast('Export failed')
    } finally {
      setLoading(null)
    }
  }

  const busy = loading !== null

  return (
    <div className="relative" ref={triggerRef}>
      <button
        className="text-xs px-3 py-1.5 rounded-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 flex items-center gap-1 transition-all disabled:opacity-50"
        title="Export selected to a ZIP"
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? (
          <svg className="animate-spin w-3 h-3 text-gray-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        ) : (
          <Download className="w-3 h-3" />
        )}
        Export
        <ChevronDown className="w-3 h-3" />
      </button>

      {open && createPortal(
        <div ref={dropdownRef} className="z-50 w-52 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-lg overflow-hidden" style={style}>
          <div className="p-1">
            {items.map((item) => (
              <button
                key={item.key}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors text-left disabled:opacity-50"
                disabled={loading === item.key}
                onClick={() => handleExport(item.key)}
              >
                <item.icon className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
