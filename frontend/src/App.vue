<template>
  <div id="app-root" class="h-screen flex flex-col overflow-hidden">
    <RouterView />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { useCategoriesStore } from '@/stores/categories'

const settingsStore = useSettingsStore()
const categoriesStore = useCategoriesStore()

onMounted(async () => {
  await Promise.all([
    settingsStore.loadSettings(),
    categoriesStore.loadCategories(),
  ])
})
</script>
