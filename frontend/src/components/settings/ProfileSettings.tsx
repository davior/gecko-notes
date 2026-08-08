import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Camera, Loader2 } from 'lucide-react'
import { useAuthStore } from '@/stores/auth'
import { mediaApi } from '@/api/media'
import TwoFactorSettings from '@/components/settings/TwoFactorSettings'

export default function ProfileSettings() {
  const navigate = useNavigate()
  const { user, updateProfile, changePassword, logout } = useAuthStore()

  const [username, setUsername] = useState(user?.username ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [profileMsg, setProfileMsg] = useState('')
  const [profileErr, setProfileErr] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)

  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [pwErr, setPwErr] = useState('')
  const [savingPw, setSavingPw] = useState(false)

  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingAvatar(true)
    try {
      const response = await mediaApi.upload(file)
      await updateProfile({ avatar_url: response.data.url })
    } catch {
      // silent
    } finally {
      setUploadingAvatar(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleProfileSave(e: React.FormEvent) {
    e.preventDefault()
    setProfileMsg('')
    setProfileErr('')
    setSavingProfile(true)
    try {
      await updateProfile({ username: username.trim(), email: email.trim() })
      setProfileMsg('Profile updated.')
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setProfileErr(detail ?? 'Failed to update profile.')
    } finally {
      setSavingProfile(false)
    }
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault()
    setPwMsg('')
    setPwErr('')
    if (newPw !== confirmPw) { setPwErr('New passwords do not match.'); return }
    if (newPw.length < 6) { setPwErr('New password must be at least 6 characters.'); return }
    setSavingPw(true)
    try {
      await changePassword(currentPw, newPw)
      setPwMsg('Password changed successfully.')
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setPwErr(detail ?? 'Failed to change password.')
    } finally {
      setSavingPw(false)
    }
  }

  function handleLogout() {
    logout()
    navigate('/login')
  }

  const initial = user?.username.charAt(0).toUpperCase() ?? '?'

  return (
    <div className="space-y-8">
      {/* Avatar */}
      <div className="flex flex-col items-center gap-3">
        <div className="relative">
          {user?.avatar_url ? (
            <img
              src={user.avatar_url}
              alt={user?.username}
              className="w-24 h-24 rounded-full object-cover ring-4 ring-gray-200 dark:ring-gray-600"
            />
          ) : (
            <div className="w-24 h-24 rounded-full bg-blue-600 text-white flex items-center justify-center text-3xl font-bold ring-4 ring-gray-200 dark:ring-gray-600 select-none">
              {initial}
            </div>
          )}
          <button
            className="absolute bottom-0 right-0 w-8 h-8 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-full flex items-center justify-center shadow hover:opacity-80 transition-opacity"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingAvatar}
            title="Upload photo"
          >
            {uploadingAvatar ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
          </button>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
        <p className="text-sm text-gray-500 dark:text-gray-400">{user?.username}</p>
      </div>

      {/* Account details */}
      <div className="card p-5">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-4">Account Details</h2>
        <form onSubmit={handleProfileSave} className="space-y-4">
          <div>
            <label className="label">Username</label>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={1} />
          </div>
          <div>
            <label className="label">
              Email
              {user && (user.email_verified
                ? <span className="ml-2 text-xs text-green-600 dark:text-green-400 font-normal">verified</span>
                : <span className="ml-2 text-xs text-amber-600 dark:text-amber-400 font-normal">unverified</span>)}
            </label>
            <input type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          {profileErr && <p className="text-sm text-red-600 dark:text-red-400">{profileErr}</p>}
          {profileMsg && <p className="text-sm text-green-600 dark:text-green-400">{profileMsg}</p>}
          <button type="submit" className="btn-primary" disabled={savingProfile}>
            {savingProfile ? 'Saving…' : 'Save Changes'}
          </button>
        </form>
      </div>

      {/* Change password */}
      <div className="card p-5">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-4">Change Password</h2>
        <form onSubmit={handlePasswordChange} className="space-y-4">
          <div>
            <label className="label">Current Password</label>
            <input type="password" className="input" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} required />
          </div>
          <div>
            <label className="label">New Password</label>
            <input type="password" className="input" value={newPw} onChange={(e) => setNewPw(e.target.value)} required minLength={6} />
          </div>
          <div>
            <label className="label">Confirm New Password</label>
            <input type="password" className="input" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} required />
          </div>
          {pwErr && <p className="text-sm text-red-600 dark:text-red-400">{pwErr}</p>}
          {pwMsg && <p className="text-sm text-green-600 dark:text-green-400">{pwMsg}</p>}
          <button type="submit" className="btn-primary" disabled={savingPw}>
            {savingPw ? 'Changing…' : 'Change Password'}
          </button>
        </form>
      </div>

      {/* Two-factor authentication */}
      <TwoFactorSettings />

      {/* Log out */}
      <div className="card p-5">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">Session</h2>
        <button
          className="px-4 py-2 rounded-lg border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 text-sm hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          onClick={handleLogout}
        >
          Log Out
        </button>
      </div>
    </div>
  )
}
