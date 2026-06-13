import { useState, useCallback, useContext, createContext } from 'react'
import { useNavigate } from 'react-router-dom'
import { createReactBlockSpec } from '@blocknote/react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { BlockNoteSchema, defaultBlockSpecs, type PartialBlock } from '@blocknote/core'
import { ChevronRight, ChevronDown, FileText, ExternalLink, Repeat } from 'lucide-react'
import { notesApi } from '@/api/notes'

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

// Read-only embedded render of the child note's content. Created lazily (only
// when the panel is expanded) so collapsed children cost nothing. Uses the full
// note schema so nested child-note blocks render too. `noteSchema` is defined
// below in this module and resolved at render time.
function ChildNotePreview({ content, chain }: { content: string; chain: string[] }) {
  const editor = useCreateBlockNote({
    schema: noteSchema,
    initialContent: parseContent(content) as never,
  })
  // Propagate the ancestor chain so nested child blocks can detect cycles.
  return (
    <ChildNoteChainContext.Provider value={chain}>
      <BlockNoteView editor={editor} editable={false} />
    </ChildNoteChainContext.Provider>
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

  const toggle = useCallback(async () => {
    if (isCircular) return
    const next = !open
    setOpen(next)
    if (next && content === null && !error) {
      setLoading(true)
      try {
        const res = await notesApi.get(childNoteId)
        setContent(res.data.content)
        if (res.data.title) setDisplayTitle(res.data.title)
      } catch {
        setError(true)
      } finally {
        setLoading(false)
      }
    }
  }, [open, content, error, childNoteId])

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
          className="shrink-0 flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
          title="Open child note"
          onClick={() => navigate(`/notes/${childNoteId}`)}
        >
          <ExternalLink className="w-3.5 h-3.5" /> Open
        </button>
      </div>
      {open && !isCircular && (
        <div className="border-t border-gray-200 dark:border-gray-700 px-2 py-1 bg-white/50 dark:bg-gray-900/30">
          {loading ? (
            <p className="text-xs text-gray-400 px-2 py-3">Loading…</p>
          ) : error ? (
            <p className="text-xs text-gray-400 px-2 py-3">Embedded note unavailable.</p>
          ) : content !== null ? (
            <ChildNotePreview content={content} chain={[...chain, childNoteId]} />
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
  },
})
