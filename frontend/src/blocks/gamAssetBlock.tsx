import { useContext, useEffect, useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { AlertTriangle, Copy, Download, ExternalLink, FileText, Library, Loader2, RefreshCw } from 'lucide-react'
import { gamApi, gamErrorMessage, type GamAsset } from '@/api/gam'
import { useGamStore, type GamEntry } from '@/stores/gam'
import { EditorNoteContext } from './editorNoteContext'
import { SharedLinkContext } from './sharedLinkContext'

// A live link to one of the person's GAM assets. The block stores the asset id and what
// it is, never a file address: GAM's are signed for an hour, so the block asks for a
// fresh one whenever it is shown (`useGamStore.resolve`). "Copy into note" is the way
// out of that dependency, for a note that is shared, exported or read offline: it swaps
// the block for an ordinary Notes file block.

/** The ordinary block a copied file becomes, by GAM's asset type. */
export function copiedBlockFor(assetType: string, url: string, name: string) {
  switch (assetType) {
    case 'image':
      return { type: 'image' as const, props: { url, name, showPreview: true } }
    case 'video':
      return { type: 'videoFile' as const, props: { url, name } }
    case 'audio':
      return { type: 'audioFile' as const, props: { url, name } }
    default:
      return { type: 'file' as const, props: { url, name } }
  }
}

/** A clip plays only its window of the parent's file: a media fragment says which. */
export function playableUrl(asset: GamAsset): string {
  const url = asset.file_url || ''
  if (!url || asset.in_point == null) return url
  return `${url}#t=${asset.in_point}${asset.out_point != null ? `,${asset.out_point}` : ''}`
}

function Card({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ${
        muted
          ? 'border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400'
          : 'border-gray-200 dark:border-gray-700'
      }`}
    >
      {children}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

interface PanelProps {
  assetId: string
  name: string
  assetType: string
  onCopy: (url: string) => void
}

export function GamAssetPanel(props: PanelProps) {
  const { assetId } = props
  const shared = useContext(SharedLinkContext)
  const enabled = useGamStore((s) => s.enabled)
  const publicUrl = useGamStore((s) => s.publicUrl)
  const entry = useGamStore((s) => s.entries[assetId])
  const loadStatus = useGamStore((s) => s.loadStatus)
  const resolve = useGamStore((s) => s.resolve)

  useEffect(() => {
    // The public shared page has no session: asking would 401, and the shared axios
    // client answers a 401 by sending the reader to /login.
    if (shared || !assetId) return
    if (enabled === null) {
      void loadStatus()
      return
    }
    if (enabled) void resolve(assetId)
  }, [shared, assetId, enabled, loadStatus, resolve])

  // Ask again before the addresses lapse, for a note left open for a long time.
  useEffect(() => {
    if (shared || !enabled || entry?.state !== 'ready') return
    const wait = Math.max(5_000, entry.fetchedAt + 50 * 60 * 1000 - Date.now())
    const timer = setTimeout(() => void resolve(assetId, { force: true }), wait)
    return () => clearTimeout(timer)
  }, [shared, enabled, entry, assetId, resolve])

  return (
    <GamAssetView
      {...props}
      shared={!!shared}
      enabled={enabled}
      publicUrl={publicUrl}
      entry={entry}
      onRetry={() => void resolve(assetId, { force: true })}
    />
  )
}

interface ViewProps extends PanelProps {
  shared: boolean
  enabled: boolean | null
  publicUrl: string | null
  entry: GamEntry | undefined
  onRetry: () => void
}

/** What the block shows for a given state, apart from the store so it can be tested. */
export function GamAssetView({ assetId, name, assetType, onCopy, shared, enabled, publicUrl, entry, onRetry }: ViewProps) {
  const editorNote = useContext(EditorNoteContext)
  const [copying, setCopying] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const label = name || 'GAM asset'

  if (!assetId) {
    return (
      <Card muted>
        <Library className="w-4 h-4 shrink-0" />
        <span>GAM asset (none chosen)</span>
      </Card>
    )
  }

  if (shared) {
    // A reader of a shared note may not have GAM at all, so only say what is here.
    return (
      <Card muted>
        <Library className="w-4 h-4 shrink-0" />
        <span className="truncate">
          {label} <span className="text-xs">· {assetType} in the author's asset library</span>
        </span>
      </Card>
    )
  }

  if (enabled === false) {
    return (
      <Card muted>
        <Library className="w-4 h-4 shrink-0" />
        <span className="truncate">{label} · Notes is not connected to GAM</span>
      </Card>
    )
  }

  if (!entry || entry.state === 'loading' || enabled === null) {
    return (
      <Card muted>
        <Loader2 className="w-4 h-4 shrink-0 animate-spin" />
        <span className="truncate">{label}</span>
      </Card>
    )
  }

  if (entry.state === 'missing') {
    return (
      <Card muted>
        <AlertTriangle className="w-4 h-4 shrink-0 text-amber-500" />
        <span className="truncate">“{label}” is no longer in your GAM library.</span>
      </Card>
    )
  }

  if (entry.state === 'error') {
    return (
      <Card muted>
        <AlertTriangle className="w-4 h-4 shrink-0 text-amber-500" />
        <span className="truncate flex-1">{label} · {entry.message}</span>
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          <RefreshCw className="w-3 h-3" /> Retry
        </button>
      </Card>
    )
  }

  const asset = entry.asset
  const noteId = editorNote?.id || ''

  async function copy() {
    if (!noteId) return
    setCopying(true)
    setCopyError(null)
    try {
      const response = await gamApi.copyIntoNote(noteId, asset.id)
      onCopy(response.data.url)
    } catch (err) {
      setCopyError(gamErrorMessage(err, 'The file could not be copied into the note.'))
    } finally {
      setCopying(false)
    }
  }

  const actionClass =
    'flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100'

  return (
    <div className="my-2 group/gam">
      {asset.asset_type === 'image' && asset.file_url && (
        <img src={asset.file_url} alt={asset.name} className="max-w-full rounded-lg" loading="lazy" />
      )}
      {asset.asset_type === 'video' && asset.file_url && (
        <video controls preload="metadata" src={playableUrl(asset)} poster={asset.thumb_url || undefined}
          className="w-full max-w-2xl rounded-lg" />
      )}
      {asset.asset_type === 'audio' && asset.file_url && (
        <audio controls preload="metadata" src={playableUrl(asset)} className="w-full max-w-md" />
      )}
      {asset.asset_type === 'document' && (
        <Card>
          {asset.thumb_url ? (
            <img src={asset.thumb_url} alt="" className="w-12 h-16 object-cover rounded border border-gray-200 dark:border-gray-700" />
          ) : (
            <FileText className="w-8 h-8 shrink-0 text-gray-400" />
          )}
          <div className="min-w-0">
            <div className="font-medium truncate">{asset.name}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {[asset.file_format?.toUpperCase(), asset.size_bytes ? formatSize(asset.size_bytes) : null]
                .filter(Boolean).join(' · ')}
            </div>
          </div>
        </Card>
      )}
      {asset.missing && (
        <div className="text-xs text-amber-600 mt-1">GAM has this asset but its file is missing.</div>
      )}
      <div className="flex flex-wrap items-center gap-3 mt-1 text-xs text-gray-500 dark:text-gray-400">
        <span className="truncate max-w-xs" title={asset.credit || undefined}>
          <Library className="inline w-3 h-3 mr-1 -mt-0.5" />
          {asset.name}
          {asset.credit && <span> · {asset.credit}</span>}
        </span>
        <a href={asset.page_url || `${publicUrl}/a/${asset.id}`} target="_blank" rel="noreferrer" className={actionClass}>
          <ExternalLink className="w-3 h-3" /> Open in GAM
        </a>
        {asset.file_url && asset.asset_type === 'document' && (
          <a href={asset.file_url} target="_blank" rel="noreferrer" className={actionClass}>
            <Download className="w-3 h-3" /> Download
          </a>
        )}
        <button
          type="button"
          onClick={() => void copy()}
          disabled={!noteId || copying || asset.missing}
          title={noteId ? 'Copy the file into this note, for sharing, exports and offline reading' : 'Save the note first'}
          className={`${actionClass} disabled:opacity-50`}
        >
          {copying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Copy className="w-3 h-3" />} Copy into note
        </button>
      </div>
      {copyError && <div className="text-xs text-red-600 mt-1">{copyError}</div>}
    </div>
  )
}

export const gamAssetBlock = createReactBlockSpec(
  {
    type: 'gamAsset',
    propSchema: {
      assetId: { default: '' },
      name: { default: '' },
      assetType: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => (
      <div contentEditable={false} className="w-full">
        <GamAssetPanel
          assetId={props.block.props.assetId}
          name={props.block.props.name}
          assetType={props.block.props.assetType}
          onCopy={(url) =>
            props.editor.replaceBlocks(
              [props.block.id],
              [copiedBlockFor(props.block.props.assetType, url, props.block.props.name)] as never,
            )
          }
        />
      </div>
    ),
  },
)()
