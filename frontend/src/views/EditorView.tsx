import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Sparkles, Printer, Trash2 } from 'lucide-react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import '@blocknote/core/fonts/inter.css'
import type { BlockNoteEditor, PartialBlock } from '@blocknote/core'

import CategoryPicker from '@/components/CategoryPicker'
import TagChip from '@/components/TagChip'
import ExportMenu from '@/components/ExportMenu'
import ShareMenu from '@/components/ShareMenu'
import AIPanel from '@/components/AIPanel'

import { useNotesStore } from '@/stores/notes'
import { useCategoriesStore } from '@/stores/categories'
import { useSettingsStore } from '@/stores/settings'
import { mediaApi } from '@/api/media'
import type { Note } from '@/api/notes'

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// Separate component so useCreateBlockNote is only called after initialContent is known.
// This prevents the editor from being created with empty content on the first render.
function EditorCanvas({
  initialContent,
  onChange,
  onReady,
}: {
  initialContent: PartialBlock[] | undefined
  onChange: () => void
  onReady: (editor: BlockNoteEditor) => void
}) {
  const editor = useCreateBlockNote({
    initialContent,
    uploadFile: async (file: File) => {
      const response = await mediaApi.upload(file)
      return response.data.url
    },
  })

  useEffect(() => {
    onReady(editor)
  }, [editor])

  return <BlockNoteView editor={editor} onChange={onChange} theme="light" />
}

