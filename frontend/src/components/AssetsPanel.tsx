import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, Braces, ChevronDown, ChevronRight, Download, File as FileIcon, FileArchive,
  FileText, Image as ImageIcon, Music, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2,
  Upload, Video, X,
} from 'lucide-react'
import {
  assetsApi, assetErrorMessage,
  type NoteAsset, type NoteAssetUpdate, type AssetRole, type UnlinkedFile,
} from '@/api/assets'
import { formatBytes } from '@/utils/format'

interface AssetsPanelProps {
  assets: NoteAsset[]
  loading: boolean
  error: string | null
  noteId: string | null
  /** False in list mode / before an editor exists — hides "Insert into note". */
  canInsert: boolean
  onUpload: (file: File) => Promise<void>
  onDelete: (asset: NoteAsset, alsoRemoveFromNote: boolean) => Promise<void>
  onUpdate: (assetId: string, payload: NoteAssetUpdate) => Promise<void>
  onInsert: (asset: NoteAsset) => void
  onRefresh: () => void
}

type FilterKey = 'all' | AssetRole

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'in_note', label: 'In note' },
  { key: 'reference', label: 'Reference' },
  { key: 'export', label: 'Exports' },
  { key: 'detached', label: 'Detached' },
]

// Section order matches how the note is worked on: what's in it, what feeds it, what
// came out of it, then what's been left behind.
const SECTIONS: { role: AssetRole; label: string; hint: string }[] = [
  { role: 'in_note', label: 'In the note', hint: 'Used in the note body right now' },
  { role: 'reference', label: 'Reference', hint: 'Kept alongside the note, not in it' },
  { role: 'export', label: 'Exports', hint: 'Produced from this note' },
  { role: 'detached', label: 'Detached', hint: 'Was in the note, no longer is' },
]

const KIND_ICONS: Record<string, React.ElementType> = {
  images: ImageIcon,
  video: Video,
  audio: Music,
  documents: FileText,
  archives: FileArchive,
  data: Braces,
}

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = KIND_ICONS[kind] ?? FileIcon
  return <Icon className={className} />
}

function shortDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

