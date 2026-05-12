import client from './client'

export interface User {
  id: string
  username: string
  email: string
  is_active: boolean
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
}
