import { useEffect, useState } from 'react'
import { Eye, EyeOff, Send } from 'lucide-react'
import { settingsApi, type SubstackSettings } from '@/api/settings'

// Substack publishing credentials. Auth is cookie-only: Substack blocks scripted
// email/password logins behind a captcha, so the user pastes their browser session
// cookie. The cookie is stored encrypted on the server and never returned to the
// browser (this component only ever learns whether one is configured). With a
// publication URL + cookie saved, the note Export menu gains "Publish to Substack".
export default function PublishingSettings() {
  const [settings, setSettings] = useState<SubstackSettings | null>(null)
  const [pubUrl, setPubUrl] = useState('')
  const [cookie, setCookie] = useState('')
  const [showCookie, setShowCookie] = useState(false)
  const [savingUrl, setSavingUrl] = useState(false)
  const [savingCookie, setSavingCookie] = useState(false)
  const [saved, setSaved] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const s = await settingsApi.getSubstackSettings()
      setSettings(s)
      setPubUrl(s.publication_url)
    } catch {
      setError('Failed to load publishing settings')
    }
  }

  useEffect(() => { void load() }, [])

  async function saveUrl() {
    setSavingUrl(true)
    setError(null)
    try {
      setSettings(await settingsApi.updateSubstackSettings({ publication_url: pubUrl.trim() }))
      setSaved('url')
      setTimeout(() => setSaved(''), 3000)
    } catch {
      setError('Failed to save the publication URL. It must be an https:// address (e.g. https://you.substack.com).')
    } finally {
      setSavingUrl(false)
    }
  }

  async function saveCookie(value: string) {
    setSavingCookie(true)
    setError(null)
    try {
      setSettings(await settingsApi.updateSubstackSettings({ cookie: value }))
      setCookie('')
      setSaved('cookie')
      setTimeout(() => setSaved(''), 3000)
    } catch {
      setError('Failed to save the session cookie')
    } finally {
      setSavingCookie(false)
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <Send className="w-5 h-5 text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Substack</h2>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Connect your Substack publication to push a note straight to your drafts. Once
        connected, open any note and choose <span className="font-medium">Export → Publish to Substack</span>;
        it creates a <span className="font-medium">draft</span> (never published) that you can review and
        send from Substack.
      </p>

      {settings?.configured && (
        <p className="text-sm text-green-600 dark:text-green-400 font-medium mb-4">✓ Ready to publish</p>
      )}
      {error && <p className="text-sm text-red-500 mb-4">{error}</p>}

      <div className="space-y-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Publication URL</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Your Substack address, e.g. <code>https://yourname.substack.com</code>.
          </p>
          <div className="card p-4 space-y-3">
            <input
              type="url"
              className="input"
              placeholder="https://yourname.substack.com"
              value={pubUrl}
              onChange={(e) => setPubUrl(e.target.value)}
            />
            <div className="flex items-center gap-3">
              <button className="btn-primary text-sm" disabled={savingUrl || !pubUrl.trim()} onClick={() => void saveUrl()}>
                {savingUrl ? 'Saving…' : 'Save URL'}
              </button>
              {saved === 'url' && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Session cookie</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Substack has no password-based API, so paste your logged-in session cookie. In a browser where
            you're signed in to Substack, open developer tools → <span className="font-medium">Network</span>,
            click any request to substack.com, and copy the full <code>cookie</code> request-header value.
            Stored encrypted; never returned to the browser. If publishing later fails with an auth error,
            refresh it here.
          </p>
          <div className="card p-4 space-y-3">
            {settings?.has_cookie && (
              <p className="text-xs text-green-600 dark:text-green-400 font-medium">✓ Session cookie configured</p>
            )}
            <div className="relative">
              <input
                type={showCookie ? 'text' : 'password'}
                className="input pr-10"
                placeholder={settings?.has_cookie ? 'Enter a new cookie to replace…' : 'substack.sid=…; other=…'}
                value={cookie}
                onChange={(e) => setCookie(e.target.value)}
              />
              <button type="button" className="absolute inset-y-0 right-0 px-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" onClick={() => setShowCookie((v) => !v)}>
                {showCookie ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <div className="flex items-center gap-3">
              <button className="btn-primary text-sm" disabled={savingCookie || !cookie} onClick={() => void saveCookie(cookie)}>
                {savingCookie ? 'Saving…' : 'Save Cookie'}
              </button>
              {settings?.has_cookie && (
                <button className="text-sm text-red-500 hover:text-red-700 dark:hover:text-red-400" disabled={savingCookie} onClick={() => void saveCookie('')}>
                  Remove cookie
                </button>
              )}
              {saved === 'cookie' && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
