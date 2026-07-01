import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { processCiteTags } from '@/utils/markdown'
import { Sparkles, X, Send, Copy, Check, Plus, Pencil, Trash2, Mic, MicOff, Paperclip, Lock, LockOpen, ListChecks, FileText, History } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useSettingsStore } from '@/stores/settings'
import { useCategoriesStore } from '@/stores/categories'
import { useDictation } from '@/hooks/useDictation'
import { settingsApi } from '@/api/settings'
import { notesApi, type NoteListItem } from '@/api/notes'
import { foldersApi } from '@/api/folders'
import { annotationsApi } from '@/api/annotations'
import { aiSessionsApi, type AISession } from '@/api/aiSessions'
import { extractPlainText, extractLinkedFileUrls, extractBlockTexts } from '@/utils/blocks'
import type { FileAttachment, ConversationTurn } from '@/services/ai'
import {
  parsePlan,
  buildPlanReferenceBlock,
  buildPlanSummary,
  buildContentStepInstruction,
  actionNeedsGeneration,
  PLAN_INSTRUCTIONS,
  defaultActionLabel,
  type Plan,
  type ContextNote,
  type ContextFolder,
  type ContextCategory,
} from '@/services/aiPlan'
import { executePlan, type PlanEditor, type ActionResult } from '@/services/planExecutor'

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

type ContextScope = 'none' | 'note' | 'children' | 'folder' | 'subfolder'

// When replaying the conversation transcript to the planner, strip the note id out
// of `/notes/<id>` links (keeping the visible title). Prior result summaries embed
// these links, and without this the model can latch onto a real note id from an
// earlier turn that isn't in the current context and target the wrong note. Only
// the copy sent to the model is sanitized — the on-screen messages keep their links.
function stripNoteLinks(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\(\/notes\/[^)]*\)/g, '$1')
    .replace(/\/notes\/[0-9a-fA-F-]{8,}/g, 'a note')
}

// Run an async op over items with a concurrency cap (chunked). Used to fan out the
// per-document content-generation calls in parallel without flooding the provider.
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn))
  }
}

// Strip a code fence that wraps an *entire* generation result (the model is told not to add
// one, but be defensive). Fences genuinely inside the body are left untouched.
function stripCodeFence(text: string): string {
  const t = text.trim()
  if (!t.startsWith('```')) return t
  return t.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim()
}

// How many per-document generation calls to run at once (see Phase 2 plan).
const GEN_CONCURRENCY = 5

// Max find_notes retrieval rounds per request (bounds an agentic search loop).
const MAX_SEARCH_ROUNDS = 3

// Everything needed to generate and execute a plan for the current context, split by
// prompt-cache stability: `instructions` + `referenceBlock` form the cacheable prefix,
// while `currentNoteText` is the volatile open-note body sent last (after the cache
// breakpoint) so editing the note doesn't bust the cache. Freezing snapshots this whole
// object so the pinned note/reference content is reused until the user unfreezes.
interface PlanContext {
  instructions: string         // static system block (PLAN_INSTRUCTIONS)
  referenceBlock: string       // id/title lists + other notes' bodies (stable, cacheable)
  referenceContextText: string // just the rendered other-note bodies (kept so find_notes can append and rebuild referenceBlock)
  currentNoteText: string      // live body (+ annotations, attached file text) of the open note
  attachments: FileAttachment[]
  targetNotes: ContextNote[]
  folders: ContextFolder[]
  categories: ContextCategory[]
  labelMap: Map<string, string>
  annotationIds: Set<string>
}

interface PendingPlan {
  plan: Plan
  ctx: PlanContext
  baseMessages: ConversationMessage[]
  // Captured at planning time so the per-document generation calls (run on confirm) rebuild
  // a byte-identical cached prefix — same history + request the planning call used.
  history: ConversationTurn[]
  userRequest: string
}

interface AIConversationPanelProps {
  isOpen: boolean
  onToggle: () => void
  // 'editor' (default): scoped to the open note. 'list': the /notes list-view
  // assistant — no open note, scope is the multiselected notes, sessions are global
  // (null note_id), and it may search the library via find_notes.
  mode?: 'editor' | 'list'
  // List mode: the currently multiselected note ids (the scope for the request).
  getSelectedNoteIds?: () => string[]
  // List mode: called when the assistant runs a find_notes search, so the list view
  // can show the hits (replacing "All notes" with a "Search Results" header).
  onSearchResults?: (query: string, results: NoteListItem[]) => void
  getNoteContext: () => string
  noteId?: string | null
  noteTitle?: string
  noteFolderId?: string | null
  noteSummary?: string | null
  getNoteDocument?: () => unknown[]
  onAddToNote: (text: string) => Promise<void>
  // Plan execution wiring (provided by EditorView)
  editor?: PlanEditor | null
  defaultCategoryId?: string
  currentFolderId?: string | null
  onBeforeExecute?: () => Promise<void> | void
  onCurrentNoteEdited?: () => Promise<void> | void
  onNotesChanged?: () => void
  getAnnotations?: () => { id: string; block_id: string; text: string }[]
  onAnnotationsChanged?: () => Promise<void> | void
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

// Short, human-readable error line shown in the chat. Unwraps the backend's
// `detail`, which for AI-proxy failures holds the upstream API error body.
function errorMessage(e: unknown, fallback = 'An error occurred'): string {
  let msg = e instanceof Error ? e.message : fallback
  const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail
  if (typeof detail === 'string') {
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: string } }
      msg = parsed?.error?.message ?? detail
    } catch { msg = detail }
  } else if (detail && typeof detail === 'object') {
    const m = (detail as Record<string, unknown>).message
    if (typeof m === 'string') msg = m
  }
  return msg
}

// Full error dump for the collapsible "More details" panel: request line, HTTP
// status, and the complete (pretty-printed) response body — so the cause of a
// failure is visible in the chat without reopening the browser devtools.
function formatErrorDetails(e: unknown): string {
  const ax = e as {
    message?: string
    code?: string
    response?: { status?: number; statusText?: string; data?: unknown }
    config?: { method?: string; url?: string }
  }
  const lines: string[] = []
  if (ax.config?.url) lines.push(`${(ax.config.method ?? 'POST').toUpperCase()} ${ax.config.url}`)

  if (ax.response) {
    const { status, statusText, data } = ax.response
    lines.push(`Status: ${status ?? '?'}${statusText ? ` ${statusText}` : ''}`)
    // FastAPI wraps the payload in `detail`; for proxy errors that's the raw
    // upstream response text, often itself JSON — unwrap and parse it so it
    // reads as structured JSON rather than an escaped one-line string.
    let body: unknown = data
    if (data && typeof data === 'object' && 'detail' in (data as Record<string, unknown>)) {
      body = (data as Record<string, unknown>).detail
    }
    if (typeof body === 'string') {
      try { body = JSON.parse(body) } catch { /* leave as plain string */ }
    }
    lines.push('', typeof body === 'string' ? body : safeStringify(body))
  } else if (ax.message) {
    lines.push(ax.message)
    if (ax.code) lines.push(`Code: ${ax.code}`)
  } else if (e instanceof Error) {
    lines.push(e.stack ?? e.message)
  } else {
    lines.push(String(e))
  }
  return lines.join('\n').trim() || 'No additional details available.'
}

