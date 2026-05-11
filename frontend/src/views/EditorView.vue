<template>
  <div class="flex flex-col h-screen bg-white">
    <!-- Header -->
    <header class="shrink-0 border-b border-gray-100 no-print">
      <div class="flex items-center gap-2 px-4 py-2">
        <button class="btn-ghost p-2" @click="goBack">
          <ArrowLeft class="w-5 h-5" />
        </button>
        <div class="flex-1" />

        <!-- Action buttons -->
        <ExportMenu v-if="note" :note="note" @toast="showToast" />
        <ShareMenu v-if="note" :note="note" @toast="showToast" />

        <button class="btn-ghost p-2" title="Print" @click="handlePrint">
          <Printer class="w-4 h-4" />
        </button>

        <button class="btn-ghost p-2" title="AI Assistant" @click="toggleAIPanel">
          <Sparkles class="w-4 h-4" :class="{ 'text-blue-600': showAIPanel }" />
        </button>

        <button
          class="btn-ghost p-2 text-red-400 hover:text-red-600 hover:bg-red-50"
          title="Delete note"
          :disabled="!note"
          @click="handleDelete"
        >
          <Trash2 class="w-4 h-4" />
        </button>
      </div>
    </header>

    <!-- Note meta area -->
    <div class="shrink-0 px-6 pt-4 pb-2 no-print" v-if="loaded">
      <!-- Title input -->
      <textarea
        ref="titleRef"
        v-model="title"
        placeholder="Untitled"
        rows="1"
        class="w-full text-3xl font-bold text-gray-900 resize-none border-0 outline-none focus:ring-0 bg-transparent placeholder-gray-300 leading-tight overflow-hidden print-content"
        @input="autoResizeTitle"
        @keydown.enter.prevent="focusEditor"
      />

      <!-- Meta row -->
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <CategoryPicker v-if="defaultCategoryId" v-model="categoryId" />
        <div v-else class="text-xs text-gray-400">Loading categories...</div>

        <!-- Tags -->
        <div class="flex flex-wrap items-center gap-1">
          <TagChip
            v-for="tag in tags"
            :key="tag"
            :tag="tag"
            removable
            @remove="removeTag"
          />
          <input
            v-model="newTagInput"
            type="text"
            placeholder="Add tag..."
            class="text-xs px-2 py-0.5 border border-dashed border-gray-300 rounded-full focus:outline-none focus:border-blue-400 w-24"
            @keydown.enter.prevent="addTag"
            @keydown.comma.prevent="addTag"
          />
        </div>

        <button
          class="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 transition-colors flex items-center gap-1"
          :disabled="generatingTags"
          @click="handleGenerateTags"
        >
          <Sparkles class="w-3 h-3" />
          {{ generatingTags ? 'Generating...' : 'Generate Tags' }}
        </button>
      </div>

      <!-- Timestamps -->
      <div class="flex gap-4 mt-2 text-xs text-gray-400">
        <span v-if="note">Created {{ formatDate(note.created_at) }}</span>
        <span v-if="note">Modified {{ formatDate(note.modified_at) }}</span>
      </div>

      <!-- Suggested tags -->
      <div v-if="suggestedTags.length > 0" class="flex items-center gap-2 mt-2">
        <span class="text-xs text-gray-400">Suggestions:</span>
        <button
          v-for="st in suggestedTags"
          :key="st"
          class="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-100 hover:bg-blue-100 transition-colors"
          @click="addSuggestedTag(st)"
        >
          + #{{ st }}
        </button>
        <button class="text-xs text-gray-400 hover:text-gray-600" @click="suggestedTags = []">
          Dismiss
        </button>
      </div>
    </div>

    <!-- Editor area -->
    <div class="flex-1 min-h-0 overflow-auto px-4 pb-4 print-content" ref="editorContainerRef">
      <div v-if="!loaded" class="flex items-center justify-center h-full">
        <svg class="animate-spin w-6 h-6 text-gray-400" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      </div>

      <div v-else ref="editorRef" class="min-h-full" />
    </div>

    <!-- Footer save status -->
    <div class="shrink-0 px-6 py-2 border-t border-gray-100 flex items-center gap-2 no-print">
      <div class="text-xs" :class="saveStatusClass">
        {{ saveStatus }}
      </div>
    </div>

    <!-- AI Panel -->
    <AIPanel
      v-if="showAIPanel"
      :note-content="currentNoteContent"
      @close="showAIPanel = false"
      @insert="insertAIText"
      @replace="replaceAIText"
      @tags-generated="onTagsGenerated"
      @toast="showToast"
    />

    <!-- Toast notification -->
    <div
      v-if="toastMessage"
      class="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-4 py-2 rounded-xl shadow-lg text-sm z-50 transition-opacity"
    >
      {{ toastMessage }}
    </div>

    <!-- Slash menu -->
    <Teleport to="body">
      <div
        v-if="slashMenuVisible && slashMenuItems.length > 0"
        class="fixed z-50 w-72 max-h-80 overflow-y-auto bg-white rounded-xl border border-gray-200 shadow-lg p-1"
        :style="{ top: slashMenuPos.top + 'px', left: slashMenuPos.left + 'px' }"
      >
        <template v-for="(item, index) in slashMenuItems" :key="item.key">
          <div
            v-if="index === 0 || item.group !== slashMenuItems[index - 1].group"
            class="px-3 pt-2 pb-0.5 text-xs font-semibold text-gray-400 uppercase tracking-wide"
          >
            {{ item.group }}
          </div>
          <button
            class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-left"
            :class="index === slashMenuSelectedIndex ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50 text-gray-900'"
            @mousedown.prevent="selectSlashMenuItem(item)"
          >
            <div class="flex-1 min-w-0">
              <div class="font-medium leading-tight">{{ item.title }}</div>
              <div class="text-xs text-gray-400 truncate leading-tight">{{ item.subtext }}</div>
            </div>
            <span v-if="item.badge" class="text-xs text-gray-400 font-mono shrink-0">{{ item.badge }}</span>
          </button>
        </template>
      </div>
    </Teleport>

    <!-- Delete confirmation modal -->
    <div
      v-if="showDeleteConfirm"
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      @click.self="showDeleteConfirm = false"
    >
      <div class="bg-white rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl">
        <h3 class="text-lg font-semibold text-gray-900 mb-2">Delete Note</h3>
        <p class="text-gray-600 text-sm mb-6">Are you sure you want to delete "{{ title }}"? This cannot be undone.</p>
        <div class="flex gap-3">
          <button class="btn-danger flex-1" @click="confirmDelete">Delete</button>
          <button class="btn-secondary flex-1" @click="showDeleteConfirm = false">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ArrowLeft, Sparkles, Printer, Trash2 } from 'lucide-vue-next'
