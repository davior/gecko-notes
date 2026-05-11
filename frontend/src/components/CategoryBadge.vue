<template>
  <span
    class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white"
    :style="{ backgroundColor: category.color }"
  >
    <span>{{ category.emoji }}</span>
    <span>{{ category.label }}</span>
  </span>
</template>

<script setup lang="ts">
import type { Category } from '@/api/categories'

defineProps<{
  category: Category
}>()
</script>
