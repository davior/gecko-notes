import client from './client'
import type { User } from './auth'

export interface UserMetrics {
  note_count: number
  folder_count: number
  shared_note_count: number
  total_likes: number
  last_login: string | null
  created_at: string
}

export interface UserStorage {
  total_bytes: number
  file_count: number
}

export const usersApi = {
  async listUsers(): Promise<User[]> {
    const res = await client.get<User[]>('/users')
    return res.data
  },

  async getUserMetrics(id: string): Promise<UserMetrics> {
    const res = await client.get<UserMetrics>(`/users/${id}/metrics`)
    return res.data
  },

  // On-demand — walks the user's media folder, so it can be slow for large accounts.
  async getUserStorage(id: string): Promise<UserStorage> {
    const res = await client.get<UserStorage>(`/users/${id}/storage`)
    return res.data
  },

  async updateUser(id: string, data: { is_active?: boolean; is_admin?: boolean }): Promise<User> {
    const res = await client.patch<User>(`/users/${id}`, data)
    return res.data
  },

  async resetPassword(id: string, new_password: string): Promise<void> {
    await client.post(`/users/${id}/reset-password`, { new_password })
  },

  async deleteUser(id: string): Promise<void> {
    await client.delete(`/users/${id}`)
  },
}