export default function EditorView() {
  const navigate = useNavigate()
  const { id: noteId } = useParams<{ id: string }>()
  const isNew = !noteId

  const notesStore = useNotesStore()
  const categoriesStore = useCategoriesStore()
  const settingsStore = useSettingsStore()

  const [note, setNote] = useState<Note | null>(null)
  const [title, setTitle] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [newTagInput, setNewTagInput] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saveStatus, setSaveStatus] = useState('All changes saved')
  const [showAIPanel, setShowAIPanel] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [toastMessage, setToastMessage] = useState('')
  const [suggestedTags, setSuggestedTags] = useState<string[]>([])
  const [generatingTags, setGeneratingTags] = useState(false)
  const [initialContent, setInitialContent] = useState<PartialBlock[] | undefined>(undefined)

  const titleRef = useRef<HTMLTextAreaElement>(null)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const createdNoteId = useRef<string | null>(null)
  const currentNoteContent = useRef('')
  // Holds the editor instance provided by EditorCanvas once it mounts
  const editorRef = useRef<BlockNoteEditor | null>(null)
  // True during initialization to prevent autosave from firing on state changes caused by loading
  const skipAutosaveRef = useRef(true)
  // Always points to the latest doSave to avoid stale closures in the scheduleAutosave timer
  const doSaveRef = useRef<() => void>(() => {})

  const defaultCategoryId = categoriesStore.categories[0]?.id ?? ''

  const saveStatusClass = saveStatus === 'Saving...' ? 'text-yellow-600' : saveStatus.includes('Unsaved') ? 'text-orange-600' : 'text-gray-400'

  // Load note data on mount (or when noteId changes)
  useEffect(() => {
    skipAutosaveRef.current = true
    createdNoteId.current = null
    setLoaded(false)
    setNote(null)
    setTitle('')
    setCategoryId('')
    setTags([])
    setInitialContent(undefined)

    async function init() {
      await categoriesStore.loadCategories()

      if (isNew) {
        setCategoryId(defaultCategoryId)
        setLoaded(true)
        setTimeout(() => {
          titleRef.current?.focus()
          skipAutosaveRef.current = false
        }, 0)
      } else if (noteId) {
        const data = await notesStore.loadNote(noteId)
        setNote(data)
        setTitle(data.title)
        setCategoryId(data.category_id)
        setTags([...data.tags])
        let blocks: PartialBlock[] = []
        try { blocks = JSON.parse(data.content) } catch { /* empty doc */ }
        setInitialContent(blocks.length > 0 ? blocks : undefined)
        setLoaded(true)
        setTimeout(() => { skipAutosaveRef.current = false }, 0)
      }
    }
    init()
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current) }
  }, [noteId])

  // Sync categoryId once categories load (for new notes whose categories weren't ready yet)
  useEffect(() => {
    if (isNew && !categoryId && defaultCategoryId) {
      setCategoryId(defaultCategoryId)
    }
  }, [defaultCategoryId])

  async function doSave() {
    const editor = editorRef.current
    if (!editor) return
    setSaveStatus('Saving...')
    const content = JSON.stringify(editor.document)
    currentNoteContent.current = extractPlainText()
    const payload = {
      title: title || 'Untitled',
      content,
      category_id: categoryId || defaultCategoryId,
      tags,
    }
    try {
      if (isNew && !createdNoteId.current) {
        const created = await notesStore.createNote(payload)
        createdNoteId.current = created.id
        setNote(created)
        navigate(`/notes/${created.id}`, { replace: true })
      } else {
        const resolvedId = createdNoteId.current || noteId!
        const updated = await notesStore.updateNote(resolvedId, payload)
        setNote(updated)
      }
      setSaveStatus('All changes saved')
    } catch {
      setSaveStatus('Error saving')
    }
  }

  // Keep doSaveRef current so the timer always calls the latest version
  doSaveRef.current = doSave

  const scheduleAutosave = useCallback(() => {
    setSaveStatus('Unsaved changes')
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    autosaveTimer.current = setTimeout(() => doSaveRef.current(), 800)
  }, [])

  // Trigger autosave when title/category/tags change, but not during initial load
  useEffect(() => { if (loaded && !skipAutosaveRef.current) scheduleAutosave() }, [title, categoryId])
  useEffect(() => { if (loaded && !skipAutosaveRef.current) scheduleAutosave() }, [tags])

  function extractPlainText(): string {
    const editor = editorRef.current
    if (!editor) return ''
    try {
      const texts: string[] = []
      function processBlock(block: Record<string, unknown>) {
        const content = block.content
        if (Array.isArray(content)) {
          for (const item of content) {
            if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text') {
              texts.push(String((item as Record<string, unknown>).text ?? ''))
            }
          }
        }
        if (Array.isArray(block.children)) {
          for (const child of block.children) processBlock(child as Record<string, unknown>)
        }
      }
      for (const block of editor.document) { processBlock(block as unknown as Record<string, unknown>); texts.push('\n') }
      return texts.join('').trim()
    } catch { return '' }
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
      const content = extractPlainText()
      const generated = await settingsStore.aiService.generateTags(`${title}\n\n${content}`)
      onTagsGenerated(generated)
    } catch { showToast('Failed to generate tags') }
    finally { setGeneratingTags(false) }
  }

  function onTagsGenerated(generated: string[]) {
    setSuggestedTags(generated.filter((t) => !tags.includes(t)))
  }

  function autoResizeTitle(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  function goBack() {
    if (window.history.length > 1) navigate(-1)
    else navigate('/notes')
  }

  function handlePrint() {
    const style = document.createElement('style')
    style.setAttribute('media', 'print')
    style.textContent = '.no-print { display: none !important; } body { background: white; color: black; } .print-content { display: block !important; }'
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

  function insertAIText(text: string) {
    const editor = editorRef.current
    if (!editor) return
    editor.insertBlocks(
      [{ type: 'paragraph', content: text }],
      editor.getTextCursorPosition().block,
      'after',
    )
    setShowAIPanel(false)
  }

  function replaceAIText(text: string) {
    const editor = editorRef.current
    if (!editor) return
    editor.updateBlock(editor.getTextCursorPosition().block, { content: text })
    setShowAIPanel(false)
  }

  return (
    <div className="flex flex-col h-screen bg-white">
      <header className="shrink-0 border-b border-gray-100 no-print">
        <div className="flex items-center gap-2 px-4 py-2">
          <button className="btn-ghost p-2" onClick={goBack}>
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1" />
          {note && <ExportMenu note={note} onToast={showToast} />}
          {note && <ShareMenu note={note} onToast={showToast} />}
          <button className="btn-ghost p-2" title="Print" onClick={handlePrint}>
            <Printer className="w-4 h-4" />
          </button>
          <button className="btn-ghost p-2" title="AI Assistant" onClick={() => setShowAIPanel((v) => !v)}>
            <Sparkles className={`w-4 h-4 ${showAIPanel ? 'text-blue-600' : ''}`} />
          </button>
          <button
            className="btn-ghost p-2 text-red-400 hover:text-red-600 hover:bg-red-50"
            title="Delete note"
            disabled={!note}
            onClick={() => setShowDeleteConfirm(true)}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </header>

      {loaded && (
        <div className="shrink-0 px-6 pt-4 pb-2 no-print">
          <textarea
            ref={titleRef}
            value={title}
            placeholder="Untitled"
            rows={1}
            className="w-full text-3xl font-bold text-gray-900 resize-none border-0 outline-none focus:ring-0 bg-transparent placeholder-gray-300 leading-tight overflow-hidden print-content"
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
              <Sparkles className="w-3 h-3" />
              {generatingTags ? 'Generating...' : 'Generate Tags'}
            </button>
          </div>

          <div className="flex gap-4 mt-2 text-xs text-gray-400">
            {note && <span>Created {formatDate(note.created_at)}</span>}
            {note && <span>Modified {formatDate(note.modified_at)}</span>}
          </div>

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

      <div className="flex-1 min-h-0 overflow-auto px-4 pb-4 print-content">
        {!loaded ? (
          <div className="flex items-center justify-center h-full">
            <svg className="animate-spin w-6 h-6 text-gray-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
          </div>
        ) : (
          <EditorCanvas
            initialContent={initialContent}
            onChange={scheduleAutosave}
            onReady={(ed) => { editorRef.current = ed }}
          />
        )}
      </div>

      <div className="shrink-0 px-6 py-2 border-t border-gray-100 flex items-center gap-2 no-print">
        <div className={`text-xs ${saveStatusClass}`}>{saveStatus}</div>
      </div>

      {showAIPanel && (
        <AIPanel
          noteContent={currentNoteContent.current}
          onClose={() => setShowAIPanel(false)}
          onInsert={insertAIText}
          onReplace={replaceAIText}
          onTagsGenerated={onTagsGenerated}
          onToast={showToast}
        />
      )}

      {toastMessage && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-4 py-2 rounded-xl shadow-lg text-sm z-50">
          {toastMessage}
        </div>
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowDeleteConfirm(false)}>
          <div className="bg-white rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Delete Note</h3>
            <p className="text-gray-600 text-sm mb-6">Are you sure you want to delete &ldquo;{title}&rdquo;? This cannot be undone.</p>
            <div className="flex gap-3">
              <button className="btn-danger flex-1" onClick={confirmDelete}>Delete</button>
              <button className="btn-secondary flex-1" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
