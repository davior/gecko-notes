<template>
  <div class="flex flex-col h-screen bg-gray-50">
    <!-- Header -->
    <header class="bg-white border-b border-gray-200 px-4 py-3 shrink-0 flex items-center gap-3">
      <button class="btn-ghost p-2" @click="$router.push('/notes')">
        <ArrowLeft class="w-5 h-5" />
      </button>
      <h1 class="text-lg font-semibold text-gray-900">Settings</h1>
    </header>

    <div class="flex flex-1 overflow-hidden">
      <!-- Sidebar tabs -->
      <aside class="w-48 shrink-0 bg-white border-r border-gray-200 py-4">
        <nav class="px-2 space-y-1">
          <RouterLink
            v-for="tab in tabs"
            :key="tab.to"
            :to="tab.to"
            class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors"
            :class="
              isActiveTab(tab.to)
                ? 'bg-blue-50 text-blue-700 font-medium'
                : 'text-gray-600 hover:bg-gray-50'
            "
          >
            <component :is="tab.icon" class="w-4 h-4" />
            {{ tab.label }}
          </RouterLink>
        </nav>
      </aside>

      <!-- Content -->
      <main class="flex-1 overflow-y-auto p-6">
        <div class="max-w-2xl mx-auto">
          <!-- Categories tab -->
          <CategoryManager v-if="activeTab === 'categories'" />

          <!-- AI Providers tab -->
          <AIProviderManager v-else-if="activeTab === 'ai-providers'" />

          <!-- General settings -->
          <div v-else-if="activeTab === 'general'">
            <h2 class="text-lg font-semibold text-gray-900 mb-6">General Settings</h2>

            <div class="card p-5 space-y-4">
              <div>
                <label class="label">Default Sort Order</label>
                <select
                  :value="settingsStore.defaultSortOrder"
                  class="input"
                  @change="updateSortOrder(($event.target as HTMLSelectElement).value)"
                >
                  <option value="modified_at">Last Modified</option>
                  <option value="created_at">Created Date</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { ArrowLeft, Tag, Cpu, SlidersHorizontal } from 'lucide-vue-next'
import CategoryManager from '@/components/settings/CategoryManager.vue'
import AIProviderManager from '@/components/settings/AIProviderManager.vue'
import { useSettingsStore } from '@/stores/settings'

const route = useRoute()
const settingsStore = useSettingsStore()

const tabs = [
  { to: '/settings/categories', label: 'Categories', icon: Tag },
  { to: '/settings/ai-providers', label: 'AI Providers', icon: Cpu },
  { to: '/settings/general', label: 'General', icon: SlidersHorizontal },
]

const activeTab = computed(() => {
  const path = route.path
  if (path.includes('ai-providers')) return 'ai-providers'
  if (path.includes('general')) return 'general'
  return 'categories'
})

function isActiveTab(to: string): boolean {
  return route.path === to || route.path.startsWith(to)
}

async function updateSortOrder(value: string) {
  await settingsStore.updateAppSettings({ default_sort_order: value })
}
</script>
