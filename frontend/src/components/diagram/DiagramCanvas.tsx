import { memo } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  type Edge,
  type NodeProps,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react'
import { Link2, FileText, Ban } from 'lucide-react'
import '@xyflow/react/dist/style.css'
import type { FlowNode } from '@/utils/diagram'

// Custom node: a rounded label box with an optional link affordance. Handles are
// placed to match the node's flow direction (left/right for mind maps, top/bottom
// for flow charts) so edges connect cleanly.
const DiagramNodeView = memo(function DiagramNodeView({
  data,
  sourcePosition,
  targetPosition,
  selected,
}: NodeProps<FlowNode>) {
  const linked = data.linkKind !== null
  const disabled = data.disabled
  const borderColor = disabled ? '#cbd5e1' : linked ? '#3b82f6' : selected ? '#6366f1' : '#cbd5e1'
  return (
    <div
      className="diagram-node"
      style={{
        width: 172,
        minHeight: 48,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 10,
        border: `1.5px solid ${borderColor}`,
        background: data.color || (disabled ? '#f1f5f9' : linked ? '#eff6ff' : '#ffffff'),
        color: disabled ? '#94a3b8' : linked ? '#1d4ed8' : '#0f172a',
        fontSize: 13,
        fontWeight: 500,
        textAlign: 'center',
        boxShadow: selected ? '0 0 0 2px rgba(99,102,241,0.35)' : 'none',
      }}
      title={disabled ? 'This note is not shared' : undefined}
    >
      <Handle type="target" position={targetPosition ?? Position.Left} style={{ opacity: 0.35 }} />
      {disabled ? (
        <Ban className="w-3.5 h-3.5 shrink-0" />
      ) : data.linkKind === 'note' ? (
        <FileText className="w-3.5 h-3.5 shrink-0" />
      ) : data.linkKind === 'url' ? (
        <Link2 className="w-3.5 h-3.5 shrink-0" />
      ) : null}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {data.label || 'Untitled'}
      </span>
      <Handle type="source" position={sourcePosition ?? Position.Right} style={{ opacity: 0.35 }} />
    </div>
  )
})

const nodeTypes = { diagramNode: DiagramNodeView }

interface Props {
  nodes: FlowNode[]
  edges: Edge[]
  interactive: boolean
  onNodesChange?: OnNodesChange<FlowNode>
  onEdgesChange?: OnEdgesChange
  onConnect?: OnConnect
  onNodeClick?: (nodeId: string) => void
  onPaneClick?: () => void
  height?: number | string
}

export default function DiagramCanvas({
  nodes,
  edges,
  interactive,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
  onPaneClick,
  height = 360,
}: Props) {
  return (
    <div style={{ width: '100%', height }} className="diagram-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={interactive ? onNodesChange : undefined}
        onEdgesChange={interactive ? onEdgesChange : undefined}
        onConnect={interactive ? onConnect : undefined}
        onNodeClick={(_e, node) => onNodeClick?.(node.id)}
        onPaneClick={() => onPaneClick?.()}
        nodesDraggable={interactive}
        nodesConnectable={interactive}
        elementsSelectable={interactive}
        panOnDrag
        zoomOnScroll
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        {interactive && <Controls showInteractive={false} />}
      </ReactFlow>
    </div>
  )
}
