import { useContext } from 'react'
import { useNavigate } from 'react-router-dom'
import { createReactBlockSpec } from '@blocknote/react'
import { FileText, ArrowRight } from 'lucide-react'
import { SharedLinkContext } from './sharedLinkContext'
import { EditorNoteContext } from './editorNoteContext'
import type { EditorReferrerState, SharedReferrerState } from './noteReferrerState'

function NoteReferencePanel({ noteId, noteTitle }: { noteId: string; noteTitle: string }) {
  const navigate = useNavigate()
  const sharedLink = useContext(SharedLinkContext)
  const editorNote = useContext(EditorNoteContext)

  if (!noteId) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-gray-400 text-sm select-none">
        <FileText className="w-4 h-4 shrink-0" />
        <span>Note reference (no note selected)</span>
      </div>
    )
  }

  // In the public shared view, only link to the referenced note when it is
  // also shared (and then to its shared page, never the private edit URL).
  const sharedToken = sharedLink?.shareTokens[noteId]
  const unavailable = !!sharedLink && !sharedToken

  function handleClick() {
    if (sharedLink) {
      if (sharedToken) {
        // Carry along where we navigated from so the referenced note's shared
        // page can offer a link back — only present for this in-app click, not
        // for a direct visit/refresh of the referenced note's URL.
        const state: SharedReferrerState = { fromToken: sharedLink.currentToken, fromTitle: sharedLink.currentTitle }
        navigate(`/shared/${sharedToken}`, { state })
      }
      return
    }
    const state: EditorReferrerState | undefined = editorNote
      ? { fromNoteId: editorNote.id, fromTitle: editorNote.title }
      : undefined
    navigate(`/notes/${noteId}`, { state })
  }

  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm select-none max-w-full transition-colors ${
        unavailable
          ? 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-400 cursor-default'
          : 'border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900/50'
      }`}
      onClick={handleClick}
      title={unavailable ? 'This note is not shared' : undefined}
    >
      <FileText className="w-4 h-4 shrink-0" />
      <span className="truncate">{noteTitle || 'Untitled'}</span>
      {!unavailable && <ArrowRight className="w-3.5 h-3.5 shrink-0 opacity-60" />}
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
)()
