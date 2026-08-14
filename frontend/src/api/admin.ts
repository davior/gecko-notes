import client from './client'

export interface AdminSettings {
  registration_enabled: boolean
  email_verification_required: boolean
  voice_mode_enabled: boolean
}

export const adminApi = {
  async getSettings(): Promise<AdminSettings> {
    const res = await client.get<AdminSettings>('/admin/settings')
    return res.data
  },

  async updateSettings(data: Partial<AdminSettings>): Promise<AdminSettings> {
    const res = await client.put<AdminSettings>('/admin/settings', data)
    return res.data
  },
}
