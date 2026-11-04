import { describe, expect, it } from 'vitest'
import { suiteNoticeFor, suitePageUrl } from '@/utils/suiteNotice'

describe('suitePageUrl', () => {
  it('joins the suite address and a page without doubling the slash', () => {
    expect(suitePageUrl('https://suite.example.com', 'usage')).toBe('https://suite.example.com/usage')
    expect(suitePageUrl('https://suite.example.com///', 'routing')).toBe('https://suite.example.com/routing')
  })
})

describe('suiteNoticeFor', () => {
  it.each(['providers', 'assistant', 'speech', 'images', 'usage'])('has a notice for %s that links somewhere', (tab) => {
    const notice = suiteNoticeFor(tab)
    expect(notice).not.toBeNull()
    expect(notice!.text.length).toBeGreaterThan(40)
    expect(notice!.links.length).toBeGreaterThan(0)
  })

  it('has none for the model catalogue, which the suite does not replace', () => {
    expect(suiteNoticeFor('model-catalog')).toBeNull()
    expect(suiteNoticeFor('nonsense')).toBeNull()
  })

  it('says what still lives in Notes where that is true, so nobody hunts for a setting that moved', () => {
    expect(suiteNoticeFor('speech')!.text).toMatch(/Live transcription and voice mode still use the Deepgram key/)
    expect(suiteNoticeFor('assistant')!.text).toMatch(/Prompts.*still managed here/)
    expect(suiteNoticeFor('images')!.text).toMatch(/model\s+list and sizes below still apply/)
  })

  it('points the speech tab at routing, where the voice is decided', () => {
    expect(suiteNoticeFor('speech')!.links.map((l) => l.page)).toContain('routing')
  })
})
