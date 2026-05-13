import client from './client'
import type { User } from './auth'

export const usersApi = {
  async listUsers(): Promise<User[]> {
    const res = await client.get<User[]>('/users')
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
