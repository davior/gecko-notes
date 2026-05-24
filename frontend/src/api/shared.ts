import client from './client'

export interface SharedNote {
  id: string
  title: string
  content: string
  tags: string[]
  created_at: string
  modified_at: string
  author_username: string
  author_avatar_url: string | null
}

export const sharedApi = {
  get(token: string): Promise<{ data: SharedNote }> {
    return client.get(`/shared/${token}`).then((r) => r.data)
  },
}
