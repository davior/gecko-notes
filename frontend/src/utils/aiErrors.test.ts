/**
 * The chat's error headline.
 *
 * These exist because the blocking and streaming proxy paths put the upstream body
 * under different keys, and only one of them was being unwrapped — so a provider
 * saying "Server Overloaded" reached the user as a wall of raw JSON. The two shapes
 * are easy to drift apart again, so both are pinned here.
 */

import { describe, expect, it } from 'vitest'

import { errorMessage } from './aiErrors'

/** What the blocking proxies produce: HTTPException(detail=<upstream body>). */
function blockingError(body: unknown, status = 502) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { detail: body } },
  })
}

/** What api/stream.ts throws: the SSE error frame, whose `message` is the body. */
function streamingError(body: string, status = 502) {
  return Object.assign(new Error(body), {
    response: { status, data: { code: 'upstream_error', message: body } },
  })
}

const OVERLOADED = JSON.stringify({
  error: {
    message: 'Server Overloaded',
    type: 'service_unavailable_error',
    param: null,
    code: 'service_unavailable_error',
  },
})

describe('the provider envelope is unwrapped on both paths', () => {
  it('reads the message out of a blocking failure', () => {
    expect(errorMessage(blockingError(OVERLOADED))).toContain('Server Overloaded')
  })

  it('reads the message out of a streaming failure', () => {
    // The regression: streaming is the normal chat path, and its body arrives under
    // `message`, not `detail`.
    expect(errorMessage(streamingError(OVERLOADED))).toContain('Server Overloaded')
  })

  it('never shows the raw envelope', () => {
    for (const e of [blockingError(OVERLOADED), streamingError(OVERLOADED)]) {
      const shown = errorMessage(e)
      expect(shown).not.toContain('{')
      expect(shown).not.toContain('service_unavailable_error')
    }
  })

  it('handles a flat detail object, as our own HTTPExceptions raise', () => {
    expect(errorMessage(blockingError({ code: 'no_fal_key', message: 'fal.ai API key is not configured' }, 400)))
      .toBe('fal.ai API key is not configured')
  })

  it('passes through a detail that is plain text rather than JSON', () => {
    expect(errorMessage(blockingError('Upstream said no', 400))).toBe('Upstream said no')
  })
})

describe('a transient upstream condition says so', () => {
  it('adds the retry hint for an overloaded provider', () => {
    // "Server Overloaded" alone does not tell the user it is the provider's, and
    // theirs to retry.
    expect(errorMessage(streamingError(OVERLOADED))).toBe(
      'Server Overloaded — The AI provider is busy right now — try again in a moment.',
    )
  })

  it('adds it for a rate limit too', () => {
    const body = JSON.stringify({ error: { message: 'Rate limited', type: 'rate_limit_error' } })
    expect(errorMessage(streamingError(body, 429))).toContain('try again in a moment')
  })

  it('does not tell the user to retry a configuration problem', () => {
    // Our proxy raises 502 for anything upstream rejected, so the status alone is not
    // evidence of a transient condition — the provider's own code is.
    const body = JSON.stringify({ error: { message: 'Invalid model', type: 'invalid_request_error' } })
    expect(errorMessage(blockingError(body, 502))).toBe('Invalid model')
  })

  it('leaves an ordinary failure alone', () => {
    const body = JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } })
    expect(errorMessage(blockingError(body, 401))).toBe('Invalid API key')
  })
})

describe('degrading gracefully', () => {
  it('falls back to a plain Error message', () => {
    expect(errorMessage(new Error('Network Error'))).toBe('Network Error')
  })

  it('uses the caller fallback when there is nothing to show', () => {
    expect(errorMessage({}, 'Failed to start the plan')).toBe('Failed to start the plan')
  })

  it('does not throw on a malformed response', () => {
    expect(() => errorMessage({ response: { data: null } })).not.toThrow()
  })
})
