import { useState, useEffect, useRef, useCallback, Component } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'
import { ArrowLeft, Printer, Trash2, History, ArrowUp, Send, X, Pin, Link2, MessageSquareText } from 'lucide-react'
import UserAvatar from '@/components/UserAvatar'
import NoteHistoryModal from '@/components/NoteHistoryModal'
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems, FormattingToolbar, FormattingToolbarController, getFormattingToolbarItems, useComponentsContext, type DefaultReactSuggestionItem } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import '@blocknote/core/fonts/inter.css'
import { filterSuggestionItems, type PartialBlock } from '@blocknote/core'
import { noteSchema, ChildNoteChainContext } from '@/blocks/childNoteBlock'

import CategoryPicker from '@/components/CategoryPicker'
import TagChip from '@/components/TagChip'
import ExportMenu from '@/components/ExportMenu'
import ShareMenu from '@/components/ShareMenu'
import AIConversationPanel, { type ConversationMessage } from '@/components/AIConversationPanel'
import TTSPlaybackControls from '@/components/TTSPlaybackControls'
import NotePickerModal from '@/components/NotePickerModal'
import AnnotationLayer from '@/components/AnnotationLayer'

import { useNotesStore } from '@/stores/notes'
import { useCategoriesStore } from '@/stores/categories'
import { useSettingsStore } from '@/stores/settings'
import { mediaApi } from '@/api/media'
import { settingsApi } from '@/api/settings'
import { notesApi, configApi, type Note } from '@/api/notes'
import { annotationsApi, type Annotation } from '@/api/annotations'
import { useDictation } from '@/hooks/useDictation'
import { useTextToSpeech } from '@/hooks/useTextToSpeech'
import { extractPlainText } from '@/utils/blocks'

const EMPTY_DOCUMENT: PartialBlock[] = [{ type: 'paragraph' }]

