import { create } from 'zustand'
import { categoriesApi, type Category, type CategoryCreate, type CategoryUpdate } from '@/api/categories'

interface CategoriesState {
  categories: Category[]
  loading: boolean
  loadCategories: () => Promise<void>
  createCategory: (payload: CategoryCreate) => Promise<Category>
  updateCategory: (id: string, payload: CategoryUpdate) => Promise<Category>
  deleteCategory: (id: string) => Promise<void>
  getCategoryById: (id: string) => Category | undefined
}

export const useCategoriesStore = create<CategoriesState>((set, get) => ({
  categories: [],
  loading: false,

  async loadCategories() {
    set({ loading: true })
    try {
      const response = await categoriesApi.list()
      set({ categories: response.data })
    } finally {
      set({ loading: false })
    }
  },

  async createCategory(payload) {
    const response = await categoriesApi.create(payload)
    set((s) => ({ categories: [...s.categories, response.data] }))
    return response.data
  },

  async updateCategory(id, payload) {
    const response = await categoriesApi.update(id, payload)
    set((s) => ({
      categories: s.categories.map((c) => (c.id === id ? response.data : c)),
    }))
    return response.data
  },

  async deleteCategory(id) {
    await categoriesApi.delete(id)
    set((s) => ({ categories: s.categories.filter((c) => c.id !== id) }))
  },

  getCategoryById(id) {
    return get().categories.find((c) => c.id === id)
  },
}))
