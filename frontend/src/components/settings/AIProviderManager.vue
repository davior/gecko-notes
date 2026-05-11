<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-lg font-semibold text-gray-900">AI Providers</h2>
      <button class="btn-primary text-sm" @click="startAddNew">
        <Plus class="w-4 h-4" />
        Add Provider
      </button>
    </div>

    <!-- Add / Edit form -->
    <div v-if="showForm" class="card p-5 mb-4 border-blue-200 bg-blue-50">
      <h3 class="text-sm font-semibold text-gray-700 mb-4">
        {{ editingId ? 'Edit Provider' : 'New Provider' }}
      </h3>

      <div class="space-y-3">
        <div>
          <label class="label">Display Name</label>
          <input v-model="form.name" type="text" class="input" placeholder="My Anthropic" />
        </div>

        <div>
          <label class="label">Provider Type</label>
          <select v-model="form.provider_type" class="input">
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="ollama">Ollama</option>
            <option value="custom">Custom (OpenAI-compatible)</option>
          </select>
        </div>

        <div v-if="form.provider_type !== 'ollama'">
          <label class="label">API Key</label>
          <div class="relative">
            <input
              v-model="form.api_key"
              :type="showKey ? 'text' : 'password'"
              class="input pr-10"
              placeholder="sk-..."
            />
            <button
              class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              @click="showKey = !showKey"
            >
              <Eye v-if="!showKey" class="w-4 h-4" />
              <EyeOff v-else class="w-4 h-4" />
            </button>
          </div>
          <p class="text-xs text-gray-400 mt-1">Stored locally on this device only.</p>
        </div>

        <div v-if="['ollama', 'custom'].includes(form.provider_type)">
          <label class="label">Base URL</label>
          <input
            v-model="form.base_url"
            type="text"
            class="input"
            :placeholder="form.provider_type === 'ollama' ? 'http://localhost:11434' : 'https://api.example.com'"
          />
        </div>

        <div>
          <label class="label">Model</label>
          <input
            v-model="form.model"
            type="text"
            class="input"
            :placeholder="modelPlaceholder"
          />
        </div>

        <div class="flex items-center gap-2">
          <input v-model="form.enabled" id="enabled-check" type="checkbox" class="rounded" />
          <label for="enabled-check" class="text-sm text-gray-700">Enabled</label>
        </div>
      </div>

      <div class="flex gap-2 mt-4">
        <button class="btn-primary text-sm flex-1" :disabled="saving" @click="saveForm">
          {{ saving ? 'Saving...' : 'Save' }}
        </button>
        <button
          class="btn-secondary text-sm"
          :disabled="testing"
          @click="testConnection"
        >
          {{ testing ? 'Testing...' : 'Test' }}
        </button>
        <button class="btn-secondary text-sm" @click="cancelForm">Cancel</button>
      </div>

      <div v-if="testResult" class="mt-3 text-sm" :class="testResult.success ? 'text-green-700' : 'text-red-600'">
        {{ testResult.success ? '✓' : '✗' }} {{ testResult.message }}
      </div>
    </div>

    <!-- Provider cards -->
    <div class="space-y-3">
      <div
        v-for="provider in providers"
        :key="provider.id"
        class="card p-4"
        :class="{ 'ring-2 ring-blue-500 ring-offset-1': provider.is_active }"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="font-medium text-sm text-gray-900">{{ provider.name }}</span>
              <span
                class="text-xs px-2 py-0.5 rounded-full font-medium"
                :class="providerTypeBadge(provider.provider_type)"
              >
                {{ provider.provider_type }}
              </span>
              <span v-if="provider.is_active" class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
                ✓ Active
              </span>
              <span v-if="!provider.enabled" class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                Disabled
              </span>
            </div>
            <p class="text-xs text-gray-400">{{ provider.model }}</p>
          </div>

          <div class="flex items-center gap-1 shrink-0">
            <button
              v-if="!provider.is_active"
              class="text-xs text-blue-600 hover:underline px-2"
              @click="activate(provider.id)"
            >
              Set Active
            </button>
            <button class="btn-ghost p-1.5" @click="startEdit(provider)">
              <Pencil class="w-4 h-4" />
            </button>
            <button
              class="btn-ghost p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50"
              @click="deleteProvider(provider.id)"
            >
              <Trash2 class="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div v-if="providers.length === 0 && !showForm" class="text-center text-gray-400 py-8 text-sm">
        No AI providers configured. Add one to enable AI features.
      </div>
    </div>

    <!-- Toast -->
    <div
      v-if="toastMsg"
      class="fixed bottom-4 right-4 px-4 py-3 rounded-xl shadow-lg text-sm z-50 text-white"
      :class="toastError ? 'bg-red-600' : 'bg-green-600'"
    >
      {{ toastMsg }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import { Plus, Pencil, Trash2, Eye, EyeOff } from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import type { AIProvider } from '@/api/settings'
import { settingsApi } from '@/api/settings'

const settingsStore = useSettingsStore()
const providers = computed(() => settingsStore.aiProviders)

const showForm = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const testing = ref(false)
const showKey = ref(false)
const toastMsg = ref('')
const toastError = ref(false)
const testResult = ref<{ success: boolean; message: string } | null>(null)

interface ProviderForm {
  name: string
  provider_type: 'anthropic' | 'openai' | 'ollama' | 'custom'
  api_key: string
  base_url: string
  model: string
  enabled: boolean
}

const form = reactive<ProviderForm>({
  name: '',
  provider_type: 'anthropic',
  api_key: '',
  base_url: '',
  model: '',
  enabled: true,
})

const modelPlaceholder = computed(() => {
  const defaults: Record<string, string> = {
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-4o',
    ollama: 'llama3.2',
    custom: 'model-name',
  }
  return defaults[form.provider_type] ?? 'model-name'
})

function providerTypeBadge(type: string): string {
  const map: Record<string, string> = {
    anthropic: 'bg-purple-100 text-purple-700',
    openai: 'bg-green-100 text-green-700',
    ollama: 'bg-orange-100 text-orange-700',
    custom: 'bg-gray-100 text-gray-700',
  }
  return map[type] ?? 'bg-gray-100 text-gray-700'
}

function startAddNew() {
  editingId.value = null
  form.name = ''
  form.provider_type = 'anthropic'
  form.api_key = ''
  form.base_url = ''
  form.model = ''
  form.enabled = true
  testResult.value = null
  showForm.value = true
}

function startEdit(provider: AIProvider) {
  editingId.value = provider.id
  form.name = provider.name
  form.provider_type = provider.provider_type
  form.api_key = provider.api_key
  form.base_url = provider.base_url ?? ''
  form.model = provider.model
  form.enabled = provider.enabled
  testResult.value = null
  showForm.value = true
}

function cancelForm() {
  showForm.value = false
  editingId.value = null
}

async function saveForm() {
  saving.value = true
  try {
    const payload = {
      name: form.name,
      provider_type: form.provider_type,
      api_key: form.api_key,
      base_url: form.base_url || null,
      model: form.model,
      enabled: form.enabled,
    }
    if (editingId.value) {
      await settingsStore.updateAIProvider(editingId.value, payload)
    } else {
      await settingsStore.createAIProvider(payload)
    }
    showForm.value = false
    editingId.value = null
    showToast('Provider saved', false)
  } catch {
    showToast('Failed to save provider', true)
  } finally {
    saving.value = false
  }
}

async function testConnection() {
  testing.value = true
  testResult.value = null
  try {
    const result = await settingsApi.testAIProvider({
      provider_type: form.provider_type,
      api_key: form.api_key,
      base_url: form.base_url || null,
      model: form.model,
    })
    testResult.value = result
  } catch {
    testResult.value = { success: false, message: 'Connection failed' }
  } finally {
    testing.value = false
  }
}

async function activate(id: string) {
  try {
    await settingsStore.activateAIProvider(id)
    showToast('Provider activated', false)
  } catch {
    showToast('Failed to activate provider', true)
  }
}

async function deleteProvider(id: string) {
  if (!confirm('Delete this AI provider?')) return
  try {
    await settingsStore.deleteAIProvider(id)
    showToast('Provider deleted', false)
  } catch {
    showToast('Failed to delete provider', true)
  }
}

function showToast(msg: string, isError: boolean) {
  toastMsg.value = msg
  toastError.value = isError
  setTimeout(() => (toastMsg.value = ''), 3000)
}
</script>
