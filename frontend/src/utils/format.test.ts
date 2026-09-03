/**
 * Relative ages in the Background tasks dropdown.
 *
 * The boundaries are pinned because they are the whole point of the helper: elapsed
 * time is floored, so nothing rounds up into a minute that hasn't passed, and nothing
 * under a minute is allowed to render as "0m ago".
 */

import { describe, expect, it } from 'vitest'

import { formatTimeAgo } from './format'

const NOW = Date.parse('2026-09-03T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatTimeAgo', () => {
  it('says "just now" for anything under a minute', () => {
    expect(formatTimeAgo(ago(0), NOW)).toBe('just now')
    expect(formatTimeAgo(ago(59 * SECOND), NOW)).toBe('just now')
  })

  it('floors rather than rounds, so 90s is 1m', () => {
    expect(formatTimeAgo(ago(60 * SECOND), NOW)).toBe('1m ago')
    expect(formatTimeAgo(ago(90 * SECOND), NOW)).toBe('1m ago')
    expect(formatTimeAgo(ago(59 * MINUTE), NOW)).toBe('59m ago')
  })

  it('steps up to hours and days at the boundary', () => {
    expect(formatTimeAgo(ago(HOUR), NOW)).toBe('1h ago')
    expect(formatTimeAgo(ago(23 * HOUR), NOW)).toBe('23h ago')
    expect(formatTimeAgo(ago(DAY), NOW)).toBe('1d ago')
    expect(formatTimeAgo(ago(6 * DAY), NOW)).toBe('6d ago')
  })

  it('falls back to a date once an age stops being informative', () => {
    expect(formatTimeAgo(ago(7 * DAY), NOW)).not.toMatch(/ago$/)
    expect(formatTimeAgo(ago(400 * DAY), NOW)).not.toMatch(/ago$/)
  })

  it('treats a timestamp in the future as "just now" rather than negative', () => {
    // The server stamps created_at from its own clock; a browser running a little
    // behind would otherwise render "-1m ago" on a job it just started.
    expect(formatTimeAgo(new Date(NOW + 30 * SECOND).toISOString(), NOW)).toBe('just now')
  })

  it('renders nothing at all for a missing or unparseable timestamp', () => {
    expect(formatTimeAgo(undefined, NOW)).toBe('')
    expect(formatTimeAgo(null, NOW)).toBe('')
    expect(formatTimeAgo('', NOW)).toBe('')
    expect(formatTimeAgo('not a date', NOW)).toBe('')
  })

  it('reads a naive server timestamp as UTC only when it is tagged', () => {
    // ActivityJobRead.created_at is a UTCDatetime, so it always carries an offset.
    // Without one, `new Date` would read it as local time and the age would be wrong
    // by the viewer's offset — this pins that the tagged form is what we handle.
    expect(formatTimeAgo('2026-09-03T11:00:00+00:00', NOW)).toBe('1h ago')
    expect(formatTimeAgo('2026-09-03T11:00:00Z', NOW)).toBe('1h ago')
  })
})
