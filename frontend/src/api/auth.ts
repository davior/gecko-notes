import client from './client'

export interface User {
  id: string
  username: string
  email: string
  is_active: boolean
  is_admin: boolean
  avatar_url: string | null
  created_at: string
  email_verified: boolean
  two_factor_method: string | null
}

export interface LoginResponse {
  access_token: string
  token_type: string
  user: User
}

export interface TwoFactorRequired {
  two_factor_required: true
  method: 'email' | 'totp'
  challenge_token: string
}

export type LoginResult = LoginResponse | TwoFactorRequired

export function isTwoFactorRequired(r: LoginResult): r is TwoFactorRequired {
  return (r as TwoFactorRequired).two_factor_required === true
}

export interface TwoFactorStatus {
  enabled: boolean
  method: string | null
  email_available: boolean
}

export interface TotpSetup {
  secret: string
  otpauth_uri: string
  qr_data_uri: string
}

export const authApi = {
  async register(username: string, email: string, password: string): Promise<User> {
    const res = await client.post<User>('/auth/register', { username, email, password })
    return res.data
  },

  async login(username: string, password: string): Promise<LoginResult> {
    const res = await client.post<LoginResult>('/auth/login', { username, password })
    return res.data
  },

  async loginTwoFactor(challenge_token: string, code: string): Promise<LoginResponse> {
    const res = await client.post<LoginResponse>('/auth/login/2fa', { challenge_token, code })
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

  // ─── Email verification & password reset ──────────────────────────────────
  async verifyEmail(token: string): Promise<{ message: string }> {
    const res = await client.post<{ message: string }>('/auth/verify-email', { token })
    return res.data
  },

  async resendVerification(email: string): Promise<{ message: string }> {
    const res = await client.post<{ message: string }>('/auth/resend-verification', { email })
    return res.data
  },

  async forgotPassword(email: string): Promise<{ message: string }> {
    const res = await client.post<{ message: string }>('/auth/forgot-password', { email })
    return res.data
  },

  async resetPassword(token: string, new_password: string): Promise<{ message: string }> {
    const res = await client.post<{ message: string }>('/auth/reset-password', { token, new_password })
    return res.data
  },

  // ─── Two-factor management ────────────────────────────────────────────────
  async twoFactorStatus(): Promise<TwoFactorStatus> {
    const res = await client.get<TwoFactorStatus>('/auth/2fa/status')
    return res.data
  },

  async totpSetup(): Promise<TotpSetup> {
    const res = await client.post<TotpSetup>('/auth/2fa/totp/setup')
    return res.data
  },

  async totpEnable(secret: string, code: string): Promise<TwoFactorStatus> {
    const res = await client.post<TwoFactorStatus>('/auth/2fa/totp/enable', { secret, code })
    return res.data
  },

  async emailTwoFactorSetup(): Promise<{ message: string }> {
    const res = await client.post<{ message: string }>('/auth/2fa/email/setup')
    return res.data
  },

  async emailTwoFactorVerify(code: string): Promise<TwoFactorStatus> {
    const res = await client.post<TwoFactorStatus>('/auth/2fa/email/verify', { code })
    return res.data
  },

  async disableTwoFactor(password: string): Promise<TwoFactorStatus> {
    const res = await client.post<TwoFactorStatus>('/auth/2fa/disable', { password })
    return res.data
  },
}
