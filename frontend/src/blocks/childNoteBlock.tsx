import { useState, useCallback, useContext, createContext } from 'react'
import { useNavigate } from 'react-router-dom'
import { createReactBlockSpec } from '@blocknote/react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteSchema, defaultBlockSpecs, type PartialBlock } from '@blocknote/core'
import { ChevronRight, ChevronDown, FileText, ExternalLink, Repeat } from 'lucide-react'
import { notesApi } from '@/api/notes'
import { sharedApi } from '@/api/shared'
import { noteReferenceBlock } from './noteReferenceBlock'
import { audioBlock } from './audioBlock'
import { SharedLinkContext } from './sharedLinkContext'

// Tracks the chain of child-note ids currently being rendered so an embed that
// references one of its own ancestors is shown as a circular reference instead
// of recursing forever.
export const ChildNoteChainContext = createContext<string[]>([])

function parseContent(content: string): PartialBlock[] {
  try {
    const blocks = JSON.parse(content)
    return Array.isArray(blocks) && blocks.length > 0 ? (blocks as PartialBlock[]) : [{ type: 'paragraph' }]
  } catch {
    return [{ type: 'paragraph' }]
  }
}

// Read-only embedded render of the child note's content. Rendered as STATIC
// HTML (via blocksToFullHTML) rather than a nested live BlockNoteView: nesting
// an editor inside the parent's editable editor breaks the parent's pointer
// features (hovering the nested editor makes the parent's drag-handle/side-menu
// call posAtCoords, which lands in the child editor's DOM, maps to an invalid
// position, and throws — wiping the whole parent note). Static HTML has no
// ProseMirror instance, so there's nothing for the parent to collide with.
function ChildNotePreview({ content }: { content: string }) {
  // The editor instance is used only to serialize blocks -> HTML; it is never
  // mounted as a BlockNoteView, so it never participates in the DOM/event tree.
  const editor = useCreateBlockNote({ schema: noteSchema })
  let html = ''
  try {
    html = editor.blocksToFullHTML(parseContent(content) as never)
  } catch {
    html = ''
  }
  if (!html) {
    return <div className="text-xs text-gray-400 px-2 py-3">No preview available.</div>
  }
  return (
    <div
      className="child-note-preview text-sm text-gray-800 dark:text-gray-100 px-1 py-1"
      style={{ pointerEvents: 'none' }}
      // First-party content, serialized by BlockNote's own HTML exporter.
      // Static HTML is read-only and not part of the parent editor's interaction
      // surface, so disable pointer events to prevent the parent's hover handlers
      // from trying to resolve coordinates inside this DOM (which would fail
      // since it's not part of the parent's document model).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

interface PanelProps {
  childNoteId: string
  title: string
}

function ChildNotePanel({ childNoteId, title }: PanelProps) {
  const navigate = useNavigate()
  const chain = useContext(ChildNoteChainContext)
  const isCircular = chain.includes(childNoteId)
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [displayTitle, setDisplayTitle] = useState(title)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)

  // In the public shared view, only load/link to the child note when it is
  // also shared — otherwise there's no accessible (unauthenticated) way to
  // fetch it, and it must never fall back to the private edit URL.
  const sharedLink = useContext(SharedLinkContext)
  const sharedToken = sharedLink?.shareTokens[childNoteId]
  const unavailable = !!sharedLink && !sharedToken

  const toggle = useCallback(async () => {
    if (isCircular) return
    const next = !open
    setOpen(next)
    if (next && content === null && !error) {
      if (unavailable) {
        setError(true)
        return
      }
      setLoading(true)
      try {
        if (sharedLink && sharedToken) {
          const res = await sharedApi.get(sharedToken)
          setContent(res.data.content)
          if (res.data.title) setDisplayTitle(res.data.title)
        } else {
          const res = await notesApi.get(childNoteId)
          setContent(res.data.content)
          if (res.data.title) setDisplayTitle(res.data.title)
        }
      } catch {
        setError(true)
      } finally {
        setLoading(false)
      }
    }
  }, [open, content, error, childNoteId, sharedLink, sharedToken, unavailable])

  function handleOpenClick() {
    if (sharedLink) {
      if (sharedToken) navigate(`/shared/${sharedToken}`)
      return
    }
    navigate(`/notes/${childNoteId}`)
  }

  return (
    <div
      className="my-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/40 overflow-hidden"
      contentEditable={false}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left text-sm font-medium text-gray-800 dark:text-gray-100 disabled:cursor-default"
          onClick={toggle}
          disabled={isCircular}
        >
          {isCircular
            ? <Repeat className="w-4 h-4 shrink-0 text-amber-500" />
            : open
              ? <ChevronDown className="w-4 h-4 shrink-0 text-gray-400" />
              : <ChevronRight className="w-4 h-4 shrink-0 text-gray-400" />}
          <FileText className="w-4 h-4 shrink-0 text-blue-500" />
          <span className="truncate">{displayTitle || 'Untitled'}</span>
          {isCircular && <span className="text-xs text-amber-500 shrink-0">(circular reference)</span>}
        </button>
        <button
          className="shrink-0 flex items-center text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 disabled:text-gray-300 dark:disabled:text-gray-600 disabled:cursor-default"
          title={unavailable ? 'This note is not shared' : 'Open child note'}
          onClick={handleOpenClick}
          disabled={unavailable}
        >
          <ExternalLink className="w-4 h-4" />
        </button>
      </div>
      {open && !isCircular && (
        <div className="border-t border-gray-200 dark:border-gray-700 px-2 py-1 bg-white/50 dark:bg-gray-900/30">
          {loading ? (
            <p className="text-xs text-gray-400 px-2 py-3">Loading…</p>
          ) : error ? (
            <p className="text-xs text-gray-400 px-2 py-3">Embedded note unavailable.</p>
          ) : content !== null ? (
            <ChildNotePreview content={content} />
          ) : null}
        </div>
      )}
    </div>
  )
}

// Custom BlockNote block that references a child note by id. Stores only the id
// and a cached title; the content is fetched on expand.
export const childNoteBlock = createReactBlockSpec(
  {
    type: 'childNote',
    propSchema: {
      childNoteId: { default: '' },
      title: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => (
      <ChildNotePanel
        childNoteId={props.block.props.childNoteId}
        title={props.block.props.title}
      />
    ),
  },
)

// Shared editor schema: the default blocks plus the childNote block. Apply this
// to every useCreateBlockNote call so notes containing child blocks render
// everywhere (editor, shared view, history preview, nested previews).
export const noteSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    childNote: childNoteBlock,
    noteReference: noteReferenceBlock,
    audioFile: audioBlock,
  },
})
