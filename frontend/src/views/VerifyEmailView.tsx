import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { authApi } from '@/api/auth'

type State = 'loading' | 'success' | 'error'

export default function VerifyEmailView() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [state, setState] = useState<State>('loading')
  const [message, setMessage] = useState('')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return  // guard against double-invoke in StrictMode
    ran.current = true
    if (!token) {
      setState('error')
      setMessage('This verification link is missing its token.')
      return
    }
    authApi.verifyEmail(token)
      .then((res) => { setState('success'); setMessage(res.message) })
      .catch((err) => {
        setState('error')
        const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        setMessage(typeof detail === 'string' ? detail : 'This verification link is invalid or has expired.')
      })
  }, [token])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="w-full max-w-sm text-center">
        <div className="mb-8">
          <span className="text-4xl">🦎</span>
          <h1 className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">Gecko Notes</h1>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 p-8">
          {state === 'loading' && (
            <div className="flex flex-col items-center gap-3 text-gray-500 dark:text-gray-400">
              <Loader2 className="w-8 h-8 animate-spin" />
              <p className="text-sm">Verifying your email…</p>
            </div>
          )}

          {state === 'success' && (
            <div className="flex flex-col items-center gap-3">
              <CheckCircle2 className="w-10 h-10 text-green-500" />
              <p className="text-sm text-gray-700 dark:text-gray-300">{message}</p>
              <Link to="/login" className="mt-2 w-full py-2 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm transition-colors">
                Continue to sign in
              </Link>
            </div>
          )}

          {state === 'error' && (
            <div className="flex flex-col items-center gap-3">
              <XCircle className="w-10 h-10 text-red-500" />
              <p className="text-sm text-gray-700 dark:text-gray-300">{message}</p>
              <Link to="/login" className="mt-2 text-sm text-blue-600 dark:text-blue-400 hover:underline">
                Back to sign in
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
