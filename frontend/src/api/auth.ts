import client from './client'

export interface User {
  id: string
  username: string
  email: string
  is_active: boolean
  is_admin: boolean
  avatar_url: string | null
  created_at: string
}

export interface LoginResponse {
  access_token: string
  token_type: string
  user: User
}

export const authApi = {
  async register(username: string, email: string, password: string): Promise<User> {
    const res = await client.post<User>('/auth/register', { username, email, password })
    return res.data
  },

  async login(username: string, password: string): Promise<LoginResponse> {
    const res = await client.post<LoginResponse>('/auth/login', { username, password })
    return res.data
  },

  async me(): Promise<User> {
    const res = await client.get<User>('/auth/me')
    return res.data
  },

  async updateMe(data: Partial<Pick<User, 'username' | 'email' | 'avatar_url'>>): Promise<User> {
    const res = await client.patch<User>('/auth/me', data)
    return res.data
  },

  async changePassword(current_password: string, new_password: string): Promise<void> {
    await client.post('/auth/me/change-password', { current_password, new_password })
  },
}
