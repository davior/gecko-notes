import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, FileText, FileDown, Code, Clipboard, ChevronDown, FileAudio } from 'lucide-react'
import type { Note } from '@/api/notes'
import { exportToPDF, exportToWord, exportToMarkdown, exportToHTML, copyAsPlainText, copyAsRichText } from '@/utils/export'
import { useDropdown } from '@/hooks/useDropdown'

interface Props {
  note: Note
  onToast: (msg: string) => void
  // When provided, an "Export as Audio (MP3)" item is shown (text-to-speech).
  onExportAudio?: () => Promise<void>
}

type ExportKey = 'pdf' | 'word' | 'md' | 'html' | 'plain' | 'rich' | 'audio'

export default function ExportMenu({ note, onToast, onExportAudio }: Props) {
  const { open, setOpen, triggerRef, dropdownRef, style } = useDropdown('right')
  const [loading, setLoading] = useState<ExportKey | null>(null)

  const items: { key: ExportKey; label: string; icon: React.ElementType; action: () => Promise<void> }[] = [
    { key: 'pdf', label: 'Export as PDF', icon: FileDown, action: () => exportToPDF(note) },
    { key: 'word', label: 'Export as Word', icon: FileText, action: () => exportToWord(note) },
    { key: 'md', label: 'Export as Markdown', icon: FileText, action: () => exportToMarkdown(note) },
    { key: 'html', label: 'Export as HTML', icon: Code, action: () => exportToHTML(note) },
    ...(onExportAudio ? [{ key: 'audio' as const, label: 'Export as Audio (MP3)', icon: FileAudio, action: onExportAudio }] : []),
    { key: 'plain', label: 'Copy plain text', icon: Clipboard, action: async () => { await copyAsPlainText(note); onToast('Copied to clipboard') } },
    { key: 'rich', label: 'Copy rich text', icon: Clipboard, action: async () => { await copyAsRichText(note); onToast('Copied to clipboard') } },
  ]

  async function handleExport(item: typeof items[number]) {
    setOpen(false)
    setLoading(item.key)
    try {
      await item.action()
    } catch {
      onToast('Export failed')
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="relative" ref={triggerRef}>
      <button className="btn-ghost gap-1 text-sm" onClick={() => setOpen((o) => !o)}>
        <Download className="w-4 h-4" />
        Export
        <ChevronDown className="w-3 h-3" />
      </button>

      {open && createPortal(
        <div ref={dropdownRef} className="z-50 w-52 bg-white rounded-xl border border-gray-200 shadow-lg overflow-hidden" style={style}>
          <div className="p-1">
            {items.map((item) => (
              <button
                key={item.key}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors text-left disabled:opacity-50"
                disabled={loading === item.key}
                onClick={() => handleExport(item)}
              >
                <item.icon className="w-4 h-4 text-gray-500" />
                <span>{item.label}</span>
                {loading === item.key && (
                  <span className="ml-auto">
                    <svg className="animate-spin w-3 h-3 text-gray-400" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
