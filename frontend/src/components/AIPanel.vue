<template>
  <div
    class="fixed z-50 w-80 bg-white rounded-xl border border-gray-200 shadow-xl overflow-hidden"
    :style="panelStyle"
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-purple-50">
      <div class="flex items-center gap-2">
        <Sparkles class="w-4 h-4 text-blue-600" />
        <span class="text-sm font-semibold text-gray-800">AI Assistant</span>
      </div>
      <button class="text-gray-400 hover:text-gray-600" @click="$emit('close')">
        <X class="w-4 h-4" />
      </button>
    </div>

    <!-- No provider warning -->
    <div v-if="!hasProvider" class="p-4 text-center">
      <p class="text-sm text-gray-500">No AI provider configured.</p>
      <RouterLink to="/settings/ai-providers" class="text-sm text-blue-600 hover:underline mt-1 block">
        Configure AI Provider →
      </RouterLink>
    </div>

    <template v-else>
      <!-- Quick actions -->
      <div class="p-3 grid grid-cols-2 gap-2">
        <button
          v-for="action in quickActions"
          :key="action.label"
          class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs bg-gray-50 hover:bg-blue-50 hover:text-blue-700 transition-colors text-left border border-gray-100"
          :disabled="loading"
          @click="runAction(action)"
        >
          <component :is="action.icon" class="w-3.5 h-3.5 shrink-0" />
          {{ action.label }}
        </button>
      </div>

      <!-- Custom prompt -->
      <div class="px-3 pb-3">
        <div class="flex gap-2">
          <input
            v-model="customPrompt"
            type="text"
            placeholder="Custom prompt..."
            class="input text-xs py-1.5"
            @keydown.enter="runCustomPrompt"
          />
          <button
            class="btn-primary px-3 py-1.5 text-xs shrink-0"
            :disabled="loading || !customPrompt.trim()"
            @click="runCustomPrompt"
          >
            <Send class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <!-- Loading indicator -->
      <div v-if="loading" class="px-4 pb-3 flex items-center gap-2 text-sm text-gray-500">
        <svg class="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        Thinking...
      </div>

      <!-- Result -->
      <div v-if="result && !loading" class="border-t border-gray-100">
        <div class="px-4 py-3">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-wide">Result</span>
            <button
              class="text-xs text-blue-600 hover:underline"
              @click="copyResult"
            >
              Copy
            </button>
          </div>
          <p class="text-sm text-gray-800 whitespace-pre-wrap max-h-40 overflow-y-auto">{{ result }}</p>
        </div>
        <div class="px-4 pb-3 flex gap-2">
          <button class="btn-primary text-xs py-1.5 flex-1" @click="$emit('insert', result)">
            Insert at cursor
          </button>
          <button class="btn-secondary text-xs py-1.5 flex-1" @click="$emit('replace', result)">
            Replace selection
          </button>
        </div>
      </div>

      <!-- Error -->
      <div v-if="error" class="px-4 pb-3">
        <p class="text-xs text-red-600 bg-red-50 rounded-lg p-2">{{ error }}</p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { RouterLink } from 'vue-router'
import { Sparkles, X, Send, FileText, Wand2, PenLine, Tag } from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'

const props = defineProps<{
  noteContent: string
  selectedText?: string
  position?: { top: number; left: number }
}>()

const emit = defineEmits<{
  close: []
  insert: [text: string]
  replace: [text: string]
  tagsGenerated: [tags: string[]]
  toast: [message: string]
}>()

const settingsStore = useSettingsStore()
const hasProvider = computed(() => !!settingsStore.aiService)

const loading = ref(false)
const result = ref('')
const error = ref('')
const customPrompt = ref('')

const panelStyle = computed(() => {
  if (props.position) {
    return {
      top: `${props.position.top}px`,
      left: `${props.position.left}px`,
    }
  }
  return {
    bottom: '80px',
    right: '24px',
  }
})

interface QuickAction {
  label: string
  icon: unknown
  fn: () => Promise<string>
}

const quickActions: QuickAction[] = [
  {
    label: 'Summarise',
    icon: FileText,
    fn: () => settingsStore.aiService!.summarise(props.selectedText || props.noteContent),
  },
  {
    label: 'Improve Writing',
    icon: Wand2,
    fn: () => settingsStore.aiService!.improveWriting(props.selectedText || props.noteContent),
  },
  {
    label: 'Continue Writing',
    icon: PenLine,
    fn: () => settingsStore.aiService!.continueWriting(props.noteContent),
  },
  {
    label: 'Generate Tags',
    icon: Tag,
    fn: async () => {
      const tags = await settingsStore.aiService!.generateTags(props.noteContent)
      emit('tagsGenerated', tags)
      return `Suggested tags: ${tags.join(', ')}`
    },
  },
]

async function runAction(action: QuickAction) {
  if (!settingsStore.aiService) return
  loading.value = true
  error.value = ''
  result.value = ''
  try {
    result.value = await action.fn()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'An error occurred'
  } finally {
    loading.value = false
  }
}

async function runCustomPrompt() {
  if (!customPrompt.value.trim() || !settingsStore.aiService) return
  loading.value = true
  error.value = ''
  result.value = ''
  try {
    result.value = await settingsStore.aiService.complete(
      `${customPrompt.value}\n\nNote content:\n${props.noteContent}`
    )
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'An error occurred'
  } finally {
    loading.value = false
  }
}

async function copyResult() {
  await navigator.clipboard.writeText(result.value)
  emit('toast', 'Copied to clipboard')
}
</script>
