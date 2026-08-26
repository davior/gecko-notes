import client from './client'

export interface Recipe {
  id: string
  name: string
  prompt: string
  tags: string[]
  sort_order: number
  created_at: string
  updated_at: string
}

export interface RecipeCreate {
  name: string
  prompt: string
  tags?: string[]
  sort_order?: number
}

export interface RecipeUpdate {
  name?: string
  prompt?: string
  tags?: string[]
  sort_order?: number
}

export const recipesApi = {
  list(): Promise<{ data: Recipe[]; total: number; limit: number; offset: number }> {
    return client.get('/recipes').then((r) => r.data)
  },

  create(payload: RecipeCreate): Promise<{ data: Recipe }> {
    return client.post('/recipes', payload).then((r) => r.data)
  },

  update(id: string, payload: RecipeUpdate): Promise<{ data: Recipe }> {
    return client.patch(`/recipes/${id}`, payload).then((r) => r.data)
  },

  delete(id: string): Promise<void> {
    return client.delete(`/recipes/${id}`).then(() => undefined)
  },
}
