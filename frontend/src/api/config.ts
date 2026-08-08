import client from './client'

export interface AppConfig {
  note_version_interval_minutes: number
  note_version_max_count: number
  registration_enabled: boolean
  email_verification_required: boolean
  email_enabled: boolean
}

export const configApi = {
  // Public endpoint — safe to call before authentication (login screen reads it).
  async get(): Promise<AppConfig> {
    const res = await client.get<AppConfig>('/config')
    return res.data
  },
}
