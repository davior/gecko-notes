import client from './client'

export interface Category {
  id: string
  label: string
  emoji: string
  color: string
  is_default: boolean
  sort_order: number
}

export interface CategoryCreate {
  label: string
  emoji: string
  color: string
  is_default?: boolean
  sort_order?: number
}

export interface CategoryUpdate {
  label?: string
  emoji?: string
  color?: string
  sort_order?: number
}

export const categoriesApi = {
  list(): Promise<{ data: Category[]; total: number; limit: number; offset: number }> {
    return client.get('/categories').then((r) => r.data)
  },

  create(payload: CategoryCreate): Promise<{ data: Category }> {
    return client.post('/categories', payload).then((r) => r.data)
  },

  update(id: string, payload: CategoryUpdate): Promise<{ data: Category }> {
    return client.put(`/categories/${id}`, payload).then((r) => r.data)
  },

  delete(id: string): Promise<void> {
    return client.delete(`/categories/${id}`).then(() => undefined)
  },
}