function Spinner() {
  return (
    <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  )
}

type ProcessedFile =
  | { kind: 'image'; attachment: FileAttachment; name: string }
  | { kind: 'text'; content: string; name: string }
  | { kind: 'unsupported'; name: string }

async function processFile(file: File): Promise<ProcessedFile> {
  if (file.type.startsWith('image/')) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1]
        resolve({ kind: 'image', name: file.name, attachment: { type: 'image', mimeType: file.type, data: base64, name: file.name } })
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }
  if (file.type === 'application/pdf') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1]
        resolve({ kind: 'image', name: file.name, attachment: { type: 'document', mimeType: 'application/pdf', data: base64, name: file.name } })
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }
  const isText =
    file.type.startsWith('text/') ||
    ['application/json', 'application/xml'].includes(file.type) ||
    /\.(md|txt|json|csv|yaml|yml|toml|xml|js|ts|py|sh|sql)$/i.test(file.name)
  if (isText) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve({ kind: 'text', name: file.name, content: reader.result as string })
      reader.onerror = reject
      reader.readAsText(file)
    })
  }
  return { kind: 'unsupported', name: file.name }
}

async function urlToAttachment(url: string): Promise<FileAttachment | null> {
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const blob = await resp.blob()
    if (!blob.type.startsWith('image/')) return null
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1]
        resolve({ type: 'image', mimeType: blob.type, data: base64, name: url.split('/').pop() ?? 'file' })
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