import {
  BlockNoteEditor,
  getDefaultSlashMenuItems,
  type PartialBlock,
} from '@blocknote/core'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/core/style.css'

import CategoryPicker from '@/components/CategoryPicker.vue'
import TagChip from '@/components/TagChip.vue'
import ExportMenu from '@/components/ExportMenu.vue'
import ShareMenu from '@/components/ShareMenu.vue'
import AIPanel from '@/components/AIPanel.vue'

import { useNotesStore } from '@/stores/notes'
import { useCategoriesStore } from '@/stores/categories'
import { useSettingsStore } from '@/stores/settings'
import { mediaApi } from '@/api/media'
import type { Note } from '@/api/notes'

const router = useRouter()
const route = useRoute()
const notesStore = useNotesStore()
const categoriesStore = useCategoriesStore()
const settingsStore = useSettingsStore()

const isNew = computed(() => route.name === 'note-new')
const noteId = computed(() => route.params.id as string | undefined)

const note = ref<Note | null>(null)
const title = ref('')
const categoryId = ref('')
const tags = ref<string[]>([])
const newTagInput = ref('')
const loaded = ref(false)
const saveStatus = ref('All changes saved')
const saveStatusClass = computed(() => {
  if (saveStatus.value === 'Saving...') return 'text-yellow-600'
  if (saveStatus.value.includes('Unsaved')) return 'text-orange-600'
  return 'text-gray-400'
})

const showAIPanel = ref(false)
const showDeleteConfirm = ref(false)
const toastMessage = ref('')
const suggestedTags = ref<string[]>([])
const generatingTags = ref(false)

const titleRef = ref<HTMLTextAreaElement | null>(null)
const editorRef = ref<HTMLElement | null>(null)
const editorContainerRef = ref<HTMLElement | null>(null)

let editor: BlockNoteEditor | null = null
let autosaveTimer: ReturnType<typeof setTimeout> | null = null
let createdNoteId: string | null = null

