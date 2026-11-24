import { useEffect, useRef, useState } from 'react'
import { FileText, Image as ImageIcon, Library, Loader2, Music, Plus, Search, Video, X, Copy } from 'lucide-react'
import { gamApi, gamErrorMessage, type GamAsset, type GamAssetType, type GamHit } from '@/api/gam'

const TYPES: { key: GamAssetType | null; label: string }[] = [
  { key: null, label: 'All' },
  { key: 'image', label: 'Images' },
  { key: 'video', label: 'Video' },
  { key: 'audio', label: 'Audio' },
  { key: 'document', label: 'Documents' },
]

function TypeIcon({ type, className }: { type: string; className?: string }) {
  if (type === 'image') return <ImageIcon className={className} />
  if (type === 'video') return <Video className={className} />
  if (type === 'audio') return <Music className={className} />
  return <FileText className={className} />
}

function duration(seconds: number | null): string | null {
  if (!seconds) return null
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** GAM's keyword snippets mark the matched words «like this». */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/)
  return (
    <p className="text-xs text-gray-400 line-clamp-2">
      {parts.map((part, i) =>
        part.startsWith('«') ? <mark key={i} className="bg-yellow-100 dark:bg-yellow-900/40 text-inherit">{part.slice(1, -1)}</mark> : part,
      )}
    </p>
  )
}

interface BrowserProps {
  /** Put the asset in the note as a live `gamAsset` block. */
  onInsert?: (asset: GamAsset) => void
  /** Copy the file into the note's own assets (the Assets panel offers this). */
  onCopy?: (asset: GamAsset) => Promise<void>
  autoFocus?: boolean
}

/** Search the person's GAM library and pick from it. */
export function GamBrowser({ onInsert, onCopy, autoFocus }: BrowserProps) {
  const [query, setQuery] = useState('')
  const [type, setType] = useState<GamAssetType | null>(null)
  const [hits, setHits] = useState<GamHit[]>([])
  const [semantic, setSemantic] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copying, setCopying] = useState<string | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Results arrive out of order when someone types quickly; only the latest may land.
  const requestId = useRef(0)

  async function run(q: string, t: GamAssetType | null) {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const result = await gamApi.search(q, t, 40)
      if (id !== requestId.current) return
      setHits(result.data)
      setSemantic(result.semantic || !q)
    } catch (err) {
      if (id !== requestId.current) return
      setHits([])
      setError(gamErrorMessage(err))
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }

  useEffect(() => {
    void run('', null)
    return () => { if (debounce.current) clearTimeout(debounce.current) }
  }, [])

  function onQuery(q: string) {
    setQuery(q)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void run(q, type), 300)
  }

  function onType(t: GamAssetType | null) {
    setType(t)
    void run(query, t)
  }

  async function copy(asset: GamAsset) {
    if (!onCopy) return
    setCopying(asset.id)
    setError(null)
    try {
      await onCopy(asset)
    } catch (err) {
      setError(gamErrorMessage(err, 'The file could not be copied into the note.'))
    } finally {
      setCopying(null)
    }
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-gray-700">
        <Search className="w-4 h-4 text-gray-400 shrink-0" />
        <input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search your GAM library…"
          className="flex-1 text-sm bg-transparent outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400"
        />
        {loading && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
      </div>
      <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-gray-100 dark:border-gray-700">
        {TYPES.map((t) => (
          <button
            key={t.label}
            type="button"
            onClick={() => onType(t.key)}
            className={`px-2 py-0.5 rounded-full text-xs ${
              type === t.key
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {error && <p className="text-sm text-red-600 px-4 py-3">{error}</p>}
        {!semantic && !error && query && (
          <p className="text-xs text-gray-400 px-4 pt-2">Matched by keywords only: GAM's search by meaning is not available.</p>
        )}
        {!loading && !error && hits.length === 0 && (
          <p className="text-sm text-gray-400 px-4 py-6 text-center">
            {query ? 'Nothing in your library matches.' : 'Your GAM library is empty.'}
          </p>
        )}
        <ul className="divide-y divide-gray-100 dark:divide-gray-700">
          {hits.map(({ asset, snippet, page_label }) => (
            <li key={asset.id} className="flex items-center gap-3 px-3 py-2">
              <div className="w-14 h-14 shrink-0 rounded bg-gray-100 dark:bg-gray-700 overflow-hidden flex items-center justify-center">
                {asset.thumb_url
                  ? <img src={asset.thumb_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                  : <TypeIcon type={asset.asset_type} className="w-6 h-6 text-gray-400" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{asset.name}</p>
                <p className="text-xs text-gray-400 truncate">
                  {[asset.asset_type, duration(asset.duration_seconds), page_label].filter(Boolean).join(' · ')}
                </p>
                {snippet && <Snippet text={snippet} />}
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                {onInsert && (
                  <button type="button" onClick={() => onInsert(asset)} disabled={asset.missing}
                    className="btn-ghost text-xs flex items-center gap-1 px-2 py-1 disabled:opacity-50"
                    title="Insert into the note as a live link to GAM">
                    <Plus className="w-3 h-3" /> Insert
                  </button>
                )}
                {onCopy && (
                  <button type="button" onClick={() => void copy(asset)} disabled={asset.missing || copying !== null}
                    className="btn-ghost text-xs flex items-center gap-1 px-2 py-1 disabled:opacity-50"
                    title="Copy the file into this note's assets">
                    {copying === asset.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Copy className="w-3 h-3" />} Copy
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** The `/GAM` slash command's dialog. */
export function GamPickerModal({ onSelect, onClose }: { onSelect: (asset: GamAsset) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 dark:border-gray-700">
          <Library className="w-4 h-4 text-gray-400" />
          <span className="flex-1 text-sm font-medium text-gray-900 dark:text-gray-100">Insert from GAM</span>
          <button className="btn-ghost p-1" onClick={onClose} aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <GamBrowser onInsert={onSelect} autoFocus />
      </div>
    </div>
  )
}

/** The block a picked asset becomes. */
export function gamAssetBlockFor(asset: GamAsset) {
  return { type: 'gamAsset' as const, props: { assetId: asset.id, name: asset.name, assetType: asset.asset_type } }
}
