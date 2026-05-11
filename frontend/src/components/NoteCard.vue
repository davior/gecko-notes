<template>
  <div
    class="card cursor-pointer hover:shadow-md transition-shadow duration-150 flex overflow-hidden"
    @click="$emit('click', note.id)"
  >
    <!-- Color accent bar -->
    <div
      class="w-1 shrink-0 rounded-l-xl"
      :style="{ backgroundColor: category?.color ?? '#6B7280' }"
    />

    <div class="flex-1 p-4 min-w-0">
      <!-- Category badge + date -->
      <div class="flex items-center justify-between mb-2 gap-2">
        <CategoryBadge v-if="category" :category="category" />
        <span v-else class="text-xs text-gray-400">Uncategorised</span>
        <span class="text-xs text-gray-400 shrink-0">{{ relativeDate }}</span>
      </div>

      <!-- Title -->
      <h3 class="font-semibold text-gray-900 text-sm leading-tight mb-1 truncate">
        {{ note.title || 'Untitled' }}
      </h3>

      <!-- Preview -->
      <p class="text-xs text-gray-500 line-clamp-2 mb-2">
        {{ note.content_preview || 'No content' }}
      </p>

      <!-- Tags -->
      <div v-if="note.tags.length > 0" class="flex flex-wrap gap-1">
        <TagChip v-for="tag in visibleTags" :key="tag" :tag="tag" />
        <span v-if="note.tags.length > 4" class="text-xs text-gray-400 px-1">
          +{{ note.tags.length - 4 }} more
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { NoteListItem } from '@/api/notes'
import type { Category } from '@/api/categories'
import CategoryBadge from './CategoryBadge.vue'
import TagChip from './TagChip.vue'

const props = defineProps<{
  note: NoteListItem
  category?: Category
}>()

defineEmits<{
  click: [id: string]
}>()

const visibleTags = computed(() => props.note.tags.slice(0, 4))

const relativeDate = computed(() => {
  const date = new Date(props.note.modified_at)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSecs < 60) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  return date.toLocaleDateString()
})
</script>
