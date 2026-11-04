import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ManagedInSuite, MovedToSuite } from '@/components/SuiteMoved'
import { isLoop, returnUrl, safeNext, suiteLoginUrl } from '@/utils/suiteSignIn'

const NOTES = 'https://notes.example.test'
const SUITE = 'https://suite.example.test'

describe('the hand-off to Gecko Suite', () => {
  it('comes back through /login, carrying the page that was wanted', () => {
    expect(returnUrl(null, '/notes/42', NOTES)).toBe(`${NOTES}/login?next=%2Fnotes%2F42`)
    expect(returnUrl(null, null, NOTES)).toBe(`${NOTES}/login`)
  })

  it('sends another app’s visitor straight back to that app', () => {
    // GAM and GVC still link to Notes' /login until they are pointed at the suite.
    expect(returnUrl('https://assets.example.test/library', null, NOTES)).toBe('https://assets.example.test/library')
  })

  it('asks the suite for its sign-in with the return address encoded', () => {
    expect(suiteLoginUrl(SUITE, `${NOTES}/login`)).toBe(
      `${SUITE}/login?redirect=${encodeURIComponent(`${NOTES}/login`)}`
    )
  })

  it.each(['//evil.example/x', 'https://evil.example/', 'notes', ''])('never goes on to %j', (next) => {
    expect(safeNext(next)).toBeNull()
  })

  it('treats a quick return without a session as a loop, and an old one as a fresh start', () => {
    // The loop: the suite's cookie never reaches Notes, so each side sends the visitor
    // to the other for ever.
    const now = 1_000_000
    expect(isLoop(now - 5_000, now)).toBe(true)
    expect(isLoop(now - 120_000, now)).toBe(false)
    expect(isLoop(0, now)).toBe(false)
  })
})

describe('where account settings went', () => {
  it('links to the matching suite page', () => {
    const html = renderToStaticMarkup(
      <ManagedInSuite suiteUrl={SUITE} what="your password" path="/account" />
    )
    expect(html).toContain(`href="${SUITE}/account"`)
    expect(html).toContain('Manage your password in Gecko Suite')
  })

  it('explains an old Notes email link instead of failing on it', () => {
    const html = renderToStaticMarkup(
      <MovedToSuite suiteUrl={SUITE} title="Reset your password" path="/forgot-password" action="Ask again" />
    )
    expect(html).toContain('no longer works')
    expect(html).toContain(`href="${SUITE}/forgot-password"`)
  })
})