export default function AssetsPanel({
  assets,
  loading,
  error,
  noteId,
  canInsert,
  onUpload,
  onDelete,
  onUpdate,
  onInsert,
  onRefresh,
}: AssetsPanelProps) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formTitle, setFormTitle] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [alsoRemove, setAlsoRemove] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return assets.filter((a) => {
      if (filter !== 'all' && a.role !== filter) return false
      if (!needle) return true
      return (
        a.display_name.toLowerCase().includes(needle) ||
        (a.description ?? '').toLowerCase().includes(needle)
      )
    })
  }, [assets, search, filter])

  const totalBytes = assets.reduce((sum, a) => sum + (a.size_bytes ?? 0), 0)

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files)
    if (!list.length) return
    setUploading(true)
    setActionError(null)
    try {
      for (const file of list) {
        await onUpload(file)
      }
    } catch (e) {
      setActionError(assetErrorMessage(e, 'Upload failed'))
    } finally {
      setUploading(false)
    }
  }

  function openEdit(asset: NoteAsset) {
    setEditingId(asset.id)
    setFormTitle(asset.title ?? '')
    setFormDescription(asset.description ?? '')
    setDeleteConfirmId(null)
  }

  async function saveEdit(asset: NoteAsset) {
    setActionError(null)
    try {
      await onUpdate(asset.id, { title: formTitle.trim(), description: formDescription.trim() })
      setEditingId(null)
    } catch (e) {
      setActionError(assetErrorMessage(e, 'Could not save those details'))
    }
  }

  async function toggleAi(asset: NoteAsset) {
    setActionError(null)
    try {
      await onUpdate(asset.id, { ai_context: !asset.ai_context })
    } catch (e) {
      setActionError(assetErrorMessage(e, 'Could not change the AI context setting'))
    }
  }

  async function confirmDelete(asset: NoteAsset) {
    setActionError(null)
    try {
      await onDelete(asset, alsoRemove && asset.in_note)
      setDeleteConfirmId(null)
    } catch (e) {
      setActionError(assetErrorMessage(e, 'Could not delete that file'))
    }
  }

  if (!noteId) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center px-6">
        <p className="text-sm text-gray-400 text-center">Open a note to see its assets.</p>
      </div>
    )
  }

  return (
    <div
      className="flex-1 min-h-0 flex flex-col overflow-hidden"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files?.length) void handleFiles(e.dataTransfer.files)
      }}
    >
      {/* Toolbar */}
      <div className="shrink-0 px-3 pt-2 pb-1.5 space-y-1.5 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter assets…"
              className="w-full text-xs pl-7 pr-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
            />
          </div>
          <button className="btn-ghost p-1.5 shrink-0" title="Refresh" onClick={onRefresh}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            className="btn-ghost p-1.5 shrink-0 text-blue-500"
            title="Add a file to this note's assets"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <Upload className="w-4 h-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              // Copy out of the live FileList before clearing the input — resetting
              // value empties the list itself, not just the control.
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              if (files.length) void handleFiles(files)
            }}
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`text-[11px] px-1.5 py-0.5 rounded-full border transition-colors ${
                filter === f.key
                  ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400'
                  : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {(error || actionError) && (
        <div className="shrink-0 mx-3 mt-2 flex items-start gap-2 text-xs px-2 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span className="flex-1">{actionError || error}</span>
          {actionError && (
            <button onClick={() => setActionError(null)} title="Dismiss">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {dragOver && (
        <div className="shrink-0 mx-3 mt-2 text-xs text-center px-2 py-3 rounded-lg border-2 border-dashed border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400">
          Drop to add to this note's assets
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {visible.length === 0 && !loading && (
          <div className="px-4 py-8 text-sm text-gray-400 text-center">
            {assets.length === 0 ? (
              <>
                Nothing here yet. Files you add to the note appear automatically — or drop
                reference material here to keep it alongside the note without putting it in.
              </>
            ) : (
              <>No assets match that filter.</>
            )}
          </div>
        )}

        {SECTIONS.map((section) => {
          const rows = visible.filter((a) => a.role === section.role)
          if (!rows.length) return null
          return (
            <div key={section.role}>
              <div
                className="sticky top-0 z-10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm"
                title={section.hint}
              >
                {section.label} · {rows.length}
              </div>
              {rows.map((asset) => (
                <div
                  key={asset.id}
                  className="group px-3 py-2 border-b border-gray-50 dark:border-gray-800"
                >
                  <div className="flex items-start gap-2">
                    <div className="shrink-0 w-10 h-10 rounded-md overflow-hidden bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                      {asset.thumb_url ? (
                        <img src={asset.thumb_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <KindIcon kind={asset.kind} className="w-4 h-4 text-gray-400" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      {/* The name gets the row to itself: the panel is narrow and
                          resizable, and a badge beside it eats the filename first. */}
                      <div
                        className="text-xs font-medium text-gray-700 dark:text-gray-200 truncate"
                        title={asset.display_name}
                      >
                        {asset.display_name}
                      </div>
                      <div className="flex items-center gap-1 flex-wrap text-[11px] text-gray-400 dark:text-gray-500">
                        {asset.ai_context && (
                          <span className="text-[10px] px-1 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
                            AI
                          </span>
                        )}
                        {asset.missing && (
                          <span className="text-[10px] px-1 rounded bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400">
                            Missing
                          </span>
                        )}
                        {asset.role === 'detached' && !asset.missing && (
                          <span className="text-[10px] px-1 rounded bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-500">
                            Not in note
                          </span>
                        )}
                        <span className="truncate">
                          {formatBytes(asset.size_bytes ?? 0)} · {asset.kind} · {shortDate(asset.created_at)}
                        </span>
                      </div>
                      {asset.description && (
                        <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
                          {asset.description}
                        </div>
                      )}
                    </div>

                    <div className="shrink-0 flex items-center gap-0.5">
                      {asset.ai_eligible && !asset.missing && (
                        <button
                          className={`p-1 transition-opacity ${
                            asset.ai_context
                              ? 'text-blue-500'
                              : 'text-gray-300 dark:text-gray-600 hover:text-blue-500 opacity-0 group-hover:opacity-100'
                          }`}
                          title={asset.ai_context ? 'Stop sending to the assistant' : 'Use as AI context'}
                          onClick={() => void toggleAi(asset)}
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {!asset.in_note && canInsert && !asset.missing && (
                        <button
                          className="p-1 text-gray-300 dark:text-gray-600 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Insert into note"
                          onClick={() => onInsert(asset)}
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {!asset.missing && (
                        <a
                          href={asset.url}
                          download={asset.display_name}
                          className="p-1 text-gray-300 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Download"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                      )}
                      <button
                        className="p-1 text-gray-300 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Edit name and description"
                        onClick={() => openEdit(asset)}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        className="p-1 text-gray-300 dark:text-gray-600 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Delete"
                        onClick={() => {
                          setDeleteConfirmId(asset.id)
                          setAlsoRemove(true)
                          setEditingId(null)
                        }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {editingId === asset.id && (
                    <div className="mt-2 space-y-1.5">
                      <input
                        value={formTitle}
                        onChange={(e) => setFormTitle(e.target.value)}
                        placeholder={asset.original_name ?? asset.filename}
                        className="w-full text-xs px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                      />
                      <textarea
                        value={formDescription}
                        onChange={(e) => setFormDescription(e.target.value)}
                        placeholder="What is this file for?"
                        rows={2}
                        className="w-full text-xs px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 resize-none"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          className="text-xs px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 hover:bg-blue-200"
                          onClick={() => void saveEdit(asset)}
                        >
                          Save
                        </button>
                        <button
                          className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {deleteConfirmId === asset.id && (
                    <div className="mt-1.5 space-y-1.5">
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Delete <span className="font-medium">{asset.display_name}</span> permanently?
                        This removes the file from disk. Older versions of this note that used it
                        will show a missing item.
                      </p>
                      {asset.in_note && (
                        <label className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-500">
                          <input
                            type="checkbox"
                            checked={alsoRemove}
                            onChange={(e) => setAlsoRemove(e.target.checked)}
                            className="mt-0.5"
                          />
                          <span>
                            Also remove it from the note. It's still used here — leaving it in
                            would leave a broken item behind.
                          </span>
                        </label>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          className="text-xs px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-200"
                          onClick={() => void confirmDelete(asset)}
                        >
                          Delete
                        </button>
                        <button
                          className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                          onClick={() => setDeleteConfirmId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        })}

        <UnlinkedFilesSection noteId={noteId} onAdopted={onRefresh} />
      </div>

      {/* Footer */}
      <div className="shrink-0 px-3 py-1.5 border-t border-gray-100 dark:border-gray-700 text-[11px] text-gray-400 dark:text-gray-500">
        {uploading ? 'Uploading…' : `${assets.length} file${assets.length === 1 ? '' : 's'} · ${formatBytes(totalBytes)}`}
      </div>
    </div>
  )
}

/**
 * Account-wide orphan sweep, collapsed by default.
 *
 * Self-contained rather than props-driven like the rest of the panel: it is scoped to
 * the whole account rather than this note, and threading its three calls up through the
 * conversation panel would add props that nothing else uses. The scan is expensive
 * (it reads every note version the user has), so it only ever runs when asked for.
 */
function UnlinkedFilesSection({ noteId, onAdopted }: { noteId: string; onAdopted: () => void }) {
  const [open, setOpen] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [files, setFiles] = useState<UnlinkedFile[]>([])
  const [totalBytes, setTotalBytes] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [confirmName, setConfirmName] = useState<string | null>(null)

  // A scan is only true for the note list it was taken against; drop it on note change
  // rather than showing a stale result under a different note.
  useEffect(() => {
    setScanned(false)
    setFiles([])
    setTotalBytes(0)
  }, [noteId])

  async function scan() {
    setScanning(true)
    setError(null)
    try {
      const response = await assetsApi.scanUnlinked()
      setFiles(response.data.files)
      setTotalBytes(response.data.total_bytes)
      setScanned(true)
    } catch (e) {
      setError(assetErrorMessage(e, 'Could not scan for unlinked files'))
    } finally {
      setScanning(false)
    }
  }

  async function remove(filename: string) {
    setError(null)
    try {
      await assetsApi.deleteUnlinked(filename)
      setFiles((f) => f.filter((x) => x.filename !== filename))
      setConfirmName(null)
    } catch (e) {
      setError(assetErrorMessage(e, 'Could not delete that file'))
    }
  }

  async function adopt(filename: string) {
    setError(null)
    try {
      await assetsApi.adoptUnlinked(filename, noteId)
      setFiles((f) => f.filter((x) => x.filename !== filename))
      onAdopted()
    } catch (e) {
      setError(assetErrorMessage(e, 'Could not add that file to the note'))
    }
  }

  return (
    <div className="border-t border-gray-100 dark:border-gray-700 mt-2">
      <button
        className="w-full flex items-center gap-1 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Unlinked files
        {scanned && <span className="normal-case font-normal">· {files.length}</span>}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          <p className="text-[11px] text-gray-400 dark:text-gray-500">
            Media left on disk that no note, note version, avatar or theme still points at.
            Deleting one here frees the space for good.
          </p>

          {error && (
            <div className="text-xs px-2 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400">
              {error}
            </div>
          )}

          <button
            className="text-xs px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 disabled:opacity-50"
            onClick={() => void scan()}
            disabled={scanning}
          >
            {scanning ? 'Scanning…' : scanned ? 'Scan again' : 'Scan for unlinked files'}
          </button>

          {scanned && files.length === 0 && (
            <p className="text-xs text-gray-400">Nothing unlinked — no space to reclaim.</p>
          )}

          {files.length > 0 && (
            <>
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                {files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(totalBytes)} reclaimable
              </p>
              {files.map((file) => (
                <div key={file.filename} className="group flex items-center gap-2 py-1">
                  <KindIcon kind={file.kind} className="w-3.5 h-3.5 shrink-0 text-gray-400" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-gray-600 dark:text-gray-300 truncate">
                      {file.filename}
                    </div>
                    <div className="text-[10px] text-gray-400">
                      {formatBytes(file.size_bytes)} · {shortDate(file.modified_at)}
                    </div>
                  </div>
                  {confirmName === file.filename ? (
                    <>
                      <button
                        className="text-[11px] px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400"
                        onClick={() => void remove(file.filename)}
                      >
                        Delete
                      </button>
                      <button
                        className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                        onClick={() => setConfirmName(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="p-1 text-gray-300 dark:text-gray-600 hover:text-blue-500 transition-colors"
                        title="Add to this note's assets"
                        onClick={() => void adopt(file.filename)}
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                      <button
                        className="p-1 text-gray-300 dark:text-gray-600 hover:text-red-500 transition-colors"
                        title="Delete permanently"
                        onClick={() => setConfirmName(file.filename)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
