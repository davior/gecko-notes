import { useState, useEffect, useRef, useCallback, Component } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { processCiteTags } from '@/utils/markdown'
import type { ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams, useLocation, Link } from 'react-router-dom'
import { ArrowLeft, Printer, Trash2, History, ArrowUp, Send, X, Pin, Link2, MessageSquareText, Tag, Sparkles, Network, Workflow, MessagesSquare, Box, Waypoints, Database, CalendarRange, PieChart, Milestone, Video as VideoIcon, Image as ImageIcon, Info, FolderInput, Search, Clapperboard } from 'lucide-react'
import UserAvatar from '@/components/UserAvatar'
import NoteHistoryModal from '@/components/NoteHistoryModal'
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems, FormattingToolbar, FormattingToolbarController, getFormattingToolbarItems, useComponentsContext, type DefaultReactSuggestionItem } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import '@blocknote/core/fonts/inter.css'
import { filterSuggestionItems, type PartialBlock } from '@blocknote/core'
import { noteSchema, ChildNoteChainContext } from '@/blocks/childNoteBlock'
import { EditorNoteContext } from '@/blocks/editorNoteContext'
import type { EditorReferrerState } from '@/blocks/noteReferrerState'

import CategoryPicker from '@/components/CategoryPicker'
import TagChip from '@/components/TagChip'
import MetaFlyout from '@/components/MetaFlyout'
import ExportMenu from '@/components/ExportMenu'
import ShareMenu from '@/components/ShareMenu'
import FolderPickerModal from '@/components/FolderPickerModal'
import FolderBreadcrumb from '@/components/FolderBreadcrumb'
import AIConversationPanel from '@/components/AIConversationPanel'
import TTSPlaybackControls from '@/components/TTSPlaybackControls'
import NotePickerModal from '@/components/NotePickerModal'
import { starterFor, newDiagramId, markPendingOpen, renderMermaid, type DiagramKind } from '@/utils/diagram'
import AnnotationLayer from '@/components/AnnotationLayer'
import DocumentOutline from '@/components/DocumentOutline'
import VideoRecorderModal from '@/components/VideoRecorderModal'
import ImageGenModal from '@/components/ImageGenModal'
import VideoGenModal from '@/components/VideoGenModal'
import ActivityIndicator from '@/components/ActivityIndicator'
import NoteStatsModal from '@/components/NoteStatsModal'
import FindReplaceBar from '@/components/FindReplaceBar'

import { useNotesStore } from '@/stores/notes'
import { useAssetsStore } from '@/stores/assets'
import { useCategoriesStore } from '@/stores/categories'
import { useSettingsStore } from '@/stores/settings'
import { useActivityStore } from '@/stores/activity'
import type { ActivityJob } from '@/api/activity'
import type { RenderOptions } from '@/api/videoGen'
import { mediaApi } from '@/api/media'
import { settingsApi } from '@/api/settings'
import { transcriptionApi } from '@/api/transcription'
import { notesApi, configApi, type Note } from '@/api/notes'
import { foldersApi, type Folder } from '@/api/folders'
import { annotationsApi, type Annotation } from '@/api/annotations'
import { useDictation, type DictationMode } from '@/hooks/useDictation'
import { useTextToSpeech } from '@/hooks/useTextToSpeech'
import { extractPlainText } from '@/utils/blocks'
import { noteToMarkdownBody, svgToPngData } from '@/utils/export'
import { ARCHIVE_SYSTEM_KEY } from '@/utils/folderTree'

const EMPTY_DOCUMENT: PartialBlock[] = [{ type: 'paragraph' }]

function formatDate(dateStr: string): string {
  // Timestamps are UTC; toLocaleString renders them in the viewer's local timezone.
  return new Date(dateStr).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function parseNoteContent(content: string): PartialBlock[] {
  try {
    const blocks = JSON.parse(content)
    return Array.isArray(blocks) && blocks.length > 0 ? blocks as PartialBlock[] : EMPTY_DOCUMENT
  } catch {
    return EMPTY_DOCUMENT
  }
}

function extractChildNoteIds(blocks: unknown[]): string[] {
  const ids: string[] = []
  function walk(b: unknown) {
    if (typeof b !== 'object' || b === null) return
    const rec = b as Record<string, unknown>
    if (rec.type === 'childNote' && typeof rec.props === 'object' && rec.props !== null) {
      const id = (rec.props as Record<string, unknown>).childNoteId
      if (typeof id === 'string') ids.push(id)
    }
    if (Array.isArray(rec.children)) {
      for (const child of rec.children) walk(child)
    }
  }
  for (const block of blocks) walk(block)
  return ids
}

class EditorErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  render() {
    if (this.state.hasError)
      return <div className="p-8 text-gray-500 text-sm">This note could not be rendered. The content may be corrupted.</div>
    return this.props.children
  }
}

// Custom formatting-toolbar button (appears in the popup when text is selected)
// that moves the current selection into a new child note. Must be rendered
// inside the BlockNoteView so useComponentsContext resolves the styled button.
function SendToChildToolbarButton({ onClick }: { onClick: () => void }) {
  const Components = useComponentsContext()!
  return (
    <Components.FormattingToolbar.Button
      mainTooltip="Send selection to child note"
      label="Send to child"
      onClick={onClick}
    >
      <Send className="w-4 h-4" />
    </Components.FormattingToolbar.Button>
  )
}

// Custom formatting-toolbar button that attaches an annotation to the current block.
function AnnotateToolbarButton({ onClick }: { onClick: () => void }) {
  const Components = useComponentsContext()!
  return (
    <Components.FormattingToolbar.Button
      mainTooltip="Annotate this block"
      label="Annotate"
      onClick={onClick}
    >
      <MessageSquareText className="w-4 h-4" />
    </Components.FormattingToolbar.Button>
  )
}

