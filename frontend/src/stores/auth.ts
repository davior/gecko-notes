import { create } from 'zustand'
import { authApi, type User } from '@/api/auth'
import { useSettingsStore } from '@/stores/settings'

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  loading: boolean
  error: string | null
  login: (username: string, password: string) => Promise<void>
  register: (username: string, email: string, password: string) => Promise<void>
  logout: () => void
  initAuth: () => void
  updateProfile: (data: Partial<Pick<User, 'username' | 'email' | 'avatar_url'>>) => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
}

function loadStoredAuth(): { user: User | null; token: string | null } {
  const token = localStorage.getItem('auth_token')
  const userStr = localStorage.getItem('auth_user')
  if (token && userStr) {
    try {
      return { token, user: JSON.parse(userStr) }
    } catch {
      return { token: null, user: null }
    }
  }
  return { token: null, user: null }
}

const stored = loadStoredAuth()

export const useAuthStore = create<AuthState>((set) => ({
  user: stored.user,
  token: stored.token,
  isAuthenticated: !!stored.token,
  loading: false,
  error: null,

  initAuth() {
    const { token, user } = loadStoredAuth()
    set({ token, user, isAuthenticated: !!token })
  },

  async login(username, password) {
    set({ loading: true, error: null })
    try {
      const { access_token, user } = await authApi.login(username, password)
      localStorage.setItem('auth_token', access_token)
      localStorage.setItem('auth_user', JSON.stringify(user))
      set({ token: access_token, user, isAuthenticated: true })
      await useSettingsStore.getState().loadSettings()
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        'Login failed'
      set({ error: message })
      throw err
    } finally {
      set({ loading: false })
    }
  },

  async register(username, email, password) {
    set({ loading: true, error: null })
    try {
      await authApi.register(username, email, password)
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        'Registration failed'
      set({ error: message })
      throw err
    } finally {
      set({ loading: false })
    }
  },

  logout() {
    localStorage.removeItem('auth_token')
    localStorage.removeItem('auth_user')
    set({ token: null, user: null, isAuthenticated: false, error: null })
    useSettingsStore.getState().reset()
  },

  async updateProfile(data) {
    const updated = await authApi.updateMe(data)
    localStorage.setItem('auth_user', JSON.stringify(updated))
    set({ user: updated })
  },

  async changePassword(currentPassword, newPassword) {
    await authApi.changePassword(currentPassword, newPassword)
  },
}))
