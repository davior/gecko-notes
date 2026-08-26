import { create } from 'zustand'
import { recipesApi, type Recipe, type RecipeCreate, type RecipeUpdate } from '@/api/recipes'

interface RecipesState {
  recipes: Recipe[]
  loading: boolean
  loaded: boolean
  loadRecipes: () => Promise<void>
  createRecipe: (payload: RecipeCreate) => Promise<Recipe>
  updateRecipe: (id: string, payload: RecipeUpdate) => Promise<Recipe>
  deleteRecipe: (id: string) => Promise<void>
  reset: () => void
}

export const useRecipesStore = create<RecipesState>((set) => ({
  recipes: [],
  loading: false,
  loaded: false,

  async loadRecipes() {
    set({ loading: true })
    try {
      const response = await recipesApi.list()
      set({ recipes: response.data, loaded: true })
    } finally {
      set({ loading: false })
    }
  },

  async createRecipe(payload) {
    const response = await recipesApi.create(payload)
    set((s) => ({ recipes: [...s.recipes, response.data] }))
    return response.data
  },

  async updateRecipe(id, payload) {
    const response = await recipesApi.update(id, payload)
    set((s) => ({
      recipes: s.recipes.map((r) => (r.id === id ? response.data : r)),
    }))
    return response.data
  },

  async deleteRecipe(id) {
    await recipesApi.delete(id)
    set((s) => ({ recipes: s.recipes.filter((r) => r.id !== id) }))
  },

  reset() {
    set({ recipes: [], loading: false, loaded: false })
  },
}))
