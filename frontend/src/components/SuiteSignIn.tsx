import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { authApi } from '@/api/auth'
import { useAuthStore } from '@/stores/auth'
import { markHandOff, recentlyHandedOff, returnUrl, safeNext, suiteLoginUrl } from '@/utils/suiteSignIn'

/**
 * The login page when Gecko Suite signs people in (IDENTITY_PROVIDER=suite, M6).
 *
 * First it tries the shared cookie: someone who has just signed in at the suite comes
 * back here holding it, and `/auth/session` trades it for the token this frontend keeps.
 * Only when there is no session does it send the browser to the suite's sign-in, asking
 * to come back here.
 *
 * That round trip can loop: if the suite's cookie never reaches Notes (the two
 * AUTH_COOKIE_DOMAIN values differ), the suite sees a signed-in visitor and sends them
 * straight back, and Notes sends them straight off again. So a second hand-off within a
 * minute stops on a page that says what is wrong instead.
 */

export default function SuiteSignIn({
  suiteUrl,
  redirectTarget,
}: {
  suiteUrl: string
  redirectTarget: string | null
}) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const adoptSession = useAuthStore((s) => s.adoptSession)
  const [stuck, setStuck] = useState(false)
  const next = params.get('next')

  function handOff() {
    markHandOff(true)
    window.location.assign(suiteLoginUrl(suiteUrl, returnUrl(redirectTarget, next)))
  }

  useEffect(() => {
    let live = true
    authApi
      .session()
      .then(async (result) => {
        if (!live) return
        markHandOff(false)
        await adoptSession(result)
        if (redirectTarget) window.location.assign(redirectTarget)
        else navigate(safeNext(next) ?? '/notes', { replace: true })
      })
      .catch(() => {
        if (!live) return
        if (recentlyHandedOff()) setStuck(true)
        else handOff()
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="card p-6 max-w-md w-full space-y-4 text-center">
        {stuck ? (
          <>
            <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto" />
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Signed in at Gecko Suite, but not here
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Gecko Suite signed you in, but its session did not reach Notes. This is a
              configuration problem, not something you did: Notes and the suite need the same
              AUTH_COOKIE_DOMAIN and JWT_SECRET_KEY.
            </p>
            <button type="button" className="btn-primary w-full" onClick={handOff}>
              Try again
            </button>
          </>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Signing in with Gecko Suite…
          </p>
        )}
      </div>
    </div>
  )
}