function parseConversation(raw: string | null | undefined): ConversationMessage[] {
  if (!raw) return []
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [] } catch { return [] }
}

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
  const [loaded, setLoaded] = useState(false)
  const [saveStatus, setSaveStatus] = useState('All changes saved')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showOrphanConfirm, setShowOrphanConfirm] = useState(false)
  const [showNotePicker, setShowNotePicker] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [snapshotIntervalMs, setSnapshotIntervalMs] = useState(5 * 60 * 1000)
  const [toastMessage, setToastMessage] = useState('')
  const [suggestedTags, setSuggestedTags] = useState<string[]>([])
  const [generatingTags, setGeneratingTags] = useState(false)
  const [generatingSummary, setGeneratingSummary] = useState(false)
  const [summary, setSummary] = useState<string>('')
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [conversation, setConversation] = useState<ConversationMessage[]>([])
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('ai-panel-open') !== 'false' } catch { return true }
  })
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [openAnnotationId, setOpenAnnotationId] = useState<string | null>(null)
  const annotationContainerRef = useRef<HTMLDivElement>(null)

  const titleRef = useRef<HTMLTextAreaElement>(null)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const createdNoteId = useRef<string | null>(null)
  const currentNoteContent = useRef('')
  const hasPendingChanges = useRef(false)
  const dirtySinceSnapshot = useRef(false)
  const blurTimestamp = useRef<number | null>(null)
  const isSaving = useRef(false)
  const isHydratingEditor = useRef(false)
  const syncedEditorKey = useRef<string | null>(null)
  const defaultCategoryId = categoriesStore.categories[0]?.id ?? ''
  const conversationRef = useRef<string>('[]')
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
      const response = await mediaApi.upload(file)
      return response.data.url
    },
  })

  const insertDictatedText = useCallback((text: string) => {
    if (!editor || !text.trim()) return
    const block: PartialBlock = { type: 'paragraph', content: [{ type: 'text', text: text.trim(), styles: {} }] }
    // When the editor has focus, insert at the cursor position. Otherwise (e.g.
    // dictation started while focus was elsewhere) append to the end of the note.
    if (editor.isFocused()) {
      const cursorBlock = editor.getTextCursorPosition().block
      editor.insertBlocks([block], cursorBlock, 'after')
    } else {
      const doc = editor.document
      const lastBlock = doc[doc.length - 1]
      if (lastBlock) editor.insertBlocks([block], lastBlock, 'after')
    }
  }, [editor])

  const { deepgramApiKey } = settingsStore
  const transcribeAudio = useCallback(
    (blob: Blob) => settingsApi.transcribeAudio(blob),
    [],
  )
  const dictation = useDictation(insertDictatedText, {
    transcribeAudio: deepgramApiKey ? transcribeAudio : undefined,
  })
  const tts = useTextToSpeech({ model: settingsStore.ttsModel })
  const exportAnchorRef = useRef<HTMLSpanElement>(null)

  useEffect(() => { conversationRef.current = JSON.stringify(conversation) }, [conversation])
  useEffect(() => {
    try { localStorage.setItem('ai-panel-open', String(panelOpen)) } catch { /* noop */ }
  }, [panelOpen])
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
        setSummaryOpen(false)
        setConversation(parseConversation(data.conversation))
        conversationRef.current = data.conversation ?? '[]'
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

    setSaveStatus('Saving...')
    isSaving.current = true
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
      conversation: conversationRef.current,
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
        if (text) lines.push(terminate(text, type === 'heading' ? ':' : '.'))

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

  function handlePlayPause() {
    if (tts.status === 'playing') { tts.pause(); return }
    if (tts.status === 'paused') { tts.resume(); return }
    if (tts.status === 'loading') return
    const text = speechText()
    if (!text) { showToast('Nothing to read'); return }
    tts.play(text)
  }

  async function handleExportAudio() {
    const text = speechText()
    if (!text) { showToast('Nothing to read'); return }
    await tts.exportToFile(text, speechFilename())
  }

  function addTag() {
    const raw = newTagInput.trim().replace(/^#/, '').toLowerCase()
    if (raw && !tags.includes(raw)) setTags((t) => [...t, raw])
    setNewTagInput('')
  }

  function removeTag(tag: string) { setTags((t) => t.filter((x) => x !== tag)) }

  function addSuggestedTag(tag: string) {
    if (!tags.includes(tag)) setTags((t) => [...t, tag])
    setSuggestedTags((s) => s.filter((t) => t !== tag))
  }

  async function handleGenerateTags() {
    if (!settingsStore.aiService) { showToast('No AI provider configured'); return }
    setGeneratingTags(true)
    try {
      const content = extractPlainText(editor?.document as unknown[] ?? [])
      const generated = await settingsStore.aiService.generateTags(`${title}\n\n${content}`)
      onTagsGenerated(generated)
    } catch { showToast('Failed to generate tags') }
    finally { setGeneratingTags(false) }
  }

  function onTagsGenerated(generated: string[]) {
    setSuggestedTags(generated.filter((t) => !tags.includes(t)))
  }

  async function handleGenerateSummary() {
    if (!settingsStore.aiService) { showToast('No AI provider configured'); return }
    setGeneratingSummary(true)
    try {
      const content = extractPlainText(editor?.document as unknown[] ?? [])
      const generated = await settingsStore.aiService.generateSummary(
        `${title}\n\n${content}`,
        settingsStore.summaryPrompt,
      )
      setSummary(generated)
      setSummaryOpen(true)
      const noteId = createdNoteId.current || latestNoteId.current
      if (noteId) {
        await notesStore.updateNote(noteId, { summary: generated })
      }
    } catch {
      showToast('Failed to generate summary')
    } finally {
      setGeneratingSummary(false)
    }
  }

  function autoResizeTitle(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  async function goBack() {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current)
      autosaveTimer.current = null
    }

    const hasDraftContent = Boolean(title.trim() || extractPlainText(editor?.document as unknown[] ?? []) || tags.length)
    if ((hasPendingChanges.current || (isNew && !createdNoteId.current && hasDraftContent)) && categoryId) {
      await doSave(true)
    }

    const folderId = note?.folder_id ?? searchParams.get('folder')
    navigate(folderId ? `/notes?folder=${folderId}` : '/notes')
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

  async function confirmDelete() {
    const id = createdNoteId.current || noteId
    if (!id) { navigate('/notes'); return }
    await notesStore.deleteNote(id)
    navigate('/notes')
  }

  function showToast(msg: string) {
    setToastMessage(msg)
    setTimeout(() => setToastMessage(''), 3000)
  }

  function handleConversationChange(messages: ConversationMessage[]) {
    setConversation(messages)
    conversationRef.current = JSON.stringify(messages)
    scheduleAutosave()
  }

  // Persist the conversation immediately (conversation-only update). Used after an
  // AI plan runs: the debounced autosave is unreliable there because refreshOpenNote's
  // forced editor re-hydrate resets hasPendingChanges, so doSave() bails.
  async function persistConversation(messages: ConversationMessage[]) {
    setConversation(messages)
    conversationRef.current = JSON.stringify(messages)
    const id = createdNoteId.current ?? noteId
    if (!id) return // brand-new unsaved note — conversationRef rides along on the next full save
    try { await notesApi.update(id, { conversation: conversationRef.current }) }
    catch { /* best-effort; conversationRef is set so a later doSave retries */ }
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

  async function handlePin() {
    if (!note) return
    try {
      const updated = await notesStore.pinNote(note.id)
      setNote(updated)
    } catch {
      showToast('Could not update pin')
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
    return filterSuggestionItems(
      [...getDefaultReactSlashMenuItems(editor), childItem, refItem, annotateItem],
      query,
    )
  }

  const theme = useSettingsStore((s) => s.theme)
  const themes = useSettingsStore((s) => s.themes)
  const activeThemeId = useSettingsStore((s) => s.activeThemeId)
  const activeGlassTheme = activeThemeId ? themes.find((t) => t.id === activeThemeId) : null
  const editorTheme: 'light' | 'dark' = activeGlassTheme ? activeGlassTheme.mode : theme

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-white dark:bg-gray-900">
      <header className="shrink-0 border-b border-gray-100 dark:border-gray-700 dark:bg-gray-900 no-print">
        <div className="flex items-center gap-2 px-4 py-2">
          <button className="btn-ghost p-2" onClick={goBack} title="Back">
            <ArrowLeft className="w-5 h-5" />
          </button>
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
          <div className="flex-1" />
          <button
            className={`btn-ghost p-2 ${note?.is_pinned ? 'text-blue-500' : ''}`}
            title={note?.is_pinned ? 'Unpin note' : 'Pin to top'}
            disabled={!note}
            onClick={() => { void handlePin() }}
          >
            <Pin className="w-4 h-4" fill={note?.is_pinned ? 'currentColor' : 'none'} />
          </button>
          {note && (
            <span ref={exportAnchorRef}>
              <ExportMenu note={note} onToast={showToast} onExportAudio={deepgramApiKey ? handleExportAudio : undefined} />
            </span>
          )}
          {note && <ShareMenu note={note} onToast={showToast} />}
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
        {/* Editor column */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {loaded && (
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

                <div className="flex flex-wrap items-center gap-1">
                  {tags.map((tag) => (
                    <TagChip key={tag} tag={tag} removable onRemove={removeTag} />
                  ))}
                  <input
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    type="text"
                    placeholder="Add tag..."
                    className="text-xs px-2 py-0.5 border border-dashed border-gray-300 rounded-full focus:outline-none focus:border-blue-400 w-24"
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag() } }}
                  />
                </div>

                <button
                  className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 transition-colors flex items-center gap-1"
                  disabled={generatingTags}
                  onClick={handleGenerateTags}
                >
                  {generatingTags ? (
                    <>
                      <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      Generating...
                    </>
                  ) : '✦ Generate Tags'}
                </button>

                <button
                  className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-purple-50 hover:text-purple-600 hover:border-purple-200 transition-colors flex items-center gap-1"
                  disabled={generatingSummary}
                  onClick={handleGenerateSummary}
                >
                  {generatingSummary ? 'Summarising...' : '✦ Generate Summary'}
                </button>


              </div>

              {deepgramApiKey && (
                <TTSPlaybackControls
                  tts={tts}
                  anchorRef={exportAnchorRef}
                  onPlayPause={handlePlayPause}
                  dictation={dictation}
                  onDictationToggle={dictation.toggleDictation}
                  ttsSpeed={tts.speed}
                  onTtsSpeedChange={tts.setSpeed}
                />
              )}

              {summary && (
                <div className="mt-3 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                  <button
                    className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    onClick={() => setSummaryOpen((o) => !o)}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="text-purple-500">✦</span>
                      AI Summary
                    </span>
                    <span className="text-gray-400">{summaryOpen ? '▲' : '▼'}</span>
                  </button>
                  {summaryOpen && (
                    <div className="px-3 py-2.5 text-sm text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-900 leading-relaxed">
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
                        {summary}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-4 mt-2 text-xs text-gray-400">
                {note && <span>Created {formatDate(note.created_at)}</span>}
                {note && <span>Modified {formatDate(note.modified_at)}</span>}
              </div>

              {dictation.interimText && (
                <p className="text-xs text-gray-400 italic mt-1 px-1 truncate">
                  {dictation.interimText}
                </p>
              )}

              {suggestedTags.length > 0 && (
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-xs text-gray-400">Suggestions:</span>
                  {suggestedTags.map((st) => (
                    <button
                      key={st}
                      className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-100 hover:bg-blue-100 transition-colors"
                      onClick={() => addSuggestedTag(st)}
                    >
                      + #{st}
                    </button>
                  ))}
                  <button className="text-xs text-gray-400 hover:text-gray-600" onClick={() => setSuggestedTags([])}>
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="editor-area flex-1 min-h-0 overflow-auto px-4 pb-4 print-content">
            {!loaded ? (
              <div className="flex items-center justify-center h-full">
                <svg className="animate-spin w-6 h-6 text-gray-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              </div>
            ) : (
              <EditorErrorBoundary>
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
              </EditorErrorBoundary>
            )}
          </div>

          <div className="shrink-0 no-print px-4 py-1.5 border-t border-gray-100 dark:border-gray-700 dark:bg-gray-900">
            <div className={`text-xs ${saveStatusClass}`}>{saveStatus}</div>
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
          getNoteDocument={() => editor?.document as unknown[] ?? []}
          conversation={conversation}
          onConversationChange={handleConversationChange}
          onPersistConversation={persistConversation}
          onAddToNote={insertAIText}
          editor={editor}
          defaultCategoryId={defaultCategoryId}
          currentFolderId={note?.folder_id ?? null}
          onBeforeExecute={async () => { if (hasPendingChanges.current) await doSave(true) }}
          onCurrentNoteEdited={refreshOpenNote}
          onNotesChanged={() => { void notesStore.loadNotes() }}
          getAnnotations={() => annotations}
          onAnnotationsChanged={reloadAnnotations}
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

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowDeleteConfirm(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Delete Note</h3>
            <p className="text-gray-600 text-sm mb-6">Are you sure you want to delete &ldquo;{title}&rdquo;? This cannot be undone.</p>
            <div className="flex gap-3">
              <button className="btn-danger flex-1" onClick={confirmDelete}>Delete</button>
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

      {showNotePicker && (
        <NotePickerModal
          onSelect={(id, title) => { insertNoteReference(id, title); setShowNotePicker(false) }}
          onClose={() => setShowNotePicker(false)}
        />
      )}
    </div>
  )
}
