import { create } from 'zustand'
import { authApi, isTwoFactorRequired, type User, type LoginResult, type LoginResponse } from '@/api/auth'
import { useSettingsStore } from '@/stores/settings'
import { useNotesStore } from '@/stores/notes'

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  loading: boolean
  error: string | null
  // Returns the raw result so the login screen can branch into a 2FA step. When 2FA
  // is required the session is NOT established until completeTwoFactor succeeds.
  login: (username: string, password: string) => Promise<LoginResult>
  completeTwoFactor: (challengeToken: string, code: string) => Promise<void>
  register: (username: string, email: string, password: string) => Promise<void>
  logout: () => void
  initAuth: () => void
  updateProfile: (data: Partial<Pick<User, 'username' | 'email' | 'avatar_url'>>) => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  setUser: (user: User) => void
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

// The login/verification endpoints can return a structured detail ({code, message});
// normalise to a display string so the UI never tries to render an object.
function extractMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  if (typeof detail === 'string') return detail
  if (detail && typeof detail === 'object' && 'message' in detail) {
    return String((detail as { message: unknown }).message)
  }
  return fallback
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
      const result = await authApi.login(username, password)
      if (isTwoFactorRequired(result)) {
        // Don't establish a session yet — the caller will drive the second factor.
        return result
      }
      _applySession(set, result)
      await useSettingsStore.getState().loadSettings()
      return result
    } catch (err: unknown) {
      set({ error: extractMessage(err, 'Login failed') })
      throw err
    } finally {
      set({ loading: false })
    }
  },

  async completeTwoFactor(challengeToken, code) {
    set({ loading: true, error: null })
    try {
      const result = await authApi.loginTwoFactor(challengeToken, code)
      _applySession(set, result)
      await useSettingsStore.getState().loadSettings()
    } catch (err: unknown) {
      set({ error: extractMessage(err, 'Verification failed') })
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
      set({ error: extractMessage(err, 'Registration failed') })
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
    useNotesStore.getState().reset()
  },

  async updateProfile(data) {
    const updated = await authApi.updateMe(data)
    localStorage.setItem('auth_user', JSON.stringify(updated))
    set({ user: updated })
  },

  async changePassword(currentPassword, newPassword) {
    await authApi.changePassword(currentPassword, newPassword)
  },

  setUser(user) {
    localStorage.setItem('auth_user', JSON.stringify(user))
    set({ user })
  },
}))

function _applySession(set: (partial: Partial<AuthState>) => void, result: LoginResponse) {
  localStorage.setItem('auth_token', result.access_token)
  localStorage.setItem('auth_user', JSON.stringify(result.user))
  set({ token: result.access_token, user: result.user, isAuthenticated: true })
}
