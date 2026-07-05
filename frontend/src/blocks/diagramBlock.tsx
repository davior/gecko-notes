import { useContext, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createReactBlockSpec } from '@blocknote/react'
import { Pencil, Network, Workflow } from 'lucide-react'
import { SharedLinkContext } from './sharedLinkContext'
import type { SharedReferrerState } from './noteReferrerState'
import DiagramCanvas from '@/components/diagram/DiagramCanvas'
import DiagramEditorModal from '@/components/diagram/DiagramEditorModal'
import {
  consumePendingOpen,
  diagramToDataUri,
  graphToFlow,
  parseGraph,
  type DiagramGraph,
  type DiagramKind,
} from '@/utils/diagram'

interface DiagramProps {
  diagramId: string
  kind: DiagramKind
  data: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  block: any
}

function DiagramView({ diagramId, kind, data, editor, block }: DiagramProps) {
  const graph = useMemo<DiagramGraph>(() => parseGraph(data, kind), [data, kind])
  const editable: boolean = editor?.isEditable ?? false

  if (editable) return <EditableDiagram diagramId={diagramId} graph={graph} editor={editor} block={block} />
  return <ReadOnlyDiagram graph={graph} />
}

// Editable surface: a static (non-interactive) preview inline in the note plus an
// "Edit" button that opens the interactive editor. Nothing interactive is mounted
// in the editable ProseMirror surface, which avoids the pointer-coordinate crash
// that nesting a live canvas would cause (see childNoteBlock.tsx for the rationale).
function EditableDiagram({
  diagramId,
  graph,
  editor,
  block,
}: {
  diagramId: string
  graph: DiagramGraph
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  block: any
}) {
  const [open, setOpen] = useState(false)

  // A freshly slash-inserted diagram opens its editor right away.
  useEffect(() => {
    if (consumePendingOpen(diagramId)) setOpen(true)
  }, [diagramId])

  const KindIcon = graph.kind === 'flowchart' ? Workflow : Network
  const empty = graph.nodes.length === 0

  function handleSave(next: DiagramGraph) {
    editor.updateBlock(block, { props: { data: JSON.stringify(next), kind: next.kind } })
  }

  return (
    <div
      className="my-2 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/40 overflow-hidden"
      style={{ width: '100%' }}
      contentEditable={false}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <KindIcon className="w-4 h-4 shrink-0 text-blue-500" />
        <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
          {graph.kind === 'flowchart' ? 'Flow chart' : 'Mind map'}
        </span>
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
        {empty ? (
          <span className="text-xs text-gray-400">Empty diagram — click to add nodes.</span>
        ) : (
          <img
            src={diagramToDataUri(graph)}
            alt="Diagram preview"
            style={{ maxWidth: '100%', height: 'auto', display: 'block', pointerEvents: 'none' }}
          />
        )}
      </button>

      {open && (
        <DiagramEditorModal initialGraph={graph} onSave={handleSave} onClose={() => setOpen(false)} />
      )}
    </div>
  )
}

// Read-only surface (shared view, history preview). Renders an interactive but
// non-editable canvas (pan/zoom) — safe because the surrounding editor is not
// editable. Node links are transformed: in the shared view a note link resolves to
// the linked note's shared page (or is disabled if that note isn't shared),
// mirroring noteReferenceBlock.
function ReadOnlyDiagram({ graph }: { graph: DiagramGraph }) {
  const navigate = useNavigate()
  const sharedLink = useContext(SharedLinkContext)

  const disabledNoteIds = useMemo(() => {
    if (!sharedLink) return undefined
    const set = new Set<string>()
    for (const n of graph.nodes) {
      if (n.noteId && !sharedLink.shareTokens[n.noteId]) set.add(n.noteId)
    }
    return set
  }, [graph, sharedLink])

  const flow = useMemo(() => graphToFlow(graph, { disabledNoteIds }), [graph, disabledNoteIds])

  function handleNodeClick(nodeId: string) {
    const node = graph.nodes.find((n) => n.id === nodeId)
    if (!node) return
    if (node.noteId) {
      if (sharedLink) {
        const token = sharedLink.shareTokens[node.noteId]
        if (token) {
          const state: SharedReferrerState = { fromToken: sharedLink.currentToken, fromTitle: sharedLink.currentTitle }
          navigate(`/shared/${token}`, { state })
        }
        return // never fall back to the private URL in the shared view
      }
      navigate(`/notes/${node.noteId}`)
      return
    }
    if (node.url) window.open(node.url, '_blank', 'noopener,noreferrer')
  }

  if (graph.nodes.length === 0) {
    return (
      <div className="my-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-3 text-xs text-gray-400" contentEditable={false}>
        Empty diagram.
      </div>
    )
  }

  return (
    <div
      className="my-2 w-full rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden bg-gray-50 dark:bg-gray-900"
      style={{ width: '100%' }}
      contentEditable={false}
    >
      <DiagramCanvas nodes={flow.nodes} edges={flow.edges} interactive={false} onNodeClick={handleNodeClick} height={360} />
    </div>
  )
}

// Custom BlockNote block holding an interactive diagram (mind map / flow chart).
// The graph lives in the `data` prop as a JSON string; `diagramId` is a stable id
// the AI can target to edit a specific diagram.
export const diagramBlock = createReactBlockSpec(
  {
    type: 'diagram',
    propSchema: {
      diagramId: { default: '' },
      kind: { default: 'mindmap' },
      data: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => (
      <DiagramView
        diagramId={props.block.props.diagramId}
        kind={(props.block.props.kind as DiagramKind) || 'mindmap'}
        data={props.block.props.data}
        editor={props.editor}
        block={props.block}
      />
    ),
  },
)()
