import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { processCiteTags } from '@/utils/markdown'
import { Sparkles, X, Send, Copy, Check, Plus, Pencil, Trash2, Mic, Paperclip, Lock, LockOpen, ListChecks, FileText, FilePlus2, History, Volume2, Square, AudioLines, BookOpen } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useSettingsStore } from '@/stores/settings'
import { useCategoriesStore } from '@/stores/categories'
import { useRecipesStore } from '@/stores/recipes'
import { useAssetsStore } from '@/stores/assets'
import type { NoteAsset, NoteAssetUpdate } from '@/api/assets'
import { useDictation } from '@/hooks/useDictation'
import { useTextToSpeech } from '@/hooks/useTextToSpeech'
import { useVoiceMode } from '@/hooks/useVoiceMode'
import VoiceModeOverlay from '@/components/VoiceModeOverlay'
import DictationWaveIcon from '@/components/DictationWaveIcon'
import NotePickerModal from '@/components/NotePickerModal'
import RecipesPanel from '@/components/RecipesPanel'
import AssetsPanel from '@/components/AssetsPanel'
import RecipePickerDropdown from '@/components/RecipePickerDropdown'
import { settingsApi } from '@/api/settings'
import { configApi } from '@/api/config'
import { notesApi, type NoteListItem } from '@/api/notes'
import { foldersApi } from '@/api/folders'
import { annotationsApi } from '@/api/annotations'
import { aiSessionsApi, type AISession } from '@/api/aiSessions'
import { assistantApi } from '@/api/assistant'
import type { ActivityJob } from '@/api/activity'
import { errorMessage } from '@/utils/aiErrors'
import { isActive, isAwaitingApproval, isSettled } from '@/api/activity'
import { useActivityStore } from '@/stores/activity'
import type { Recipe } from '@/api/recipes'
import { renderRecipePrompt, getCurrentSelectionText } from '@/utils/recipeVariables'
import { matchRecipeVoiceCommand } from '@/utils/recipeVoiceCommand'
import { extractPlainText, extractLinkedFileUrls, extractBlockTexts, type MarkdownEditor } from '@/utils/blocks'
import { describeDiagrams } from '@/utils/diagram'
import type { FileAttachment, ConversationTurn, ConversationRequest } from '@/services/ai'
import {
  normalizeActionTags,
  buildPlanReferenceBlock,
  formatNoteMeta,
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

// How often the panel asks what the model has said so far. The worker writes the
// reply onto its job row about once a second, so asking faster only costs requests.
const PREVIEW_POLL_MS = 1000

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

/** A plan the server has parked, waiting for the user to decide.
 *
 * Far less than it used to carry. The context, the history and the request all live on
 * the job now — approving is a single call naming which steps to keep — so what is
 * left is only what the modal draws with. */
interface PendingPlan {
  runId: string
  plan: Plan
  /** Resolves the ids the plan names to note, folder and category titles. */
  labelMap: Map<string, string>
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
  editor?: MarkdownEditor | null
  defaultCategoryId?: string
  currentFolderId?: string | null
  onBeforeExecute?: () => Promise<void> | void
  onCurrentNoteEdited?: () => Promise<void> | void
  onNotesChanged?: () => void
  getAnnotations?: () => { id: string; block_id: string; text: string }[]
  onAnnotationsChanged?: () => Promise<void> | void
  // Assets tab: insert a block at the cursor, strip every block pointing at a media URL,
  // and force a save. Block edits go through the live editor rather than the server
  // because the editor holds the document — a server-side rewrite of note.content would
  // just be overwritten by the next autosave.
  onInsertBlocks?: (blocks: unknown[]) => void
  onRemoveMediaBlocks?: (url: string) => void
  onFlushSave?: () => Promise<void>
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
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

// A per-file ceiling on what may ride along as AI context. Attachments are base64'd
// into the request body, so one large PDF is enough to blow a whole turn.
const MAX_CONTEXT_FILE_BYTES = 10 * 1024 * 1024

async function urlToAttachment(url: string, name?: string): Promise<FileAttachment | null> {
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const blob = await resp.blob()
    const isImage = blob.type.startsWith('image/')
    const isPdf = blob.type === 'application/pdf'
    if (!isImage && !isPdf) return null
    if (blob.size > MAX_CONTEXT_FILE_BYTES) return null
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1]
        resolve({
          type: isPdf ? 'document' : 'image',
          mimeType: blob.type,
          data: base64,
          name: name ?? url.split('/').pop() ?? 'file',
        })
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

// Reference material a model can read as plain text rather than as a content block.
const TEXT_CONTEXT_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.toml']

async function urlToContextText(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const blob = await resp.blob()
    if (blob.size > MAX_CONTEXT_FILE_BYTES) return null
    return await blob.text()
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
  onInsertBlocks,
  onRemoveMediaBlocks,
  onFlushSave,
}: AIConversationPanelProps) {
  const isList = mode === 'list'
  // Sessions are available when scoped to a saved note (editor) or in the global
  // list-view assistant (null note_id). A brand-new, unsaved editor note has no id yet.
  const sessionsEnabled = isList || !!noteId
  // Assets belong to a saved note, so unlike sessions there is nothing to show in
  // list mode or before the first save.
  const assetsEnabled = !isList && !!noteId
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
  // Chat | Recipes | History | Assets — four tabs sharing this one side panel.
  const [panelTab, setPanelTab] = useState<'chat' | 'recipes' | 'history' | 'assets'>('chat')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')

  const recipes = useRecipesStore((s) => s.recipes)
  const recipesLoading = useRecipesStore((s) => s.loading)
  const createRecipe = useRecipesStore((s) => s.createRecipe)
  const updateRecipe = useRecipesStore((s) => s.updateRecipe)
  const deleteRecipe = useRecipesStore((s) => s.deleteRecipe)

  const assets = useAssetsStore((s) => s.assets)
  const assetsLoading = useAssetsStore((s) => s.loading)
  const assetsError = useAssetsStore((s) => s.error)

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
  // The reply so far, polled off the turn's job row while it is planning.
  const [streamingText, setStreamingText] = useState<string | null>(null)

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isMobileRef = useRef(isMobile)
  const panelWidthRef = useRef(panelWidth)
  const panelHeightRef = useRef(panelHeight)

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
    onBargeIn: () => stopTurn(),
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
      if (text.trim() && !loading && !planning && aiService) {
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

  // This conversation's turn, whatever phase it is in.
  const activityJobs = useActivityStore((s) => s.jobs)
  const mine = (job: ActivityJob) =>
    job.kind === 'assistant' && !!currentSessionId && job.meta?.session_id === currentSessionId
  const activeRun = useMemo(
    () => Object.values(activityJobs).find((job) => mine(job) && isActive(job)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activityJobs, currentSessionId],
  )

  // Planning is the one phase that owns the conversation: a second question asked while
  // the first is still being thought about would race it. Once the turn is writing or
  // applying, the composer opens again — the *note* is what is held then, not the chat.
  const planning = activeRun?.meta?.phase === 'planning'
  const runInFlight = executing || planning

  // The transcript lives on the server: the worker appends the model's reply and its
  // result summary there, whether or not this panel was open. So it is reloaded rather
  // than reproduced.
  const reloadTranscript = useCallback(async () => {
    if (!currentSessionId) return
    try {
      const data = await aiSessionsApi.list(noteId ?? null)
      setSessions(data)
      const found = data.find((s) => s.id === currentSessionId)
      if (!found) return
      try {
        setConversation(JSON.parse(found.messages) as ConversationMessage[])
      } catch { /* keep what we have */ }
    } catch { /* offline; the next poll picks it up */ }
  }, [currentSessionId, noteId])

  // A finished turn: reload what it wrote, and refresh whatever it may have changed.
  // Keyed on *settled* rather than "no longer active", because a turn parked for
  // approval is neither — treating that as finished would mark it done here and then
  // never reload the summary it writes after the user approves it.
  const settledRuns = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const job of Object.values(activityJobs)) {
      if (!mine(job) || !isSettled(job)) continue
      if (settledRuns.current.has(job.id)) continue
      settledRuns.current.add(job.id)

      void reloadTranscript()
      onNotesChanged?.()
      void onCurrentNoteEdited?.()
      void onAnnotationsChanged?.()
      void useRecipesStore.getState().loadRecipes()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityJobs, currentSessionId, noteId, reloadTranscript])

  // While the model is writing, show what it has said so far. The worker puts the reply
  // on its job row about once a second; this is the only thing that polls for it, and
  // only while its own turn is actually planning.
  useEffect(() => {
    if (!activeRun || !planning) {
      setStreamingText(null)
      return
    }
    const runId = activeRun.id
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      try {
        const { data } = await assistantApi.preview(runId)
        if (!stopped) setStreamingText(liveExtractText(data.text))
      } catch { /* a missed poll keeps the last text; try again */ }
      if (!stopped) timer = setTimeout(() => void tick(), PREVIEW_POLL_MS)
    }
    void tick()

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [activeRun, planning])

  // A plan the server parked for review. Fetched rather than kept in state, because the
  // panel that asked the question may be long gone — this is what makes a plan still be
  // waiting when you come back to the note.
  const openedPlans = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (pendingPlan) return
    const parked = Object.values(activityJobs).find((job) => mine(job) && isAwaitingApproval(job))
    if (!parked || openedPlans.current.has(parked.id)) return
    openedPlans.current.add(parked.id)

    void assistantApi.plan(parked.id).then(({ data }) => {
      const labelMap = new Map(Object.entries(data.label_map))
      setPendingPlan({ runId: parked.id, plan: data.plan, labelMap })
      void reloadTranscript()
      // A find_notes resolved server-side still belongs in the list view's results.
      if (data.found_note_ids.length) {
        void notesApi
          .list({ ids: data.found_note_ids.join(','), limit: 50, include_children: true })
          .then((res) => onSearchResults?.(data.search_label || 'Search results', res.data))
          .catch(() => {})
      }
      // Voice confirms out loud instead of through the modal.
      if (voiceActiveRef.current) {
        const readback = describePlanForVoice(data.plan, labelMap)
        setVoiceConfirmText(readback)
        voice.speak(readback)
      }
    }).catch(() => {
      // Gone, or someone else's. Let it be re-picked-up if it reappears.
      openedPlans.current.delete(parked.id)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityJobs, currentSessionId, pendingPlan, reloadTranscript])

  // Plans left waiting from a previous visit. The activity store is lost on reload, and
  // /api/activity?active=1 rightly does not list a turn that is holding nothing.
  useEffect(() => {
    void assistantApi.listAwaiting()
      .then(({ data }) => data.forEach((job) => useActivityStore.getState().track(job)))
      .catch(() => {})
  }, [])

  // Keep the assets cache pointed at the open note, and only let the editor's autosave
  // refresh it while the tab is actually on screen (see stores/assets.ts).
  useEffect(() => {
    const store = useAssetsStore.getState()
    if (panelTab !== 'assets' || !noteId) {
      store.setWatching(false)
      return
    }
    store.setWatching(true)
    void store.load(noteId)
    return () => { useAssetsStore.getState().setWatching(false) }
  }, [panelTab, noteId])

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
      const fetched = await Promise.all(allUrls.map((u) => urlToAttachment(u)))
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
    const referenceParts = rendered.filter((_, i) => i !== currentIndex)

    // Assets marked "use as AI context" — the reference material kept alongside the note
    // rather than published in it. Images and PDFs go as content blocks; text-ish files
    // are appended to the REFERENCE block rather than the current-note message, because
    // the split here is by cache stability and this material doesn't change between
    // turns. Putting a long PDF's text in the volatile half would re-send it every turn
    // and undo the point of freezing the context.
    if (!isList && noteId) {
      try {
        const contextAssets = (await useAssetsStore.getState().loadForContext(noteId))
          .filter((a) => a.ai_context && a.ai_eligible && !a.missing)
        const docParts: string[] = []
        for (const asset of contextAssets) {
          const ext = asset.filename.slice(asset.filename.lastIndexOf('.')).toLowerCase()
          if (TEXT_CONTEXT_EXTENSIONS.includes(ext)) {
            const text = await urlToContextText(asset.url)
            if (text) docParts.push(`### ${asset.display_name}\n\`\`\`\n${text}\n\`\`\``)
          } else {
            const attachment = await urlToAttachment(asset.url, asset.display_name)
            if (attachment) fileAttachments.push(attachment)
          }
        }
        if (docParts.length > 0) {
          referenceParts.push(`**Reference documents for this note:**\n\n${docParts.join('\n\n')}`)
        }
      } catch {
        // Context is best-effort: a failed asset fetch must not stop the turn.
      }
    }

    const referenceContextText = referenceParts.join('\n\n---\n\n')

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
  // Phase 2: fill in deferred note bodies. For each action that declared a `spec` but left
  // `content` empty, make a per-document generation call that reuses the planning call's
  // cached prefix (same instructions/reference/history/current-note + request) and appends
  // [assistant: <compact plan>, user: <step instruction>]. Runs in parallel (capped). Mutates
  // the successful actions' `content` in place; returns a runnable plan with any failed
  /**
   * Run a plan the server parked for review.
   *
   * The plan, the context and the conversation all live on the job already, so this is
   * one call naming which steps survived the checkboxes. `respond` actions are kept
   * server-side whatever was ticked — the model's reply is not a step the user is
   * choosing between.
   */
  async function approvePlan(actionIndices?: number[]) {
    const pending = pendingPlanRef.current
    if (!pending) return
    setExecuting(true)
    try {
      // Flush unsaved edits first, so amend/append build on the latest content and the
      // run isn't overwritten by a stale autosave a moment later.
      await onBeforeExecute?.()
      const { data: job } = await assistantApi.approve(pending.runId, actionIndices)
      setPendingPlan(null)
      useActivityStore.getState().track(job)
    } catch (e) {
      setError(errorMessage(e, 'Failed to start the plan'))
      setErrorDetails(formatErrorDetails(e))
    } finally {
      setExecuting(false)
    }
  }

  /** Decline a parked plan. The server says so in the chat, so the transcript reload
   *  that follows is what puts it on screen. */
  async function cancelPlan() {
    const pending = pendingPlanRef.current
    setPendingPlan(null)
    if (!pending) return
    try {
      const { data: job } = await assistantApi.cancel(pending.runId)
      useActivityStore.getState().track(job)
    } catch {
      // Already finished or gone; the transcript reload below still catches up.
    }
    void reloadTranscript()
  }

  /**
   * Ask for something. Everything after this happens on the server.
   *
   * What is left here is the half only a browser can do: reading the live editor
   * document, the attached files, and the scope the user picked, and assembling the
   * request body for this provider — cache breakpoints and all. Then the turn is handed
   * over and this returns. Planning, searching, deciding and running all happen without
   * it, which is the whole point: leaving the note no longer throws the work away.
   */
  async function handleSend(userContent: string, priorMessages: ConversationMessage[]) {
    if (!userContent.trim() || !aiService || loading || planning || executing || pendingPlan) return
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
      const userRequest = userContent.trim()
      const ctx = frozenContext ?? await buildPlanContext()

      // Prior turns become real message turns (note-link-stripped so the model can't
      // latch onto a stale id from an old result summary). The live current-note body
      // and the new request are sent last, after the cache breakpoint.
      const history = priorMessages
        .map((m) => ({ role: m.role, content: stripNoteLinks(m.content) }))
        .filter((m) => m.content.trim().length > 0) // drop empty turns (invalid as text blocks)

      // Compose the planner's system instructions from the static base plus two optional
      // blocks: the web-search guidance for however this provider searches (see
      // webSearchMode — native tool, app-run action, or nothing) and, in voice mode, the
      // spoken-reply guidance. Both belong to the planning call only; deferred note-body
      // generation keeps the base instructions, so saved note content stays fully
      // formatted Markdown and is never told about a capability it isn't given. Voice
      // guidance stays last so its "every rule above is unchanged" wording still refers
      // to everything before it.
      const planInstructions = [
        ctx.instructions,
        ...(webSearchMode === 'native' ? [NATIVE_WEB_SEARCH_INSTRUCTIONS] : []),
        ...(webSearchMode === 'action' ? [WEB_SEARCH_ACTION_INSTRUCTIONS] : []),
        ...(voiceActiveRef.current ? [VOICE_REPLY_INSTRUCTIONS] : []),
      ].join('\n\n')

      const req: ConversationRequest = {
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

      // Persist the question BEFORE handing the turn over. The worker appends the
      // model's reply to this same stored transcript, and if it got there first this
      // save would overwrite it.
      await persistCurrentSession(withUser, sessionId)

      const { data: job } = await assistantApi.start({
        prompt_ctx: aiService.buildPlanRequest(req),
        exec_ctx: {
          current_note_id: noteId ?? null,
          default_category_id: defaultCategoryId ?? '',
          current_folder_id: currentFolderId ?? null,
          valid_note_ids: ctx.targetNotes.map((n) => n.id),
          valid_folder_ids: ctx.folders.map((f) => f.id),
          valid_category_ids: ctx.categories.map((c) => c.id),
          valid_annotation_ids: [...ctx.annotationIds],
          valid_recipe_ids: ctx.recipes.map((r) => r.id),
        },
        turn_ctx: {
          label_map: Object.fromEntries(ctx.labelMap),
          folder_names: Object.fromEntries(ctx.folders.map((f) => [f.id, f.name])),
          plan_mode: planMode,
          // Voice always confirms out loud, whatever the plan-mode toggle says.
          voice: voiceActiveRef.current,
          web_search_mode: webSearchMode,
          use_summaries: useSummaries,
        },
        note_id: noteId ?? null,
        session_id: sessionId ?? null,
      })

      setPendingFiles([])
      useActivityStore.getState().track(job)
    } catch (e: unknown) {
      // A second turn against a note already working is an ordinary thing to attempt,
      // not a failure — say so in the chat rather than in red.
      const code = (e as { response?: { data?: { detail?: { code?: string } } } })
        ?.response?.data?.detail?.code
      if (code === 'already_running') {
        setConversation([
          ...withUser,
          assistantMsg('_This note already has a turn running. Wait for it to finish, or stop it from the header, then try again._'),
        ])
      } else {
        setError(errorMessage(e))
        setErrorDetails(formatErrorDetails(e))
        // Keep the user's question in the chat even though the request failed —
        // reverting would silently discard what they typed. They can retry by editing.
        setConversation(withUser)
        if (voiceActiveRef.current) voice.speak('Sorry, something went wrong.')
      }
    } finally {
      setLoading(false)
    }
  }

  /** Stop the turn. It runs on the server, so this asks the server to stop it —
   *  there is no in-flight request here to abort any more. */
  function stopTurn() {
    if (!activeRun) return
    void useActivityStore.getState().cancel(activeRun)
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

  // ─── Assets tab ────────────────────────────────────────────────────────────

  async function handleAssetUpload(file: File) {
    if (!noteId) return
    await useAssetsStore.getState().upload(noteId, file)
  }

  async function handleAssetUpdate(assetId: string, payload: NoteAssetUpdate) {
    if (!noteId) return
    await useAssetsStore.getState().update(noteId, assetId, payload)
    // Adding or removing a reference document changes what the next turn would send, so
    // a pinned snapshot of the old context is now stale — same reason the scope toggles
    // unfreeze it.
    if (payload.ai_context !== undefined) setFrozenContext(null)
  }

  /**
   * Delete an asset, optionally taking its blocks out of the note first.
   *
   * The order matters. Reconciliation re-registers any /media/ URL it finds when the
   * note is saved, so deleting the row while the block is still in the body means the
   * next autosave resurrects it — pointing at a file that no longer exists. Removing the
   * block and flushing the save first closes that window. If the user opts out, the row
   * does come back, marked as missing, which is at least honest.
   */
  async function handleAssetDelete(asset: NoteAsset, alsoRemoveFromNote: boolean) {
    if (!noteId) return
    if (alsoRemoveFromNote && asset.in_note && onRemoveMediaBlocks) {
      onRemoveMediaBlocks(asset.url)
      if (onFlushSave) await onFlushSave()
    }
    await useAssetsStore.getState().remove(noteId, asset.id)
    await useAssetsStore.getState().load(noteId, true)
  }

  // Put an asset back into the note using the same block shapes the editor writes.
  function handleAssetInsert(asset: NoteAsset) {
    if (!onInsertBlocks) return
    const type =
      asset.kind === 'images' ? 'image'
      : asset.kind === 'video' ? 'videoFile'
      : asset.kind === 'audio' ? 'audioFile'
      : 'file'
    onInsertBlocks([{ type, props: { url: asset.url, name: asset.display_name } }])
    // Save before refreshing. The server decides `in_note` from the note's stored
    // content, so the row only moves out of Reference once the insert has landed — and
    // onCurrentNoteEdited must not be used here: it re-hydrates the editor from the
    // server, which would throw the new block away before it was ever saved.
    void (async () => {
      if (onFlushSave) await onFlushSave()
      if (noteId) await useAssetsStore.getState().load(noteId, true)
    })()
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
        setVoiceConfirmText(null)
        await approvePlan()
        voice.speak('Done.')
      } else if (decision === 'no') {
        setVoiceConfirmText(null)
        await cancelPlan()
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
          <button
            onClick={() => setPanelTab('assets')}
            disabled={!assetsEnabled}
            className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors disabled:opacity-40 ${
              panelTab === 'assets'
                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            <Paperclip className="w-3.5 h-3.5" />
            Assets
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
            if (!pendingPlanRef.current) return
            setVoiceConfirmText(null)
            void (async () => {
              await approvePlan()
              voice.speak('Done.')
            })()
          }}
          onCancel={() => { setVoiceConfirmText(null); void cancelPlan(); voice.speak('Okay, I cancelled that.') }}
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

      {/* Assets tab: every file related to this note — in it, alongside it, or made from it */}
      {panelTab === 'assets' && (
        <AssetsPanel
          assets={assets}
          loading={assetsLoading}
          error={assetsError}
          noteId={noteId ?? null}
          canInsert={!!editor && !!onInsertBlocks}
          onUpload={handleAssetUpload}
          onDelete={handleAssetDelete}
          onUpdate={handleAssetUpdate}
          onInsert={handleAssetInsert}
          onRefresh={() => { if (noteId) void useAssetsStore.getState().load(noteId, true) }}
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

        {aiService && conversation.length === 0 && !loading && !planning && (
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

        {(loading || planning) && (
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
          {activeRun && !planning && (
            // The turn, once it is past planning. Shown here rather than in the plan
            // modal (which closes the moment the run starts) so it stays visible while
            // the conversation carries on around it. Not during planning: the thinking
            // bubble and the composer's Stop button already say that, and three ways to
            // stop one turn is two too many.
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
              <Spinner />
              <span className="truncate">
                {activeRun.stage || 'Working'}
                {activeRun.detail ? ` · ${activeRun.detail}` : ''}
                {` · ${activeRun.progress}%`}
              </span>
              <button
                className="btn-ghost ml-auto shrink-0 px-1.5 py-0.5 text-xs"
                onClick={() => void useActivityStore.getState().cancel(activeRun)}
                title="Stop this run"
              >
                Stop
              </button>
            </div>
          )}
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

            <RecipePickerDropdown recipes={recipes} disabled={loading || runInFlight} onSelect={handleRunRecipe} />

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
                  disabled={loading || planning}
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
                disabled={loading || runInFlight}
              />
              {loading || planning ? (
                // While the model is thinking, the send button becomes a Stop button.
                // The thinking is a job now, so this stops the job rather than aborting
                // a request this browser is holding open.
                <button
                  className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-gray-600 hover:bg-gray-700 text-white transition-colors disabled:opacity-40"
                  disabled={loading}
                  onClick={stopTurn}
                  type="button"
                  aria-label="Stop generating"
                  title="Stop generating"
                >
                  <span className="w-2.5 h-2.5 bg-white rounded-[2px]" />
                </button>
              ) : (
                <button
                  className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
                  disabled={runInFlight || !input.trim()}
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
          onClick={() => { if (!runInFlight) cancelPlan() }}
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
                  <span className="leading-snug">{defaultActionLabel(action, pendingPlan.labelMap)}</span>
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
                disabled={runInFlight || selectedReviewCount === 0}
                onClick={() => {
                  // Only the mutation steps need naming: the server keeps every respond
                  // action regardless, because the reply is not one of the choices.
                  void approvePlan(
                    pendingPlan.plan.actions.flatMap((a, i) =>
                      a.type !== 'respond' && selectedSteps[i] ? [i] : []),
                  )
                }}
              >
                {runInFlight ? <><Spinner /> Running…</> : 'Approve & run'}
              </button>
              <button
                className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
                disabled={runInFlight}
                onClick={() => void cancelPlan()}
              >
                Cancel
              </button>
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
