import { useEffect, useState } from 'react'
import { ShieldCheck, Smartphone, Mail, Loader2 } from 'lucide-react'
import { authApi, type TwoFactorStatus, type TotpSetup } from '@/api/auth'
import { useAuthStore } from '@/stores/auth'

type Flow = 'none' | 'totp' | 'email'

export default function TwoFactorSettings() {
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)

  const [status, setStatus] = useState<TwoFactorStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const [flow, setFlow] = useState<Flow>('none')
  const [totp, setTotp] = useState<TotpSetup | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  const [showDisable, setShowDisable] = useState(false)
  const [disablePw, setDisablePw] = useState('')

  useEffect(() => {
    authApi.twoFactorStatus().then(setStatus).finally(() => setLoading(false))
  }, [])

  function syncUser(method: string | null) {
    if (user) setUser({ ...user, two_factor_method: method })
  }

  function resetFlow() {
    setFlow('none'); setTotp(null); setCode(''); setErr(''); setMsg('')
  }

  async function startTotp() {
    setErr(''); setMsg(''); setBusy(true)
    try {
      const setup = await authApi.totpSetup()
      setTotp(setup)
      setFlow('totp')
    } catch {
      setErr('Could not start authenticator setup.')
    } finally {
      setBusy(false)
    }
  }

  async function startEmail() {
    setErr(''); setMsg(''); setBusy(true)
    try {
      await authApi.emailTwoFactorSetup()
      setFlow('email')
      setMsg('We emailed you a code. Enter it below to turn on email 2FA.')
    } catch (e: unknown) {
      setErr((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Could not send the code.')
    } finally {
      setBusy(false)
    }
  }

  async function confirmEnable() {
    setErr(''); setBusy(true)
    try {
      const next = flow === 'totp'
        ? await authApi.totpEnable(totp!.secret, code.trim())
        : await authApi.emailTwoFactorVerify(code.trim())
      setStatus(next)
      syncUser(next.method)
      resetFlow()
    } catch (e: unknown) {
      setErr((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'That code was not accepted.')
    } finally {
      setBusy(false)
    }
  }

  async function confirmDisable() {
    setErr(''); setBusy(true)
    try {
      const next = await authApi.disableTwoFactor(disablePw)
      setStatus(next)
      syncUser(next.method)
      setShowDisable(false)
      setDisablePw('')
    } catch (e: unknown) {
      setErr((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Could not disable 2FA.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="card p-5 flex items-center gap-2 text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin" /> <span className="text-sm">Loading…</span>
      </div>
    )
  }

  const methodLabel = status?.method === 'totp' ? 'authenticator app' : status?.method === 'email' ? 'email codes' : ''

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <ShieldCheck className="w-5 h-5 text-gray-500 dark:text-gray-400" />
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Two-Factor Authentication</h2>
      </div>

      {err && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{err}</p>}
      {msg && <p className="text-sm text-green-600 dark:text-green-400 mb-3">{msg}</p>}

      {status?.enabled ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Two-factor authentication is <span className="font-medium text-green-600 dark:text-green-400">on</span> via {methodLabel}.
          </p>
          <button className="btn-danger" onClick={() => { setShowDisable(true); setErr('') }}>
            Disable 2FA
          </button>
        </div>
      ) : flow === 'none' ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Add a second step at sign-in for extra security. Choose a method to set up.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary inline-flex items-center gap-2" onClick={startTotp} disabled={busy}>
              <Smartphone className="w-4 h-4" /> Authenticator app
            </button>
            {status?.email_available && (
              <button className="btn-secondary inline-flex items-center gap-2" onClick={startEmail} disabled={busy}>
                <Mail className="w-4 h-4" /> Email codes
              </button>
            )}
          </div>
          {!status?.email_available && (
            <p className="text-xs text-gray-400">Email codes are unavailable until email is configured on the server.</p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {flow === 'totp' && totp && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600 dark:text-gray-300">
                Scan this QR code with your authenticator app (or enter the key manually), then enter the 6-digit code it shows.
              </p>
              <img src={totp.qr_data_uri} alt="Authenticator QR code" className="w-40 h-40 rounded-lg border border-gray-200 dark:border-gray-700 bg-white p-2" />
              <p className="text-xs text-gray-500 dark:text-gray-400 break-all">
                Manual key: <code className="font-mono">{totp.secret}</code>
              </p>
            </div>
          )}

          <div>
            <label className="label">Verification code</label>
            <input
              className="input tracking-widest"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="000000"
            />
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={resetFlow} disabled={busy}>Cancel</button>
            <button className="btn-primary" onClick={confirmEnable} disabled={busy || code.trim().length < 6}>
              {busy ? 'Enabling…' : 'Enable 2FA'}
            </button>
          </div>
        </div>
      )}

      {showDisable && (
        <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card p-6 w-full max-w-sm shadow-xl">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">Disable 2FA?</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Confirm your password to turn off two-factor authentication.</p>
            {err && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{err}</p>}
            <input
              type="password"
              className="input mb-4"
              value={disablePw}
              onChange={(e) => setDisablePw(e.target.value)}
              placeholder="Your password"
              autoFocus
            />
            <div className="flex gap-2">
              <button className="btn-ghost flex-1" onClick={() => { setShowDisable(false); setDisablePw(''); setErr('') }}>Cancel</button>
              <button className="btn-danger flex-1" onClick={confirmDisable} disabled={busy || !disablePw}>
                {busy ? 'Disabling…' : 'Disable'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
