import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  addEdge,
  useEdgesState,
  useNodesState,
  MarkerType,
  type Connection,
  type Edge,
} from '@xyflow/react'
import { Plus, Trash2, Wand2, Maximize2, Minimize2, X, Link2, FileText, Network, Workflow, Check } from 'lucide-react'
import NotePickerModal from '@/components/NotePickerModal'
import DiagramCanvas from './DiagramCanvas'
import {
  autoLayout,
  flowToGraph,
  graphToFlow,
  newNodeId,
  type DiagramGraph,
  type DiagramKind,
  type FlowNode,
} from '@/utils/diagram'

interface Props {
  initialGraph: DiagramGraph
  onSave: (graph: DiagramGraph) => void
  onClose: () => void
}

export default function DiagramEditorModal({ initialGraph, onSave, onClose }: Props) {
  const seed = graphToFlow(initialGraph)
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(seed.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(seed.edges)
  const [kind, setKind] = useState<DiagramKind>(initialGraph.kind)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [showNotePicker, setShowNotePicker] = useState(false)

  // Persist edits back to the block (which triggers the note's autosave) shortly
  // after each change, and flush immediately on close. Skip the initial mount so
  // merely opening the editor doesn't mark the note dirty.
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    const t = setTimeout(() => onSaveRef.current(flowToGraph(nodes, edges, kind)), 400)
    return () => clearTimeout(t)
  }, [nodes, edges, kind])

  const onConnect = useCallback(
    (c: Connection) => setEdges((eds) => addEdge({ ...c, markerEnd: { type: MarkerType.ArrowClosed } }, eds)),
    [setEdges],
  )

  const selected = nodes.find((n) => n.id === selectedId) ?? null

  const patchSelected = useCallback(
    (patch: Partial<FlowNode['data']>) => {
      if (!selectedId) return
      setNodes((nds) =>
        nds.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n)),
      )
    },
    [selectedId, setNodes],
  )

  function addNode() {
    const id = newNodeId()
    const anchor = selected
    const pos = anchor ? { x: anchor.position.x + 220, y: anchor.position.y + 20 } : { x: 40, y: 40 }
    const node: FlowNode = {
      id,
      type: 'diagramNode',
      position: pos,
      data: { label: 'New node', linkKind: null, disabled: false },
      sourcePosition: seed.nodes[0]?.sourcePosition,
      targetPosition: seed.nodes[0]?.targetPosition,
    }
    setNodes((nds) => [...nds, node])
    if (anchor) {
      setEdges((eds) =>
        addEdge({ source: anchor.id, target: id, markerEnd: { type: MarkerType.ArrowClosed } } as Edge, eds),
      )
    }
    setSelectedId(id)
  }

  function deleteSelected() {
    if (!selectedId) return
    setEdges((eds) => eds.filter((e) => e.source !== selectedId && e.target !== selectedId))
    setNodes((nds) => nds.filter((n) => n.id !== selectedId))
    setSelectedId(null)
  }

  function relayout(nextKind: DiagramKind = kind) {
    const laid = autoLayout(flowToGraph(nodes, edges, nextKind))
    const flow = graphToFlow(laid)
    setNodes(flow.nodes)
    setEdges(flow.edges)
  }

  function changeKind(next: DiagramKind) {
    if (next === kind) return
    setKind(next)
    const laid = autoLayout(flowToGraph(nodes, edges, next))
    const flow = graphToFlow(laid)
    setNodes(flow.nodes)
    setEdges(flow.edges)
  }

  function handleClose() {
    onSaveRef.current(flowToGraph(nodes, edges, kind))
    onClose()
  }

  const panelStyle: React.CSSProperties = fullscreen
    ? { position: 'fixed', inset: 12, width: 'auto', height: 'auto', maxWidth: 'none' }
    : { width: 'min(1100px, 94vw)', height: 'min(760px, 88vh)' }

  return createPortal(
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center" onClick={handleClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden flex flex-col"
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-gray-700 flex-wrap">
          <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden">
            <button
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium ${kind === 'mindmap' ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
              onClick={() => changeKind('mindmap')}
            >
              <Network className="w-3.5 h-3.5" /> Mind map
            </button>
            <button
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border-l border-gray-200 dark:border-gray-600 ${kind === 'flowchart' ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
              onClick={() => changeKind('flowchart')}
            >
              <Workflow className="w-3.5 h-3.5" /> Flow chart
            </button>
          </div>

          <button className="btn-ghost flex items-center gap-1.5 px-2.5 py-1 text-xs" onClick={addNode}>
            <Plus className="w-3.5 h-3.5" /> Add node
          </button>
          <button className="btn-ghost flex items-center gap-1.5 px-2.5 py-1 text-xs" onClick={() => relayout()}>
            <Wand2 className="w-3.5 h-3.5" /> Auto-layout
          </button>

          <div className="ml-auto flex items-center gap-1">
            <button
              className="btn-ghost p-1.5"
              title={fullscreen ? 'Exit full screen' : 'Full screen'}
              onClick={() => setFullscreen((f) => !f)}
            >
              {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700"
              onClick={handleClose}
            >
              <Check className="w-3.5 h-3.5" /> Done
            </button>
            <button className="btn-ghost p-1.5" title="Close" onClick={handleClose}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body: canvas + inspector */}
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-w-0 bg-gray-50 dark:bg-gray-900">
            <DiagramCanvas
              nodes={nodes}
              edges={edges}
              interactive
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={setSelectedId}
              onPaneClick={() => setSelectedId(null)}
              height="100%"
            />
          </div>

          {/* Inspector */}
          <aside className="w-64 shrink-0 border-l border-gray-100 dark:border-gray-700 p-3 overflow-y-auto text-sm">
            {selected ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Label</label>
                  <input
                    value={(selected.data.label as string) ?? ''}
                    onChange={(e) => patchSelected({ label: e.target.value })}
                    className="w-full text-sm px-2 py-1.5 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 outline-none focus:border-blue-400"
                    placeholder="Node label"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Link to note</label>
                  {selected.data.noteId ? (
                    <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate flex-1">{(selected.data.noteTitle as string) || 'Untitled'}</span>
                      <button
                        className="text-gray-400 hover:text-gray-600"
                        title="Remove note link"
                        onClick={() => patchSelected({ noteId: undefined, noteTitle: undefined, linkKind: (selected.data.url ? 'url' : null) })}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 hover:border-blue-400 hover:text-blue-600"
                      onClick={() => setShowNotePicker(true)}
                    >
                      <FileText className="w-3.5 h-3.5" /> Pick a note…
                    </button>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Link to URL</label>
                  <div className="flex items-center gap-1.5">
                    <Link2 className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    <input
                      value={(selected.data.url as string) ?? ''}
                      onChange={(e) => {
                        const url = e.target.value
                        patchSelected({ url: url || undefined, linkKind: url ? 'url' : (selected.data.noteId ? 'note' : null) })
                      }}
                      className="w-full text-sm px-2 py-1.5 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 outline-none focus:border-blue-400"
                      placeholder="https://…"
                    />
                  </div>
                  {selected.data.noteId && selected.data.url ? (
                    <p className="text-[11px] text-gray-400 mt-1">A note link takes priority over the URL.</p>
                  ) : null}
                </div>

                <button
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 text-sm"
                  onClick={deleteSelected}
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete node
                </button>
              </div>
            ) : (
              <div className="text-xs text-gray-400 space-y-2">
                <p className="font-medium text-gray-500 dark:text-gray-400">No node selected</p>
                <p>Click a node to edit its label and links.</p>
                <p>Drag from a node's edge handle to another node to connect them.</p>
                <p>Select a node or edge and press Delete to remove it.</p>
              </div>
            )}
          </aside>
        </div>
      </div>

      {showNotePicker && (
        <NotePickerModal
          onSelect={(id, title) => {
            patchSelected({ noteId: id, noteTitle: title, linkKind: 'note' })
            setShowNotePicker(false)
          }}
          onClose={() => setShowNotePicker(false)}
        />
      )}
    </div>,
    document.body,
  )
}