// ─── Slash menu ───────────────────────────────────────────────────────────────

type SlashMenuItem = ReturnType<typeof getDefaultSlashMenuItems>[number]
const slashMenuVisible = ref(false)
const slashMenuPos = ref({ top: 0, left: 0 })
const slashMenuItems = ref<SlashMenuItem[]>([])
const slashMenuSelectedIndex = ref(0)

const defaultCategoryId = computed(() => categoriesStore.categories[0]?.id ?? '')
const currentNoteContent = ref('')

// ─── Init ─────────────────────────────────────────────────────────────────────

onMounted(async () => {
  await categoriesStore.loadCategories()

  if (isNew.value) {
    categoryId.value = defaultCategoryId.value
    title.value = ''
    tags.value = []
    loaded.value = true
    await nextTick()
    initEditor([])
    titleRef.value?.focus()
  } else if (noteId.value) {
    const data = await notesStore.loadNote(noteId.value)
    note.value = data
    title.value = data.title
    categoryId.value = data.category_id
    tags.value = [...data.tags]
    loaded.value = true
    await nextTick()
    let blocks: PartialBlock[] = []
    try {
      blocks = JSON.parse(data.content)
    } catch {
      blocks = []
    }
    initEditor(blocks)
  }
})

onUnmounted(() => {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  document.removeEventListener('keydown', handleSlashMenuKeydown, true)
  editor?.mount(null)
})

function initEditor(initialContent: PartialBlock[]) {
  if (!editorRef.value) return

  editor = BlockNoteEditor.create({
    initialContent: initialContent.length > 0 ? initialContent : undefined,
    uploadFile: async (file: File) => {
      const response = await mediaApi.upload(file)
      return response.data.url
    },
  })

  editor.onEditorContentChange(() => {
    currentNoteContent.value = extractPlainTextFromEditor()
    scheduleAutosave()
  })

  editor.mount(editorRef.value)
  editorRef.value.style.minHeight = '400px'
  setupSlashMenu()
}

function setupSlashMenu() {
  if (!editor) return
  const allItems = getDefaultSlashMenuItems(editor)

  editor.suggestionMenus.onUpdate('/', (state) => {
    if (state.show) {
      const q = (state.query ?? '').toLowerCase()
      slashMenuItems.value = q
        ? allItems.filter(
            (item) =>
              item.title.toLowerCase().includes(q) ||
              (item.subtext ?? '').toLowerCase().includes(q) ||
              (item.aliases ?? []).some((a: string) => a.toLowerCase().includes(q)),
          )
        : allItems
      slashMenuSelectedIndex.value = 0
      slashMenuVisible.value = slashMenuItems.value.length > 0
      const rect = state.referencePos as DOMRect
      slashMenuPos.value = { top: rect.bottom + 4, left: rect.left }
    } else {
      slashMenuVisible.value = false
    }
  })
}

function selectSlashMenuItem(item: SlashMenuItem) {
  editor?.suggestionMenus.clearQuery()
  item.onItemClick()
  slashMenuVisible.value = false
}

function handleSlashMenuKeydown(e: KeyboardEvent) {
  if (!slashMenuVisible.value) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    e.stopPropagation()
    slashMenuSelectedIndex.value = Math.min(
      slashMenuSelectedIndex.value + 1,
      slashMenuItems.value.length - 1,
    )
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    e.stopPropagation()
    slashMenuSelectedIndex.value = Math.max(slashMenuSelectedIndex.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    const item = slashMenuItems.value[slashMenuSelectedIndex.value]
    if (item) selectSlashMenuItem(item)
  } else if (e.key === 'Escape') {
    e.stopPropagation()
    slashMenuVisible.value = false
    editor?.suggestionMenus.closeMenu()
  }
}

watch(slashMenuVisible, (visible) => {
  if (visible) {
    document.addEventListener('keydown', handleSlashMenuKeydown, true)
  } else {
    document.removeEventListener('keydown', handleSlashMenuKeydown, true)
  }
})

// ─── Autosave ─────────────────────────────────────────────────────────────────

function scheduleAutosave() {
  saveStatus.value = 'Unsaved changes'
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => doSave(), 800)
}