export default function EditorView() {
  const navigate = useNavigate()
  const { id: noteId } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const location = useLocation()
  // Set only when this note was reached by clicking a noteReference block
  // (see noteReferenceBlock.tsx); absent on a direct visit/refresh of this URL.
  const referrer = location.state as EditorReferrerState | undefined
  const isNew = !noteId
  // When creating a note from inside a folder view, the FAB carries ?folder=<id>
  // so the new note is created directly in that folder.
  const initialFolderId = useRef<string | null>(searchParams.get('folder'))

  const notesStore = useNotesStore()
  const categoriesStore = useCategoriesStore()
  const settingsStore = useSettingsStore()

  const [note, setNote] = useState<Note | null>(null)
  const [title, setTitle] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [newTagInput, setNewTagInput] = useState('')
  const [parentNoteTitle, setParentNoteTitle] = useState('')
  const [folderBreadcrumb, setFolderBreadcrumb] = useState<Folder[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saveStatus, setSaveStatus] = useState('All changes saved')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showOrphanConfirm, setShowOrphanConfirm] = useState(false)
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [showNotePicker, setShowNotePicker] = useState(false)
  const [showVideoRecorder, setShowVideoRecorder] = useState(false)
  const [showImageGen, setShowImageGen] = useState(false)
  const [showVideoGen, setShowVideoGen] = useState(false)
  const [diagramImages, setDiagramImages] = useState<Record<string, string>>({})
  const [showHistory, setShowHistory] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findShowReplace, setFindShowReplace] = useState(false)
  const [snapshotIntervalMs, setSnapshotIntervalMs] = useState(5 * 60 * 1000)
  const [toastMessage, setToastMessage] = useState('')
  const [suggestedTags, setSuggestedTags] = useState<string[]>([])
  const [generatingMetadata, setGeneratingMetadata] = useState(false)
  const [summary, setSummary] = useState<string>('')
  // Bumped to pop the tags flyout open (e.g. to surface freshly generated suggestions).
  const [tagFlyoutSignal, setTagFlyoutSignal] = useState(0)
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('ai-panel-open') !== 'false' } catch { return true }
  })
  // Whether the TTS/dictation controls are docked into the bottom status bar
  // (vs. floating). Remembered across notes/sessions in localStorage.
  const [ttsDocked, setTtsDocked] = useState<boolean>(() => {
    try { return localStorage.getItem('tts-controls-docked') === 'true' } catch { return false }
  })
  // When on, pressing Play also saves the synthesized audio and inserts it as an
  // audio object at the top of the note. Remembered across notes/sessions.
  const [ttsInsertMode, setTtsInsertMode] = useState<boolean>(() => {
    try { return localStorage.getItem('tts-insert-mode') === 'true' } catch { return false }
  })
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [openAnnotationId, setOpenAnnotationId] = useState<string | null>(null)
  const annotationContainerRef = useRef<HTMLDivElement>(null)
  const editorScrollRef = useRef<HTMLDivElement>(null)

  const titleRef = useRef<HTMLTextAreaElement>(null)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const createdNoteId = useRef<string | null>(null)
  const currentNoteContent = useRef('')
  const hasPendingChanges = useRef(false)
  const dirtySinceSnapshot = useRef(false)
  const blurTimestamp = useRef<number | null>(null)
  const isSaving = useRef(false)
  // Files pasted/dropped into the editor are inserted as a placeholder block
  // immediately, with `uploadFile` resolving the real URL asynchronously
  // afterwards (see @blocknote/core's handleFileInsertion). A save that reads
  // editor.document while an upload is still in flight persists the block
  // before its URL is set — the note then reopens with the file's "add
  // image" placeholder instead of the pasted image. Track in-flight uploads
  // here so doSave can wait for them before serializing the document.
  const pendingUploads = useRef<Set<Promise<void>>>(new Set())
  const isHydratingEditor = useRef(false)
  const syncedEditorKey = useRef<string | null>(null)
  // Latches true the first time the editor UI has mounted, and stays true for the
  // rest of this EditorView instance's lifetime (i.e. across parent <-> child note
  // navigation, which changes `noteId` but keeps the same component/editor alive).
  // Without this, `loaded` briefly flips false on every note switch and the JSX
  // below would unmount BlockNoteView, tearing down and recreating the underlying
  // ProseMirror view. BlockNote's TableHandlesController keeps a document-level
  // mousemove listener alive across that teardown for one tick and throws
  // ("editor view is not available") if it fires before the new view exists.
  const editorEverLoaded = useRef(false)
  const defaultCategoryId = categoriesStore.categories[0]?.id ?? ''
  const latestTitle = useRef(title)
  const latestCategoryId = useRef(categoryId)
  const latestTags = useRef(tags)
  const latestDefaultCategoryId = useRef(defaultCategoryId)
  const latestIsNew = useRef(isNew)
  const latestNoteId = useRef(noteId)
  const saveDraftRef = useRef<((force?: boolean) => Promise<Note | null | undefined>) | undefined>(undefined)

  const editor = useCreateBlockNote({
    schema: noteSchema,
    uploadFile: async (file: File) => {
      let markSettled: () => void = () => {}
      const settled = new Promise<void>((resolve) => { markSettled = resolve })
      pendingUploads.current.add(settled)
      try {
        // Naming the note here is the only chance to keep the original filename —
        // the file is stored under a UUID. When the note has no id yet (a brand-new
        // /notes/new draft) the server registers nothing and picks the file up when
        // the note is first saved.
        const response = await mediaApi.upload(file, createdNoteId.current || latestNoteId.current)
        return response.data.url
      } finally {
        // Defer clearing to a macrotask: BlockNote writes the resolved URL
        // onto the block in a microtask continuation right after this
        // function returns, and that write must land before we report the
        // upload as settled.
        setTimeout(() => {
          markSettled()
          pendingUploads.current.delete(settled)
        }, 0)
      }
    },
  })

  // Insert blocks at the cursor when the editor is focused, otherwise append to
  // the end of the note (e.g. dictation started while focus was elsewhere).
  // Returns the inserted blocks so callers (e.g. dictation) can track them.
  const insertBlocksAtCursor = useCallback((blocks: PartialBlock[]) => {
    if (!editor || blocks.length === 0) return []
    if (editor.isFocused()) {
      const cursorBlock = editor.getTextCursorPosition().block
      return editor.insertBlocks(blocks, cursorBlock, 'after')
    }
    const doc = editor.document
    const lastBlock = doc[doc.length - 1]
    return lastBlock ? editor.insertBlocks(blocks, lastBlock, 'after') : []
  }, [editor])

  // Take every block referencing a media URL out of the note. Used by the Assets tab
  // when a file is deleted while still in the body: the block has to go before the row
  // does, or the next autosave re-registers the file from content that still names it.
  // Doing it through the editor rather than the server also means it lands in the undo
  // stack and saves by the normal path.
  const removeMediaBlocks = useCallback((url: string) => {
    if (!editor) return
    const ids: string[] = []
    const walk = (blocks: unknown[]) => {
      for (const block of blocks as { id?: string; props?: { url?: string }; children?: unknown[] }[]) {
        if (block?.props?.url === url && block.id) ids.push(block.id)
        if (block?.children?.length) walk(block.children)
      }
    }
    walk(editor.document as unknown[])
    if (ids.length) editor.removeBlocks(ids)
  }, [editor])

  const insertBlocksAtTop = useCallback((blocks: PartialBlock[]) => {
    if (!editor || blocks.length === 0) return
    const firstBlock = editor.document[0]
    if (firstBlock) editor.insertBlocks(blocks, firstBlock, 'before')
  }, [editor])

  // Tracks the paragraph block the *current* dictation session is appending
  // to, so consecutive recognized chunks concatenate onto one line instead of
  // each becoming its own new block (which, without a stable insertion point,
  // ends up stacking in reverse order as the cursor never advances). Cleared
  // whenever a dictation session isn't active — see the effect below.
  const dictationModeRef = useRef<DictationMode>(null)
  const dictationSessionBlockIdRef = useRef<string | null>(null)

  const insertDictatedText = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed || !editor) return

    const inSession = dictationModeRef.current === 'dictation'
    const targetId = inSession ? dictationSessionBlockIdRef.current : null

    if (targetId) {
      const existing = editor.getBlock(targetId)
      if (existing) {
        const priorText = extractPlainText([existing])
        const merged = priorText ? `${priorText} ${trimmed}` : trimmed
        editor.updateBlock(targetId, { content: [{ type: 'text', text: merged, styles: {} }] })
        if (editor.isFocused()) editor.setTextCursorPosition(targetId, 'end')
        return
      }
      // Target block was deleted mid-session (e.g. user backspaced it) — fall
      // through and re-anchor to a freshly inserted one.
    }

    const inserted = insertBlocksAtCursor([{ type: 'paragraph', content: [{ type: 'text', text: trimmed, styles: {} }] }])
    const newBlock = inserted[0]
    if (newBlock) {
      if (inSession) dictationSessionBlockIdRef.current = newBlock.id
      if (editor.isFocused()) editor.setTextCursorPosition(newBlock.id, 'end')
    }
  }, [editor, insertBlocksAtCursor])

  // Upload an audio blob to /media and return its URL. The filename extension
  // must match the blob type so the backend accepts it (.webm/.ogg/.mp3 are allowed).
  const uploadAudioBlob = useCallback(async (blob: Blob, baseName: string): Promise<string> => {
    const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('webm') ? 'webm' : 'mp3'
    const safeBase = (baseName || 'audio').replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 80) || 'audio'
    const file = new File([blob], `${safeBase}.${ext}`, { type: blob.type || 'application/octet-stream' })
    const res = await mediaApi.upload(file, createdNoteId.current || latestNoteId.current)
    return res.data.url
  }, [])

  const { falKeyConfigured, substackConfigured, sttProvider } = settingsStore
  const transcribeAudio = useCallback(
    (blob: Blob) => settingsApi.transcribeAudio(blob),
    [],
  )

  // Record button: save the recorded audio as an audio object, then the
  // transcription text directly below it.
  const handleRecordingComplete = useCallback(async (text: string, blob: Blob) => {
    const transcript = text.trim()
    try {
      const url = await uploadAudioBlob(blob, 'recording')
      const blocks: PartialBlock[] = [
        { type: 'audioFile', props: { url, name: `Recording — ${new Date().toLocaleString()}` } } as unknown as PartialBlock,
      ]
      if (transcript) blocks.push({ type: 'paragraph', content: [{ type: 'text', text: transcript, styles: {} }] })
      insertBlocksAtCursor(blocks)
    } catch {
      showToast('Failed to save recording audio')
      if (transcript) insertDictatedText(transcript)
    }
  }, [uploadAudioBlob, insertBlocksAtCursor, insertDictatedText])

  const dictation = useDictation(insertDictatedText, {
    transcribeAudio: falKeyConfigured ? transcribeAudio : undefined,
    onRecordingComplete: handleRecordingComplete,
    sttProvider,
  })

  // Clear the dictation session's target block whenever a session isn't
  // active, so the next session starts a fresh paragraph rather than
  // continuing to append to a stale one.
  useEffect(() => {
    dictationModeRef.current = dictation.mode
    if (dictation.mode !== 'dictation') dictationSessionBlockIdRef.current = null
  }, [dictation.mode])

  // Upload a recorded video blob to /media and return its URL + stored filename
  // (the filename is what the async transcription job references).
  const uploadVideoBlob = useCallback(async (blob: Blob, mimeType: string, baseName: string): Promise<{ url: string; filename: string }> => {
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm'
    const safeBase = (baseName || 'video').replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 80) || 'video'
    const file = new File([blob], `${safeBase}.${ext}`, { type: mimeType || 'application/octet-stream' })
    const res = await mediaApi.upload(file, createdNoteId.current || latestNoteId.current)
    return { url: res.data.url, filename: res.data.filename }
  }, [])

  // Poll a background transcription job until it finishes, then insert the
  // resulting transcript as a file block right after the video it belongs to.
  // Runs independently of the recorder modal so closing it doesn't lose the job.
  // Guards against inserting into the wrong note: if the user has since
  // navigated to a different note, the transcript is left unattached (rather
  // than risk corrupting whatever note is now open) and the toast says so.
  const pollTranscriptionJob = useCallback((jobId: string, afterBlockId: string, ownerNoteId: string | undefined, ownerNoteTitle: string) => {
    const POLL_MS = 4000
    const poll = async () => {
      try {
        const res = await transcriptionApi.getJob(jobId)
        const job = res.data
        if (job.status === 'done' && job.result_url) {
          const stillOpen = (createdNoteId.current || latestNoteId.current) === ownerNoteId
          if (!stillOpen) {
            showToast(`Transcript ready for "${ownerNoteTitle}" — reopen that note to attach it`)
            return
          }
          const fileBlock = {
            type: 'file',
            props: { url: job.result_url, name: `Transcript — ${new Date().toLocaleString()}` },
          } as unknown as PartialBlock
          const target = editor?.getBlock(afterBlockId)
          if (target) editor?.insertBlocks([fileBlock], target as never, 'after')
          else insertBlocksAtCursor([fileBlock])
          showToast('Transcript ready')
          return
        }
        if (job.status === 'error') {
          showToast(`Transcription failed${job.error_message ? `: ${job.error_message}` : ''}`)
          return
        }
      } catch {
        showToast('Lost connection while checking transcript status')
        return
      }
      setTimeout(() => { void poll() }, POLL_MS)
    }
    setTimeout(() => { void poll() }, POLL_MS)
  }, [editor, insertBlocksAtCursor])

  // Record button in the video recorder modal: save the recorded video as a
  // video block, then (optionally) kick off async transcription in the background.
  const handleVideoRecorded = useCallback(async (blob: Blob, mimeType: string, wantTranscript: boolean) => {
    try {
      const { url, filename } = await uploadVideoBlob(blob, mimeType, title || 'video')
      const videoBlockId = `video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const videoBlock = {
        id: videoBlockId,
        type: 'videoFile',
        props: { url, name: `Recording — ${new Date().toLocaleString()}` },
      } as unknown as PartialBlock
      insertBlocksAtCursor([videoBlock])

      if (wantTranscript && falKeyConfigured) {
        try {
          const ownerNoteId = createdNoteId.current || latestNoteId.current
          const res = await transcriptionApi.createJob(filename)
          showToast('Transcribing in the background…')
          pollTranscriptionJob(res.data.id, videoBlockId, ownerNoteId, latestTitle.current || 'Untitled')
        } catch {
          showToast('Could not start transcription')
        }
      }
    } catch {
      showToast('Failed to save recorded video')
    }
  }, [uploadVideoBlob, insertBlocksAtCursor, falKeyConfigured, pollTranscriptionJob, title])
  const tts = useTextToSpeech({ model: settingsStore.voice })
  const exportAnchorRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    try { localStorage.setItem('ai-panel-open', String(panelOpen)) } catch { /* noop */ }
  }, [panelOpen])
  useEffect(() => {
    try { localStorage.setItem('tts-controls-docked', String(ttsDocked)) } catch { /* noop */ }
  }, [ttsDocked])
  useEffect(() => {
    try { localStorage.setItem('tts-insert-mode', String(ttsInsertMode)) } catch { /* noop */ }
  }, [ttsInsertMode])
  useEffect(() => { latestTitle.current = title }, [title])
  useEffect(() => { latestCategoryId.current = categoryId }, [categoryId])
  useEffect(() => { latestTags.current = tags }, [tags])
  useEffect(() => { latestDefaultCategoryId.current = defaultCategoryId }, [defaultCategoryId])
  useEffect(() => { latestIsNew.current = isNew }, [isNew])
  useEffect(() => { latestNoteId.current = noteId }, [noteId])
  useEffect(() => {
    if (dictation.status === 'error' && dictation.errorMessage) {
      showToast(dictation.errorMessage)
    }
  }, [dictation.status, dictation.errorMessage])
  useEffect(() => {
    if (tts.status === 'error' && tts.errorMessage) {
      showToast(tts.errorMessage)
    }
  }, [tts.status, tts.errorMessage])
  useEffect(() => {
    document.title = title ? `Gecko Notes - ${title}` : 'Gecko Notes'
    return () => { document.title = 'Gecko Notes' }
  }, [title])

  const saveStatusClass = saveStatus === 'Saving...' ? 'text-yellow-600' : saveStatus.includes('Unsaved') ? 'text-orange-600' : 'text-gray-400'

  // Load note data on mount
  useEffect(() => {
    async function init() {
      setLoaded(false)
      setNote(null)
      setTitle('')
      setCategoryId('')
      setTags([])
      setParentNoteTitle('')
      createdNoteId.current = null
      currentNoteContent.current = ''
      syncedEditorKey.current = null
      hasPendingChanges.current = false
      setAnnotations([])
      setOpenAnnotationId(null)

      await categoriesStore.loadCategories()

      if (isNew) {
        setCategoryId(defaultCategoryId)
        setLoaded(true)
        setTimeout(() => titleRef.current?.focus(), 0)
      } else if (noteId) {
        const data = await notesStore.loadNote(noteId)
        setNote(data)
        setTitle(data.title)
        setCategoryId(data.category_id)
        setTags([...data.tags])
        setSummary(data.summary ?? '')
        currentNoteContent.current = extractPlainText(parseNoteContent(data.content) as unknown[])
        annotationsApi.list(noteId).then((res) => setAnnotations(res.data)).catch(() => setAnnotations([]))

        // Load parent note title if this is a child note
        if (data.parent_note_id) {
          try {
            const parentData = await notesStore.loadNote(data.parent_note_id)
            setParentNoteTitle(parentData.title)
          } catch {
            setParentNoteTitle('')
          }
        } else {
          setParentNoteTitle('')
        }

        setLoaded(true)
      }
    }
    // Skip the reload when we just created this note ourselves: autosave on a new
    // note navigates here via replace(), changing noteId. The editor already holds
    // the user's content, so reloading would clear state and steal focus mid-typing.
    if (!(noteId && noteId === createdNoteId.current)) {
      init()
    }
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
      // Flush any pending edits to the note we're leaving (e.g. navigating
      // parent <-> child) so they aren't lost to the cancelled debounce. React
      // runs all effect cleanups before any effect bodies, so the refs that
      // doSave reads (createdNoteId / latestNoteId) still point at the departing
      // note here. Guard against materialising an empty, never-saved draft.
      if (hasPendingChanges.current && (latestNoteId.current || createdNoteId.current)) {
        void saveDraftRef.current?.(true)
      }
    }
  }, [noteId])

  // Folder the note lives in — or, for a brand-new note, the folder it's being
  // created inside (carried on ?folder=). Drives the header breadcrumb trail.
  const folderId = note?.folder_id ?? searchParams.get('folder')

  // Load the folder's ancestor chain (root..current) for the header breadcrumb.
  useEffect(() => {
    let cancelled = false
    if (!folderId) {
      setFolderBreadcrumb([])
      return
    }
    foldersApi.listContents(folderId)
      .then((res) => { if (!cancelled) setFolderBreadcrumb(res.data.breadcrumb) })
      .catch(() => { if (!cancelled) setFolderBreadcrumb([]) })
    return () => { cancelled = true }
  }, [folderId])

  // Sync categoryId once categories load (for new notes)
  useEffect(() => {
    if (isNew && !categoryId && defaultCategoryId) {
      setCategoryId(defaultCategoryId)
    }
  }, [defaultCategoryId])

  const scheduleAutosave = useCallback(() => {
    if (isHydratingEditor.current) return
    hasPendingChanges.current = true
    dirtySinceSnapshot.current = true
    currentNoteContent.current = extractPlainText(editor?.document as unknown[] ?? [])
    setSaveStatus('Unsaved changes')
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    autosaveTimer.current = setTimeout(() => {
      void saveDraftRef.current?.()
    }, 800)
  }, [])

  async function doSave(force = false) {
    if (!editor || isSaving.current) return note
    if (!force && !hasPendingChanges.current) return note

    // Never write a document the editor is not actually holding. `editor` exists
    // from the first render with an empty default document, and the note's
    // content is applied later by the hydration effect — which is what sets
    // syncedEditorKey. Saving in that window (a forced save skips the
    // pending-changes check that would otherwise stop it) replaces the note with
    // a blank document. Creating a brand-new note is the one case with nothing
    // to overwrite.
    const targetId = createdNoteId.current || latestNoteId.current
    const creatingNew = latestIsNew.current && !createdNoteId.current
    if (!creatingNew && targetId && syncedEditorKey.current !== targetId) return note

    setSaveStatus('Saving...')
    isSaving.current = true

    // Let any in-flight pasted/dropped file uploads finish and write their
    // URL onto the block before we read the document — otherwise a save
    // triggered right after a paste (e.g. immediately exiting the note) can
    // persist the block before it has a URL.
    if (pendingUploads.current.size > 0) {
      await Promise.allSettled([...pendingUploads.current])
    }

    const content = JSON.stringify(editor.document)
    currentNoteContent.current = extractPlainText(editor.document as unknown[])

    // Detect removed child-note blocks so we can orphan them (set parent_note_id = NULL)
    // and re-surface them in the main list. Extract childNote IDs from the current
    // document and the previously-saved content, then orphan any that disappeared.
    const currentChildIds = extractChildNoteIds(editor.document as unknown[])
    const previousChildIds = note ? extractChildNoteIds(parseNoteContent(note.content) as unknown[]) : []
    const removedChildIds = previousChildIds.filter((id) => !currentChildIds.includes(id))

    const payload = {
      title: latestTitle.current || 'Untitled',
      content,
      category_id: latestCategoryId.current || latestDefaultCategoryId.current,
      tags: latestTags.current,
    }
    try {
      let saved: Note
      if (latestIsNew.current && !createdNoteId.current) {
        const created = await notesStore.createNote({ ...payload, folder_id: initialFolderId.current })
        createdNoteId.current = created.id
        syncedEditorKey.current = created.id
        saved = created
        navigate(`/notes/${created.id}`, { replace: true })
      } else {
        const resolvedId = createdNoteId.current || latestNoteId.current!
        saved = await notesStore.updateNote(resolvedId, payload)
      }
      setNote(saved)

      // Orphan any child notes that were removed from the editor.
      for (const childId of removedChildIds) {
        void notesApi.orphanChild(childId).catch(() => {
          // Orphaning is best-effort; don't break the save if it fails.
        })
      }

      hasPendingChanges.current = false
      setSaveStatus('All changes saved')
      // The save is what makes the server reconcile the note's media, so this is the
      // moment the Assets list can change. Deliberately not done on upload: at that
      // point the block hasn't been saved yet, so the file would briefly show as
      // detached. A no-op unless the Assets tab is open on this note.
      useAssetsStore.getState().invalidate(saved.id)
    } catch {
      setSaveStatus('Error saving')
      hasPendingChanges.current = true
    } finally {
      isSaving.current = false
    }
  }

  useEffect(() => {
    saveDraftRef.current = doSave
  })

  // Trigger autosave when title/category/tags change
  useEffect(() => { if (loaded) scheduleAutosave() }, [title, categoryId])
  useEffect(() => { if (loaded) scheduleAutosave() }, [tags])

  // Ctrl/Cmd+F opens find; Ctrl/Cmd+H opens find with the replace row. On the editor
  // page these take over the browser's native find in favour of in-note find/replace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'f') { e.preventDefault(); setFindShowReplace(false); setFindOpen(true) }
      else if (k === 'h') { e.preventDefault(); setFindShowReplace(true); setFindOpen(true) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!editor || !loaded) return

    const editorKey = noteId ?? 'new'
    if (syncedEditorKey.current === editorKey) return

    // Guard against a render-timing race when navigating between notes that
    // share this route (e.g. parent <-> child): `noteId` updates immediately but
    // the `note` state still holds the previous note until init()'s async
    // setNote() applies. Without this gate we'd seed the editor with the previous
    // note's content under the new note's key, then falsely mark it synced so the
    // real content never loads. Only hydrate once the loaded note matches the
    // route param (or it's a genuinely new, unsaved note).
    const isNewNote = isNew && !createdNoteId.current
    if (!isNewNote && note?.id !== noteId) return

    const blocks = isNewNote ? EMPTY_DOCUMENT : parseNoteContent(note?.content ?? '[]')
    isHydratingEditor.current = true
    editor.replaceBlocks(editor.document, blocks as Parameters<typeof editor.replaceBlocks>[1])
    currentNoteContent.current = extractPlainText(blocks as unknown[])
    syncedEditorKey.current = editorKey
    hasPendingChanges.current = false
    setSaveStatus('All changes saved')
    setTimeout(() => {
      isHydratingEditor.current = false
    }, 0)
  }, [editor, loaded, isNew, noteId, note])

  // Load the snapshot interval (env-var driven, served by the backend).
  useEffect(() => {
    let active = true
    configApi.get()
      .then((c) => { if (active) setSnapshotIntervalMs(Math.max(1, c.note_version_interval_minutes) * 60 * 1000) })
      .catch(() => { /* keep default */ })
    return () => { active = false }
  }, [])

  // Periodically snapshot a version while the editor is focused and has changed.
  // The timer is disabled when the tab/window loses focus and re-armed on return.
  useEffect(() => {
    if (isNew && !createdNoteId.current) return
    let timer: ReturnType<typeof setInterval> | null = null

    async function snapshot() {
      if (!dirtySinceSnapshot.current) return
      const id = createdNoteId.current || latestNoteId.current
      if (!id || typeof document !== 'undefined' && document.hidden) return
      try {
        if (hasPendingChanges.current) await saveDraftRef.current?.(true)
        await notesApi.createVersion(id)
        dirtySinceSnapshot.current = false
      } catch { /* snapshot is best-effort */ }
    }

    const arm = () => {
      // If focus was absent for ≥ the interval, trigger an immediate snapshot check.
      if (blurTimestamp.current !== null && Date.now() - blurTimestamp.current >= snapshotIntervalMs) {
        void snapshot()
      }
      blurTimestamp.current = null
      if (!timer) timer = setInterval(() => { void snapshot() }, snapshotIntervalMs)
    }
    const disarm = () => {
      blurTimestamp.current = Date.now()
      if (timer) { clearInterval(timer); timer = null }
    }
    const onVisibility = () => { if (document.hidden) disarm(); else arm() }

    if (!document.hidden) arm()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', arm)
    window.addEventListener('blur', disarm)
    return () => {
      disarm()
      void snapshot()  // snapshot on leave/unmount if content changed since last version
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', arm)
      window.removeEventListener('blur', disarm)
    }
  }, [snapshotIntervalMs, noteId, loaded])

  function handleRestored(updated: Note) {
    setNote(updated)
    setTitle(updated.title)
    setCategoryId(updated.category_id)
    setTags([...updated.tags])
    syncedEditorKey.current = null // force the hydrate effect to reload editor content
    dirtySinceSnapshot.current = false
    setShowHistory(false)
    showToast('Note restored from history')
  }

  function handleRecoveredToNew(newNote: Note) {
    setShowHistory(false)
    navigate(`/notes/${newNote.id}`)
  }

  // Re-fetch and re-hydrate the open note after the AI assistant mutated it via
  // the API, reusing the same "force hydrate" mechanism as history restore.
  async function refreshOpenNote() {
    const id = createdNoteId.current ?? noteId
    if (!id) return
    if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null }
    hasPendingChanges.current = false
    try {
      const fresh = await notesStore.loadNote(id)
      setNote(fresh)
      setTitle(fresh.title)
      setCategoryId(fresh.category_id)
      setTags([...fresh.tags])
      setSummary(fresh.summary ?? '')
      syncedEditorKey.current = null // force the hydrate effect to reload editor content
    } catch { /* best-effort refresh */ }
  }

  // Build well-punctuated text for text-to-speech. Unlike extractPlainText (used
  // for AI context), this terminates list items, table rows and headings with
  // punctuation so the TTS engine inserts natural pauses instead of reading the
  // note as one run-on line.
  function blocksToSpeechText(blocks: unknown[] | undefined = editor?.document): string {
    if (!blocks) return ''
    try {
      const lines: string[] = []

      function inlineText(content: unknown): string {
        if (!Array.isArray(content)) return ''
        let out = ''
        for (const item of content) {
          if (typeof item !== 'object' || item === null) continue
          const rec = item as Record<string, unknown>
          if (rec.type === 'text') out += String(rec.text ?? '')
          else if (Array.isArray(rec.content)) out += inlineText(rec.content) // e.g. links
        }
        return out
      }

      // Append sentence-ending punctuation unless the text already ends with some.
      function terminate(text: string, end = '.'): string {
        const t = text.trim()
        if (!t) return ''
        return /[.!?:,;]$/.test(t) ? t : t + end
      }

      function processBlock(block: Record<string, unknown>) {
        const type = block.type
        const content = block.content

        // Tables: read each row as a comma-separated sentence so cells and rows
        // are clearly delineated.
        if (type === 'table' && content && typeof content === 'object') {
          const rows = (content as Record<string, unknown>).rows
          if (Array.isArray(rows)) {
            for (const row of rows) {
              const cells = (row as Record<string, unknown>)?.cells
              if (!Array.isArray(cells)) continue
              const cellTexts = cells
                .map((cell) =>
                  // A cell is either inline content (array) or a TableCell object.
                  Array.isArray(cell)
                    ? inlineText(cell).trim()
                    : inlineText((cell as Record<string, unknown>)?.content).trim(),
                )
                .filter(Boolean)
              if (cellTexts.length) lines.push(terminate(cellTexts.join(', ')))
            }
          }
          return
        }

        const text = inlineText(content).trim()
        if (text) {
          // A heading is a section boundary, not another sentence of the
          // paragraph above it, so it is set apart by a blank line either side
          // — the same marking the backend segmenter's `_set_apart` uses, and
          // what `parsePauseMarkup` reads as a paragraph break. Without it
          // `lines.join('\n')` never produced two consecutive newlines, so the
          // 1600ms `DEFAULT_PAUSE_MS['\n\n']` could never fire from the editor
          // and paragraph pauses were unreachable in read-aloud.
          if (type === 'heading') lines.push('')
          lines.push(terminate(text, type === 'heading' ? ':' : '.'))
          if (type === 'heading') lines.push('')
        } else if (type === 'paragraph') {
          // An empty paragraph is a deliberate beat in the prose. Keep it as
          // the blank line it is instead of dropping it silently.
          lines.push('')
        }

        if (Array.isArray(block.children)) {
          for (const child of block.children) processBlock(child as Record<string, unknown>)
        }
      }

      for (const block of blocks) processBlock(block as Record<string, unknown>)
      return lines.join('\n')
    } catch { return '' }
  }

  function getSelectedText(): string {
    if (!editor) return ''
    try {
      const ed = editor as unknown as { getSelectedText?: () => string; getSelection?: () => { blocks?: unknown[] } | undefined }
      // Prefer block-based extraction so multi-item / table selections are
      // punctuated; getSelection() returns blocks only for multi-block selections.
      const selection = ed.getSelection?.()
      if (selection?.blocks?.length) {
        const fromBlocks = blocksToSpeechText(selection.blocks)
        if (fromBlocks.trim()) return fromBlocks
      }
      // Single-block / inline selection: the exact highlighted substring.
      const direct = ed.getSelectedText?.()
      if (typeof direct === 'string' && direct.trim()) return direct
    } catch { /* fall through */ }
    return ''
  }

  function speechText(): string {
    return getSelectedText().trim() || blocksToSpeechText()
  }

  function speechFilename(): string {
    const base = (title || 'note').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 80) || 'note'
    return `${base}.mp3`
  }

  // Insert Mode: start playing immediately (small first chunk) while the full
  // clip assembles in the background, then save + insert it at the top of the
  // note. Reuses the same per-chunk audio, so fal.ai isn't billed twice.
  async function handlePlayWithInsert(text: string) {
    let blob: Blob
    try {
      blob = await tts.playAndSynthesize(text)
    } catch {
      // Playback was stopped, or synthesis failed (which already set the error
      // status + message, surfaced as a toast via effect) — nothing to save.
      return
    }
    try {
      const url = await uploadAudioBlob(blob, title || 'note')
      insertBlocksAtTop([
        { type: 'audioFile', props: { url, name: `Read-aloud — ${new Date().toLocaleString()}` } } as unknown as PartialBlock,
      ])
    } catch {
      // Saving to the note failed, but the audio already played — just notify.
      showToast('Could not save the audio to the note')
    }
  }

  function handlePlayPause() {
    if (tts.status === 'playing') { tts.pause(); return }
    if (tts.status === 'paused') { tts.resume(); return }
    if (tts.status === 'loading') return
    const text = speechText()
    if (!text) { showToast('Nothing to read'); return }
    if (ttsInsertMode) { void handlePlayWithInsert(text); return }
    tts.play(text)
  }

  const startVideoJob = useActivityStore((s) => s.startVideo)

  /**
   * Open the render dialog, rasterising any Mermaid diagrams first.
   *
   * Diagrams live in the note as Mermaid source and are drawn by the browser, so
   * the server can't use one as a background. Rendering them here — with the
   * same SVG-to-PNG path the PDF and HTML exporters use — and uploading the
   * result lets the backend treat them as ordinary images.
   */
  async function openVideoGen() {
    const id = createdNoteId.current || latestNoteId.current
    if (!id) return
    if (hasPendingChanges.current) await doSave(true)

    const rasterised: Record<string, string> = {}
    const blocks = (editor?.document ?? []) as { id?: string; type?: string; props?: { source?: string } }[]
    for (const block of blocks) {
      const source = block.type === 'diagram' ? block.props?.source : undefined
      if (!block.id || !source) continue
      try {
        const { svg } = await renderMermaid(source)
        if (!svg) continue
        const { data } = await svgToPngData(svg)
        const file = new File([new Blob([data as BlobPart], { type: 'image/png' })], `diagram-${block.id}.png`, { type: 'image/png' })
        const uploaded = await mediaApi.upload(file, createdNoteId.current || latestNoteId.current)
        rasterised[block.id] = uploaded.data.url
      } catch {
        // A diagram that won't render just isn't used as a background.
      }
    }
    setDiagramImages(rasterised)
    setShowVideoGen(true)
  }

  async function runVideoGen(options: RenderOptions, quality: 'preview' | 'full') {
    const id = createdNoteId.current || latestNoteId.current
    if (!id) throw new Error('Save the note first')
    await startVideoJob(id, options, quality)
    showToast(quality === 'preview' ? 'Rendering a preview…' : 'Rendering your video…')
  }

  /** Drop a finished render into the open note as a playable block.
   *
   * The server appends the block to the stored note when the render finishes, so
   * a video still arrives if the tab was closed. But an editor that is open on
   * that note holds its own document and would overwrite that append on its next
   * autosave — so the live document gets the block too, guarded by the URL so it
   * can only ever land once.
   */
  /** Whether the editor's document is actually this note's content.
   *
   * `editor` exists from the first render holding an empty default document; the
   * note is fetched afterwards and applied by the hydration effect, which is what
   * sets `syncedEditorKey`. Anything that writes the document back to the server
   * must wait for that, or it will save a blank document over the real note.
   */
  const editorHoldsNote = useCallback((noteIdToMatch: string | null | undefined) => {
    if (!editor || !loaded || !noteIdToMatch) return false
    return syncedEditorKey.current === noteIdToMatch
  }, [editor, loaded])

  const insertRenderedVideo = useCallback((job: ActivityJob) => {
    if (!job.result_url || !editor) return false
    if (!editorHoldsNote(createdNoteId.current || latestNoteId.current)) return false
    const already = editor.document.some(
      (b) => (b.props as { url?: string } | undefined)?.url === job.result_url,
    )
    if (already) return false
    insertBlocksAtCursor([{
      id: `video-${job.id}`,
      type: 'videoFile',
      props: { url: job.result_url, name: `Video — ${job.note_title || title || 'note'}` },
    } as unknown as PartialBlock])
    return true
  }, [editor, editorHoldsNote, insertBlocksAtCursor, title])

  // Reconcile finished renders with the open editor. Runs for every completed
  // job on this note, whether it finished while the user watched or while the
  // tab was closed and the server attached it on their behalf.
  const activityJobs = useActivityStore((s) => s.jobs)
  const reconciledVideos = useRef<Set<string>>(new Set())
  useEffect(() => {
    const openNoteId = createdNoteId.current || latestNoteId.current
    // Bail before marking anything reconciled: on a fresh mount the note has not
    // loaded yet, and a job left in the store from an earlier visit would
    // otherwise be inserted into the empty document and saved over the note.
    // Once hydration completes this effect re-runs and picks the job up.
    if (!editorHoldsNote(openNoteId)) return
    for (const job of Object.values(activityJobs)) {
      if (job.kind !== 'video') continue
      if (job.status !== 'done' || !job.result_url) continue
      if (job.note_id !== openNoteId || !job.meta?.auto_insert) continue
      if (reconciledVideos.current.has(job.id)) continue
      reconciledVideos.current.add(job.id)
      if (insertRenderedVideo(job)) {
        showToast('Video added to this note')
        void doSave(true)
      }
    }
    // `note` is a dependency because it is what re-hydration changes: a history
    // restore or an AI edit clears syncedEditorKey and reloads the document, and
    // this has to re-evaluate once the editor is holding real content again.
  }, [activityJobs, note, editorHoldsNote, insertRenderedVideo])

  async function handleExportAudio() {
    const text = speechText()
    if (!text) { showToast('Nothing to read'); return }
    await tts.exportToFile(text, speechFilename())
  }

  async function handlePublishSubstack() {
    if (!note) return
    showToast('Publishing to Substack…')
    try {
      const markdown = await noteToMarkdownBody(note)
      const { draft_url } = await settingsApi.publishToSubstack({
        title: note.title,
        markdown,
        tags: note.tags,
      })
      showToast('Draft created on Substack ✓')
      window.open(draft_url, '_blank', 'noopener')
    } catch (e) {
      // Surface the backend's message (e.g. an expired session cookie) when present.
      const detail = (e as { response?: { data?: { detail?: { message?: string } | string } } })?.response?.data?.detail
      const msg = typeof detail === 'string' ? detail : detail?.message
      showToast(msg || 'Failed to publish to Substack')
    }
  }

  function addTag() {
    const raw = newTagInput.trim().replace(/^#/, '').toLowerCase()
    if (raw && !tags.includes(raw)) setTags((t) => [...t, raw])
    setNewTagInput('')
  }

  function removeTag(tag: string) { setTags((t) => t.filter((x) => x !== tag)) }

  // Copy the bare tag name to the clipboard (clicking a chip in the tags flyout).
  async function copyTag(tag: string) {
    try {
      await navigator.clipboard.writeText(tag)
      showToast(`Copied #${tag}`)
    } catch {
      showToast('Could not copy tag')
    }
  }

  function addSuggestedTag(tag: string) {
    if (!tags.includes(tag)) setTags((t) => [...t, tag])
    setSuggestedTags((s) => s.filter((t) => t !== tag))
  }

  function onTagsGenerated(generated: string[]) {
    setSuggestedTags(generated.filter((t) => !tags.includes(t)))
  }

  async function handleGenerateMetadata() {
    if (!settingsStore.aiService) { showToast('No AI provider configured'); return }
    setGeneratingMetadata(true)
    try {
      const content = extractPlainText(editor?.document as unknown[] ?? [])
      const isUntitled = !title.trim() || title.trim().toLowerCase() === 'untitled'
      const { tags: generatedTags, summary: generatedSummary, title: generatedTitle } = await settingsStore.aiService.generateMetadata(
        isUntitled ? content : `${title}\n\n${content}`,
        settingsStore.summaryPrompt,
        isUntitled,
      )
      onTagsGenerated(generatedTags)
      if (isUntitled && generatedTitle.trim()) setTitle(generatedTitle.trim())
      if (generatedSummary) {
        setSummary(generatedSummary)
        const noteId = createdNoteId.current || latestNoteId.current
        if (noteId) await notesStore.updateNote(noteId, { summary: generatedSummary })
      }
      // Pop the tags flyout open so the new suggestions are immediately visible.
      if (generatedTags.some((t) => !tags.includes(t))) setTagFlyoutSignal((n) => n + 1)
      showToast('Metadata generated')
    } catch {
      showToast('Failed to generate metadata')
    } finally {
      setGeneratingMetadata(false)
    }
  }

  function autoResizeTitle(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  // Flush a pending/draft save before navigating away, so edits aren't lost to
  // the cancelled autosave debounce. Shared by the Back button and breadcrumb.
  async function flushPendingSave() {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current)
      autosaveTimer.current = null
    }

    const hasDraftContent = Boolean(title.trim() || extractPlainText(editor?.document as unknown[] ?? []) || tags.length)
    if ((hasPendingChanges.current || (isNew && !createdNoteId.current && hasDraftContent)) && categoryId) {
      await doSave(true)
    }
  }

  async function goBack() {
    await flushPendingSave()
    // Prefer real history-back so we return to wherever the user came from — a physical
    // folder, a dynamic-folder search (?q=…), or another note. location.key === 'default'
    // means this note was opened directly (deep link / refresh) with no in-app history to
    // pop, so fall back to the note's own folder.
    if (location.key !== 'default') navigate(-1)
    else navigate(folderId ? `/notes?folder=${folderId}` : '/notes')
  }

  // Breadcrumb crumb click: flush like goBack, then open that folder's list view
  // (null => "All notes" root).
  async function navigateToFolder(id: string | null) {
    await flushPendingSave()
    navigate(id ? `/notes?folder=${id}` : '/notes')
  }

  async function orphanChild() {
    if (!note) return
    try {
      await notesApi.update(note.id, { parent_note_id: null })
      setNote({ ...note, parent_note_id: null })
      setParentNoteTitle('')
      showToast('Note removed from parent')
    } catch {
      showToast('Could not remove from parent')
    }
  }

  function handlePrint() {
    const style = document.createElement('style')
    style.setAttribute('media', 'print')
    style.textContent = `.no-print { display: none !important; } body { background: white; color: black; margin: 0; padding: 0; height: auto; min-height: auto; } html { height: auto; min-height: auto; } .print-content { display: block !important; } .editor-area { overflow: visible !important; min-height: auto !important; height: auto !important; page-break-inside: auto; } .bn-editor { page-break-inside: auto; height: auto !important; min-height: auto !important; } h1, h2, h3, h4, h5, h6 { text-shadow: none !important; box-shadow: none !important; } * { text-shadow: none !important; box-shadow: none !important; }`
    document.head.appendChild(style)
    window.print()
    setTimeout(() => document.head.removeChild(style), 1000)
  }

  // A note is "in the archive" when its folder chain runs through the Archive Bin.
  // folderBreadcrumb is the note folder's ancestor chain, already loaded for the
  // header breadcrumb — so no need to pull in the whole folder tree here.
  const noteInArchive = folderBreadcrumb.some((f) => f.system_key === ARCHIVE_SYSTEM_KEY)

  async function confirmDelete() {
    const id = createdNoteId.current || noteId
    if (!id) { navigate('/notes'); return }
    // First delete archives (soft); deleting again from inside the Bin is permanent.
    if (noteInArchive) {
      await notesStore.deleteNote(id)
    } else {
      await notesStore.archiveNote(id)
    }
    navigate('/notes')
  }

  function showToast(msg: string) {
    setToastMessage(msg)
    setTimeout(() => setToastMessage(''), 3000)
  }

  async function insertAIText(text: string) {
    if (!editor) return
    const blocks = await editor.tryParseMarkdownToBlocks(text)
    editor.insertBlocks(
      blocks.length > 0 ? blocks : [{ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }],
      editor.getTextCursorPosition().block,
      'after',
    )
  }

  // ─── Annotations ──────────────────────────────────────────────────────────

  // Re-fetch the open note's annotations (used after AI plans touch them).
  const reloadAnnotations = useCallback(async () => {
    const id = createdNoteId.current ?? noteId
    if (!id) return
    try { const res = await annotationsApi.list(id); setAnnotations(res.data) } catch { /* best-effort */ }
  }, [noteId])

  // Attach an annotation to the block at the cursor (toolbar / slash entry point).
  async function annotateCurrentBlock() {
    if (!editor) return
    const blockId = editor.getTextCursorPosition().block?.id
    if (!blockId) return
    const id = await ensureParentId()
    if (!id) { showToast('Could not save note'); return }
    try {
      const res = await annotationsApi.create(id, { block_id: blockId, text: '' })
      setAnnotations((prev) => [...prev, res.data])
      setOpenAnnotationId(res.data.id)
    } catch {
      showToast('Could not add annotation')
    }
  }

  function saveAnnotation(id: string, text: string) {
    const noteIdResolved = createdNoteId.current ?? noteId
    if (!noteIdResolved) return
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, text } : a)))
    void annotationsApi.update(noteIdResolved, id, { text }).catch(() => showToast('Could not save annotation'))
  }

  function deleteAnnotation(id: string) {
    const noteIdResolved = createdNoteId.current ?? noteId
    if (!noteIdResolved) return
    setAnnotations((prev) => prev.filter((a) => a.id !== id))
    if (openAnnotationId === id) setOpenAnnotationId(null)
    void annotationsApi.delete(noteIdResolved, id).catch(() => showToast('Could not delete annotation'))
  }

  // Promote an annotation into the note: insert its content as block(s) right
  // after the annotated block, then remove the annotation.
  async function insertAnnotationIntoNote(annotation: Annotation) {
    if (!editor) return
    const target = editor.getBlock(annotation.block_id)
    const blocks = await editor.tryParseMarkdownToBlocks(annotation.text)
    const toInsert = blocks.length > 0
      ? blocks
      : [{ type: 'paragraph', content: [{ type: 'text', text: annotation.text, styles: {} }] }]
    if (target) {
      editor.insertBlocks(toInsert as never, target as never, 'after')
    } else {
      const doc = editor.document
      const last = doc[doc.length - 1]
      if (last) editor.insertBlocks(toInsert as never, last as never, 'after')
    }
    deleteAnnotation(annotation.id)
  }

  // Resolve (saving first if needed) the id under which a child note should be
  // created. New notes must be persisted before they can parent a child.
  async function ensureParentId(): Promise<string | undefined> {
    const existing = createdNoteId.current || noteId
    if (existing) return existing
    await doSave(true)
    return createdNoteId.current ?? undefined
  }

  function deriveChildTitle(blocks: unknown[]): string {
    // Prefer the first heading block's text so the embed header shows just the
    // heading. Fall back to the first non-empty line of text.
    const heading = (blocks as Array<Record<string, unknown>>).find((b) => b?.type === 'heading')
    const headingText = heading ? extractPlainText([heading]).trim() : ''
    const text = headingText || extractPlainText(blocks).trim()
    if (!text) return 'Untitled'
    return text.length > 60 ? `${text.slice(0, 57)}…` : text
  }

  // Move the current selection (or the cursor's block) into a new child note and
  // replace it with an embedded childNote block.
  async function sendSelectionToChild() {
    if (!editor) return
    const ed = editor as unknown as { getSelection?: () => { blocks?: unknown[] } | undefined }
    let blocks = ed.getSelection?.()?.blocks as PartialBlock[] | undefined
    if (!blocks || blocks.length === 0) {
      const cur = editor.getTextCursorPosition().block
      blocks = cur ? [cur as PartialBlock] : []
    }
    if (!blocks.length) { showToast('Select some content first'); return }

    const parentId = await ensureParentId()
    if (!parentId) { showToast('Could not save note'); return }

    try {
      const child = await notesApi.createChild(parentId, {
        title: deriveChildTitle(blocks as unknown[]),
        content: JSON.stringify(blocks),
      })
      editor.insertBlocks(
        [{ type: 'childNote', props: { childNoteId: child.data.id, title: child.data.title } }] as never,
        blocks[0] as never,
        'before',
      )
      editor.removeBlocks(blocks as never)
      // Persist the embed reference immediately so it survives navigation,
      // rather than relying on the 800ms autosave debounce.
      hasPendingChanges.current = true
      await doSave(true)
      showToast('Moved to child note')
    } catch {
      showToast('Could not create child note')
    }
  }

  // Insert an empty child note at the cursor (slash-menu entry point).
  async function insertEmptyChild() {
    if (!editor) return
    const parentId = await ensureParentId()
    if (!parentId) { showToast('Could not save note'); return }
    try {
      const child = await notesApi.createChild(parentId, { title: 'Untitled' })
      editor.insertBlocks(
        [{ type: 'childNote', props: { childNoteId: child.data.id, title: child.data.title } }] as never,
        editor.getTextCursorPosition().block,
        'after',
      )
      // Persist the embed reference immediately (see sendSelectionToChild).
      hasPendingChanges.current = true
      await doSave(true)
    } catch {
      showToast('Could not create child note')
    }
  }

  function insertNoteReference(noteId: string, noteTitle: string) {
    if (!editor) return
    editor.insertBlocks(
      [{ type: 'noteReference', props: { noteId, noteTitle } }] as never,
      editor.getTextCursorPosition().block,
      'after',
    )
  }

  // Insert a diagram (seeded with that kind's Mermaid starter template) at the cursor and
  // flag it to open its editor immediately (consumed on mount in diagramBlock).
  function insertDiagram(kind: DiagramKind) {
    if (!editor) return
    const diagramId = newDiagramId()
    markPendingOpen(diagramId)
    editor.insertBlocks(
      [{ type: 'diagram', props: { diagramId, source: starterFor(kind) } }] as never,
      editor.getTextCursorPosition().block,
      'after',
    )
  }

  async function handlePin() {
    if (!note) return
    try {
      const updated = await notesStore.pinNote(note.id)
      setNote(updated)
    } catch {
      showToast('Could not update pin')
    }
  }

  // Relocate the open note to another folder (or root). Flush pending edits first so
  // they aren't lost, then use the dedicated /move endpoint and refresh local state so
  // note.folder_id (read by goBack and the AI panel) stays current.
  async function handleMoveToFolder(folderId: string | null) {
    const id = createdNoteId.current || noteId
    if (!id || !note) return
    try {
      if (hasPendingChanges.current) await doSave(true)
      const { data } = await notesApi.move(id, folderId)
      setNote(data)
      showToast('Note moved')
    } catch {
      showToast('Could not move note')
    }
  }

  // Slash menu: default items plus "Child note" and "Link to note".
  function getSlashItems(query: string): DefaultReactSuggestionItem[] {
    const childItem: DefaultReactSuggestionItem = {
      title: 'Child note',
      subtext: 'Insert a nested note',
      aliases: ['child', 'subnote', 'nested'],
      group: 'Basic blocks',
      onItemClick: () => { void insertEmptyChild() },
    }
    const refItem: DefaultReactSuggestionItem = {
      title: 'Link to note',
      subtext: 'Insert a reference to another note',
      aliases: ['ref', 'reference', 'link'],
      group: 'Basic blocks',
      icon: <Link2 className="w-4 h-4" />,
      onItemClick: () => setShowNotePicker(true),
    }
    const annotateItem: DefaultReactSuggestionItem = {
      title: 'Annotate block',
      subtext: 'Attach an annotation to this block',
      aliases: ['annotate', 'annotation', 'comment', 'note'],
      group: 'Basic blocks',
      icon: <MessageSquareText className="w-4 h-4" />,
      onItemClick: () => { void annotateCurrentBlock() },
    }
    const videoItem: DefaultReactSuggestionItem = {
      title: 'Record video',
      subtext: 'Record from a camera and optionally transcribe it',
      aliases: ['video', 'record', 'camera', 'webcam'],
      group: 'Basic blocks',
      icon: <VideoIcon className="w-4 h-4" />,
      onItemClick: () => setShowVideoRecorder(true),
    }
    const imageGenItem: DefaultReactSuggestionItem = {
      title: 'Generate image',
      subtext: 'Create an image with fal.ai and insert it here',
      aliases: ['image', 'generate', 'ai image', 'picture', 'fal', 'illustration'],
      group: 'Basic blocks',
      icon: <ImageIcon className="w-4 h-4" />,
      onItemClick: () => setShowImageGen(true),
    }
    const videoGenItem: DefaultReactSuggestionItem = {
      title: 'Generate video',
      subtext: 'Narrate this article over its images as an MP4',
      aliases: ['video', 'mp4', 'render', 'presentation', 'narrate'],
      group: 'Basic blocks',
      icon: <Clapperboard className="w-4 h-4" />,
      onItemClick: () => { void openVideoGen() },
    }
    const diagramItems: DefaultReactSuggestionItem[] = [
      { kind: 'flowchart' as const, title: 'Flow chart', subtext: 'Insert a flow chart diagram', aliases: ['flowchart', 'flow chart', 'flow', 'process'], icon: <Workflow className="w-4 h-4" /> },
      { kind: 'mindmap' as const, title: 'Mind map', subtext: 'Insert a mind map diagram', aliases: ['mindmap', 'mind map', 'brainstorm'], icon: <Network className="w-4 h-4" /> },
      { kind: 'sequence' as const, title: 'Sequence diagram', subtext: 'Insert a sequence diagram', aliases: ['sequence', 'sequencediagram'], icon: <MessagesSquare className="w-4 h-4" /> },
      { kind: 'class' as const, title: 'Class diagram', subtext: 'Insert a class diagram', aliases: ['class', 'classdiagram', 'uml'], icon: <Box className="w-4 h-4" /> },
      { kind: 'state' as const, title: 'State diagram', subtext: 'Insert a state diagram', aliases: ['state', 'statediagram', 'fsm'], icon: <Waypoints className="w-4 h-4" /> },
      { kind: 'er' as const, title: 'ER diagram', subtext: 'Insert an entity-relationship diagram', aliases: ['er', 'erdiagram', 'entity', 'database'], icon: <Database className="w-4 h-4" /> },
      { kind: 'gantt' as const, title: 'Gantt chart', subtext: 'Insert a Gantt chart', aliases: ['gantt', 'timeline', 'schedule'], icon: <CalendarRange className="w-4 h-4" /> },
      { kind: 'pie' as const, title: 'Pie chart', subtext: 'Insert a pie chart', aliases: ['pie', 'piechart'], icon: <PieChart className="w-4 h-4" /> },
      { kind: 'timeline' as const, title: 'Timeline', subtext: 'Insert a timeline diagram', aliases: ['timeline', 'history'], icon: <Milestone className="w-4 h-4" /> },
    ].map(({ kind, title, subtext, aliases, icon }) => ({
      title, subtext, aliases, icon, group: 'Diagrams',
      onItemClick: () => insertDiagram(kind),
    }))
    return filterSuggestionItems(
      [...getDefaultReactSlashMenuItems(editor), childItem, refItem, annotateItem, videoItem, imageGenItem,
       ...(falKeyConfigured ? [videoGenItem] : []), ...diagramItems],
      query,
    )
  }

  const theme = useSettingsStore((s) => s.theme)
  const themes = useSettingsStore((s) => s.themes)
  const activeThemeId = useSettingsStore((s) => s.activeThemeId)
  const activeGlassTheme = activeThemeId ? themes.find((t) => t.id === activeThemeId) : null
  const editorTheme: 'light' | 'dark' = activeGlassTheme ? activeGlassTheme.mode : theme

  if (loaded) editorEverLoaded.current = true
  // True on the very first load of this EditorView instance; false on every
  // subsequent note switch, so the editor UI (and its BlockNoteView) stays
  // mounted once shown instead of tearing down and rebuilding on navigation.
  const showEditorChrome = loaded || editorEverLoaded.current

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-white dark:bg-gray-900">
      <header className="shrink-0 border-b border-gray-100 dark:border-gray-700 dark:bg-gray-900 no-print">
        <div className="flex items-center gap-2 px-4 py-2">
          <button className="btn-ghost p-2" onClick={goBack} title="Back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          {folderBreadcrumb.length > 0 && (
            <FolderBreadcrumb
              breadcrumb={folderBreadcrumb}
              onNavigate={navigateToFolder}
              className="min-w-0"
              // The trail ends at this note, not at a folder — so the note's own
              // folder stays clickable.
              lastCrumbClickable
            />
          )}
          {note?.parent_note_id && (
            <div className="flex items-center gap-1">
              <button
                className="btn-ghost px-2 py-1.5 text-xs flex items-center gap-1 text-blue-600 dark:text-blue-400"
                title="Go to parent note"
                onClick={() => navigate(`/notes/${note.parent_note_id}`)}
              >
                <ArrowUp className="w-4 h-4" /> Up to {parentNoteTitle || 'Parent'}
              </button>
              <button
                className="btn-ghost p-1.5 text-xs text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                title="Remove parent link"
                onClick={() => setShowOrphanConfirm(true)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
          {referrer && referrer.fromNoteId !== noteId && (
            <button
              className="btn-ghost px-2 py-1.5 text-xs flex items-center gap-1 text-blue-600 dark:text-blue-400"
              title="Go back to the note you referenced this from"
              onClick={() => navigate(`/notes/${referrer.fromNoteId}`)}
            >
              <ArrowLeft className="w-4 h-4" /> Back to {referrer.fromTitle || 'note'}
            </button>
          )}
          <div className="flex-1" />
          <button
            className={`btn-ghost p-2 ${note?.is_pinned ? 'text-blue-500' : ''}`}
            title={note?.is_pinned ? 'Unpin note' : 'Pin to top'}
            disabled={!note}
            onClick={() => { void handlePin() }}
          >
            <Pin className="w-4 h-4" fill={note?.is_pinned ? 'currentColor' : 'none'} />
          </button>
          <button
            className="btn-ghost p-2"
            title="Move to folder"
            disabled={!note}
            onClick={() => setShowFolderPicker(true)}
          >
            <FolderInput className="w-4 h-4" />
          </button>
          <ActivityIndicator
            onInsert={(job) => {
              if (insertRenderedVideo(job)) { showToast('Video inserted'); void doSave(true) }
              else showToast('That video is already in this note')
            }}
          />
          {note && (
            <span ref={exportAnchorRef}>
              <ExportMenu
                note={note}
                onToast={showToast}
                onExportAudio={falKeyConfigured ? handleExportAudio : undefined}
                onPublishSubstack={substackConfigured ? handlePublishSubstack : undefined}
                onGenerateVideo={falKeyConfigured ? openVideoGen : undefined}
              />
            </span>
          )}
          {note && <ShareMenu note={note} onToast={showToast} onUpdate={setNote} />}
          <button
            className="btn-ghost p-2"
            title="Find & replace (Ctrl/Cmd+F)"
            disabled={!showEditorChrome}
            onClick={() => { setFindShowReplace(false); setFindOpen(true) }}
          >
            <Search className="w-4 h-4" />
          </button>
          <button
            className="btn-ghost p-2"
            title="Version history"
            disabled={!note}
            onClick={() => setShowHistory(true)}
          >
            <History className="w-4 h-4" />
          </button>
          <button className="btn-ghost p-2" title="Print" onClick={handlePrint}>
            <Printer className="w-4 h-4" />
          </button>
          <button
            className="btn-ghost p-2 text-red-400 hover:text-red-600 hover:bg-red-50"
            title="Delete note"
            disabled={!note}
            onClick={() => setShowDeleteConfirm(true)}
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <UserAvatar />
        </div>
      </header>

      <div className="flex flex-1 min-h-0 flex-col sm:flex-row">
        {/* Document outline (left) */}
        {showEditorChrome && (
          <DocumentOutline
            editor={editor}
            scrollContainerRef={editorScrollRef}
            storageKey="editor-outline"
          />
        )}

        {/* Editor column */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {showEditorChrome && (
            <div className="shrink-0 px-6 pt-4 pb-2 no-print">
              <textarea
                ref={titleRef}
                value={title}
                placeholder="Untitled"
                rows={1}
                className="w-full text-3xl font-bold text-gray-900 dark:text-gray-100 resize-none border-0 outline-none focus:ring-0 bg-transparent placeholder-gray-300 dark:placeholder-gray-600 leading-tight overflow-hidden print-content"
                onChange={(e) => { setTitle(e.target.value); autoResizeTitle(e.target) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (document.querySelector('[contenteditable]') as HTMLElement)?.focus() } }}
              />

              <div className="flex flex-wrap items-center gap-2 mt-3">
                {defaultCategoryId ? (
                  <CategoryPicker value={categoryId} onChange={setCategoryId} />
                ) : (
                  <div className="text-xs text-gray-400">Loading categories...</div>
                )}

                {/* Tags — folded into a flyout (icon + count) */}
                <MetaFlyout
                  openSignal={tagFlyoutSignal}
                  title="Tags"
                  trigger={
                    <>
                      <Tag className="w-3.5 h-3.5" />
                      <span>{tags.length > 0 ? tags.length : 'Add tags'}</span>
                    </>
                  }
                >
                  <div className="p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-1">
                      {tags.length > 0
                        ? tags.map((tag) => <TagChip key={tag} tag={tag} removable onRemove={removeTag} onClick={copyTag} />)
                        : <span className="text-xs text-gray-400">No tags yet</span>}
                    </div>
                    <input
                      value={newTagInput}
                      onChange={(e) => setNewTagInput(e.target.value)}
                      type="text"
                      placeholder="Add tag..."
                      className="w-full text-xs px-2 py-1 border border-dashed border-gray-300 dark:border-gray-600 rounded-lg bg-transparent dark:text-gray-200 focus:outline-none focus:border-blue-400"
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag() } }}
                    />
                    {suggestedTags.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1 pt-2 border-t border-gray-100 dark:border-gray-700">
                        <span className="w-full text-xs text-gray-400">Suggestions</span>
                        {suggestedTags.map((st) => (
                          <button
                            key={st}
                            className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-100 hover:bg-blue-100 transition-colors dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/30"
                            onClick={() => addSuggestedTag(st)}
                          >
                            + #{st}
                          </button>
                        ))}
                        <button className="ml-auto text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" onClick={() => setSuggestedTags([])}>
                          Dismiss
                        </button>
                      </div>
                    )}
                  </div>
                </MetaFlyout>

                {/* AI Summary — only when present; it's metadata, kept un-prominent */}
                {summary && (
                  <MetaFlyout
                    title="AI Summary"
                    panelClassName="w-80"
                    trigger={
                      <>
                        <Sparkles className="w-3.5 h-3.5 text-purple-500" />
                        <span>Summary</span>
                      </>
                    }
                  >
                    <div className="px-3 py-2.5 text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          strong: ({ children }) => <strong className="font-semibold text-gray-800 dark:text-gray-100">{children}</strong>,
                          em: ({ children }) => <em className="italic">{children}</em>,
                          ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 my-1">{children}</ul>,
                          ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 my-1">{children}</ol>,
                          p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
                          code: ({ children }) => <code className="bg-gray-100 dark:bg-gray-800 rounded px-1 font-mono text-xs">{children}</code>,
                          table: ({ children }) => <div className="overflow-x-auto my-2"><table className="min-w-full border-collapse text-xs">{children}</table></div>,
                          thead: ({ children }) => <thead className="bg-gray-100 dark:bg-gray-700">{children}</thead>,
                          tbody: ({ children }) => <tbody className="divide-y divide-gray-200 dark:divide-gray-600">{children}</tbody>,
                          tr: ({ children }) => <tr className="even:bg-gray-50 dark:even:bg-gray-750">{children}</tr>,
                          th: ({ children }) => <th className="px-2 py-1 text-left font-semibold border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100">{children}</th>,
                          td: ({ children }) => <td className="px-2 py-1 border border-gray-300 dark:border-gray-600">{children}</td>,
                        }}
                      >
                        {processCiteTags(summary)}
                      </ReactMarkdown>
                    </div>
                  </MetaFlyout>
                )}

                {/* Generate tags + summary with AI */}
                <button
                  className="text-xs px-2 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 transition-colors flex items-center gap-1 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-blue-500/10 dark:hover:text-blue-300"
                  disabled={generatingMetadata}
                  onClick={handleGenerateMetadata}
                  title="Generate tags & summary with AI"
                >
                  {generatingMetadata ? (
                    <>
                      <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      <span className="hidden sm:inline">Generating...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Generate</span>
                    </>
                  )}
                </button>

                {/* Timestamps — muted, pushed to the right */}
                {note && (
                  <div className="ml-auto flex items-center gap-3 text-xs text-gray-400">
                    <span>Created {formatDate(note.created_at)}</span>
                    <span>Modified {formatDate(note.modified_at)}</span>
                  </div>
                )}
              </div>

              {falKeyConfigured && !ttsDocked && (
                <TTSPlaybackControls
                  tts={tts}
                  anchorRef={exportAnchorRef}
                  onPlayPause={handlePlayPause}
                  dictation={dictation}
                  onDictationToggle={dictation.toggleDictation}
                  onRecordToggle={dictation.toggleRecording}
                  insertMode={ttsInsertMode}
                  onToggleInsertMode={() => setTtsInsertMode((v) => !v)}
                  ttsSpeed={tts.speed}
                  onTtsSpeedChange={tts.setSpeed}
                  onToggleDock={() => setTtsDocked(true)}
                />
              )}

              {dictation.interimText && (
                <p className="text-xs text-gray-400 italic mt-1 px-1 truncate">
                  {dictation.interimText}
                </p>
              )}

            </div>
          )}

          <div className="relative flex-1 min-h-0 flex flex-col">
            {showEditorChrome && (
              <FindReplaceBar
                editor={editor}
                scrollContainerRef={editorScrollRef}
                open={findOpen}
                showReplace={findShowReplace}
                onClose={() => setFindOpen(false)}
              />
            )}
          <div ref={editorScrollRef} className="editor-area flex-1 min-h-0 overflow-auto px-4 pb-4 print-content">
            {!showEditorChrome ? (
              <div className="flex items-center justify-center h-full">
                <svg className="animate-spin w-6 h-6 text-gray-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              </div>
            ) : (
              <EditorErrorBoundary>
                <EditorNoteContext.Provider value={noteId ? { id: noteId, title } : null}>
                <ChildNoteChainContext.Provider value={note?.id ? [note.id] : []}>
                  <div ref={annotationContainerRef} className="relative">
                    <BlockNoteView
                      editor={editor}
                      onChange={scheduleAutosave}
                      theme={editorTheme}
                      slashMenu={false}
                      formattingToolbar={false}
                    >
                      <SuggestionMenuController
                        triggerCharacter="/"
                        getItems={async (query) => getSlashItems(query)}
                      />
                      <FormattingToolbarController
                        formattingToolbar={() => (
                          <FormattingToolbar>
                            {getFormattingToolbarItems()}
                            <SendToChildToolbarButton onClick={() => void sendSelectionToChild()} />
                            <AnnotateToolbarButton onClick={() => void annotateCurrentBlock()} />
                          </FormattingToolbar>
                        )}
                      />
                    </BlockNoteView>
                    <AnnotationLayer
                      containerRef={annotationContainerRef}
                      annotations={annotations}
                      openId={openAnnotationId}
                      onOpen={setOpenAnnotationId}
                      onSave={saveAnnotation}
                      onDelete={deleteAnnotation}
                      onInsert={(a) => { void insertAnnotationIntoNote(a) }}
                    />
                  </div>
                </ChildNoteChainContext.Provider>
                </EditorNoteContext.Provider>
              </EditorErrorBoundary>
            )}
          </div>
          </div>

          <div className="shrink-0 no-print px-4 py-1.5 border-t border-gray-100 dark:border-gray-700 dark:bg-gray-900 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <div className={`text-xs ${saveStatusClass}`}>{saveStatus}</div>
              {note?.id && (
                <button
                  title="Note statistics"
                  className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                  onClick={async () => { if (hasPendingChanges.current) await doSave(true); setShowStats(true) }}
                >
                  <Info className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {falKeyConfigured && ttsDocked && (
              <TTSPlaybackControls
                tts={tts}
                anchorRef={exportAnchorRef}
                onPlayPause={handlePlayPause}
                dictation={dictation}
                onDictationToggle={dictation.toggleDictation}
                onRecordToggle={dictation.toggleRecording}
                insertMode={ttsInsertMode}
                onToggleInsertMode={() => setTtsInsertMode((v) => !v)}
                ttsSpeed={tts.speed}
                onTtsSpeedChange={tts.setSpeed}
                docked
                onToggleDock={() => setTtsDocked(false)}
              />
            )}
          </div>
        </div>

        {/* AI Conversation Panel */}
        <AIConversationPanel
          isOpen={panelOpen}
          onToggle={() => setPanelOpen((o) => !o)}
          getNoteContext={() => currentNoteContent.current}
          noteId={createdNoteId.current ?? noteId}
          noteTitle={title}
          noteFolderId={note?.folder_id ?? null}
          noteSummary={note?.summary ?? null}
          noteCreatedAt={note?.created_at ?? null}
          noteModifiedAt={note?.modified_at ?? null}
          getNoteDocument={() => editor?.document as unknown[] ?? []}
          onAddToNote={insertAIText}
          editor={editor}
          defaultCategoryId={defaultCategoryId}
          currentFolderId={note?.folder_id ?? null}
          onBeforeExecute={async () => { if (hasPendingChanges.current) await doSave(true) }}
          onCurrentNoteEdited={refreshOpenNote}
          onNotesChanged={() => { void notesStore.loadNotes() }}
          getAnnotations={() => annotations}
          onAnnotationsChanged={reloadAnnotations}
          onInsertBlocks={(blocks) => { insertBlocksAtCursor(blocks as PartialBlock[]) }}
          onRemoveMediaBlocks={removeMediaBlocks}
          // Unconditional, unlike onBeforeExecute above: after removing a block the
          // document has to reach the server before the asset row is deleted, whether or
          // not anything else was pending.
          onFlushSave={async () => { await doSave(true) }}
        />
      </div>

      {toastMessage && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-4 py-2 rounded-xl shadow-lg text-sm z-50">
          {toastMessage}
        </div>
      )}

      {showHistory && note && (
        <NoteHistoryModal
          noteId={note.id}
          currentContent={note.content}
          onClose={() => setShowHistory(false)}
          onRestored={handleRestored}
          onRecoveredToNew={handleRecoveredToNew}
        />
      )}

      {showStats && note?.id && (
        <NoteStatsModal noteId={note.id} onClose={() => setShowStats(false)} />
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowDeleteConfirm(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
              {noteInArchive ? 'Delete permanently' : 'Move to Archive Bin'}
            </h3>
            <p className="text-gray-600 dark:text-gray-400 text-sm mb-6">
              {noteInArchive
                ? <>Permanently delete &ldquo;{title}&rdquo;? This cannot be undone.</>
                : <>Move &ldquo;{title}&rdquo; to the Archive Bin? You can restore it later.</>}
            </p>
            <div className="flex gap-3">
              <button className="btn-danger flex-1" onClick={confirmDelete}>
                {noteInArchive ? 'Delete' : 'Move to Bin'}
              </button>
              <button className="btn-secondary flex-1" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showOrphanConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowOrphanConfirm(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Remove from Parent</h3>
            <p className="text-gray-600 text-sm mb-6">Move &ldquo;{title}&rdquo; back to the root level and remove its link to the parent note?</p>
            <div className="flex gap-3">
              <button className="btn-danger flex-1" onClick={() => { void orphanChild(); setShowOrphanConfirm(false) }}>Remove</button>
              <button className="btn-secondary flex-1" onClick={() => setShowOrphanConfirm(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showFolderPicker && note && (
        <FolderPickerModal
          title="Move to folder"
          onSelect={(folderId) => { void handleMoveToFolder(folderId); setShowFolderPicker(false) }}
          onClose={() => setShowFolderPicker(false)}
        />
      )}

      {showNotePicker && (
        <NotePickerModal
          onSelect={(id, title) => { insertNoteReference(id, title); setShowNotePicker(false) }}
          onClose={() => setShowNotePicker(false)}
        />
      )}

      {showVideoRecorder && (
        <VideoRecorderModal
          canTranscribe={!!falKeyConfigured}
          onRecorded={(blob, mimeType, wantTranscript) => { void handleVideoRecorded(blob, mimeType, wantTranscript) }}
          onClose={() => setShowVideoRecorder(false)}
        />
      )}

      {showVideoGen && (
        <VideoGenModal
          noteId={createdNoteId.current || latestNoteId.current || ''}
          noteTitle={title || 'Untitled'}
          diagramImages={diagramImages}
          onGenerate={runVideoGen}
          onClose={() => setShowVideoGen(false)}
        />
      )}
      {showImageGen && (
        <ImageGenModal
          onInsert={(url, caption) => insertBlocksAtCursor([{ type: 'image', props: { url, caption } } as unknown as PartialBlock])}
          onClose={() => setShowImageGen(false)}
        />
      )}
    </div>
  )
}
