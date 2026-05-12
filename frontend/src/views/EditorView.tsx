import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Sparkles, Printer, Trash2 } from 'lucide-react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import '@blocknote/core/fonts/inter.css'
import type { PartialBlock } from '@blocknote/core'

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

const EMPTY_DOCUMENT: PartialBlock[] = [{ type: 'paragraph' }]

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function parseNoteContent(content: string): PartialBlock[] {
  try {
    const blocks = JSON.parse(content) as PartialBlock[]
    return blocks.length > 0 ? blocks : EMPTY_DOCUMENT
  } catch {
    return EMPTY_DOCUMENT
  }
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

  const titleRef = useRef<HTMLTextAreaElement>(null)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const createdNoteId = useRef<string | null>(null)
  const currentNoteContent = useRef('')
  const hasPendingChanges = useRef(false)
  const isSaving = useRef(false)
  const isHydratingEditor = useRef(false)
  const syncedEditorKey = useRef<string | null>(null)
  const defaultCategoryId = categoriesStore.categories[0]?.id ?? ''
  const latestTitle = useRef(title)
  const latestCategoryId = useRef(categoryId)
  const latestTags = useRef(tags)
  const latestDefaultCategoryId = useRef(defaultCategoryId)
  const latestIsNew = useRef(isNew)
  const latestNoteId = useRef(noteId)
  const saveDraftRef = useRef<((force?: boolean) => Promise<Note | null | undefined>) | undefined>(undefined)

  const editor = useCreateBlockNote({
    uploadFile: async (file: File) => {
      const response = await mediaApi.upload(file)
      return response.data.url
    },
  })

  useEffect(() => { latestTitle.current = title }, [title])
  useEffect(() => { latestCategoryId.current = categoryId }, [categoryId])
  useEffect(() => { latestTags.current = tags }, [tags])
  useEffect(() => { latestDefaultCategoryId.current = defaultCategoryId }, [defaultCategoryId])
  useEffect(() => { latestIsNew.current = isNew }, [isNew])
  useEffect(() => { latestNoteId.current = noteId }, [noteId])

  const saveStatusClass = saveStatus === 'Saving...' ? 'text-yellow-600' : saveStatus.includes('Unsaved') ? 'text-orange-600' : 'text-gray-400'

  // Load note data on mount
  useEffect(() => {
    async function init() {
      setLoaded(false)
      setNote(null)
      setTitle('')
      setCategoryId('')
      setTags([])
      createdNoteId.current = null
      currentNoteContent.current = ''
      syncedEditorKey.current = null
      hasPendingChanges.current = false

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
        currentNoteContent.current = extractPlainText(parseNoteContent(data.content) as unknown[])
        setLoaded(true)
      }
    }
    init()
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current) }
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
    currentNoteContent.current = extractPlainText()
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
    currentNoteContent.current = extractPlainText()
    const payload = {
      title: latestTitle.current || 'Untitled',
      content,
      category_id: latestCategoryId.current || latestDefaultCategoryId.current,
      tags: latestTags.current,
    }
    try {
      if (latestIsNew.current && !createdNoteId.current) {
        const created = await notesStore.createNote(payload)
        createdNoteId.current = created.id
        setNote(created)
        navigate(`/notes/${created.id}`, { replace: true })
      } else {
        const resolvedId = createdNoteId.current || latestNoteId.current!
        const updated = await notesStore.updateNote(resolvedId, payload)
        setNote(updated)
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

    const blocks = isNew ? EMPTY_DOCUMENT : parseNoteContent(note?.content ?? '[]')
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

  function extractPlainText(blocks: unknown[] | undefined = editor?.document): string {
    if (!blocks) return ''
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
      for (const block of blocks) { processBlock(block as unknown as Record<string, unknown>); texts.push('\n') }
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

  async function goBack() {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current)
      autosaveTimer.current = null
    }

    const hasDraftContent = Boolean(title.trim() || extractPlainText() || tags.length)
    if ((hasPendingChanges.current || (isNew && !createdNoteId.current && hasDraftContent)) && categoryId) {
      await doSave(true)
    }

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

  async function insertAIText(text: string) {
    if (!editor) return
    const blocks = await editor.tryParseMarkdownToBlocks(text)
    editor.insertBlocks(
      blocks.length > 0 ? blocks : [{ type: 'paragraph', content: text }],
      editor.getTextCursorPosition().block,
      'after',
    )
    setShowAIPanel(false)
  }

  async function replaceAIText(text: string) {
    if (!editor) return
    const blocks = await editor.tryParseMarkdownToBlocks(text)
    if (blocks.length > 1) {
      editor.insertBlocks(blocks, editor.getTextCursorPosition().block, 'after')
    } else {
      editor.updateBlock(editor.getTextCursorPosition().block, { content: blocks[0]?.content ?? text })
    }
    setShowAIPanel(false)
  }

  const theme = useSettingsStore((s) => s.theme)

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-gray-900">
      <header className="shrink-0 border-b border-gray-100 dark:border-gray-700 dark:bg-gray-900 no-print">
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
          <BlockNoteView
            editor={editor}
            onChange={scheduleAutosave}
            theme={theme}
          />
        )}
      </div>

      <div className="shrink-0 px-6 py-2 border-t border-gray-100 dark:border-gray-700 dark:bg-gray-900 flex items-center gap-2 no-print">
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
    </div>
  )
}
