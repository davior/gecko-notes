import { useState, useEffect, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { authApi, isTwoFactorRequired } from '@/api/auth'
import { configApi } from '@/api/config'

type Mode = 'login' | 'register' | 'forgot'
type Step = 'form' | 'twofa'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm'
const labelCls = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'

export default function LoginView() {
  const navigate = useNavigate()
  const { login, completeTwoFactor, register, loading, error } = useAuthStore()

  const [mode, setMode] = useState<Mode>('login')
  const [step, setStep] = useState<Step>('form')

  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  // Second-factor step
  const [twofaMethod, setTwofaMethod] = useState<'email' | 'totp'>('totp')
  const [challengeToken, setChallengeToken] = useState('')
  const [code, setCode] = useState('')

  // Email-not-verified recovery
  const [needsVerification, setNeedsVerification] = useState(false)
  const [resendEmail, setResendEmail] = useState('')
  const [resendMsg, setResendMsg] = useState<string | null>(null)

  // Public runtime config
  const [registrationEnabled, setRegistrationEnabled] = useState(true)
  const [verificationRequired, setVerificationRequired] = useState(false)
  const [emailEnabled, setEmailEnabled] = useState(false)

  const displayError = localError ?? error

  useEffect(() => {
    configApi.get()
      .then((cfg) => {
        setRegistrationEnabled(cfg.registration_enabled)
        setVerificationRequired(cfg.email_verification_required)
        setEmailEnabled(cfg.email_enabled)
        if (!cfg.registration_enabled) setMode('login')
      })
      .catch(() => { /* fall back to defaults */ })
  }, [])

  function resetMessages() {
    setLocalError(null)
    setSuccessMsg(null)
    setNeedsVerification(false)
    setResendMsg(null)
  }

  function switchMode(next: Mode) {
    setMode(next)
    setStep('form')
    resetMessages()
    setPassword('')
    setConfirm('')
    setCode('')
  }

  async function handleLogin() {
    try {
      const result = await login(username, password)
      if (isTwoFactorRequired(result)) {
        setTwofaMethod(result.method)
        setChallengeToken(result.challenge_token)
        setCode('')
        setStep('twofa')
        return
      }
      navigate('/notes', { replace: true })
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
      if (detail && typeof detail === 'object' && (detail as { code?: string }).code === 'email_not_verified') {
        setNeedsVerification(true)
        setResendEmail(email || '')
      }
      // store already set a readable error
    }
  }

  async function handleRegister() {
    if (password !== confirm) { setLocalError('Passwords do not match'); return }
    if (password.length < 8) { setLocalError('Password must be at least 8 characters'); return }
    try {
      await register(username, email, password)
      setSuccessMsg(
        verificationRequired
          ? 'Account created! Check your email for a verification link before signing in.'
          : 'Account created! You can now log in.'
      )
      setMode('login')
      setStep('form')
      setPassword('')
      setConfirm('')
    } catch {
      // error already set in store
    }
  }

  async function handleForgot() {
    try {
      const res = await authApi.forgotPassword(email)
      setSuccessMsg(res.message)
    } catch {
      setLocalError('Could not process that request. Please try again.')
    }
  }

  async function handleTwoFactor() {
    try {
      await completeTwoFactor(challengeToken, code)
      navigate('/notes', { replace: true })
    } catch {
      // store set the error
    }
  }

  async function handleResend() {
    setResendMsg(null)
    try {
      const res = await authApi.resendVerification(resendEmail)
      setResendMsg(res.message)
    } catch {
      setResendMsg('Could not send the verification email. Please try again.')
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    resetMessages()
    if (step === 'twofa') return handleTwoFactor()
    if (mode === 'register') return handleRegister()
    if (mode === 'forgot') return handleForgot()
    return handleLogin()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <span className="text-4xl">🦎</span>
          <h1 className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">Gecko Notes</h1>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 p-8">
          {/* Segmented control — only on the login/register form step */}
          {step === 'form' && mode !== 'forgot' && (
            <div className="flex rounded-lg bg-gray-100 dark:bg-gray-800 p-1 mb-6">
              <button
                type="button"
                onClick={() => switchMode('login')}
                className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  mode === 'login'
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                Sign in
              </button>
              {registrationEnabled && (
                <button
                  type="button"
                  onClick={() => switchMode('register')}
                  className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    mode === 'register'
                      ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
                >
                  Register
                </button>
              )}
            </div>
          )}

          {(step === 'twofa' || mode === 'forgot') && (
            <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-4">
              {step === 'twofa' ? 'Two-factor authentication' : 'Reset your password'}
            </h2>
          )}

          {successMsg && (
            <div className="mb-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-4 py-3 text-sm text-green-700 dark:text-green-400">
              {successMsg}
            </div>
          )}

          {displayError && (
            <div className="mb-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
              {displayError}
            </div>
          )}

          {/* Email-not-verified recovery */}
          {needsVerification && (
            <div className="mb-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
              <p className="mb-2">Your email isn't verified yet. Enter it below to get a new link.</p>
              <input
                type="email"
                value={resendEmail}
                onChange={(e) => setResendEmail(e.target.value)}
                placeholder="you@example.com"
                className={`${inputCls} mb-2`}
              />
              <button type="button" onClick={handleResend} className="text-blue-600 dark:text-blue-400 font-medium hover:underline">
                Resend verification email
              </button>
              {resendMsg && <p className="mt-2 text-green-700 dark:text-green-400">{resendMsg}</p>}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Two-factor code step */}
            {step === 'twofa' ? (
              <>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {twofaMethod === 'email'
                    ? 'We emailed you a 6-digit code. Enter it below to finish signing in.'
                    : 'Enter the 6-digit code from your authenticator app.'}
                </p>
                <div>
                  <label className={labelCls}>Verification code</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    autoFocus
                    maxLength={6}
                    className={`${inputCls} tracking-widest text-center`}
                    placeholder="000000"
                  />
                </div>
              </>
            ) : (
              <>
                {/* Forgot-password: email only */}
                {mode === 'forgot' ? (
                  <>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Enter your account email and we'll send you a link to reset your password.
                    </p>
                    <div>
                      <label className={labelCls}>Email</label>
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        autoComplete="email"
                        className={inputCls}
                        placeholder="you@example.com"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className={labelCls}>Username</label>
                      <input
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        required
                        autoComplete="username"
                        className={inputCls}
                        placeholder="your-username"
                      />
                    </div>

                    {mode === 'register' && (
                      <div>
                        <label className={labelCls}>Email</label>
                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          required
                          autoComplete="email"
                          className={inputCls}
                          placeholder="you@example.com"
                        />
                      </div>
                    )}

                    <div>
                      <label className={labelCls}>Password</label>
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                        className={inputCls}
                        placeholder="••••••••"
                      />
                    </div>

                    {mode === 'register' && (
                      <div>
                        <label className={labelCls}>Confirm password</label>
                        <input
                          type="password"
                          value={confirm}
                          onChange={(e) => setConfirm(e.target.value)}
                          required
                          autoComplete="new-password"
                          className={inputCls}
                          placeholder="••••••••"
                        />
                      </div>
                    )}

                    {mode === 'login' && emailEnabled && (
                      <div className="text-right">
                        <button
                          type="button"
                          onClick={() => switchMode('forgot')}
                          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          Forgot password?
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm transition-colors"
            >
              {loading
                ? 'Please wait…'
                : step === 'twofa'
                  ? 'Verify'
                  : mode === 'login'
                    ? 'Sign in'
                    : mode === 'register'
                      ? 'Create account'
                      : 'Send reset link'}
            </button>

            {(step === 'twofa' || mode === 'forgot') && (
              <button
                type="button"
                onClick={() => switchMode('login')}
                className="w-full text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              >
                ← Back to sign in
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  )
}
