import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { categoriesApi, type Category, type CategoryCreate, type CategoryUpdate } from '@/api/categories'

export const useCategoriesStore = defineStore('categories', () => {
  const categories = ref<Category[]>([])
  const loading = ref(false)

  const categoriesMap = computed(() => {
    const map: Record<string, Category> = {}
    for (const cat of categories.value) {
      map[cat.id] = cat
    }
    return map
  })

  async function loadCategories() {
    loading.value = true
    try {
      const response = await categoriesApi.list()
      categories.value = response.data
    } finally {
      loading.value = false
    }
  }

  async function createCategory(payload: CategoryCreate) {
    const response = await categoriesApi.create(payload)
    categories.value.push(response.data)
    return response.data
  }

  async function updateCategory(id: string, payload: CategoryUpdate) {
    const response = await categoriesApi.update(id, payload)
    const idx = categories.value.findIndex((c) => c.id === id)
    if (idx !== -1) {
      categories.value[idx] = response.data
    }
    return response.data
  }

  async function deleteCategory(id: string) {
    await categoriesApi.delete(id)
    categories.value = categories.value.filter((c) => c.id !== id)
  }

  function getCategoryById(id: string): Category | undefined {
    return categoriesMap.value[id]
  }

  return {
    categories,
    loading,
    categoriesMap,
    loadCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    getCategoryById,
  }
})
