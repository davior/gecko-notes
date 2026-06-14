import { useNavigate } from 'react-router-dom'
import { createReactBlockSpec } from '@blocknote/react'
import { FileText, ArrowRight } from 'lucide-react'

function NoteReferencePanel({ noteId, noteTitle }: { noteId: string; noteTitle: string }) {
  const navigate = useNavigate()

  if (!noteId) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-gray-400 text-sm select-none">
        <FileText className="w-4 h-4 shrink-0" />
        <span>Note reference (no note selected)</span>
      </div>
    )
  }

  return (
    <div
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-sm cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors select-none max-w-full"
      onClick={() => navigate(`/notes/${noteId}`)}
    >
      <FileText className="w-4 h-4 shrink-0" />
      <span className="truncate">{noteTitle || 'Untitled'}</span>
      <ArrowRight className="w-3.5 h-3.5 shrink-0 opacity-60" />
    </div>
  )
}

export const noteReferenceBlock = createReactBlockSpec(
  {
    type: 'noteReference',
    propSchema: {
      noteId: { default: '' },
      noteTitle: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => (
      <NoteReferencePanel
        noteId={props.block.props.noteId}
        noteTitle={props.block.props.noteTitle}
      />
    ),
  },
)
