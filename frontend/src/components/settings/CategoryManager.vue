<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-lg font-semibold text-gray-900">Categories</h2>
      <button class="btn-primary text-sm" @click="startAddNew">
        <Plus class="w-4 h-4" />
        Add Category
      </button>
    </div>

    <!-- Category list -->
    <div class="space-y-2">
      <!-- New category form -->
      <div v-if="addingNew" class="card p-4 border-blue-200 bg-blue-50">
        <h3 class="text-sm font-medium text-gray-700 mb-3">New Category</h3>
        <div class="flex flex-col gap-3">
          <div class="flex gap-3">
            <div class="w-24">
              <label class="label">Emoji</label>
              <input v-model="newForm.emoji" type="text" class="input text-center text-xl" maxlength="4" />
            </div>
            <div class="flex-1">
              <label class="label">Label</label>
              <input v-model="newForm.label" type="text" class="input" placeholder="Category name" />
            </div>
            <div class="w-24">
              <label class="label">Color</label>
              <input v-model="newForm.color" type="color" class="w-full h-9 rounded-lg border border-gray-300 cursor-pointer" />
            </div>
          </div>
          <div class="flex gap-2">
            <button class="btn-primary text-sm flex-1" :disabled="!newForm.label.trim()" @click="saveNew">Save</button>
            <button class="btn-secondary text-sm flex-1" @click="addingNew = false">Cancel</button>
          </div>
        </div>
      </div>

      <div
        v-for="cat in categories"
        :key="cat.id"
        class="card p-4"
      >
        <div v-if="editingId === cat.id">
          <div class="flex flex-col gap-3">
            <div class="flex gap-3">
              <div class="w-24">
                <label class="label">Emoji</label>
                <input v-model="editForm.emoji" type="text" class="input text-center text-xl" maxlength="4" />
              </div>
              <div class="flex-1">
                <label class="label">Label</label>
                <input v-model="editForm.label" type="text" class="input" placeholder="Category name" />
              </div>
              <div class="w-24">
                <label class="label">Color</label>
                <input v-model="editForm.color" type="color" class="w-full h-9 rounded-lg border border-gray-300 cursor-pointer" />
              </div>
            </div>
            <div class="flex gap-2">
              <button class="btn-primary text-sm flex-1" @click="saveEdit(cat.id)">Save</button>
              <button class="btn-secondary text-sm flex-1" @click="editingId = null">Cancel</button>
            </div>
          </div>
        </div>

        <div v-else class="flex items-center gap-3">
          <!-- Emoji with color bg -->
          <div
            class="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-lg"
            :style="{ backgroundColor: cat.color + '22' }"
          >
            {{ cat.emoji }}
          </div>

          <!-- Label + color indicator -->
          <div class="flex items-center gap-2 flex-1 min-w-0">
            <div
              class="w-3 h-3 rounded-full shrink-0"
              :style="{ backgroundColor: cat.color }"
            />
            <span class="text-sm font-medium text-gray-900 truncate">{{ cat.label }}</span>
            <span v-if="cat.is_default" class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Default</span>
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-1 shrink-0">
            <button
              class="btn-ghost p-1.5"
              title="Edit"
              @click="startEdit(cat)"
            >
              <Pencil class="w-4 h-4" />
            </button>
            <button
              class="btn-ghost p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50"
              title="Delete"
              :disabled="cat.is_default"
              :class="{ 'opacity-30 cursor-not-allowed': cat.is_default }"
              @click="!cat.is_default && deleteCategory(cat.id)"
            >
              <Trash2 class="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div v-if="categories.length === 0 && !addingNew" class="text-center text-gray-400 py-8 text-sm">
        No categories yet. Add one to get started.
      </div>
    </div>

    <!-- Error toast -->
    <div
      v-if="errorMsg"
      class="fixed bottom-4 right-4 bg-red-600 text-white px-4 py-3 rounded-xl shadow-lg text-sm z-50"
    >
      {{ errorMsg }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import { Plus, Pencil, Trash2 } from 'lucide-vue-next'
import { useCategoriesStore } from '@/stores/categories'
import type { Category } from '@/api/categories'

const categoriesStore = useCategoriesStore()
const categories = computed(() => categoriesStore.categories)

const addingNew = ref(false)
const editingId = ref<string | null>(null)
const errorMsg = ref('')

interface CategoryFormData {
  label: string
  emoji: string
  color: string
}

const newForm = reactive<CategoryFormData>({ label: '', emoji: '📝', color: '#3B82F6' })
const editForm = reactive<CategoryFormData>({ label: '', emoji: '', color: '' })

function startAddNew() {
  newForm.label = ''
  newForm.emoji = '📝'
  newForm.color = '#3B82F6'
  addingNew.value = true
  editingId.value = null
}

function startEdit(cat: Category) {
  editForm.label = cat.label
  editForm.emoji = cat.emoji
  editForm.color = cat.color
  editingId.value = cat.id
  addingNew.value = false
}

async function saveNew() {
  if (!newForm.label.trim()) return
  try {
    await categoriesStore.createCategory({
      label: newForm.label.trim(),
      emoji: newForm.emoji,
      color: newForm.color,
      sort_order: categories.value.length,
    })
    addingNew.value = false
  } catch {
    showError('Failed to create category')
  }
}

async function saveEdit(id: string) {
  try {
    await categoriesStore.updateCategory(id, {
      label: editForm.label.trim(),
      emoji: editForm.emoji,
      color: editForm.color,
    })
    editingId.value = null
  } catch {
    showError('Failed to update category')
  }
}

async function deleteCategory(id: string) {
  if (!confirm('Delete this category?')) return
  try {
    await categoriesStore.deleteCategory(id)
  } catch {
    showError('Cannot delete default categories')
  }
}

function showError(msg: string) {
  errorMsg.value = msg
  setTimeout(() => (errorMsg.value = ''), 3000)
}
</script>
