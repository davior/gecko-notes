import client from './client'

export interface AppConfig {
  note_version_interval_minutes: number
  note_version_max_count: number
  registration_enabled: boolean
  email_verification_required: boolean
  email_enabled: boolean
  voice_mode_enabled: boolean
  /** Who signs people in (M6). "suite": Gecko Suite keeps the accounts; Notes only verifies. */
  identity_provider: 'notes' | 'suite'
  /** The suite's address for the browser, when it signs people in; otherwise null. */
  identity_url: string | null
}

export const configApi = {
  // Public endpoint — safe to call before authentication (login screen reads it).
  async get(): Promise<AppConfig> {
    const res = await client.get<AppConfig>('/config')
    return res.data
  },
}
