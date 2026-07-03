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
  // Title of the parent note, present whenever this note has one — even if
  // the parent isn't shared. parent_share_token is only set when it is,
  // which is what makes the "Up to {parent}" link navigable.
  parent_title: string | null
  parent_share_token: string | null
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
