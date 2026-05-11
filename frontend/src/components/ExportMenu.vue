<template>
  <div class="relative" ref="containerRef">
    <button class="btn-ghost gap-1 text-sm" @click="open = !open">
      <Download class="w-4 h-4" />
      Export
      <ChevronDown class="w-3 h-3" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        class="fixed z-50 w-52 bg-white rounded-xl border border-gray-200 shadow-lg overflow-hidden"
        :style="dropdownStyle"
      >
        <div class="p-1">
          <button
            v-for="item in exportItems"
            :key="item.label"
            class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors text-left"
            :disabled="item.loading"
            @click="handleExport(item)"
          >
            <component :is="item.icon" class="w-4 h-4 text-gray-500" />
            <span>{{ item.label }}</span>
            <span v-if="item.loading" class="ml-auto">
              <svg class="animate-spin w-3 h-3 text-gray-400" viewBox="0 0 24 24" fill="none">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            </span>
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import { Download, FileText, FileDown, Code, Clipboard, ChevronDown } from 'lucide-vue-next'
import type { Note } from '@/api/notes'
import {
  exportToPDF,
  exportToWord,
  exportToMarkdown,
  exportToHTML,
  copyAsPlainText,
  copyAsRichText,
} from '@/utils/export'

const props = defineProps<{
  note: Note
}>()

const emit = defineEmits<{
  toast: [message: string]
}>()

interface ExportItem {
  label: string
  icon: unknown
  action: () => Promise<void>
  loading: boolean
}

const open = ref(false)
const containerRef = ref<HTMLElement | null>(null)
const dropdownStyle = ref<Record<string, string>>({})

const exportItems = reactive<ExportItem[]>([
  {
    label: 'Export as PDF',
    icon: FileDown,
    action: () => exportToPDF(props.note),
    loading: false,
  },
  {
    label: 'Export as Word',
    icon: FileText,
    action: () => exportToWord(props.note),
    loading: false,
  },
  {
    label: 'Export as Markdown',
    icon: FileText,
    action: () => exportToMarkdown(props.note),
    loading: false,
  },
  {
    label: 'Export as HTML',
    icon: Code,
    action: () => {
      exportToHTML(props.note)
      return Promise.resolve()
    },
    loading: false,
  },
  {
    label: 'Copy plain text',
    icon: Clipboard,
    action: async () => {
      await copyAsPlainText(props.note)
      emit('toast', 'Copied to clipboard')
    },
    loading: false,
  },
  {
    label: 'Copy rich text',
    icon: Clipboard,
    action: async () => {
      await copyAsRichText(props.note)
      emit('toast', 'Copied to clipboard')
    },
    loading: false,
  },
])

async function handleExport(item: ExportItem) {
  item.loading = true
  open.value = false
  try {
    await item.action()
  } catch (e) {
    console.error('Export failed', e)
    emit('toast', 'Export failed')
  } finally {
    item.loading = false
  }
}

function updateDropdownPosition() {
  if (!containerRef.value) return
  const rect = containerRef.value.getBoundingClientRect()
  dropdownStyle.value = {
    top: `${rect.bottom + 4}px`,
    right: `${window.innerWidth - rect.right}px`,
  }
}

function handleClickOutside(e: MouseEvent) {
  if (containerRef.value && !containerRef.value.contains(e.target as Node)) {
    open.value = false
  }
}

watch(open, (val) => {
  if (val) {
    updateDropdownPosition()
    document.addEventListener('mousedown', handleClickOutside)
  } else {
    document.removeEventListener('mousedown', handleClickOutside)
  }
})
</script>
