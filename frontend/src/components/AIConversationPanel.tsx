import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { processCiteTags } from '@/utils/markdown'
import { Sparkles, X, Send, Copy, Check, Plus, Pencil, Trash2, Mic, Paperclip, Lock, LockOpen, ListChecks, FileText, FilePlus2, History, Volume2, Square, AudioLines, BookOpen } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useSettingsStore } from '@/stores/settings'
import { useCategoriesStore } from '@/stores/categories'
import { useRecipesStore } from '@/stores/recipes'
import { useDictation } from '@/hooks/useDictation'
import { useTextToSpeech } from '@/hooks/useTextToSpeech'
import { useVoiceMode } from '@/hooks/useVoiceMode'
import VoiceModeOverlay from '@/components/VoiceModeOverlay'
import DictationWaveIcon from '@/components/DictationWaveIcon'
import NotePickerModal from '@/components/NotePickerModal'
import RecipesPanel from '@/components/RecipesPanel'
import RecipePickerDropdown from '@/components/RecipePickerDropdown'
import { settingsApi } from '@/api/settings'
import { configApi } from '@/api/config'
import { searchApi } from '@/api/search'
import { notesApi, type NoteListItem, type ListNotesParams } from '@/api/notes'
import { foldersApi } from '@/api/folders'
import { annotationsApi } from '@/api/annotations'
import { aiSessionsApi, type AISession } from '@/api/aiSessions'
import type { Recipe } from '@/api/recipes'
import { renderRecipePrompt, getCurrentSelectionText } from '@/utils/recipeVariables'
import { matchRecipeVoiceCommand } from '@/utils/recipeVoiceCommand'
import { extractPlainText, extractLinkedFileUrls, extractBlockTexts } from '@/utils/blocks'
import { describeDiagrams } from '@/utils/diagram'
import type { FileAttachment, ConversationTurn, ConversationRequest } from '@/services/ai'
import {
  parsePlan,
  normalizeActionTags,
  buildPlanReferenceBlock,
  buildPlanSummary,
  buildContentStepInstruction,
  actionNeedsGeneration,
  formatNoteMeta,
  formatWebSearchResults,
  webSearchContinuation,
  PLAN_INSTRUCTIONS,
  VOICE_REPLY_INSTRUCTIONS,
  NATIVE_WEB_SEARCH_INSTRUCTIONS,
  WEB_SEARCH_ACTION_INSTRUCTIONS,
  defaultActionLabel,
  type Plan,
  type PlanAction,
  type ContextNote,
  type ContextFolder,
  type ContextCategory,
  type ContextRecipe,
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

// Best-effort human-readable text from a partial streaming buffer. The model streams a
// JSON plan envelope, so this surfaces the reply — leading prose plus the (possibly still
// growing) respond.text value — instead of raw braces. Display-only: final correctness
// always comes from parsePlan on the complete text, never from this. Returns '' when only
// non-respond JSON has arrived so the caller can show a placeholder rather than braces.
function liveExtractText(buf: string): string {
  // Strip any XML-style <actions> container a model (e.g. DeepSeek) emits instead of
  // the JSON envelope, so the tags never flash in the live bubble — the final message
  // is re-derived by parsePlan, which normalizes the same way.
  const s = normalizeActionTags(buf).replace(/^```(?:json)?\s*/i, '')
  const brace = s.indexOf('{')
  if (brace === -1) return s.trim()              // pure prose so far
  const pre = s.slice(0, brace).trim()           // prose before the JSON envelope
  let answer = ''
  const m = s.slice(brace).match(/"text"\s*:\s*"/)
  if (m && m.index !== undefined) {
    // Decode the JSON string value up to the first unescaped quote (or end-of-buffer
    // while it's still streaming).
    let i = brace + m.index + m[0].length
    for (; i < s.length; i++) {
      const c = s[i]
      if (c === '\\') {
        const n = s[i + 1]
        answer += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '' : n === 'u' ? '' : (n ?? '')
        if (n === 'u') i += 4
        i += 1
      } else if (c === '"') {
        break
      } else {
        answer += c
      }
    }
  }
  return [pre, answer].filter(Boolean).join('\n\n')
}

// How many per-document generation calls to run at once (see Phase 2 plan).
const GEN_CONCURRENCY = 5

// Max retrieval rounds per request — find_notes over the note library and web_search
// over the web share one budget (bounds an agentic search loop, whichever it searches).
const MAX_RETRIEVAL_ROUNDS = 4

// Web searches run in a single round. Each is a live API call the user waits on, so a
// plan asking for a dozen angles at once is trimmed to the first few.
const MAX_WEB_SEARCHES_PER_ROUND = 3

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
  recipes: ContextRecipe[]
  currentFolderId: string | null   // folder being viewed (kept so find_notes can rebuild referenceBlock)
  currentFolderName: string | null
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
  // can show the hits (replacing "All notes" with a "Search Results" header). `label`
  // is a human-readable, always-non-empty description of the search (query and/or
  // folder scope) — never the raw query alone, since find_notes may be folder-scoped
  // with no query text at all.
  onSearchResults?: (label: string, results: NoteListItem[]) => void
  getNoteContext: () => string
  noteId?: string | null
  noteTitle?: string
  noteFolderId?: string | null
  noteSummary?: string | null
  // Timestamps of the open note (editor mode), so the model can reason about its dates.
  noteCreatedAt?: string | null
  noteModifiedAt?: string | null
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

// Resolve a find_notes action's folder scope + free-text query into notesApi.list()
// params. 'current' resolves against the folder currently being viewed
// (ctx.currentFolderId — itself possibly null, meaning the root). When `folderId`
// is absent, this is identical to the old unscoped behavior (global substring search).
function findNotesParams(action: Extract<PlanAction, { type: 'find_notes' }>, ctx: PlanContext): ListNotesParams {
  const params: ListNotesParams = { limit: 50 }
  if (action.query) params.search = action.query
  if (action.folderId !== undefined) {
    const resolved = action.folderId === 'current' ? ctx.currentFolderId : action.folderId
    params.in_folder = true
    if (resolved !== null) params.folder_id = resolved
    if (action.recursive) params.recursive = true
  }
  return params
}

// Human-readable description of a find_notes action's scope — used both in the
// round summary sent back to the model and as the list view's "Search Results"
// label. Always returns a non-empty string: the caller relies on this to avoid
// tripping a "search box is empty" reset in the list view.
function describeFindNotes(action: Extract<PlanAction, { type: 'find_notes' }>, ctx: PlanContext): string {
  const parts: string[] = []
  if (action.query) parts.push(`"${action.query}"`)
  if (action.folderId !== undefined) {
    const resolved = action.folderId === 'current' ? ctx.currentFolderId : action.folderId
    const folderName = resolved === null ? 'the root' : (ctx.folders.find((f) => f.id === resolved)?.name ?? resolved)
    parts.push(`folder "${folderName}"${action.recursive ? ' (recursive)' : ''}`)
  }
  return parts.join(' in ') || 'notes'
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
  noteCreatedAt,
  noteModifiedAt,
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
  const activeProvider = useSettingsStore((s) => s.activeProvider)
  // Whether the active provider can take image/PDF content blocks. Default to true
  // when unknown (no provider yet) so we never over-block; text-only backends like
  // DeepSeek set this false and the attach flow drops images before they're sent.
  const supportsImages = activeProvider?.supports_images ?? true
  // How this provider searches the web — the two mechanisms are mutually exclusive:
  //   'native' — any provider on the Anthropic Messages protocol: Claude, and equally a
  //              DeepSeek provider pointed at api.deepseek.com/anthropic. ai.ts attaches
  //              the web_search_20250305 server tool and the PROVIDER runs the search
  //              inside the model call. Always preferred: nothing to configure, no
  //              second key, no per-search fee beyond the provider's own tokens.
  //   'action' — providers whose API has no search tool at all (Ollama, OpenAI-compatible
  //              endpoints, and a DeepSeek provider still on the OpenAI-compatible one):
  //              the model asks with a `web_search` plan action and the APP runs it (see
  //              the retrieval loop in handleSend). Needs a search backend configured
  //              under Settings → AI → Assistant.
  //   'none'   — neither: no native tool, no backend configured.
  // The prompt's promise of search and the mechanism behind it are gated together on this:
  // a model told it can search but given nothing to search with either emits tool-call
  // markup as raw text (<tool_calls><invoke name="web_search">…) or tells the user it has
  // no web access — the two bugs this guards against.
  const webSearchConfigured = useSettingsStore((s) => s.webSearchConfigured)
  const hasNativeSearch = activeProvider?.provider_type === 'anthropic' || !!activeProvider?.use_anthropic_api
  const webSearchMode: 'native' | 'action' | 'none' =
    hasNativeSearch ? 'native' : webSearchConfigured ? 'action' : 'none'
  const falKeyConfigured = useSettingsStore((s) => s.falKeyConfigured)
  const deepgramKeyConfigured = useSettingsStore((s) => s.deepgramKeyConfigured)
  const sttProvider = useSettingsStore((s) => s.sttProvider)
  const categories = useCategoriesStore((s) => s.categories)

  // Conversation and session state (self-managed — not driven by props)
  const [conversation, setConversation] = useState<ConversationMessage[]>([])
  const [sessions, setSessions] = useState<AISession[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  // Chat | Recipes | History — three tabs sharing this one side panel.
  const [panelTab, setPanelTab] = useState<'chat' | 'recipes' | 'history'>('chat')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')

  const recipes = useRecipesStore((s) => s.recipes)
  const recipesLoading = useRecipesStore((s) => s.loading)
  const createRecipe = useRecipesStore((s) => s.createRecipe)
  const updateRecipe = useRecipesStore((s) => s.updateRecipe)
  const deleteRecipe = useRecipesStore((s) => s.deleteRecipe)

  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Full request/response dump for the failed call, shown in a collapsible panel
  // under the short error message. Empty when there's nothing extra to show.
  const [errorDetails, setErrorDetails] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // Read-aloud: which assistant message is currently being spoken (null = none).
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null)
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
  // Notes the user hand-attached as extra AI context (on top of the scope). {id, title}:
  // the id is authoritative (bodies are re-fetched live each send); title is for the pill.
  const [attachedNotes, setAttachedNotes] = useState<{ id: string; title: string }[]>([])
  const [showNotePicker, setShowNotePicker] = useState(false)
  // Set when image/PDF files are dropped from a selection because the active provider
  // is text-only. Cleared on the next selection or when the provider changes.
  const [attachNotice, setAttachNotice] = useState('')
  const [frozenContext, setFrozenContext] = useState<PlanContext | null>(null)
  const [freezing, setFreezing] = useState(false)
  // Live text of the in-flight streamed reply (null = not streaming). See planOnce.
  const [streamingText, setStreamingText] = useState<string | null>(null)
  // Phase 2 (deferred body) generation progress, shown live in the plan modal so a long
  // multi-minute stream doesn't look frozen. null = not generating.
  const [genProgress, setGenProgress] = useState<{ done: number; total: number; chars: number } | null>(null)

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isMobileRef = useRef(isMobile)
  const panelWidthRef = useRef(panelWidth)
  const panelHeightRef = useRef(panelHeight)
  const streamBufRef = useRef('')                          // raw accumulated stream text
  const abortRef = useRef<AbortController | null>(null)     // cancels the in-flight stream
  const liveRafRef = useRef<number | null>(null)            // rAF handle throttling live updates
  const genAbortRef = useRef<AbortController | null>(null)  // cancels in-flight Phase 2 body generation
  const genCharsRef = useRef(0)                            // chars streamed so far across all in-flight bodies
  const genDoneRef = useRef(0)                             // bodies finished (ok or failed) this run
  const genRafRef = useRef<number | null>(null)            // rAF handle throttling genProgress updates

  // Abort any in-flight stream on unmount so its reader/state updates don't leak.
  useEffect(() => () => { abortRef.current?.abort(); genAbortRef.current?.abort() }, [])

  // Tracks whether the *current* dictation session has recognized any speech
  // yet, so stopping the mic without having said anything never re-sends
  // whatever text was already typed in the box.
  const dictatedThisSessionRef = useRef(false)

  const handleDictationResult = useCallback((text: string) => {
    dictatedThisSessionRef.current = true
    setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
  }, [])

  const transcribeAudio = useCallback(
    (blob: Blob) => settingsApi.transcribeAudio(blob),
    [],
  )
  const dictation = useDictation(handleDictationResult, {
    transcribeAudio: falKeyConfigured ? transcribeAudio : undefined,
    sttProvider,
  })

  // Read-aloud for assistant responses. One player instance for the panel — only
  // one message speaks at a time (tracked by speakingMsgId). The TTS provider
  // (Deepgram Flux or fal.ai fallback) is resolved server-side.
  const readAloud = useTextToSpeech()
  useEffect(() => {
    if (readAloud.status === 'idle' || readAloud.status === 'error') setSpeakingMsgId(null)
  }, [readAloud.status])

  // ── Voice mode (Deepgram Flux) ──────────────────────────────────────────────
  const voiceModeEnabled = useSettingsStore((s) => s.voiceModeEnabled)
  const [voiceInstanceEnabled, setVoiceInstanceEnabled] = useState(false)
  useEffect(() => {
    configApi.get().then((c) => setVoiceInstanceEnabled(c.voice_mode_enabled)).catch(() => { /* pre-auth or older backend */ })
  }, [])
  const [voiceOpen, setVoiceOpen] = useState(false)
  // Read-back text for a note-changing plan awaiting a spoken "yes" (null = none).
  const [voiceConfirmText, setVoiceConfirmText] = useState<string | null>(null)
  const voiceActiveRef = useRef(false)
  const voiceTurnRef = useRef<(t: string) => void>(() => {})
  // Fresh refs so the socket-driven turn handler never reads stale state.
  const pendingPlanRef = useRef(pendingPlan)
  useEffect(() => { pendingPlanRef.current = pendingPlan })
  const conversationRef = useRef(conversation)
  useEffect(() => { conversationRef.current = conversation })
  const voice = useVoiceMode({
    onUserTurn: (t) => voiceTurnRef.current(t),
    onBargeIn: () => { abortRef.current?.abort(); genAbortRef.current?.abort() },
    onError: (msg) => { setError(msg); void endVoiceSession(false) },
  })
  // Voice mode is available only when the instance flag, the user's opt-in, and a
  // Deepgram key are all present.
  const voiceCapable = voiceInstanceEnabled && voiceModeEnabled && deepgramKeyConfigured

  // Send only once a dictation session ends (or Enter is pressed, below) —
  // not after every recognized chunk. `latestSendCtxRef` must be kept fresh
  // *before* the edge-detect effect below runs: for the fal.ai batch fallback
  // path, the final chunk's setInput and the mode->null transition land in
  // the same commit, so effects run in declaration order and this one needs
  // to see this render's `input`, not a stale one.
  const latestSendCtxRef = useRef({ input, loading, aiService, conversation })
  useEffect(() => { latestSendCtxRef.current = { input, loading, aiService, conversation } })

  const handleSendRef = useRef(handleSend)
  useEffect(() => { handleSendRef.current = handleSend })

  const prevDictationModeRef = useRef(dictation.mode)
  useEffect(() => {
    const prev = prevDictationModeRef.current
    prevDictationModeRef.current = dictation.mode

    if (dictation.mode === 'dictation' && prev !== 'dictation') {
      dictatedThisSessionRef.current = false // fresh session, nothing dictated yet
    }

    if (prev === 'dictation' && dictation.mode === null && dictation.status !== 'error' && dictatedThisSessionRef.current) {
      dictatedThisSessionRef.current = false
      const { input: text, loading, aiService, conversation } = latestSendCtxRef.current
      if (text.trim() && !loading && aiService) {
        void handleSendRef.current(text, conversation)
      }
    }
  }, [dictation.mode, dictation.status])

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
    setPanelTab('chat')
    setAttachedNotes([])
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
        try { setAttachedNotes(JSON.parse(latest.attached_notes)) } catch { setAttachedNotes([]) }
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

  // Clear the "images skipped" notice once the active provider can take images again
  // (e.g. the user switched to a vision-capable provider).
  useEffect(() => {
    if (supportsImages) setAttachNotice('')
  }, [supportsImages])

  useEffect(() => {
    try { localStorage.setItem('ai-plan-mode', String(planMode)) } catch { /* noop */ }
  }, [planMode])

  // Auto-unfreeze when scope settings change — frozen context is now stale
  useEffect(() => {
    setFrozenContext(null)
  }, [contextScope, useSummaries, includeLinkedFiles, attachedNotes])

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
        attached_notes: JSON.stringify(attachedNotes),
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
        attached_notes: JSON.stringify(attachedNotes),
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
    setPanelTab('chat')
    setAttachedNotes([])
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
    try { setAttachedNotes(JSON.parse(session.attached_notes)) } catch { setAttachedNotes([]) }
    setFrozenContext(null)
    setPendingPlan(null)
    setPanelTab('chat')
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
  type ScopeNote = { id?: string; title: string; content: string; summary?: string | null; blocks: unknown[]; createdAt?: string; modifiedAt?: string }
  const fetchNotesById = async (ids: string[]): Promise<ScopeNote[]> => {
    const fetched = await Promise.all(ids.map((id) => notesApi.get(id)))
    return fetched.map((r) => {
      let blocks: unknown[] = []
      try { blocks = JSON.parse(r.data.content) } catch { /* ignore */ }
      return { id: r.data.id, title: r.data.title, content: blocksToMarkdown(blocks), summary: r.data.summary, blocks, createdAt: r.data.created_at, modifiedAt: r.data.modified_at }
    })
  }

  async function buildScopeContext(): Promise<{ referenceContextText: string; currentNoteText: string; attachments: FileAttachment[]; targetNotes: ContextNote[]; annotationIds: Set<string> }> {
    const fileAttachments: FileAttachment[] = []
    const annotationIds = new Set<string>()

    if (!isList && contextScope === 'none' && attachedNotes.length === 0) {
      const processed = await Promise.all(pendingFiles.map(processFile))
      const imgs = processed.filter((p): p is Extract<ProcessedFile, {kind:'image'}> => p.kind === 'image')
      return { referenceContextText: '', currentNoteText: '', attachments: supportsImages ? imgs.map(p => p.attachment) : [], targetNotes: [], annotationIds }
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
      notes = [{ id: noteId ?? undefined, title: noteTitle ?? '', content: blocksToMarkdown(blocks), summary: noteSummary, blocks, createdAt: noteCreatedAt ?? undefined, modifiedAt: noteModifiedAt ?? undefined }]
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
        notes.unshift({ id: noteId ?? undefined, title: noteTitle ?? '', content: blocksToMarkdown(curBlocks), summary: noteSummary, blocks: curBlocks, createdAt: noteCreatedAt ?? undefined, modifiedAt: noteModifiedAt ?? undefined })
      }
    }

    // Fold in user-attached notes (dedup vs. notes already in scope). They're always
    // reference context (never the volatile "current" note) and re-fetched live by id.
    const presentIds = new Set(notes.map((n) => n.id).filter(Boolean) as string[])
    const extraIds = attachedNotes.map((n) => n.id).filter((id) => !presentIds.has(id))
    if (extraIds.length) {
      notes = [...notes, ...await fetchNotesById(extraIds)]
    }

    // Render one note as labelled Markdown (heading carries its id so the model can
    // target it) plus its annotations, recording annotation ids for executor validation.
    const renderNote = async (n: typeof notes[number]): Promise<string> => {
      const body = (useSummaries && n.summary) ? n.summary : n.content
      const meta = formatNoteMeta(n.createdAt, n.modifiedAt)
      const heading = n.id
        ? `## ${n.title || 'This note'} [id: ${n.id}]${meta}`
        : (n.title ? `## ${n.title}${meta}` : '')
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
      // Diagrams are custom blocks invisible in the Markdown body — describe them so
      // the model can reference and edit them via edit_diagram.
      let diagramSection = ''
      const diagText = describeDiagrams(n.blocks)
      if (diagText) {
        diagramSection = `\n\n**Diagrams on this note (edit with edit_diagram using the diagram id):**\n${diagText}`
      }
      const base = heading ? `${heading}\n\n${body}` : body
      return base + annoSection + diagramSection
    }

    const targetNotes: ContextNote[] = notes
      .filter((n): n is typeof n & { id: string } => Boolean(n.id))
      .map((n) => ({ id: n.id, title: n.title || 'Untitled', createdAt: n.createdAt, modifiedAt: n.modifiedAt }))

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
      // Safety net: a text-only provider (supports_images = false) can't take image or
      // PDF content blocks — the picker already filters them out, but linked-file images
      // (Files toggle) also land here, so drop any that slipped through. Text files stay:
      // they ride in currentNoteText as plain text, which every provider accepts.
      attachments: supportsImages ? fileAttachments : [],
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
    const recipesForContext: ContextRecipe[] = recipes.map((r) => ({ id: r.id, name: r.name, tags: r.tags, prompt: r.prompt }))

    const labelMap = new Map<string, string>()
    targetNotes.forEach((n) => labelMap.set(n.id, n.title || 'Untitled'))
    folders.forEach((f) => labelMap.set(f.id, f.name))
    cats.forEach((c) => labelMap.set(c.id, c.label))
    recipesForContext.forEach((r) => labelMap.set(r.id, r.name))

    const curFolderId = currentFolderId ?? null
    const currentFolderName = curFolderId ? folders.find((f) => f.id === curFolderId)?.name ?? null : null

    const referenceBlock = buildPlanReferenceBlock({ referenceContextText, targetNotes, folders, categories: cats, recipes: recipesForContext, currentFolderId: curFolderId, currentFolderName })
    return { instructions: PLAN_INSTRUCTIONS, referenceBlock, referenceContextText, currentNoteText, attachments, targetNotes, folders, categories: cats, recipes: recipesForContext, currentFolderId: curFolderId, currentFolderName, labelMap, annotationIds }
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

  // Throttle live Phase 2 progress to at most one update per frame — 5 parallel body streams
  // would otherwise re-render on every token. `total` is preserved from the initial set.
  const flushGenProgress = () => {
    if (genRafRef.current !== null) return
    genRafRef.current = requestAnimationFrame(() => {
      genRafRef.current = null
      setGenProgress((p) => (p ? { ...p, done: genDoneRef.current, chars: genCharsRef.current } : p))
    })
  }

  // Abort in-flight Phase 2 body generation (the long-running step). runPlan treats the
  // resulting abort as a soft cancel and skips execution — see below.
  function stopGenerating() {
    genAbortRef.current?.abort()
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
  ): Promise<{ plan: Plan; genFailures: ActionResult[]; cancelled: boolean }> {
    const svc = aiService
    const targets = plan.actions
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => actionNeedsGeneration(action))
    if (!targets.length || !svc) return { plan, genFailures: [], cancelled: false }

    const planSummary = buildPlanSummary(plan)
    const genFailures: ActionResult[] = []
    const failedIdx = new Set<number>()
    const signal = genAbortRef.current?.signal

    // Reset the live progress counters and show the indicator for this run.
    genCharsRef.current = 0
    genDoneRef.current = 0
    setGenProgress({ done: 0, total: targets.length, chars: 0 })

    await mapWithConcurrency(targets, GEN_CONCURRENCY, async ({ action, index }) => {
      if (signal?.aborted) return  // cancelled — don't start further bodies
      try {
        const req: ConversationRequest = {
          instructions: ctx.instructions,
          referenceBlock: ctx.referenceBlock,
          currentNoteText: ctx.currentNoteText || undefined,
          history,
          userRequest,
          followups: [
            { role: 'assistant', content: planSummary },
            { role: 'user', content: buildContentStepInstruction(action, index, ctx.labelMap) },
          ],
          enableWebSearch: false,
        }
        // Stream so the read timeout bounds the gap between tokens, not the whole
        // generation — a long body no longer trips the blocking cap (or nginx's 300s).
        // onDelta only sums a character total, so parallel streams can't interleave; it
        // also drives the live progress indicator and lets the fetch be aborted.
        const raw = svc.streamConversation
          ? await svc.streamConversation(req, (t) => { genCharsRef.current += t.length; flushGenProgress() }, signal)
          : await svc.completeConversation(req)
        const body = stripCodeFence(raw)
        if (!body.trim()) throw new Error('the model returned an empty body')
        ;(action as { content: string }).content = body
      } catch (e) {
        // A user-initiated Stop aborts the fetch — not a real failure. Don't record it;
        // runPlan detects the abort and cancels the whole run.
        if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) return
        failedIdx.add(index)
        genFailures.push({ ok: false, message: `Couldn't write “${defaultActionLabel(action, ctx.labelMap)}”: ${errorMessage(e)}` })
      } finally {
        genDoneRef.current += 1
        flushGenProgress()
      }
    })

    if (signal?.aborted) return { plan, genFailures: [], cancelled: true }
    return { plan: { actions: plan.actions.filter((_, i) => !failedIdx.has(i)) }, genFailures, cancelled: false }
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
        genAbortRef.current = new AbortController()  // lets the user Stop the long generation
        setGenerating(true)
        try {
          const out = await generatePlanContent(plan, ctx, history, userRequest)
          // User pressed Stop: abandon this run rather than execute a partially-written plan.
          if (out.cancelled) {
            const cancelled = [...baseMessages, assistantMsg('_Generation cancelled._')]
            setConversation(cancelled)
            void persistCurrentSession(cancelled)
            setPendingPlan(null)
            return
          }
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
        validRecipeIds: new Set(ctx.recipes.map((r) => r.id)),
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
      if (results.some((r) => r.recipesChanged)) void useRecipesStore.getState().loadRecipes()

      setConversation(finalMessages)
      await persistCurrentSession(finalMessages)
    } catch (e) {
      setError(errorMessage(e, 'Failed to run plan'))
      setErrorDetails(formatErrorDetails(e))
    } finally {
      setExecuting(false)
      setPendingPlan(null)
      genAbortRef.current = null
      if (genRafRef.current !== null) { cancelAnimationFrame(genRafRef.current); genRafRef.current = null }
      setGenProgress(null)
    }
  }

  function cancelPlan() {
    if (!pendingPlan) return
    // Preserve any conversational answer the plan carried (e.g. prose the model wrote
    // alongside its mutations) so cancelling the mutations doesn't discard the reply.
    const respondText = pendingPlan.plan.actions
      .flatMap((a) => (a.type === 'respond' ? [a.text] : []))
      .filter(Boolean)
      .join('\n\n')
    const msg = [respondText, '_Plan cancelled._'].filter(Boolean).join('\n\n')
    const cancelled = [...pendingPlan.baseMessages, assistantMsg(msg)]
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
    abortRef.current = new AbortController()

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
      // Push live streamed text into the bubble at most once per frame (a fast token
      // stream would otherwise re-render + re-parse Markdown per token).
      const scheduleLive = () => {
        if (liveRafRef.current !== null) return
        liveRafRef.current = requestAnimationFrame(() => {
          liveRafRef.current = null
          setStreamingText(liveExtractText(streamBufRef.current))
        })
      }
      // Put a status line in that same bubble while something other than the model is
      // working (a web search between planning rounds). Any frame still queued from the
      // last stream is cancelled first, or it would overwrite the status a moment later.
      const showStatus = (text: string) => {
        if (liveRafRef.current !== null) { cancelAnimationFrame(liveRafRef.current); liveRafRef.current = null }
        streamBufRef.current = ''
        setStreamingText(text)
      }
      // Stream when the provider supports it (all three do); fall back to the blocking
      // call otherwise. Either way the returned string is fed to parsePlan unchanged —
      // the live bubble is cosmetic. `ctx`/`history` are read fresh each call because the
      // retrieval loop reassigns them between rounds.
      const planOnce = async (): Promise<Plan> => {
        streamBufRef.current = ''
        setStreamingText('')
        // Compose the planner's system instructions from the static base plus two optional
        // blocks: the web-search guidance for however this provider searches (see
        // webSearchMode — native tool, app-run action, or nothing) and, in voice mode, the
        // spoken-reply guidance. Both are appended only to THIS planning call; deferred
        // note-body generation keeps the base instructions, so saved note content stays
        // fully formatted Markdown and is never told about a capability it isn't given.
        // Voice guidance stays last so its "every rule above is unchanged" wording still
        // refers to everything before it.
        const planInstructions = [
          ctx.instructions,
          ...(webSearchMode === 'native' ? [NATIVE_WEB_SEARCH_INSTRUCTIONS] : []),
          ...(webSearchMode === 'action' ? [WEB_SEARCH_ACTION_INSTRUCTIONS] : []),
          ...(voiceActiveRef.current ? [VOICE_REPLY_INSTRUCTIONS] : []),
        ].join('\n\n')
        const req = {
          instructions: planInstructions,
          referenceBlock: ctx.referenceBlock,
          currentNoteText: ctx.currentNoteText || undefined,
          history,
          userRequest,
          attachments: ctx.attachments.length ? ctx.attachments : undefined,
          // Only enable the native tool where it's actually wired up; otherwise the prompt
          // above never mentions it, so the model won't fake a tool call.
          enableWebSearch: webSearchMode === 'native',
        }
        const raw = svc.streamConversation
          ? await svc.streamConversation(req, (t) => { streamBufRef.current += t; scheduleLive() }, abortRef.current?.signal)
          : await svc.completeConversation(req)
        return parsePlan(raw)
      }

      let plan = await planOnce()
      setPendingFiles([])

      // Retrieval steps, both resolved here rather than by planExecutor: find_notes
      // searches the note library, web_search searches the web (only in 'action' mode —
      // Anthropic searches inside its own model call instead). Both work the same way:
      // run the search(es), fold what came back into the conversation, then re-plan so
      // the model can act on it. They share one bounded round budget so a looping model
      // can't search forever, and a single round may carry both kinds.
      let retrievalRounds = 0
      const isRetrieval = (a: PlanAction) =>
        a.type === 'find_notes' || (webSearchMode === 'action' && a.type === 'web_search')
      while (retrievalRounds < MAX_RETRIEVAL_ROUNDS && plan.actions.some(isRetrieval)) {
        retrievalRounds++
        const findActions = plan.actions.filter(
          (a): a is Extract<PlanAction, { type: 'find_notes' }> => a.type === 'find_notes',
        )
        const webActions = (webSearchMode === 'action'
          ? plan.actions.filter((a): a is Extract<PlanAction, { type: 'web_search' }> => a.type === 'web_search')
          : []
        ).slice(0, MAX_WEB_SEARCHES_PER_ROUND)
        // One block per retrieval kind, joined into the single user turn below.
        const summaries: string[] = []

        if (findActions.length) {
          // Search the library; dedupe hits across all find_notes actions in this round.
          // Each action independently scopes by free-text query, folder, or both.
          const seen = new Set<string>()
          const foundListItems: NoteListItem[] = []
          for (const a of findActions) {
            try {
              const res = await notesApi.list(findNotesParams(a, ctx))
              for (const item of res.data) {
                if (!seen.has(item.id)) { seen.add(item.id); foundListItems.push(item) }
              }
            } catch { /* skip a failed search */ }
          }

          // Reflect the search in the list view (Search Results header + populated
          // results). The label is never empty: an explicit action.description wins,
          // else describeFindNotes always synthesizes something (query, folder scope,
          // or the literal "notes" fallback) — this matters because the list view uses
          // an empty search box to reset out of its search-results display.
          const label = findActions.map((a) => a.description || describeFindNotes(a, ctx)).join(', ') || 'Search results'
          onSearchResults?.(label, foundListItems)

          // Fetch full bodies and fold them into the context so the model can consolidate/edit them.
          const foundNotes = foundListItems.length ? await fetchNotesById(foundListItems.slice(0, 50).map((i) => i.id)) : []
          const foundTargets: ContextNote[] = foundNotes
            .filter((n): n is typeof n & { id: string } => Boolean(n.id))
            .map((n) => ({ id: n.id, title: n.title || 'Untitled', createdAt: n.createdAt, modifiedAt: n.modifiedAt }))
          const foundRendered = foundNotes.map((n) =>
            `## ${n.title || 'Untitled'} [id: ${n.id}]${formatNoteMeta(n.createdAt, n.modifiedAt)}\n\n${(useSummaries && n.summary) ? n.summary : n.content}`)

          const mergedTargets: ContextNote[] = [...ctx.targetNotes]
          const mergedIds = new Set(mergedTargets.map((n) => n.id))
          for (const t of foundTargets) if (!mergedIds.has(t.id)) { mergedIds.add(t.id); mergedTargets.push(t) }
          const mergedRefText = [ctx.referenceContextText, ...foundRendered].filter(Boolean).join('\n\n---\n\n')
          const mergedLabelMap = new Map(ctx.labelMap)
          mergedTargets.forEach((n) => mergedLabelMap.set(n.id, n.title || 'Untitled'))
          ctx = {
            ...ctx,
            referenceContextText: mergedRefText,
            referenceBlock: buildPlanReferenceBlock({ referenceContextText: mergedRefText, targetNotes: mergedTargets, folders: ctx.folders, categories: ctx.categories, recipes: ctx.recipes, currentFolderId: ctx.currentFolderId, currentFolderName: ctx.currentFolderName }),
            targetNotes: mergedTargets,
            labelMap: mergedLabelMap,
          }

          // Record the search as a turn so the model sees its own query and the results.
          const resultLines = foundNotes.map((n) => `- ${n.id} — ${n.title || 'Untitled'}${formatNoteMeta(n.createdAt, n.modifiedAt)}`).join('\n')
          const scopeDescriptions = findActions.map((a) => describeFindNotes(a, ctx))
          summaries.push(foundListItems.length
            ? `Search results for ${scopeDescriptions.join(', ')} — ${foundListItems.length} note(s), now added to your context above:\n${resultLines}\n\nContinue with the original request: reply, or emit actions targeting these note ids.`
            : `Search for ${scopeDescriptions.join(', ')} returned no notes. Continue with the original request (e.g. tell the user nothing matched).`)
        }

        if (webActions.length) {
          // Run the searches in sequence and hand the model the hits verbatim. A search
          // that fails is reported as a failed search rather than dropped: told nothing,
          // the model answers from memory as though it had searched.
          const blocks: string[] = []
          let anySucceeded = false
          for (const a of webActions) {
            showStatus(`_Searching the web for “${a.query}”…_`)
            try {
              const res = await searchApi.web(a.query, a.maxResults, abortRef.current?.signal)
              blocks.push(formatWebSearchResults(res))
              anySucceeded = true
            } catch (e) {
              // Stop mid-search: hand the caller the same AbortError a stopped
              // completion throws, so it takes the soft-cancel path rather than
              // reporting a failed search and planning another round.
              if (abortRef.current?.signal.aborted) throw new DOMException('Aborted', 'AbortError')
              blocks.push(`Web search for “${a.query}” failed: ${errorMessage(e, 'the search could not be run')}`)
            }
          }
          summaries.push([...blocks, webSearchContinuation(anySucceeded)].join('\n\n'))
        }

        history = [
          ...history,
          { role: 'assistant', content: JSON.stringify({ actions: [...findActions, ...webActions] }) },
          { role: 'user', content: summaries.join('\n\n---\n\n') },
        ]

        plan = await planOnce()
      }

      // Drop any leftover retrieval actions — they're resolved above, never executed.
      // A web_search also lands here when no backend is configured (the loop only runs
      // them in 'action' mode), so this doubles as the guard for a model that asks for a
      // search it was never offered.
      const leftoverRetrieval = plan.actions.filter((a) => a.type === 'find_notes' || a.type === 'web_search')
      if (leftoverRetrieval.length) {
        plan = { actions: plan.actions.filter((a) => a.type !== 'find_notes' && a.type !== 'web_search') }
        if (plan.actions.length === 0) {
          plan = {
            actions: [{
              type: 'respond',
              text: leftoverRetrieval.every((a) => a.type === 'find_notes')
                ? '_(No matching notes found.)_'
                : '_(The search didn’t turn up an answer — try rephrasing, or check Settings → AI → Assistant for web search.)_',
            }],
          }
        }
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
        // Keep the formatted text in the chat, but speak it stripped of Markdown.
        if (voiceActiveRef.current) voice.speak(stripMarkdownForSpeech(text))
      } else if (voiceActiveRef.current) {
        // Voice mode: read the plan back and wait for a spoken confirmation before
        // running it, regardless of the panel's Plan-mode setting.
        setPendingPlan({ plan, ctx, baseMessages: withUser, history, userRequest: userContent.trim() })
        const readback = describePlanForVoice(plan, ctx.labelMap)
        setVoiceConfirmText(readback)
        voice.speak(readback)
      } else if (planMode) {
        setPendingPlan({ plan, ctx, baseMessages: withUser, history, userRequest: userContent.trim() })
      } else {
        await runPlan(plan, ctx, withUser, history, userContent.trim())
      }
    } catch (e: unknown) {
      // A user-initiated Stop aborts the fetch — treat it as a soft cancel: keep the
      // question in the chat, drop the partial reply, and show no error.
      if (e instanceof DOMException && e.name === 'AbortError') {
        setConversation(withUser)
        void persistCurrentSession(withUser, sessionId)
      } else {
        setError(errorMessage(e))
        setErrorDetails(formatErrorDetails(e))
        // Keep the user's question in the chat (and persist it) even though the
        // request failed — reverting to priorMessages would silently discard what
        // they typed. They can retry by editing the message.
        setConversation(withUser)
        void persistCurrentSession(withUser, sessionId)
        if (voiceActiveRef.current) voice.speak('Sorry, something went wrong.')
      }
    } finally {
      setLoading(false)
      if (liveRafRef.current !== null) { cancelAnimationFrame(liveRafRef.current); liveRafRef.current = null }
      setStreamingText(null)
      abortRef.current = null
    }
  }

  function stopStreaming() {
    abortRef.current?.abort()
  }

  // Submit the input box, ending any in-progress dictation first. Shared by the
  // Enter key and the Send button so both stop the mic on submit — the dictate
  // button already stops via toggleDictation. dictatedThisSessionRef is cleared so
  // the mode→null transition effect doesn't also fire a second, duplicate send.
  function submitFromInput() {
    if (dictation.mode === 'dictation') {
      dictatedThisSessionRef.current = false
      dictation.stopDictation()
    }
    void handleSend(input, conversation)
  }

  // Run a Recipe (Overview: selecting one injects its prompt into the chat and sends
  // it — no manual review). Placeholders ({{title}}, {{selected text}}, {{date}}) are
  // substituted against the live context first. handleSend already gates multi-step
  // plans behind Plan mode's confirmation UI, so that's where "if plan mode is on the
  // user is prompted to confirm" naturally falls out — a respond-only reply still runs
  // straight through either way.
  function handleRunRecipe(recipe: Recipe) {
    const prompt = renderRecipePrompt(recipe.prompt, { title: noteTitle, selectedText: getCurrentSelectionText() })
    if (!prompt.trim()) return
    setPanelTab('chat')
    void handleSend(prompt, conversation)
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

  // Reduce a Markdown response to plain-ish prose so it's read aloud (both the
  // per-message button and voice mode) without voicing the markup — asterisks,
  // backticks, link URLs, cite tags, heading hashes, list bullets, table pipes.
  function stripMarkdownForSpeech(md: string): string {
    return md
      .replace(/<cite[^>]*>([\s\S]*?)<\/cite>/g, '$1')       // cite tags → their text
      .replace(/```[\s\S]*?```/g, ' ')                        // fenced code blocks
      .replace(/^\s{0,3}\|?[\s:|-]*-[\s:|-]*$/gm, '')         // table separators / horizontal rules
      .replace(/\|/g, ' ')                                    // table cell pipes → spaces
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')               // images → alt text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')                // links → label text
      .replace(/`([^`]+)`/g, '$1')                            // inline code
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')                     // heading hashes
      .replace(/^\s{0,3}>\s?/gm, '')                          // blockquotes
      .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')          // list markers (-, *, +, 1., 1))
      .replace(/[*_~]+/g, '')                                 // bold / italic / strikethrough
      .replace(/[ \t]{2,}/g, ' ')                             // collapse runs of spaces
      .replace(/\n{3,}/g, '\n\n')                             // collapse extra blank lines
      .trim()
  }

  function handleReadAloud(content: string, id: string) {
    // Toggle: clicking the message that's speaking stops it; clicking any other
    // starts it (startPlayback cancels any current playback inside the hook).
    if (speakingMsgId === id && readAloud.isSpeaking) {
      readAloud.stop()
      setSpeakingMsgId(null)
      return
    }
    const text = stripMarkdownForSpeech(content)
    if (!text) return
    setSpeakingMsgId(id)
    readAloud.play(text)
  }

  function interpretYesNo(text: string): 'yes' | 'no' | 'unclear' {
    const t = ` ${text.toLowerCase().replace(/[^a-z\s']/g, ' ')} `
    if (/\b(yes|yeah|yep|yup|sure|confirm|go ahead|do it|please do|okay|ok|correct|affirmative)\b/.test(t)) return 'yes'
    if (/\b(no|nope|nah|cancel|stop|don't|do not|never mind|nevermind|abort|negative)\b/.test(t)) return 'no'
    return 'unclear'
  }

  // Does the utterance naturally wrap up the conversation ("that'll be all",
  // "goodbye", "exit voice mode")? Used to let the user end voice mode by speaking
  // rather than tapping End. Kept deliberately conservative: unambiguous farewells
  // and explicit "…voice" commands match at any length, while softer "I'm done" /
  // "that's all" phrasings match only in a short utterance, so a long sentence that
  // merely contains those words isn't mistaken for a sign-off.
  function isEndIntent(text: string): boolean {
    // Drop apostrophes (so contractions collapse: "that's"→"thats") and keep letters/spaces.
    const norm = text.toLowerCase().replace(/['’]/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!norm) return false
    const t = ` ${norm} `
    // Explicit "exit/stop/close … voice [mode]" commands (verb immediately before "voice").
    if (/\b(exit|end|close|stop|quit|leave|turn off|shut off)\s+(the\s+)?voice\b/.test(t)) return true
    // Clear farewells.
    if (/\b(goodbye|good bye|bye bye|bye now|bye|see ya|good ?night)\b/.test(t)) return true
    if (/\bsee\s+you\b/.test(t)) return true
    if (/\b(talk|chat|speak)\s+(to\s+you\s+)?later\b/.test(t)) return true
    // Softer sign-offs — only when the whole utterance is short.
    if (norm.split(' ').length <= 6) {
      if (/\bthat(?:s| is|ll be| will be| would be)\s+(all|it|everything|enough)\b/.test(t)) return true
      if (/\b(im|i am|we are|were)\s+(all\s+)?(done|finished)\b/.test(t)) return true
      if (/\b(all done|nothing else|nothing more|no more questions|thats everything)\b/.test(t)) return true
    }
    return false
  }

  function describePlanForVoice(plan: Plan, labelMap: Map<string, string>): string {
    const respond = plan.actions
      .flatMap((a) => (a.type === 'respond' ? [a.text] : []))
      .filter(Boolean)
      .join(' ')
    const labels = plan.actions
      .filter((a) => a.type !== 'respond')
      .map((a) => a.description || defaultActionLabel(a, labelMap))
    const list = labels.length ? labels.join(', then ') : 'make some changes'
    const prefix = respond ? `${respond} ` : ''
    return stripMarkdownForSpeech(`${prefix}I'd like to ${list}. Should I go ahead?`)
  }

  async function handleVoiceUserTurn(transcript: string) {
    const text = transcript.trim()
    if (!text) return
    // A note-changing plan is awaiting a spoken confirmation: interpret yes/no.
    if (pendingPlanRef.current) {
      const decision = interpretYesNo(text)
      if (decision === 'yes') {
        const pp = pendingPlanRef.current
        setVoiceConfirmText(null)
        await runPlan(pp.plan, pp.ctx, pp.baseMessages, pp.history, pp.userRequest)
        voice.speak('Done.')
      } else if (decision === 'no') {
        setVoiceConfirmText(null)
        cancelPlan()
        voice.speak('Okay, I cancelled that.')
      } else {
        voice.speak('Should I go ahead? Please say yes or no.')
      }
      return
    }
    // "Run the summary recipe": resolve against the user's saved recipes and send its
    // (placeholder-substituted) prompt immediately — bypassing the plain-utterance
    // routing below, so recipes stay a one-shot voice command.
    const recipeMatch = matchRecipeVoiceCommand(text, recipes)
    if (recipeMatch) {
      const prompt = renderRecipePrompt(recipeMatch.prompt, { title: noteTitle, selectedText: getCurrentSelectionText() })
      await handleSend(prompt, conversationRef.current)
      return
    }
    // The user naturally wrapped up ("that'll be all", "goodbye", "exit voice mode"):
    // acknowledge out loud, then close voice mode once the farewell finishes speaking.
    // (endVoiceSession tears down TTS immediately, so it must run only after playback.)
    if (isEndIntent(text)) {
      voice.speak('Sure, talk to you later!', { onEnd: () => { void endVoiceSession(true) } })
      return
    }
    // Otherwise route the utterance through the same pipeline as typed chat;
    // handleSend speaks the reply / reads back a plan when voiceActiveRef is set.
    await handleSend(text, conversationRef.current)
  }
  useEffect(() => { voiceTurnRef.current = (t) => { void handleVoiceUserTurn(t) } })

  async function openVoiceSession() {
    if (!aiService) { setError('Select an AI provider first.'); return }
    setError('')
    setVoiceConfirmText(null)
    setVoiceOpen(true)
    voiceActiveRef.current = true
    // Ensure a session exists so the transcript persists into it.
    if (!currentSessionId && sessionsEnabled) {
      await autoCreateSession('Voice session')
    }
    await voice.start()
  }

  async function endVoiceSession(withSummary: boolean) {
    const wasActive = voiceActiveRef.current
    voiceActiveRef.current = false
    setVoiceConfirmText(null)
    voice.stop()
    setVoiceOpen(false)
    if (withSummary && wasActive) await appendVoiceSummary()
  }

  async function appendVoiceSummary() {
    const svc = aiService
    if (!svc) return
    const convo = conversationRef.current
    if (convo.length === 0) return
    try {
      const transcript = convo
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n')
      const summary = await svc.generateSummary(transcript, 'Summarize this voice conversation in 2-3 sentences.')
      if (summary && summary.trim()) {
        const withSummary = [...conversationRef.current, assistantMsg(`**Voice session summary**\n\n${summary.trim()}`)]
        setConversation(withSummary)
        void persistCurrentSession(withSummary)
      }
    } catch {
      /* summary is best-effort — never block closing the session */
    }
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

  // Respond ("Response") steps are auto-accepted: they carry the conversational reply
  // and are always executed, so the plan review never lists or counts them — it shows
  // only the mutation steps the user actually decides between. selectedSteps stays
  // indexed by the full action list (respond entries kept `true`), so those steps pass
  // straight through the Approve filter without a checkbox.
  const reviewSteps = pendingPlan
    ? pendingPlan.plan.actions
        .map((action, index) => ({ action, index }))
        .filter(({ action }) => action.type !== 'respond')
    : []
  const selectedReviewCount = reviewSteps.filter(({ index }) => selectedSteps[index] ?? true).length

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

      {/* Header: Chat | Recipes | History tabs */}
      <div className="shrink-0 flex items-center justify-between px-2 py-1.5 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-0.5 text-xs font-semibold">
          <button
            onClick={() => setPanelTab('chat')}
            className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors ${
              panelTab === 'chat'
                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            Assistant
          </button>
          <button
            onClick={() => setPanelTab('recipes')}
            className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors ${
              panelTab === 'recipes'
                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            Recipes
          </button>
          <button
            onClick={() => setPanelTab('history')}
            disabled={!sessionsEnabled}
            className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors disabled:opacity-40 ${
              panelTab === 'history'
                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            History
          </button>
        </div>
        <div className="flex items-center gap-1">
          {voiceCapable && (
            <button
              onClick={() => (voiceOpen ? void endVoiceSession(true) : void openVoiceSession())}
              className={`btn-ghost p-1 ${voiceOpen ? 'text-indigo-500' : ''}`}
              title={voiceOpen ? 'End voice mode' : 'Start voice mode'}
            >
              <AudioLines className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => void handleNewSession()}
            className="btn-ghost p-1"
            title="New session"
            disabled={!sessionsEnabled}
          >
            <Plus className="w-4 h-4" />
          </button>
          <button onClick={onToggle} className="btn-ghost p-1" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Voice mode overlay (Deepgram Flux) */}
      {voiceOpen && (
        <VoiceModeOverlay
          state={voice.state}
          interimText={voice.interimText}
          errorMessage={voice.errorMessage}
          confirmText={voiceConfirmText}
          onConfirm={() => {
            const pp = pendingPlanRef.current
            if (!pp) return
            setVoiceConfirmText(null)
            void (async () => {
              await runPlan(pp.plan, pp.ctx, pp.baseMessages, pp.history, pp.userRequest)
              voice.speak('Done.')
            })()
          }}
          onCancel={() => { setVoiceConfirmText(null); cancelPlan(); voice.speak('Okay, I cancelled that.') }}
          onEnd={() => void endVoiceSession(true)}
          onInterrupt={() => voice.interrupt()}
        />
      )}

      {/* Recipes tab: manage saved prompts (list/add/edit/delete/tags/import-export) */}
      {panelTab === 'recipes' && (
        <RecipesPanel
          recipes={recipes}
          loading={recipesLoading}
          onCreate={createRecipe}
          onUpdate={updateRecipe}
          onDelete={deleteRecipe}
          onRun={handleRunRecipe}
          previewContext={{ title: noteTitle, selectedText: getCurrentSelectionText() }}
          disabled={!aiService}
        />
      )}

      {/* History tab: past AI sessions for this note (or global, in list mode) */}
      {panelTab === 'history' && (
        <div className="flex-1 flex flex-col overflow-hidden">
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

      {panelTab === 'chat' && (
      <>
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
                {(falKeyConfigured || deepgramKeyConfigured) && (
                  <button
                    className="flex items-center gap-1 text-xs text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors px-1.5 py-0.5 rounded hover:bg-indigo-50 dark:hover:bg-indigo-900/20"
                    title={speakingMsgId === msg.id && readAloud.isSpeaking ? 'Stop reading' : 'Read aloud'}
                    onClick={() => handleReadAloud(msg.content, msg.id)}
                  >
                    {speakingMsgId === msg.id && readAloud.isSpeaking ? (
                      <><Square className="w-3 h-3" />{readAloud.status === 'loading' ? 'Loading…' : 'Stop'}</>
                    ) : (
                      <><Volume2 className="w-3 h-3" />Read aloud</>
                    )}
                  </button>
                )}
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
          streamingText ? (
            // Live streamed reply — replaces the "Thinking…" bubble once tokens arrive.
            // Rendered with a trailing caret; the final, fully-styled message is appended
            // when the stream completes.
            <div className="flex flex-col items-start gap-1">
              <div className="max-w-[85%] bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-2xl rounded-tl-sm px-3 py-2 text-sm leading-relaxed break-words">
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
                </div>
                <span className="inline-block w-1.5 h-3.5 ml-0.5 align-middle bg-gray-400 animate-pulse" aria-hidden="true" />
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl rounded-tl-sm px-3 py-2.5 flex items-center gap-2 text-gray-400 text-sm">
                <Spinner />
                Thinking…
              </div>
            </div>
          )
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

            <RecipePickerDropdown recipes={recipes} disabled={loading || executing} onSelect={handleRunRecipe} />

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
              onClick={() => setShowNotePicker(true)}
              disabled={!!frozenContext}
              title="Attach notes to the AI context"
              className="flex items-center gap-0.5 text-gray-400 hover:text-blue-500 transition-colors disabled:opacity-40"
            >
              <FilePlus2 className="w-3 h-3" />
              {attachedNotes.length > 0 && (
                <span className="text-blue-500 font-medium">{attachedNotes.length}</span>
              )}
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!!frozenContext}
              title={supportsImages ? 'Attach files to next message' : `Attach text files — ${activeProvider?.name ?? 'the active provider'} doesn't accept images`}
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
              // Text-only providers can't take images/PDFs — hint the native picker.
              // Not a hard guarantee (drag/drop, "all files"), so onChange filters too.
              accept={supportsImages ? undefined : '.md,.txt,.json,.csv,.yaml,.yml,.toml,.xml,.js,.ts,.py,.sh,.sql,text/*,application/json,application/xml'}
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files ? Array.from(e.target.files) : []
                e.target.value = ''
                if (!picked.length) return
                if (supportsImages) {
                  setAttachNotice('')
                  setPendingFiles((prev) => [...prev, ...picked])
                  return
                }
                // Provider is text-only: keep text files, drop images/PDFs and say why.
                const isImageLike = (file: File) => file.type.startsWith('image/') || file.type === 'application/pdf'
                const blocked = picked.filter(isImageLike)
                const allowed = picked.filter((file) => !isImageLike(file))
                if (allowed.length) setPendingFiles((prev) => [...prev, ...allowed])
                setAttachNotice(
                  blocked.length
                    ? `${blocked.length} image/PDF file${blocked.length > 1 ? 's' : ''} skipped — ${activeProvider?.name ?? 'the active provider'} doesn't support images. Switch to a vision-capable provider in Settings.`
                    : ''
                )
              }}
            />
          </div>

          {/* Text-only-provider attach notice */}
          {attachNotice && (
            <div className="px-2 pb-1 text-xs text-amber-600 dark:text-amber-400">{attachNotice}</div>
          )}

          {/* Attached-note pills */}
          {attachedNotes.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {attachedNotes.map((note, i) => (
                <span
                  key={note.id}
                  className="flex items-center gap-1 text-xs bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 rounded px-1.5 py-0.5"
                  title={note.title || 'Untitled'}
                >
                  <FileText className="w-3 h-3 shrink-0" />
                  {(note.title || 'Untitled').length > 16 ? `${(note.title || 'Untitled').slice(0, 14)}…` : (note.title || 'Untitled')}
                  <button
                    onClick={() => setAttachedNotes((prev) => prev.filter((_, j) => j !== i))}
                    className="hover:text-red-500 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

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
                    <DictationWaveIcon className="text-red-500" />
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
                    submitFromInput()
                  }
                }}
                placeholder="Ask a question or tell me what to do…"
                rows={1}
                className="flex-1 resize-none input text-sm py-1.5 max-h-28 overflow-y-auto"
                disabled={loading || executing}
              />
              {loading ? (
                // While a reply is streaming/planning, the send button becomes a Stop
                // button that aborts the in-flight stream (soft cancel — see handleSend).
                <button
                  className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-gray-600 hover:bg-gray-700 text-white transition-colors"
                  onClick={stopStreaming}
                  type="button"
                  aria-label="Stop generating"
                  title="Stop generating"
                >
                  <span className="w-2.5 h-2.5 bg-white rounded-[2px]" />
                </button>
              ) : (
                <button
                  className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
                  disabled={executing || !input.trim()}
                  onClick={submitFromInput}
                  type="button"
                >
                  {executing ? <Spinner /> : <Send className="w-3.5 h-3.5" />}
                </button>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-0.5">Shift+Enter for new line</p>
          </div>
        </div>
      )}
      </>
      )}

      {/* Plan confirmation (Plan mode) */}
      {pendingPlan && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 p-3"
          onClick={() => { if (!executing && !generating) cancelPlan() }}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-sm max-h-full flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1.5 px-4 py-3 border-b border-gray-100 dark:border-gray-700">
              <ListChecks className="w-4 h-4 text-blue-500" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Review plan</h3>
              <span className="text-xs text-gray-400 ml-auto">
                {selectedReviewCount} / {reviewSteps.length} step{reviewSteps.length === 1 ? '' : 's'}
              </span>
            </div>
            <ul className="flex-1 overflow-y-auto px-4 py-3 space-y-2 text-sm text-gray-700 dark:text-gray-200">
              {reviewSteps.map(({ action, index }) => (
                <li key={index} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selectedSteps[index] ?? true}
                    onChange={(e) => setSelectedSteps((prev) => {
                      const next = [...prev]; next[index] = e.target.checked; return next
                    })}
                    className="mt-0.5 h-3.5 w-3.5 accent-blue-600 cursor-pointer shrink-0"
                  />
                  <span className="leading-snug">{defaultActionLabel(action, pendingPlan.ctx.labelMap)}</span>
                </li>
              ))}
            </ul>
            {pendingPlan.plan.actions.some((a) => a.type === 'edit_note' && a.mode === 'replace') && (
              <p className="px-4 pb-2 text-xs text-amber-600 dark:text-amber-400">
                ⚠ A full replace overwrites the note body — embedded child notes or images may be removed. A version snapshot is saved first, so you can restore from history.
              </p>
            )}
            {generating && genProgress && (
              // Live liveness cue for the long streaming generation (a static spinner alone
              // reads as frozen): a growing char count for a single body, done/total for many.
              <div className="flex items-center gap-2 px-4 pb-2 text-xs text-gray-500 dark:text-gray-400">
                <Spinner />
                <span>
                  {genProgress.total > 1
                    ? `Writing note bodies… ${genProgress.done}/${genProgress.total}`
                    : 'Writing the note body…'}
                  {genProgress.chars > 0 ? ` · ${genProgress.chars.toLocaleString()} characters` : ''}
                </span>
              </div>
            )}
            <div className="flex gap-2 px-4 py-3 border-t border-gray-100 dark:border-gray-700">
              <button
                className="flex-1 px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors flex items-center justify-center gap-1.5"
                disabled={executing || generating || selectedReviewCount === 0}
                onClick={() => {
                  // Respond steps are always kept (auto-accepted); mutation steps follow their checkbox.
                  const filtered = { actions: pendingPlan.plan.actions.filter((a, i) => a.type === 'respond' || selectedSteps[i]) }
                  void runPlan(filtered, pendingPlan.ctx, pendingPlan.baseMessages, pendingPlan.history, pendingPlan.userRequest)
                }}
              >
                {generating ? <><Spinner /> Writing…</> : executing ? <><Spinner /> Running…</> : 'Approve & run'}
              </button>
              {generating ? (
                // While generating, Cancel becomes an active Stop that aborts the streams.
                <button
                  className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  onClick={stopGenerating}
                >
                  Stop
                </button>
              ) : (
              <button
                className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
                disabled={executing}
                onClick={cancelPlan}
              >
                Cancel
              </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showNotePicker && (
        <NotePickerModal
          onSelect={(id, title) => {
            setAttachedNotes((prev) => (prev.some((n) => n.id === id) ? prev : [...prev, { id, title }]))
            setShowNotePicker(false)
          }}
          onClose={() => setShowNotePicker(false)}
        />
      )}
    </div>
  )
}