async function doSave() {
  if (!editor) return
  saveStatus.value = 'Saving...'

  const content = JSON.stringify(editor.document)
  const payload = {
    title: title.value || 'Untitled',
    content,
    category_id: categoryId.value || defaultCategoryId.value,
    tags: tags.value,
  }

  try {
    if (isNew.value && !createdNoteId) {
      const created = await notesStore.createNote(payload)
      createdNoteId = created.id
      note.value = created
      // Replace route without adding to history
      router.replace(`/notes/${created.id}`)
    } else {
      const id = createdNoteId || noteId.value!
      const updated = await notesStore.updateNote(id, payload)
      note.value = updated
    }
    saveStatus.value = 'All changes saved'
  } catch {
    saveStatus.value = 'Error saving'
  }
}

// ─── Title autosave ───────────────────────────────────────────────────────────

watch(title, () => scheduleAutosave())
watch(categoryId, () => scheduleAutosave())
watch(tags, () => scheduleAutosave(), { deep: true })

// ─── Tags ─────────────────────────────────────────────────────────────────────

function addTag() {
  const raw = newTagInput.value.trim().replace(/^#/, '').toLowerCase()
  if (raw && !tags.value.includes(raw)) {
    tags.value.push(raw)
  }
  newTagInput.value = ''
}

function removeTag(tag: string) {
  tags.value = tags.value.filter((t) => t !== tag)
}

function addSuggestedTag(tag: string) {
  if (!tags.value.includes(tag)) {
    tags.value.push(tag)
  }
  suggestedTags.value = suggestedTags.value.filter((t) => t !== tag)
}

async function handleGenerateTags() {
  if (!settingsStore.aiService) {
    showToast('No AI provider configured')
    return
  }
  generatingTags.value = true
  try {
    const content = extractPlainTextFromEditor()
    const generated = await settingsStore.aiService.generateTags(`${title.value}\n\n${content}`)
    onTagsGenerated(generated)
  } catch (e) {
    showToast('Failed to generate tags')
  } finally {
    generatingTags.value = false
  }
}

function onTagsGenerated(generated: string[]) {
  suggestedTags.value = generated.filter((t) => !tags.value.includes(t))
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function autoResizeTitle() {
  const el = titleRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function focusEditor() {
  editorRef.value?.querySelector<HTMLElement>('[contenteditable]')?.focus()
}

function goBack() {
  if (window.history.length > 1) {
    router.back()
  } else {
    router.push('/notes')
  }
}

function toggleAIPanel() {
  showAIPanel.value = !showAIPanel.value
}

function handleDelete() {
  showDeleteConfirm.value = true
}

async function confirmDelete() {
  const id = createdNoteId || noteId.value
  if (!id) {
    router.push('/notes')
    return
  }
  await notesStore.deleteNote(id)
  router.push('/notes')
}

function handlePrint() {
  const style = document.createElement('style')
  style.setAttribute('media', 'print')
  style.textContent = `
    .no-print { display: none !important; }
    body { background: white; color: black; }
    .print-content { display: block !important; }
  `
  document.head.appendChild(style)
  window.print()
  setTimeout(() => document.head.removeChild(style), 1000)
}

function showToast(msg: string) {
  toastMessage.value = msg
  setTimeout(() => (toastMessage.value = ''), 3000)
}

function insertAIText(text: string) {
  if (!editor) return
  // Insert at cursor position by adding a paragraph block
  editor.insertBlocks(
    [{ type: 'paragraph', content: text }],
    editor.getTextCursorPosition().block,
    'after'
  )
  showAIPanel.value = false
}

function replaceAIText(text: string) {
  if (!editor) return
  const block = editor.getTextCursorPosition().block
  editor.updateBlock(block, { content: text })
  showAIPanel.value = false
}

function extractPlainTextFromEditor(): string {
  if (!editor) return ''
  try {
    const blocks = editor.document
    const texts: string[] = []
    function processBlock(block: Record<string, unknown>) {
      const content = block.content
      if (Array.isArray(content)) {
        for (const item of content) {
          if (typeof item === 'object' && item !== null) {
            const typedItem = item as Record<string, unknown>
            if (typedItem.type === 'text') {
              texts.push(String(typedItem.text ?? ''))
            }
          }
        }
      }
      const children = block.children
      if (Array.isArray(children)) {
        for (const child of children) {
          processBlock(child as Record<string, unknown>)
        }
      }
    }
    for (const block of blocks) {
      processBlock(block as unknown as Record<string, unknown>)
      texts.push('\n')
    }
    return texts.join('').trim()
  } catch {
    return ''
  }
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
</script>
