<template>
  <div class="flex flex-col h-screen bg-gray-50">
    <!-- Top bar -->
    <header class="bg-white border-b border-gray-200 px-4 py-3 shrink-0 no-print">
      <div class="max-w-3xl mx-auto">
        <div class="flex items-center gap-3 mb-3">
          <h1 class="text-xl font-bold text-gray-900 flex items-center gap-2">
            <span class="text-2xl">🦎</span>
            Gecko Notes
          </h1>
          <div class="flex-1" />
          <RouterLink to="/settings" class="btn-ghost p-2">
            <Settings class="w-5 h-5" />
          </RouterLink>
        </div>

        <!-- Search -->
        <div class="relative mb-3">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search notes..."
            class="input pl-9"
          />
        </div>

        <!-- Category filter chips -->
        <div class="flex items-center gap-2 overflow-x-auto pb-1">
          <button
            class="text-xs px-3 py-1.5 rounded-full border shrink-0 transition-colors"
            :class="
              activeCategoryId === null
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            "
            @click="activeCategoryId = null"
          >
            All
          </button>
          <button
            v-for="cat in categories"
            :key="cat.id"
            class="text-xs px-3 py-1.5 rounded-full border shrink-0 transition-colors"
            :class="
              activeCategoryId === cat.id
                ? 'text-white border-transparent'
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            "
            :style="activeCategoryId === cat.id ? { backgroundColor: cat.color, borderColor: cat.color } : {}"
            @click="activeCategoryId = activeCategoryId === cat.id ? null : cat.id"
          >
            {{ cat.emoji }} {{ cat.label }}
          </button>

          <!-- Sort toggle -->
          <div class="flex-1" />
          <button
            class="text-xs px-3 py-1.5 rounded-full border border-gray-200 bg-white text-gray-600 hover:border-gray-400 shrink-0 flex items-center gap-1 transition-colors"
            @click="toggleSort"
          >
            <ArrowUpDown class="w-3 h-3" />
            {{ sortOrder === 'modified_at' ? 'Modified' : 'Created' }}
          </button>
        </div>
      </div>
    </header>

    <!-- Note list -->
    <main class="flex-1 overflow-y-auto px-4 py-4">
      <div class="max-w-3xl mx-auto space-y-3">
        <!-- Loading skeleton -->
        <template v-if="loading && notes.length === 0">
          <div
            v-for="i in 6"
            :key="i"
            class="card p-4 animate-pulse"
          >
            <div class="h-4 bg-gray-200 rounded w-1/3 mb-2" />
            <div class="h-5 bg-gray-200 rounded w-3/4 mb-2" />
            <div class="h-3 bg-gray-100 rounded w-full mb-1" />
            <div class="h-3 bg-gray-100 rounded w-2/3" />
          </div>
        </template>

        <!-- Empty state -->
        <div
          v-else-if="notes.length === 0"
          class="text-center py-20"
        >
          <p class="text-5xl mb-4">📝</p>
          <p class="text-gray-500 text-lg font-medium mb-1">No notes yet</p>
          <p class="text-gray-400 text-sm mb-6">Create your first note to get started</p>
          <RouterLink to="/notes/new" class="btn-primary inline-flex">
            <Plus class="w-4 h-4" />
            New Note
          </RouterLink>
        </div>

        <!-- Notes -->
        <NoteCard
          v-for="note in notes"
          :key="note.id"
          :note="note"
          :category="categoriesStore.getCategoryById(note.category_id)"
          @click="goToNote"
        />

        <!-- Load more sentinel -->
        <div ref="sentinel" class="h-2" />

        <!-- Loading more indicator -->
        <div v-if="loading && notes.length > 0" class="text-center py-4">
          <svg class="animate-spin w-5 h-5 text-gray-400 mx-auto" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        </div>
      </div>
    </main>

    <!-- FAB -->
    <RouterLink
      to="/notes/new"
      class="fixed bottom-6 right-6 w-14 h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-lg flex items-center justify-center transition-colors no-print"
      aria-label="New note"
    >
      <Plus class="w-7 h-7" />
    </RouterLink>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { RouterLink } from 'vue-router'
import { Search, Settings, Plus, ArrowUpDown } from 'lucide-vue-next'
import NoteCard from '@/components/NoteCard.vue'
import { useNotesStore } from '@/stores/notes'
import { useCategoriesStore } from '@/stores/categories'
import { useSettingsStore } from '@/stores/settings'

const router = useRouter()
const notesStore = useNotesStore()
const categoriesStore = useCategoriesStore()
const settingsStore = useSettingsStore()

const notes = computed(() => notesStore.notes)
const loading = computed(() => notesStore.loading)
const hasMore = computed(() => notesStore.hasMore)
const categories = computed(() => categoriesStore.categories)

const searchQuery = ref('')
const activeCategoryId = ref<string | null>(null)
const sortOrder = ref<'modified_at' | 'created_at'>(
  (settingsStore.defaultSortOrder as 'modified_at' | 'created_at') || 'modified_at'
)
const sentinel = ref<HTMLElement | null>(null)

let searchDebounce: ReturnType<typeof setTimeout> | null = null
let observer: IntersectionObserver | null = null

function buildParams() {
  return {
    sort: sortOrder.value,
    order: 'desc' as const,
    category_id: activeCategoryId.value ?? undefined,
    search: searchQuery.value || undefined,
  }
}

async function reload() {
  await notesStore.loadNotes(buildParams(), true)
}

function goToNote(id: string) {
  router.push(`/notes/${id}`)
}

function toggleSort() {
  sortOrder.value = sortOrder.value === 'modified_at' ? 'created_at' : 'modified_at'
  reload()
}

// Debounced search
watch(searchQuery, () => {
  if (searchDebounce) clearTimeout(searchDebounce)
  searchDebounce = setTimeout(() => reload(), 300)
})

watch(activeCategoryId, () => reload())

// Infinite scroll
onMounted(async () => {
  await reload()

  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && hasMore.value && !loading.value) {
        notesStore.loadMore(buildParams())
      }
    },
    { threshold: 0.1 }
  )

  if (sentinel.value) {
    observer.observe(sentinel.value)
  }
})

onUnmounted(() => {
  observer?.disconnect()
  if (searchDebounce) clearTimeout(searchDebounce)
})
</script>
