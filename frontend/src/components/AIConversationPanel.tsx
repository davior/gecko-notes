import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Sparkles, X, Send, Copy, Check, Plus, Pencil, Trash2, Mic, MicOff, Paperclip, Lock, LockOpen, ListChecks } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useSettingsStore } from '@/stores/settings'
import { useCategoriesStore } from '@/stores/categories'
import { useDictation } from '@/hooks/useDictation'
import { settingsApi } from '@/api/settings'
import { notesApi } from '@/api/notes'
import { foldersApi } from '@/api/folders'
import { extractPlainText, extractLinkedFileUrls } from '@/utils/blocks'
import type { FileAttachment } from '@/services/ai'
import {
  parsePlan,
  buildPlanSystemPrompt,
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

// Everything needed to generate and execute a plan for the current context.
// Cached when the context is frozen so repeated requests reuse the same (cached)
// system prompt and target-id sets.
interface PlanContext {
  systemPrompt: string
  attachments: FileAttachment[]
  targetNotes: ContextNote[]
  folders: ContextFolder[]
  categories: ContextCategory[]
  labelMap: Map<string, string>
}

interface PendingPlan {
  plan: Plan
  ctx: PlanContext
  baseMessages: ConversationMessage[]
}

interface AIConversationPanelProps {
  isOpen: boolean
  onToggle: () => void
  getNoteContext: () => string
  noteId?: string | null
  noteTitle?: string
  noteFolderId?: string | null
  noteSummary?: string | null
  getNoteDocument?: () => unknown[]
  conversation: ConversationMessage[]
  onConversationChange: (messages: ConversationMessage[]) => void
  onAddToNote: (text: string) => Promise<void>
  // Plan execution wiring (provided by EditorView)
  editor?: PlanEditor | null
  defaultCategoryId?: string
  currentFolderId?: string | null
  onBeforeExecute?: () => Promise<void> | void
  onCurrentNoteEdited?: () => Promise<void> | void
  onNotesChanged?: () => void
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
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
  getNoteContext,
  noteId,
  noteTitle,
  noteFolderId,
  noteSummary,
  getNoteDocument,
  conversation,
  onConversationChange,
  onAddToNote,
  editor,
  defaultCategoryId,
  currentFolderId,
  onBeforeExecute,
  onCurrentNoteEdited,
  onNotesChanged,
}: AIConversationPanelProps) {
  const aiService = useSettingsStore((s) => s.aiService)
  const deepgramApiKey = useSettingsStore((s) => s.deepgramApiKey)
  const categories = useCategoriesStore((s) => s.categories)

  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
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
  const [executing, setExecuting] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [frozenContext, setFrozenContext] = useState<PlanContext | null>(null)
  const [freezing, setFreezing] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
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
    if (isOpen) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
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

  async function buildScopeContext(): Promise<{ contextText: string; attachments: FileAttachment[]; targetNotes: ContextNote[] }> {
    const fileAttachments: FileAttachment[] = []

    if (contextScope === 'none') {
      const processed = await Promise.all(pendingFiles.map(processFile))
      const imgs = processed.filter((p): p is Extract<ProcessedFile, {kind:'image'}> => p.kind === 'image')
      return { contextText: '', attachments: imgs.map(p => p.attachment), targetNotes: [] }
    }

    // `id` is carried through so the model can target each note in plan actions.
    let notes: { id?: string; title: string; content: string; summary?: string | null; blocks: unknown[] }[] = []

    if (contextScope === 'note') {
      const blocks = getNoteDocument?.() ?? []
      notes = [{ id: noteId ?? undefined, title: noteTitle ?? '', content: getNoteContext(), summary: noteSummary, blocks }]
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

      // Fetch full note content in parallel
      const fetched = await Promise.all(listItems.map((item) => notesApi.get(item.id)))
      notes = fetched.map((r) => {
        let blocks: unknown[] = []
        try { blocks = JSON.parse(r.data.content) } catch { /* ignore */ }
        return {
          id: r.data.id,
          title: r.data.title,
          content: extractPlainText(blocks),
          summary: r.data.summary,
          blocks,
        }
      })

      // Prepend current note for children scope
      if (contextScope === 'children') {
        const curBlocks = getNoteDocument?.() ?? []
        notes.unshift({ id: noteId ?? undefined, title: noteTitle ?? '', content: getNoteContext(), summary: noteSummary, blocks: curBlocks })
      }
    }

    // Build context text — each note labelled with its id so the model can target it.
    const parts = notes.map((n) => {
      const body = (useSummaries && n.summary) ? n.summary : n.content
      const heading = n.id
        ? `## ${n.title || 'This note'} [id: ${n.id}]`
        : (n.title ? `## ${n.title}` : '')
      return heading ? `${heading}\n\n${body}` : body
    })

    const targetNotes: ContextNote[] = notes
      .filter((n): n is typeof n & { id: string } => Boolean(n.id))
      .map((n) => ({ id: n.id, title: n.title || 'Untitled' }))

    // Collect linked file URLs (images only — others not supported as content blocks)
    if (includeLinkedFiles) {
      const allUrls = notes.flatMap((n) => extractLinkedFileUrls(n.blocks))
      const fetched = await Promise.all(allUrls.map(urlToAttachment))
      fileAttachments.push(...(fetched.filter(Boolean) as FileAttachment[]))
    }

    // Pending uploaded files — images go as content blocks, text as context, others as placeholders
    let contextText = parts.join('\n\n---\n\n')
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
      const fileSection = `**Attached files:**\n\n${fileTextParts.join('\n\n')}`
      contextText = contextText ? `${contextText}\n\n---\n${fileSection}` : fileSection
    }

    return { contextText, attachments: fileAttachments, targetNotes }
  }

  // Assemble everything the planner needs: the labelled system prompt plus the
  // id sets the executor validates against. Folders/categories come from the
  // store/API so the model can move notes, retag, and create folders.
  async function buildPlanContext(): Promise<PlanContext> {
    const { contextText, attachments, targetNotes } = await buildScopeContext()

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

    const systemPrompt = buildPlanSystemPrompt({ contextText, targetNotes, folders, categories: cats })
    return { systemPrompt, attachments, targetNotes, folders, categories: cats, labelMap }
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
      setError(e instanceof Error ? e.message : 'Failed to freeze context')
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
    const lines = results.map((r) =>
      r.kind === 'respond' ? r.message : `${r.ok ? '✓' : '✗'} ${r.message}`,
    )
    const failures = results.filter((r) => r.kind !== 'respond' && !r.ok).length
    const text = lines.join('\n\n')
    return failures > 0 ? `${text}\n\n_(${failures} action${failures === 1 ? '' : 's'} could not be completed.)_` : text
  }

  async function runPlan(plan: Plan, ctx: PlanContext, baseMessages: ConversationMessage[]) {
    if (!editor) {
      setError('Editor is not ready yet — try again in a moment.')
      setPendingPlan(null)
      return
    }
    setExecuting(true)
    try {
      // Flush any unsaved edits to the open note so amend/append build on the
      // latest content and a later re-hydrate won't clobber the user's typing.
      await onBeforeExecute?.()

      const results = await executePlan(plan, {
        editor,
        currentNoteId: noteId ?? null,
        defaultCategoryId: defaultCategoryId ?? '',
        currentFolderId: currentFolderId ?? null,
        validNoteIds: new Set(ctx.targetNotes.map((n) => n.id)),
        validFolderIds: new Set(ctx.folders.map((f) => f.id)),
        validCategoryIds: new Set(ctx.categories.map((c) => c.id)),
      })

      onConversationChange([...baseMessages, assistantMsg(buildResultSummary(results))])

      if (results.some((r) => r.notesChanged)) onNotesChanged?.()
      if (results.some((r) => r.touchedCurrentNote)) await onCurrentNoteEdited?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run plan')
    } finally {
      setExecuting(false)
      setPendingPlan(null)
    }
  }

  function cancelPlan() {
    if (!pendingPlan) return
    onConversationChange([...pendingPlan.baseMessages, assistantMsg('_Plan cancelled._')])
    setPendingPlan(null)
  }

  async function handleSend(userContent: string, priorMessages: ConversationMessage[]) {
    if (!userContent.trim() || !aiService || loading || executing || pendingPlan) return
    setError('')

    const userMsg: ConversationMessage = {
      id: uid(),
      role: 'user',
      content: userContent.trim(),
      timestamp: new Date().toISOString(),
    }
    const withUser = [...priorMessages, userMsg]
    onConversationChange(withUser)
    setInput('')
    setLoading(true)

    try {
      const transcript = priorMessages
        .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
        .join('\n\n')
      const fullPrompt = transcript
        ? `${transcript}\n\nHuman: ${userContent.trim()}`
        : userContent.trim()

      // Use frozen context if locked; otherwise build fresh from current scope.
      const isFrozen = frozenContext !== null
      const ctx = isFrozen ? frozenContext! : await buildPlanContext()

      // No prefill: it behaves inconsistently across providers (Anthropic
      // continues from it; OpenAI/Ollama prepend it to a fresh full-JSON reply,
      // yielding "{{"). The system prompt asks for JSON-only and parsePlan
      // tolerantly extracts the object, so temperature:0 alone is enough.
      const raw = await aiService.complete(fullPrompt, {
        systemPrompt: ctx.systemPrompt,
        attachments: ctx.attachments.length ? ctx.attachments : undefined,
        cacheSystem: isFrozen,
        temperature: 0,
      })
      setPendingFiles([])

      const plan = parsePlan(raw)
      const onlyRespond = plan.actions.every((a) => a.type === 'respond')

      if (onlyRespond) {
        // Respond-only results display immediately as a normal chat message — no
        // preview — even when Plan mode is on.
        const text =
          plan.actions
            .map((a) => (a.type === 'respond' ? a.text : ''))
            .filter(Boolean)
            .join('\n\n') || '(no response)'
        onConversationChange([...withUser, assistantMsg(text)])
      } else if (planMode) {
        setPendingPlan({ plan, ctx, baseMessages: withUser })
      } else {
        await runPlan(plan, ctx, withUser)
      }
    } catch (e: unknown) {
      let msg = e instanceof Error ? e.message : 'An error occurred'
      // Axios errors: the backend wraps the upstream API error body in `detail`
      const axiosErr = e as { response?: { data?: Record<string, unknown> } }
      const detail = axiosErr.response?.data?.detail
      if (typeof detail === 'string') {
        try {
          const parsed = JSON.parse(detail) as { error?: { message?: string } }
          msg = parsed?.error?.message ?? detail
        } catch { msg = detail }
      } else if (typeof detail === 'object' && detail !== null) {
        const d = detail as Record<string, unknown>
        if (typeof d.message === 'string') msg = d.message
      }
      setError(msg)
      onConversationChange(priorMessages)
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

  function handleClear() {
    onConversationChange([])
  }

  function handleDelete(idx: number) {
    onConversationChange([...conversation.slice(0, idx), ...conversation.slice(idx + 1)])
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
        <div className="flex items-center gap-2">
          {conversation.length > 0 && (
            <button
              onClick={handleClear}
              className="text-xs text-gray-400 hover:text-red-500 transition-colors"
            >
              Clear
            </button>
          )}
          <button onClick={onToggle} className="btn-ghost p-1" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4 min-h-0">
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
                    {msg.content}
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
                <button
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors px-1.5 py-0.5 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20"
                  title="Add to note"
                  onClick={() => void onAddToNote(msg.content)}
                >
                  <Plus className="w-3 h-3" />Add to note
                </button>
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
          <div className="flex items-center justify-between bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 text-xs text-red-600 dark:text-red-400">
            <span>{error}</span>
            <button onClick={() => setError('')} className="ml-2 hover:text-red-800 dark:hover:text-red-300">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {aiService && (
        <div className="shrink-0 border-t border-gray-100 dark:border-gray-700">
          {/* Context scope controls */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pt-1.5 pb-1 text-xs text-gray-500 dark:text-gray-400">
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

            <button
              onClick={() => void handleFreeze()}
              disabled={freezing || contextScope === 'none'}
              title={frozenContext ? 'Context frozen — click to unfreeze' : 'Freeze context for prompt caching'}
              className={`flex items-center gap-0.5 transition-colors disabled:opacity-40 ${
                frozenContext ? 'text-amber-500 hover:text-amber-600' : 'text-gray-400 hover:text-blue-500'
              }`}
            >
              {freezing ? <Spinner /> : frozenContext ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
            </button>

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
                {pendingPlan.plan.actions.length} step{pendingPlan.plan.actions.length === 1 ? '' : 's'}
              </span>
            </div>
            <ol className="flex-1 overflow-y-auto px-4 py-3 space-y-2 text-sm text-gray-700 dark:text-gray-200 list-decimal list-inside">
              {pendingPlan.plan.actions.map((a, i) => (
                <li key={i} className="leading-snug">{defaultActionLabel(a, pendingPlan.ctx.labelMap)}</li>
              ))}
            </ol>
            {pendingPlan.plan.actions.some((a) => a.type === 'edit_note' && a.mode === 'replace') && (
              <p className="px-4 pb-2 text-xs text-amber-600 dark:text-amber-400">
                ⚠ A full replace overwrites the note body — embedded child notes or images may be removed. A version snapshot is saved first, so you can restore from history.
              </p>
            )}
            <div className="flex gap-2 px-4 py-3 border-t border-gray-100 dark:border-gray-700">
              <button
                className="flex-1 px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors flex items-center justify-center gap-1.5"
                disabled={executing}
                onClick={() => void runPlan(pendingPlan.plan, pendingPlan.ctx, pendingPlan.baseMessages)}
              >
                {executing ? <><Spinner /> Running…</> : 'Approve & run'}
              </button>
              <button
                className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
                disabled={executing}
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
