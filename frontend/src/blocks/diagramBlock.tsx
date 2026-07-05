import { useContext, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createReactBlockSpec } from '@blocknote/react'
import { Pencil, Network, Workflow, GitBranch } from 'lucide-react'
import { SharedLinkContext } from './sharedLinkContext'
import type { SharedReferrerState } from './noteReferrerState'
import MermaidView, { type NoteLinkResolution } from '@/components/diagram/MermaidView'
import DiagramEditorModal from '@/components/diagram/DiagramEditorModal'
import { consumePendingOpen, detectMermaidKind, DIAGRAM_KIND_LABELS } from '@/utils/diagram'

interface DiagramProps {
  diagramId: string
  source: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  block: any
}

function DiagramView({ diagramId, source, editor, block }: DiagramProps) {
  const editable: boolean = editor?.isEditable ?? false
  if (editable) return <EditableDiagram diagramId={diagramId} source={source} editor={editor} block={block} />
  return <ReadOnlyDiagram source={source} />
}

const KIND_ICONS = { mindmap: Network, flowchart: Workflow } as const

// Editable surface: a non-interactive preview inline in the note plus an "Edit" button
// that opens the interactive editor. Nothing pointer-interactive is mounted in the
// editable ProseMirror surface (the whole preview has pointer-events:none via MermaidView,
// and the wrapping button captures the click), avoiding the pointer-coordinate crash that
// nesting a live interactive surface would cause (see childNoteBlock.tsx for the rationale).
function EditableDiagram({
  diagramId,
  source,
  editor,
  block,
}: {
  diagramId: string
  source: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  block: any
}) {
  const [open, setOpen] = useState(false)
  const kind = useMemo(() => detectMermaidKind(source), [source])

  // A freshly slash-inserted diagram opens its editor right away.
  useEffect(() => {
    if (consumePendingOpen(diagramId)) setOpen(true)
  }, [diagramId])

  const KindIcon = KIND_ICONS[kind as keyof typeof KIND_ICONS] ?? GitBranch

  function handleSave(nextSource: string) {
    editor.updateBlock(block, { props: { source: nextSource } })
  }

  return (
    <div
      className="my-2 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/40 overflow-hidden"
      style={{ width: '100%' }}
      contentEditable={false}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <KindIcon className="w-4 h-4 shrink-0 text-blue-500" />
        <span className="text-sm font-medium text-gray-800 dark:text-gray-100">{DIAGRAM_KIND_LABELS[kind]}</span>
        <button
          className="ml-auto flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 border border-blue-200 dark:border-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/30 px-2.5 py-1 rounded-full transition-colors"
          onClick={() => setOpen(true)}
        >
          <Pencil className="w-3.5 h-3.5" /> Edit
        </button>
      </div>
      <button
        type="button"
        className="block w-full text-left px-3 py-3"
        style={{ pointerEvents: 'auto' }}
        onClick={() => setOpen(true)}
        title="Edit diagram"
      >
        <MermaidView source={source} interactive={false} />
      </button>

      {open && (
        <DiagramEditorModal initialSource={source} onSave={handleSave} onClose={() => setOpen(false)} />
      )}
    </div>
  )
}

// Read-only surface (shared view, version-history preview). Node links are transformed:
// in the shared view a note link resolves to the linked note's shared page (or a disabled
// state if that note isn't shared), mirroring noteReferenceBlock.
function ReadOnlyDiagram({ source }: { source: string }) {
  const navigate = useNavigate()
  const sharedLink = useContext(SharedLinkContext)

  const resolveNoteLink = (noteId: string): NoteLinkResolution => {
    if (sharedLink) {
      const token = sharedLink.shareTokens[noteId]
      if (!token) return { disabled: true, title: 'This note is not shared' }
      return {
        disabled: false,
        onClick: () => {
          const state: SharedReferrerState = { fromToken: sharedLink.currentToken, fromTitle: sharedLink.currentTitle }
          navigate(`/shared/${token}`, { state })
        },
      }
    }
    return { disabled: false, onClick: () => navigate(`/notes/${noteId}`) }
  }

  return (
    <div
      className="my-2 w-full rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden bg-gray-50 dark:bg-gray-900"
      style={{ width: '100%' }}
      contentEditable={false}
    >
      <MermaidView source={source} interactive resolveNoteLink={resolveNoteLink} minHeight={120} />
    </div>
  )
}

// Custom BlockNote block holding a Mermaid diagram. `source` is the raw Mermaid text;
// `diagramId` is a stable id the AI can target to edit a specific diagram. Kind is never
// stored — always derived from the source (see detectMermaidKind in utils/diagram.ts).
export const diagramBlock = createReactBlockSpec(
  {
    type: 'diagram',
    propSchema: {
      diagramId: { default: '' },
      source: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => (
      <DiagramView
        diagramId={props.block.props.diagramId}
        source={props.block.props.source}
        editor={props.editor}
        block={props.block}
      />
    ),
  },
)()
