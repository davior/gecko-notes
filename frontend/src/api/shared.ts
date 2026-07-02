import client from './client'
import type { Theme } from './settings'

export interface SharedNote {
  id: string
  title: string
  content: string
  tags: string[]
  created_at: string
  modified_at: string
  author_username: string
  author_avatar_url: string | null
  theme: Theme | null
  like_count: number
  linked_shared_notes: Record<string, string>
}

export const sharedApi = {
  get(token: string): Promise<{ data: SharedNote }> {
    return client.get(`/shared/${token}`).then((r) => r.data)
  },
  like(token: string): Promise<{ data: { like_count: number } }> {
    return client.post(`/shared/${token}/like`).then((r) => r.data)
  },
  unlike(token: string): Promise<{ data: { like_count: number } }> {
    return client.delete(`/shared/${token}/like`).then((r) => r.data)
  },
}
