import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { settingsApi, type AIProvider } from '@/api/settings'
import { createAIService, type AIService } from '@/services/ai'

export const useSettingsStore = defineStore('settings', () => {
  const appSettings = ref<Record<string, unknown>>({})
  const aiProviders = ref<AIProvider[]>([])
  const aiService = ref<AIService | null>(null)
  const loading = ref(false)

  const activeProvider = computed(() => aiProviders.value.find((p) => p.is_active && p.enabled) ?? null)
  const defaultSortOrder = computed(() => (appSettings.value['default_sort_order'] as string) ?? 'modified_at')

  async function loadSettings() {
    loading.value = true
    try {
      const [settings, providers] = await Promise.all([
        settingsApi.getAll(),
        settingsApi.listAIProviders(),
      ])
      appSettings.value = settings
      aiProviders.value = providers.data
      refreshAIService()
    } finally {
      loading.value = false
    }
  }

  function refreshAIService() {
    if (activeProvider.value) {
      aiService.value = createAIService(activeProvider.value)
    } else {
      aiService.value = null
    }
  }

  async function updateAppSettings(settings: Record<string, unknown>) {
    const updated = await settingsApi.update(settings)
    appSettings.value = updated
  }

  async function loadAIProviders() {
    const response = await settingsApi.listAIProviders()
    aiProviders.value = response.data
    refreshAIService()
  }

  async function createAIProvider(payload: Parameters<typeof settingsApi.createAIProvider>[0]) {
    const response = await settingsApi.createAIProvider(payload)
    aiProviders.value.push(response.data)
    refreshAIService()
    return response.data
  }

  async function updateAIProvider(id: string, payload: Parameters<typeof settingsApi.updateAIProvider>[1]) {
    const response = await settingsApi.updateAIProvider(id, payload)
    const idx = aiProviders.value.findIndex((p) => p.id === id)
    if (idx !== -1) {
      aiProviders.value[idx] = response.data
    }
    refreshAIService()
    return response.data
  }

  async function deleteAIProvider(id: string) {
    await settingsApi.deleteAIProvider(id)
    aiProviders.value = aiProviders.value.filter((p) => p.id !== id)
    refreshAIService()
  }

  async function activateAIProvider(id: string) {
    const response = await settingsApi.activateAIProvider(id)
    // Deactivate all others locally
    for (const p of aiProviders.value) {
      p.is_active = p.id === id
    }
    refreshAIService()
    return response.data
  }

  return {
    appSettings,
    aiProviders,
    aiService,
    activeProvider,
    defaultSortOrder,
    loading,
    loadSettings,
    updateAppSettings,
    loadAIProviders,
    createAIProvider,
    updateAIProvider,
    deleteAIProvider,
    activateAIProvider,
    refreshAIService,
  }
})