export default function AIConversationPanel({
  isOpen,
  onToggle,
  mode = 'editor',
  getSelectedNoteIds,
  onSearchResults,
  getNoteContext,
  noteId,
  noteTitle,
  noteFolderId,
  noteSummary,
  getNoteDocument,
  onAddToNote,
  editor,
  defaultCategoryId,
  currentFolderId,
  onBeforeExecute,
  onCurrentNoteEdited,
  onNotesChanged,
  getAnnotations,
  onAnnotationsChanged,
}: AIConversationPanelProps) {
  const isList = mode === 'list'
  // Sessions are available when scoped to a saved note (editor) or in the global
  // list-view assistant (null note_id). A brand-new, unsaved editor note has no id yet.
  const sessionsEnabled = isList || !!noteId
  const aiService = useSettingsStore((s) => s.aiService)
  const deepgramApiKey = useSettingsStore((s) => s.deepgramApiKey)
  const categories = useCategoriesStore((s) => s.categories)

  // Conversation and session state (self-managed — not driven by props)
  const [conversation, setConversation] = useState<ConversationMessage[]>([])
  const [sessions, setSessions] = useState<AISession[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')

  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Full request/response dump for the failed call, shown in a collapsible panel
  // under the short error message. Empty when there's nothing extra to show.
  const [errorDetails, setErrorDetails] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [isMobile, setIsMobile] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 640 : false))
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('ai-panel-width') || '320') } catch { return 320 }
  })
  const [panelHeight, setPanelHeight] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('ai-panel-height') || '288') } catch { return 288 }
  })

  // Context scope state
  const [contextScope, setContextScope] = useState<ContextScope>(() => {
    try { return (localStorage.getItem('ai-context-scope') as ContextScope) ?? 'note' } catch { return 'note' }
  })
  const [useSummaries, setUseSummaries] = useState(() => {
    try { return localStorage.getItem('ai-use-summaries') === 'true' } catch { return false }
  })
  const [includeLinkedFiles, setIncludeLinkedFiles] = useState(() => {
    try { return localStorage.getItem('ai-include-linked-files') === 'true' } catch { return false }
  })
  // Plan mode: when on, multi-step plans are previewed for confirmation before
  // they run. Defaults to on for first-run safety.
  const [planMode, setPlanMode] = useState(() => {
    try { return localStorage.getItem('ai-plan-mode') !== 'false' } catch { return true }
  })
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null)
  const [selectedSteps, setSelectedSteps] = useState<boolean[]>([])
  const [executing, setExecuting] = useState(false)
  const [generating, setGenerating] = useState(false)  // Phase 2: filling deferred note bodies
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [frozenContext, setFrozenContext] = useState<PlanContext | null>(null)
  const [freezing, setFreezing] = useState(false)

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isMobileRef = useRef(isMobile)
  const panelWidthRef = useRef(panelWidth)
  const panelHeightRef = useRef(panelHeight)

  const handleDictationResult = useCallback((text: string) => {
    const newInput = input.trim() ? `${input.trim()} ${text}` : text
    setInput(newInput)
    setTimeout(() => {
      if (newInput.trim() && !loading && aiService) {
        void handleSend(newInput, conversation)
      }
    }, 0)
  }, [input, loading, aiService, conversation])

  const transcribeAudio = useCallback(
    (blob: Blob) => settingsApi.transcribeAudio(blob),
    [],
  )
  const dictation = useDictation(handleDictationResult, {
    transcribeAudio: deepgramApiKey ? transcribeAudio : undefined,
  })

  // Reset step selection (all checked) whenever a new plan is ready to review.
  useEffect(() => {
    setSelectedSteps(pendingPlan?.plan.actions.map(() => true) ?? [])
  }, [pendingPlan])

  useEffect(() => { isMobileRef.current = isMobile }, [isMobile])
  useEffect(() => { panelWidthRef.current = panelWidth }, [panelWidth])
  useEffect(() => { panelHeightRef.current = panelHeight }, [panelHeight])

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 640)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  useEffect(() => {
    try { localStorage.setItem('ai-panel-width', String(panelWidth)) } catch { /* noop */ }
  }, [panelWidth])

  useEffect(() => {
    try { localStorage.setItem('ai-panel-height', String(panelHeight)) } catch { /* noop */ }
  }, [panelHeight])

  // Load sessions for the current note whenever noteId changes
  useEffect(() => {
    setConversation([])
    setCurrentSessionId(null)
    setSessions([])
    setShowHistory(false)
    if (!sessionsEnabled) return
    aiSessionsApi.list(noteId ?? null).then((data) => {
      setSessions(data)
      if (data.length > 0) {
        const latest = data[0]
        setCurrentSessionId(latest.id)
        try { setConversation(JSON.parse(latest.messages) as ConversationMessage[]) } catch { setConversation([]) }
        setContextScope(latest.context_scope as ContextScope)
        setUseSummaries(latest.use_summaries)
        setIncludeLinkedFiles(latest.include_linked_files)
        setPlanMode(latest.plan_mode)
      }
    }).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId])

  useEffect(() => {
    try { localStorage.setItem('ai-context-scope', contextScope) } catch { /* noop */ }
  }, [contextScope])

  useEffect(() => {
    try { localStorage.setItem('ai-use-summaries', String(useSummaries)) } catch { /* noop */ }
  }, [useSummaries])

  useEffect(() => {
    try { localStorage.setItem('ai-include-linked-files', String(includeLinkedFiles)) } catch { /* noop */ }
  }, [includeLinkedFiles])

  useEffect(() => {
    try { localStorage.setItem('ai-plan-mode', String(planMode)) } catch { /* noop */ }
  }, [planMode])

  // Auto-unfreeze when scope settings change — frozen context is now stale
  useEffect(() => {
    setFrozenContext(null)
  }, [contextScope, useSummaries, includeLinkedFiles])

  useEffect(() => {
    if (!isOpen) return
    // Scroll the message list itself rather than scrollIntoView on an anchor:
    // scrollIntoView walks up and scrolls every scrollable ancestor (even an
    // overflow-hidden one is programmatically scrollable), which would scroll
    // the whole page and clip the note header.
    const el = messagesContainerRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [conversation, loading, isOpen])

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = `${inputRef.current.scrollHeight}px`
    }
  }, [input])

  useEffect(() => {
    if (editRef.current) {
      editRef.current.style.height = 'auto'
      editRef.current.style.height = `${editRef.current.scrollHeight}px`
    }
  }, [editText])

  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startWidth = panelWidthRef.current
    const startHeight = panelHeightRef.current

    function onMouseMove(ev: MouseEvent) {
      if (isMobileRef.current) {
        const delta = startY - ev.clientY
        const newHeight = Math.max(150, Math.min(600, startHeight + delta))
        setPanelHeight(newHeight)
      } else {
        const delta = startX - ev.clientX
        const newWidth = Math.max(200, Math.min(700, startWidth + delta))
        setPanelWidth(newWidth)
      }
    }

    function onMouseUp() {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }

    document.body.style.userSelect = 'none'
    document.body.style.cursor = isMobileRef.current ? 'ns-resize' : 'ew-resize'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  async function persistCurrentSession(msgs: ConversationMessage[], sessionId?: string | null) {
    const sid = sessionId ?? currentSessionId
    if (!sid || !sessionsEnabled) return
    try {
      const updated = await aiSessionsApi.update(noteId ?? null, sid, {
        messages: JSON.stringify(msgs),
        context_scope: contextScope,
        use_summaries: useSummaries,
        include_linked_files: includeLinkedFiles,
        plan_mode: planMode,
      })
      setSessions((prev) =>
        [updated, ...prev.filter((s) => s.id !== sid)]
      )
    } catch { /* best-effort */ }
  }

  async function autoCreateSession(firstMessage: string): Promise<string | null> {
    if (!sessionsEnabled) return null
    const name = firstMessage.length > 50 ? `${firstMessage.slice(0, 47)}…` : firstMessage
    try {
      const session = await aiSessionsApi.create(noteId ?? null, {
        name,
        messages: '[]',
        context_scope: contextScope,
        use_summaries: useSummaries,
        include_linked_files: includeLinkedFiles,
        plan_mode: planMode,
      })
      setCurrentSessionId(session.id)
      setSessions((prev) => [session, ...prev])
      return session.id
    } catch { return null }
  }

  async function handleNewSession() {
    if (currentSessionId && conversation.length > 0) {
      await persistCurrentSession(conversation)
    }
    setConversation([])
    setCurrentSessionId(null)
    setFrozenContext(null)
    setPendingPlan(null)
    setShowHistory(false)
  }

  function handleOpenSession(session: AISession) {
    try {
      setConversation(JSON.parse(session.messages) as ConversationMessage[])
    } catch {
      setConversation([])
    }
    setCurrentSessionId(session.id)
    setContextScope(session.context_scope as ContextScope)
    setUseSummaries(session.use_summaries)
    setIncludeLinkedFiles(session.include_linked_files)
    setPlanMode(session.plan_mode)
    setFrozenContext(null)
    setPendingPlan(null)
    setShowHistory(false)
  }

  async function handleDeleteSession(id: string) {
    if (!sessionsEnabled) return
    try {
      await aiSessionsApi.remove(noteId ?? null, id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
      if (currentSessionId === id) {
        setConversation([])
        setCurrentSessionId(null)
      }
    } catch { /* best-effort */ }
  }

  async function handleRenameSession(id: string, newName: string) {
    if (!sessionsEnabled || !newName.trim()) { setRenamingId(null); return }
    try {
      const updated = await aiSessionsApi.update(noteId ?? null, id, { name: newName.trim() })
      setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)))
    } catch { /* best-effort */ }
    setRenamingId(null)
  }

  // Give the model the note's real Markdown (headings/bold/lists/links) instead of
  // plain text, so it can preserve formatting when editing/replacing. Falls back to
  // plain text if the editor is unavailable or conversion throws (e.g. custom blocks).
  // In list mode the editor is a headless instance created purely for conversion.
  const blocksToMarkdown = (blocks: unknown[]): string => {
    if (!editor) return extractPlainText(blocks)
    try { return editor.blocksToMarkdownLossy(blocks) || extractPlainText(blocks) }
    catch { return extractPlainText(blocks) }
  }

  // Fetch full note bodies by id and render each as Markdown (a NoteListItem only carries
  // a preview). Shared by the list-view selection scope and the find_notes results.
  type ScopeNote = { id?: string; title: string; content: string; summary?: string | null; blocks: unknown[] }
  const fetchNotesById = async (ids: string[]): Promise<ScopeNote[]> => {
    const fetched = await Promise.all(ids.map((id) => notesApi.get(id)))
    return fetched.map((r) => {
      let blocks: unknown[] = []
      try { blocks = JSON.parse(r.data.content) } catch { /* ignore */ }
      return { id: r.data.id, title: r.data.title, content: blocksToMarkdown(blocks), summary: r.data.summary, blocks }
    })
  }

  async function buildScopeContext(): Promise<{ referenceContextText: string; currentNoteText: string; attachments: FileAttachment[]; targetNotes: ContextNote[]; annotationIds: Set<string> }> {
    const fileAttachments: FileAttachment[] = []
    const annotationIds = new Set<string>()

    if (!isList && contextScope === 'none') {
      const processed = await Promise.all(pendingFiles.map(processFile))
      const imgs = processed.filter((p): p is Extract<ProcessedFile, {kind:'image'}> => p.kind === 'image')
      return { referenceContextText: '', currentNoteText: '', attachments: imgs.map(p => p.attachment), targetNotes: [], annotationIds }
    }

    // `id` is carried through so the model can target each note in plan actions.
    let notes: ScopeNote[] = []

    if (isList) {
      // List-view assistant: scope is the multiselected notes. With no selection the
      // context has no note bodies — the model is expected to use find_notes to locate them.
      const ids = getSelectedNoteIds?.() ?? []
      notes = ids.length ? await fetchNotesById(ids.slice(0, 50)) : []
    } else if (contextScope === 'note') {
      const blocks = getNoteDocument?.() ?? []
      notes = [{ id: noteId ?? undefined, title: noteTitle ?? '', content: blocksToMarkdown(blocks), summary: noteSummary, blocks }]
    } else {
      // Fetch list items, then get full content for each (NoteListItem only has content_preview)
      let listItems: { id: string }[] = []

      if (contextScope === 'children' && noteId) {
        const res = await notesApi.listChildren(noteId)
        listItems = res.data.slice(0, 50)
      } else if (contextScope === 'folder') {
        const res = await notesApi.list({
          folder_id: noteFolderId ?? undefined,
          in_folder: true,
          include_children: true,
          limit: 50,
        })
        listItems = res.data
      } else if (contextScope === 'subfolder') {
        const res = await notesApi.list({
          folder_id: noteFolderId ?? undefined,
          in_folder: true,
          recursive: true,
          include_children: true,
          limit: 50,
        })
        listItems = res.data
      }

      notes = await fetchNotesById(listItems.map((item) => item.id))

      // Prepend current note for children scope
      if (contextScope === 'children') {
        const curBlocks = getNoteDocument?.() ?? []
        notes.unshift({ id: noteId ?? undefined, title: noteTitle ?? '', content: blocksToMarkdown(curBlocks), summary: noteSummary, blocks: curBlocks })
      }
    }

    // Render one note as labelled Markdown (heading carries its id so the model can
    // target it) plus its annotations, recording annotation ids for executor validation.
    const renderNote = async (n: typeof notes[number]): Promise<string> => {
      const body = (useSummaries && n.summary) ? n.summary : n.content
      const heading = n.id
        ? `## ${n.title || 'This note'} [id: ${n.id}]`
        : (n.title ? `## ${n.title}` : '')
      let annoSection = ''
      if (n.id) {
        let list: { id: string; block_id: string; text: string }[] = []
        try {
          list = (n.id === noteId && getAnnotations) ? getAnnotations() : (await annotationsApi.list(n.id)).data
        } catch { list = [] }
        if (list.length) {
          const blockMap = new Map(extractBlockTexts(n.blocks).map((b) => [b.id, b.text]))
          const lines = list.map((a) => {
            annotationIds.add(a.id)
            const snippet = (blockMap.get(a.block_id) ?? '').trim().slice(0, 80) || '(unknown block)'
            return `- [annotation ${a.id}] anchored to "${snippet}": ${a.text || '(empty)'}`
          })
          annoSection = `\n\n**Annotations on this note:**\n${lines.join('\n')}`
        }
      }
      const base = heading ? `${heading}\n\n${body}` : body
      return base + annoSection
    }

    const targetNotes: ContextNote[] = notes
      .filter((n): n is typeof n & { id: string } => Boolean(n.id))
      .map((n) => ({ id: n.id, title: n.title || 'Untitled' }))

    // Collect linked file URLs (images only — others not supported as content blocks)
    if (includeLinkedFiles) {
      const allUrls = notes.flatMap((n) => extractLinkedFileUrls(n.blocks))
      const fetched = await Promise.all(allUrls.map(urlToAttachment))
      fileAttachments.push(...(fetched.filter(Boolean) as FileAttachment[]))
    }

    // Split the open note from the rest. Its body is volatile (the user edits it most
    // turns), so it travels in the final, uncached message; the other notes are part of
    // the stable, cacheable reference block. For 'note' scope the single note IS the
    // current one even if it has no id yet (a freshly created, unsaved note).
    const rendered = await Promise.all(notes.map(renderNote))
    // List mode has no open note, so nothing is the "current" (volatile) note — all
    // selected notes go into the cacheable reference block.
    const currentIndex = (!isList && contextScope === 'note')
      ? 0
      : notes.findIndex((n) => Boolean(n.id) && n.id === noteId)
    const currentNoteParts: string[] = currentIndex >= 0 ? [rendered[currentIndex]] : []
    const referenceContextText = rendered.filter((_, i) => i !== currentIndex).join('\n\n---\n\n')

    // Pending uploaded files — images go as content blocks; text/other ride with the
    // volatile current-note message (they change per upload, so keep them out of cache).
    const processed = await Promise.all(pendingFiles.map(processFile))
    const fileTextParts: string[] = []
    for (const p of processed) {
      if (p.kind === 'image') {
        fileAttachments.push(p.attachment)
      } else if (p.kind === 'text') {
        fileTextParts.push(`### ${p.name}\n\`\`\`\n${p.content}\n\`\`\``)
      } else {
        fileTextParts.push(`### ${p.name}\n*(file type not supported for AI context)*`)
      }
    }
    if (fileTextParts.length > 0) {
      currentNoteParts.push(`**Attached files:**\n\n${fileTextParts.join('\n\n')}`)
    }

    return {
      referenceContextText,
      currentNoteText: currentNoteParts.join('\n\n---\n\n'),
      attachments: fileAttachments,
      targetNotes,
      annotationIds,
    }
  }

  // Assemble everything the planner needs, split by cache stability: the static
  // instructions + the reference block (cacheable prefix) and the live current-note
  // body (volatile, sent last). Folders/categories come from the store/API so the model
  // can move notes, retag, and create folders.
  async function buildPlanContext(): Promise<PlanContext> {
    const { referenceContextText, currentNoteText, attachments, targetNotes, annotationIds } = await buildScopeContext()

    let folders: ContextFolder[] = []
    try {
      const res = await foldersApi.list()
      folders = res.data.map((f) => ({ id: f.id, name: f.name }))
    } catch { /* folders are optional context */ }

    const cats: ContextCategory[] = categories.map((c) => ({ id: c.id, label: c.label }))

    const labelMap = new Map<string, string>()
    targetNotes.forEach((n) => labelMap.set(n.id, n.title || 'Untitled'))
    folders.forEach((f) => labelMap.set(f.id, f.name))
    cats.forEach((c) => labelMap.set(c.id, c.label))

    const referenceBlock = buildPlanReferenceBlock({ referenceContextText, targetNotes, folders, categories: cats })
    return { instructions: PLAN_INSTRUCTIONS, referenceBlock, referenceContextText, currentNoteText, attachments, targetNotes, folders, categories: cats, labelMap, annotationIds }
  }

  async function handleFreeze() {
    if (frozenContext) {
      setFrozenContext(null)
      return
    }
    setFreezing(true)
    try {
      setFrozenContext(await buildPlanContext())
    } catch (e) {
      setError(errorMessage(e, 'Failed to freeze context'))
      setErrorDetails(formatErrorDetails(e))
    } finally {
      setFreezing(false)
    }
  }

  function assistantMsg(content: string): ConversationMessage {
    return { id: uid(), role: 'assistant', content, timestamp: new Date().toISOString() }
  }

  // Turn the per-action results into one assistant chat message: respond actions
  // render as their text, mutations as a ✓/✗ line.
  function buildResultSummary(results: ActionResult[]): string {
    // Respond-kind actions emit text (rare in mutation plans) — show above the table.
    const respondParts = results.filter((r) => r.kind === 'respond').map((r) => r.message)
    const mutationRows = results
      .filter((r) => r.kind !== 'respond')
      .map((r) => {
        const icon = r.ok ? '✅' : '❌'
        const pill = r.ok && r.noteId && r.noteTitle ? ` [${r.noteTitle}](/notes/${r.noteId})` : ''
        return `| ${icon} | ${r.message}${pill} |`
      })
    const parts: string[] = []
    if (respondParts.length) parts.push(respondParts.join('\n\n'))
    if (mutationRows.length) parts.push(['| | |', '|:---:|:---|', ...mutationRows].join('\n'))
    const failures = results.filter((r) => r.kind !== 'respond' && !r.ok).length
    const text = parts.join('\n\n')
    return failures > 0 ? `${text}\n\n_(${failures} action${failures === 1 ? '' : 's'} could not be completed.)_` : text
  }

  // Phase 2: fill in deferred note bodies. For each action that declared a `spec` but left
  // `content` empty, make a per-document generation call that reuses the planning call's
  // cached prefix (same instructions/reference/history/current-note + request) and appends
  // [assistant: <compact plan>, user: <step instruction>]. Runs in parallel (capped). Mutates
  // the successful actions' `content` in place; returns a runnable plan with any failed
  // actions removed plus their failures as result rows.
  async function generatePlanContent(
    plan: Plan,
    ctx: PlanContext,
    history: ConversationTurn[],
    userRequest: string,
  ): Promise<{ plan: Plan; genFailures: ActionResult[] }> {
    const svc = aiService
    const targets = plan.actions
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => actionNeedsGeneration(action))
    if (!targets.length || !svc) return { plan, genFailures: [] }

    const planSummary = buildPlanSummary(plan)
    const genFailures: ActionResult[] = []
    const failedIdx = new Set<number>()

    await mapWithConcurrency(targets, GEN_CONCURRENCY, async ({ action, index }) => {
      try {
        const raw = await svc.completeConversation({
          instructions: ctx.instructions,
          referenceBlock: ctx.referenceBlock,
          currentNoteText: ctx.currentNoteText || undefined,
          history,
          userRequest,
          followups: [
            { role: 'assistant', content: planSummary },
            { role: 'user', content: buildContentStepInstruction(action, index, ctx.labelMap) },
          ],
          temperature: 0,
          enableWebSearch: false,
        })
        const body = stripCodeFence(raw)
        if (!body.trim()) throw new Error('the model returned an empty body')
        ;(action as { content: string }).content = body
      } catch (e) {
        failedIdx.add(index)
        genFailures.push({ ok: false, message: `Couldn't write “${defaultActionLabel(action, ctx.labelMap)}”: ${errorMessage(e)}` })
      }
    })

    return { plan: { actions: plan.actions.filter((_, i) => !failedIdx.has(i)) }, genFailures }
  }

  async function runPlan(
    plan: Plan,
    ctx: PlanContext,
    baseMessages: ConversationMessage[],
    history: ConversationTurn[],
    userRequest: string,
  ) {
    if (!editor) {
      setError('Editor is not ready yet — try again in a moment.')
      setPendingPlan(null)
      return
    }
    setExecuting(true)
    try {
      // Phase 2: write any deferred note bodies (spec → content) before executing. Engaged
      // only when at least one action deferred its body; otherwise this is a no-op.
      let runnable = plan
      let genFailures: ActionResult[] = []
      if (plan.actions.some(actionNeedsGeneration)) {
        setGenerating(true)
        try {
          const out = await generatePlanContent(plan, ctx, history, userRequest)
          runnable = out.plan
          genFailures = out.genFailures
        } finally {
          setGenerating(false)
        }
      }

      // Flush any unsaved edits to the open note so amend/append build on the
      // latest content and a later re-hydrate won't clobber the user's typing.
      await onBeforeExecute?.()

      const execResults = await executePlan(runnable, {
        editor,
        currentNoteId: noteId ?? null,
        defaultCategoryId: defaultCategoryId ?? '',
        currentFolderId: currentFolderId ?? null,
        validNoteIds: new Set(ctx.targetNotes.map((n) => n.id)),
        validFolderIds: new Set(ctx.folders.map((f) => f.id)),
        validCategoryIds: new Set(ctx.categories.map((c) => c.id)),
        validAnnotationIds: ctx.annotationIds,
      })
      // Generation failures (excluded from execution) are surfaced alongside execution rows.
      const results = [...genFailures, ...execResults]

      const finalMessages = [
        ...baseMessages,
        assistantMsg(buildResultSummary(results)),
        assistantMsg('_Plan completed._'),
      ]

      // Refresh in-memory note state (re-fetch + re-hydrate for content/title/tag/category changes).
      if (results.some((r) => r.notesChanged)) onNotesChanged?.()
      if (results.some((r) => r.touchedCurrentNote)) await onCurrentNoteEdited?.()
      if (results.some((r) => r.annotationsChanged)) await onAnnotationsChanged?.()

      setConversation(finalMessages)
      await persistCurrentSession(finalMessages)
    } catch (e) {
      setError(errorMessage(e, 'Failed to run plan'))
      setErrorDetails(formatErrorDetails(e))
    } finally {
      setExecuting(false)
      setPendingPlan(null)
    }
  }

  function cancelPlan() {
    if (!pendingPlan) return
    const cancelled = [...pendingPlan.baseMessages, assistantMsg('_Plan cancelled._')]
    setConversation(cancelled)
    void persistCurrentSession(cancelled)
    setPendingPlan(null)
  }

  async function handleSend(userContent: string, priorMessages: ConversationMessage[]) {
    if (!userContent.trim() || !aiService || loading || executing || pendingPlan) return
    setError('')
    setErrorDetails('')

    const userMsg: ConversationMessage = {
      id: uid(),
      role: 'user',
      content: userContent.trim(),
      timestamp: new Date().toISOString(),
    }
    const withUser = [...priorMessages, userMsg]
    setConversation(withUser)
    setInput('')
    setLoading(true)

    // Auto-create a session on the first message if one doesn't exist yet
    let sessionId = currentSessionId
    if (!sessionId && sessionsEnabled) {
      sessionId = await autoCreateSession(userContent.trim())
    }

    try {
      const svc = aiService
      const userRequest = userContent.trim()

      // Use frozen context if locked; otherwise build fresh from current scope.
      const isFrozen = frozenContext !== null
      let ctx = isFrozen ? frozenContext! : await buildPlanContext()

      // Prior turns become real message turns (note-link-stripped so the model can't
      // latch onto a stale id from an old result summary). The live current-note body
      // and the new request are sent last, after the cache breakpoint.
      let history = priorMessages
        .map((m) => ({ role: m.role, content: stripNoteLinks(m.content) }))
        .filter((m) => m.content.trim().length > 0) // drop empty turns (invalid as text blocks)

      // No prefill: it behaves inconsistently across providers (Anthropic continues from
      // it; OpenAI/Ollama prepend it to a fresh full-JSON reply, yielding "{{"). The
      // instructions ask for JSON-only and parsePlan tolerantly extracts the object, so
      // temperature:0 alone is enough.
      const planOnce = async (): Promise<Plan> => parsePlan(await svc.completeConversation({
        instructions: ctx.instructions,
        referenceBlock: ctx.referenceBlock,
        currentNoteText: ctx.currentNoteText || undefined,
        history,
        userRequest,
        attachments: ctx.attachments.length ? ctx.attachments : undefined,
        temperature: 0,
        enableWebSearch: true,
      }))

      let plan = await planOnce()
      setPendingFiles([])

      // find_notes is a retrieval step: run the search(es), surface the hits in the list
      // view, fold the found notes into the planning context, then re-plan so the model
      // can act on them. Bounded so a looping model can't search forever.
      let searchRounds = 0
      while (searchRounds < MAX_SEARCH_ROUNDS && plan.actions.some((a) => a.type === 'find_notes')) {
        searchRounds++
        const queries: string[] = []
        for (const a of plan.actions) if (a.type === 'find_notes') queries.push(a.query)

        // Search the library; dedupe hits across all queries in this round.
        const seen = new Set<string>()
        const foundListItems: NoteListItem[] = []
        for (const q of queries) {
          try {
            const res = await notesApi.list({ search: q, limit: 50 })
            for (const item of res.data) {
              if (!seen.has(item.id)) { seen.add(item.id); foundListItems.push(item) }
            }
          } catch { /* skip a failed search */ }
        }

        // Reflect the search in the list view (Search Results header + populated results).
        if (queries[0] !== undefined) onSearchResults?.(queries[0], foundListItems)

        // Fetch full bodies and fold them into the context so the model can consolidate/edit them.
        const foundNotes = foundListItems.length ? await fetchNotesById(foundListItems.slice(0, 50).map((i) => i.id)) : []
        const foundTargets: ContextNote[] = foundNotes
          .filter((n): n is typeof n & { id: string } => Boolean(n.id))
          .map((n) => ({ id: n.id, title: n.title || 'Untitled' }))
        const foundRendered = foundNotes.map((n) =>
          `## ${n.title || 'Untitled'} [id: ${n.id}]\n\n${(useSummaries && n.summary) ? n.summary : n.content}`)

        const mergedTargets: ContextNote[] = [...ctx.targetNotes]
        const mergedIds = new Set(mergedTargets.map((n) => n.id))
        for (const t of foundTargets) if (!mergedIds.has(t.id)) { mergedIds.add(t.id); mergedTargets.push(t) }
        const mergedRefText = [ctx.referenceContextText, ...foundRendered].filter(Boolean).join('\n\n---\n\n')
        const mergedLabelMap = new Map(ctx.labelMap)
        mergedTargets.forEach((n) => mergedLabelMap.set(n.id, n.title || 'Untitled'))
        ctx = {
          ...ctx,
          referenceContextText: mergedRefText,
          referenceBlock: buildPlanReferenceBlock({ referenceContextText: mergedRefText, targetNotes: mergedTargets, folders: ctx.folders, categories: ctx.categories }),
          targetNotes: mergedTargets,
          labelMap: mergedLabelMap,
        }

        // Record the search as a turn so the model sees its own query and the results.
        const resultLines = foundNotes.map((n) => `- ${n.id} — ${n.title || 'Untitled'}`).join('\n')
        const summary = foundListItems.length
          ? `Search results for ${queries.map((q) => `"${q}"`).join(', ')} — ${foundListItems.length} note(s), now added to your context above:\n${resultLines}\n\nContinue with the original request: reply, or emit actions targeting these note ids.`
          : `Search for ${queries.map((q) => `"${q}"`).join(', ')} returned no notes. Continue with the original request (e.g. tell the user nothing matched).`
        history = [
          ...history,
          { role: 'assistant', content: JSON.stringify({ actions: queries.map((q) => ({ type: 'find_notes', query: q })) }) },
          { role: 'user', content: summary },
        ]

        plan = await planOnce()
      }

      // Drop any leftover find_notes (retrieval-only; never executed by planExecutor).
      if (plan.actions.some((a) => a.type === 'find_notes')) {
        plan = { actions: plan.actions.filter((a) => a.type !== 'find_notes') }
        if (plan.actions.length === 0) plan = { actions: [{ type: 'respond', text: '_(No matching notes found.)_' }] }
      }

      const onlyRespond = plan.actions.every((a) => a.type === 'respond')

      if (onlyRespond) {
        // Respond-only results display immediately as a normal chat message — no
        // preview — even when Plan mode is on.
        const text =
          plan.actions
            .map((a) => (a.type === 'respond' ? a.text : ''))
            .filter(Boolean)
            .join('\n\n') || '(no response)'
        const responded = [...withUser, assistantMsg(text)]
        setConversation(responded)
        void persistCurrentSession(responded, sessionId)
      } else if (planMode) {
        setPendingPlan({ plan, ctx, baseMessages: withUser, history, userRequest: userContent.trim() })
      } else {
        await runPlan(plan, ctx, withUser, history, userContent.trim())
      }
    } catch (e: unknown) {
      setError(errorMessage(e))
      setErrorDetails(formatErrorDetails(e))
      // Keep the user's question in the chat (and persist it) even though the
      // request failed — reverting to priorMessages would silently discard what
      // they typed. They can retry by editing the message.
      setConversation(withUser)
      void persistCurrentSession(withUser, sessionId)
    } finally {
      setLoading(false)
    }
  }

  function handleEdit(idx: number) {
    const priorMessages = conversation.slice(0, idx)
    setEditingId(null)
    setEditText('')
    void handleSend(editText, priorMessages)
  }

  function handleCopy(content: string, id: string) {
    void navigator.clipboard.writeText(content).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    })
  }

  function handleDelete(idx: number) {
    const updated = [...conversation.slice(0, idx), ...conversation.slice(idx + 1)]
    setConversation(updated)
    void persistCurrentSession(updated)
  }

  if (!isOpen) {
    return (
      <div className="shrink-0 flex sm:flex-col items-center justify-center no-print">
        <button
          onClick={onToggle}
          className="sm:h-full w-full sm:w-9 flex sm:flex-col items-center justify-center gap-2 px-3 sm:px-0 py-2 sm:py-0 border-t sm:border-t-0 sm:border-l border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:text-blue-500 text-gray-400 transition-colors"
          title="Open AI Chat"
        >
          <Sparkles className="w-4 h-4" />
          <span className="text-xs sm:hidden">AI Chat</span>
          <span className="hidden sm:block text-xs font-medium tracking-widest" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
            AI Chat
          </span>
        </button>
      </div>
    )
  }

  const containerStyle = isMobile ? { height: panelHeight } : { width: panelWidth }

  return (
    <div
      className="relative flex flex-col shrink-0 border-t sm:border-t-0 sm:border-l border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-900 no-print"
      style={containerStyle}
    >
      {/* Resize handle */}
      <div
        className={`absolute z-10 transition-colors hover:bg-blue-400/40 active:bg-blue-400/60 ${
          isMobile
            ? 'top-0 left-0 right-0 h-1.5 cursor-ns-resize'
            : 'top-0 bottom-0 left-0 w-1.5 cursor-ew-resize'
        }`}
        onMouseDown={startResize}
      />

      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <Sparkles className="w-4 h-4 text-blue-500" />
          AI Assistant
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void handleNewSession()}
            className="btn-ghost p-1"
            title="New session"
            disabled={!sessionsEnabled}
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowHistory((v) => !v)}
            className={`btn-ghost p-1 ${showHistory ? 'text-blue-500' : ''}`}
            title="Session history"
            disabled={!sessionsEnabled}
          >
            <History className="w-4 h-4" />
          </button>
          <button onClick={onToggle} className="btn-ghost p-1" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Session history panel */}
      {showHistory && (
        <div className="absolute inset-x-0 top-[41px] bottom-0 z-20 bg-white dark:bg-gray-900 border-t border-gray-100 dark:border-gray-700 flex flex-col overflow-hidden">
          <div className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide border-b border-gray-100 dark:border-gray-700 shrink-0">
            Session History
          </div>
          <div className="flex-1 overflow-y-auto">
            {sessions.length === 0 && (
              <div className="px-3 py-6 text-sm text-gray-400 text-center">No sessions yet.</div>
            )}
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`group flex items-center gap-1 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer border-b border-gray-50 dark:border-gray-800 ${
                  session.id === currentSessionId ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                }`}
              >
                {renamingId === session.id ? (
                  <input
                    autoFocus
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onBlur={() => void handleRenameSession(session.id, renameText || session.name)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleRenameSession(session.id, renameText || session.name)
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    className="flex-1 text-sm input py-0.5"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div className="flex-1 min-w-0" onClick={() => handleOpenSession(session)}>
                    <div className="text-sm text-gray-800 dark:text-gray-100 truncate">{session.name}</div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {new Date(session.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </div>
                  </div>
                )}
                {renamingId !== session.id && (
                  <>
                    <button
                      className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-blue-500 transition-colors shrink-0"
                      title="Rename"
                      onClick={(e) => { e.stopPropagation(); setRenamingId(session.id); setRenameText(session.name) }}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-colors shrink-0"
                      title="Delete session"
                      onClick={(e) => { e.stopPropagation(); void handleDeleteSession(session.id) }}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Message list */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-4 min-h-0">
        {!aiService && (
          <div className="text-center py-8 text-sm text-gray-400 space-y-2">
            <Sparkles className="w-8 h-8 mx-auto text-gray-300" />
            <p>No AI provider configured.</p>
            <Link to="/settings/ai-providers" className="text-blue-500 hover:underline text-xs">
              Configure AI →
            </Link>
          </div>
        )}

        {aiService && conversation.length === 0 && !loading && (
          <div className="text-center py-8 text-sm text-gray-400 space-y-1">
            <Sparkles className="w-8 h-8 mx-auto text-gray-300" />
            <p>Ask about your notes — or tell me to create, edit, rename, or organise them.</p>
          </div>
        )}

        {conversation.map((msg, idx) =>
          msg.role === 'user' ? (
            <div key={msg.id} className="flex flex-col items-end gap-1">
              {editingId === msg.id ? (
                <div className="w-full space-y-1">
                  <textarea
                    ref={editRef}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEdit(idx) }
                      if (e.key === 'Escape') { setEditingId(null); setEditText('') }
                    }}
                    rows={1}
                    className="w-full resize-none input text-sm py-1.5 max-h-28 overflow-y-auto"
                    autoFocus
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                      onClick={() => { setEditingId(null); setEditText('') }}
                    >
                      Cancel
                    </button>
                    <button
                      className="text-xs px-2.5 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors"
                      disabled={!editText.trim() || loading}
                      onClick={() => handleEdit(idx)}
                    >
                      Send
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="max-w-[85%] bg-blue-600 text-white rounded-2xl rounded-tr-sm px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words">
                    {msg.content}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      className="text-gray-300 hover:text-gray-500 dark:hover:text-gray-400 transition-colors p-0.5"
                      title="Edit message"
                      onClick={() => { setEditingId(msg.id); setEditText(msg.content) }}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      className="text-gray-300 hover:text-red-400 transition-colors p-0.5"
                      title="Delete from here"
                      onClick={() => handleDelete(idx)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div key={msg.id} className="flex flex-col items-start gap-1">
              <div className="max-w-[85%] bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-2xl rounded-tl-sm px-3 py-2 text-sm leading-relaxed break-words">
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
                      a: ({ href, children }) => {
                        if (href?.startsWith('/notes/')) {
                          return (
                            <Link to={href} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors no-underline">
                              <FileText className="w-3 h-3 shrink-0" />
                              <span>{children}</span>
                            </Link>
                          )
                        }
                        if (href?.startsWith('/'))
                          return <Link to={href} className="text-blue-600 dark:text-blue-400 underline hover:no-underline">{children}</Link>
                        return <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 underline hover:no-underline">{children}</a>
                      },
                      ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 my-1">{children}</ul>,
                      ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 my-1">{children}</ol>,
                      code: ({ children }) => <code className="bg-gray-200 dark:bg-gray-700 rounded px-1 font-mono text-xs">{children}</code>,
                      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                      table: ({ children }) => <div className="overflow-x-auto my-2"><table className="min-w-full border-collapse text-xs">{children}</table></div>,
                      thead: ({ children }) => <thead className="bg-gray-200 dark:bg-gray-700">{children}</thead>,
                      tbody: ({ children }) => <tbody className="divide-y divide-gray-200 dark:divide-gray-600">{children}</tbody>,
                      tr: ({ children }) => <tr className="even:bg-gray-50 dark:even:bg-gray-750">{children}</tr>,
                      th: ({ children }) => <th className="px-2 py-1 text-left font-semibold border border-gray-300 dark:border-gray-600">{children}</th>,
                      td: ({ children }) => <td className="px-2 py-1 border border-gray-300 dark:border-gray-600">{children}</td>,
                    }}
                  >
                    {processCiteTags(msg.content)}
                  </ReactMarkdown>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                  title="Copy response"
                  onClick={() => handleCopy(msg.content, msg.id)}
                >
                  {copiedId === msg.id ? (
                    <><Check className="w-3 h-3 text-green-500" /><span className="text-green-500">Copied</span></>
                  ) : (
                    <><Copy className="w-3 h-3" />Copy</>
                  )}
                </button>
                {!isList && (
                  <button
                    className="flex items-center gap-1 text-xs text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors px-1.5 py-0.5 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20"
                    title="Add to note"
                    onClick={() => void onAddToNote(msg.content)}
                  >
                    <Plus className="w-3 h-3" />Add to note
                  </button>
                )}
                <button
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 transition-colors px-1.5 py-0.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20"
                  title="Delete from here"
                  onClick={() => handleDelete(idx)}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          )
        )}

        {loading && (
          <div className="flex items-start gap-2">
            <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl rounded-tl-sm px-3 py-2.5 flex items-center gap-2 text-gray-400 text-sm">
              <Spinner />
              Thinking…
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 text-xs text-red-600 dark:text-red-400">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 break-words">{error}</span>
              <button
                onClick={() => { setError(''); setErrorDetails('') }}
                className="shrink-0 hover:text-red-800 dark:hover:text-red-300"
                title="Dismiss"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            {errorDetails && (
              <details className="mt-1.5">
                <summary className="cursor-pointer select-none text-[11px] text-red-500/90 dark:text-red-400/90 hover:text-red-700 dark:hover:text-red-300">
                  More details…
                </summary>
                <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-red-200 dark:border-red-800/60 bg-red-100/50 dark:bg-red-950/40 p-2 font-mono text-[11px] leading-relaxed text-red-700 dark:text-red-300">
                  {errorDetails}
                </pre>
              </details>
            )}
          </div>
        )}

      </div>

      {/* Input */}
      {aiService && (
        <div className="shrink-0 border-t border-gray-100 dark:border-gray-700">
          {/* Context scope controls */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pt-1.5 pb-1 text-xs text-gray-500 dark:text-gray-400">
            {isList ? (
              // List mode: the scope is the multiselected notes (no note-editor scope
              // selector). With no selection the assistant searches the library itself.
              <span className="flex items-center gap-1 shrink-0 text-gray-400 dark:text-gray-500">
                Scope: selected notes
              </span>
            ) : (
              <label className="flex items-center gap-1 shrink-0">
                <span className="text-gray-400 dark:text-gray-500">Context:</span>
                <select
                  value={contextScope}
                  onChange={(e) => setContextScope(e.target.value as ContextScope)}
                  disabled={!!frozenContext}
                  className="text-xs border border-gray-200 dark:border-gray-600 rounded px-1 py-0.5 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 disabled:opacity-50"
                >
                  <option value="none">None</option>
                  <option value="note">This note</option>
                  <option value="children" disabled={!noteId}>+ Children</option>
                  <option value="folder" disabled={!noteFolderId}>Folder</option>
                  <option value="subfolder" disabled={!noteFolderId}>Subfolder</option>
                </select>
              </label>
            )}

            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useSummaries}
                onChange={(e) => setUseSummaries(e.target.checked)}
                disabled={!!frozenContext}
                className="rounded"
              />
              Summaries
            </label>

            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeLinkedFiles}
                onChange={(e) => setIncludeLinkedFiles(e.target.checked)}
                disabled={!!frozenContext}
                className="rounded"
              />
              Files
            </label>

            <label className="flex items-center gap-1 cursor-pointer select-none" title="Preview multi-step plans before they run">
              <input
                type="checkbox"
                checked={planMode}
                onChange={(e) => setPlanMode(e.target.checked)}
                className="rounded"
              />
              Plan mode
            </label>

            {!isList && (
              <button
                onClick={() => void handleFreeze()}
                disabled={freezing || contextScope === 'none'}
                title={frozenContext ? 'Context pinned — click to use the live note again' : 'Pin a snapshot of the note/context (ignore further edits until unpinned)'}
                className={`flex items-center gap-0.5 transition-colors disabled:opacity-40 ${
                  frozenContext ? 'text-amber-500 hover:text-amber-600' : 'text-gray-400 hover:text-blue-500'
                }`}
              >
                {freezing ? <Spinner /> : frozenContext ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
              </button>
            )}

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!!frozenContext}
              title="Attach files to next message"
              className="flex items-center gap-0.5 text-gray-400 hover:text-blue-500 transition-colors disabled:opacity-40"
            >
              <Paperclip className="w-3 h-3" />
              {pendingFiles.length > 0 && (
                <span className="text-blue-500 font-medium">{pendingFiles.length}</span>
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) setPendingFiles((prev) => [...prev, ...Array.from(e.target.files!)])
                e.target.value = ''
              }}
            />
          </div>

          {/* Pending file pills */}
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {pendingFiles.map((file, i) => (
                <span
                  key={i}
                  className="flex items-center gap-1 text-xs bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded px-1.5 py-0.5"
                >
                  {file.name.length > 16 ? `${file.name.slice(0, 14)}…` : file.name}
                  <button
                    onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="hover:text-red-500 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="p-2">
            <div className="flex items-end gap-2">
              {dictation.isSupported && (
                <button
                  className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
                  onClick={dictation.toggleDictation}
                  onMouseDown={(e) => e.preventDefault()}
                  disabled={loading}
                  title={dictation.status === 'recording' ? 'Stop dictation' : 'Start dictation'}
                  aria-label={dictation.status === 'recording' ? 'Stop dictation' : 'Start dictation'}
                >
                  {dictation.status === 'recording' ? (
                    <MicOff className="w-4 h-4 text-red-500" />
                  ) : (
                    <Mic className="w-4 h-4" />
                  )}
                </button>
              )}
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void handleSend(input, conversation)
                  }
                }}
                placeholder="Ask a question or tell me what to do…"
                rows={1}
                className="flex-1 resize-none input text-sm py-1.5 max-h-28 overflow-y-auto"
                disabled={loading || executing}
              />
              <button
                className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
                disabled={loading || executing || !input.trim()}
                onClick={() => void handleSend(input, conversation)}
                type="button"
              >
                {loading || executing ? <Spinner /> : <Send className="w-3.5 h-3.5" />}
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">Shift+Enter for new line</p>
          </div>
        </div>
      )}

      {/* Plan confirmation (Plan mode) */}
      {pendingPlan && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 p-3"
          onClick={() => { if (!executing) cancelPlan() }}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-sm max-h-full flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1.5 px-4 py-3 border-b border-gray-100 dark:border-gray-700">
              <ListChecks className="w-4 h-4 text-blue-500" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Review plan</h3>
              <span className="text-xs text-gray-400 ml-auto">
                {selectedSteps.filter(Boolean).length} / {pendingPlan.plan.actions.length} step{pendingPlan.plan.actions.length === 1 ? '' : 's'}
              </span>
            </div>
            <ul className="flex-1 overflow-y-auto px-4 py-3 space-y-2 text-sm text-gray-700 dark:text-gray-200">
              {pendingPlan.plan.actions.map((a, i) => (
                <li key={i} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selectedSteps[i] ?? true}
                    onChange={(e) => setSelectedSteps((prev) => {
                      const next = [...prev]; next[i] = e.target.checked; return next
                    })}
                    className="mt-0.5 h-3.5 w-3.5 accent-blue-600 cursor-pointer shrink-0"
                  />
                  <span className="leading-snug">{defaultActionLabel(a, pendingPlan.ctx.labelMap)}</span>
                </li>
              ))}
            </ul>
            {pendingPlan.plan.actions.some((a) => a.type === 'edit_note' && a.mode === 'replace') && (
              <p className="px-4 pb-2 text-xs text-amber-600 dark:text-amber-400">
                ⚠ A full replace overwrites the note body — embedded child notes or images may be removed. A version snapshot is saved first, so you can restore from history.
              </p>
            )}
            <div className="flex gap-2 px-4 py-3 border-t border-gray-100 dark:border-gray-700">
              <button
                className="flex-1 px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors flex items-center justify-center gap-1.5"
                disabled={executing || generating || selectedSteps.filter(Boolean).length === 0}
                onClick={() => {
                  const filtered = { actions: pendingPlan.plan.actions.filter((_, i) => selectedSteps[i]) }
                  void runPlan(filtered, pendingPlan.ctx, pendingPlan.baseMessages, pendingPlan.history, pendingPlan.userRequest)
                }}
              >
                {generating ? <><Spinner /> Writing…</> : executing ? <><Spinner /> Running…</> : 'Approve & run'}
              </button>
              <button
                className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
                disabled={executing || generating}
                onClick={cancelPlan}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
