// The pure half of handing sign-in to Gecko Suite (M6): where to send the browser and
// back, and the guard against a loop between the two. Kept apart from the component so it
// can be tested without the stores (which read localStorage on import).

const HANDED_OFF = 'notes_suite_handoff_at'
const LOOP_WINDOW_MS = 60_000

/** Whether a hand-off at `at` (ms) is recent enough that coming back unsigned means a loop. */
export function isLoop(at: number, now: number = Date.now()): boolean {
  return at > 0 && now - at < LOOP_WINDOW_MS
}

export function recentlyHandedOff(): boolean {
  try {
    return isLoop(Number(sessionStorage.getItem(HANDED_OFF) || 0))
  } catch {
    return false
  }
}

export function markHandOff(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(HANDED_OFF, String(Date.now()))
    else sessionStorage.removeItem(HANDED_OFF)
  } catch {
    /* private mode: no loop guard, which is the old behaviour */
  }
}

/** A same-site path to go on to, or null: never `//host` or an absolute URL. */
export function safeNext(next: string | null): string | null {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : null
}

/** Where the suite should send the browser after signing in. */
export function returnUrl(
  redirectTarget: string | null,
  next: string | null,
  origin: string = window.location.origin
): string {
  // Another app (GAM, GVC) that sent someone here can be sent to directly: the suite
  // checks it against its own allow-list. Notes' own pages come back through /login,
  // which is what picks the cookie up.
  if (redirectTarget) return redirectTarget
  const here = new URL('/login', origin)
  const path = safeNext(next)
  if (path) here.searchParams.set('next', path)
  return here.toString()
}

export function suiteLoginUrl(suite: string, back: string): string {
  return `${suite}/login?redirect=${encodeURIComponent(back)}`
}
