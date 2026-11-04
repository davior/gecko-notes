import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AiBackendInfo } from '@/api/settings'
import { SuiteNoticeView } from '@/components/settings/SuiteNotice'

// Rendered on the server (no DOM) with the mode given, which is what the connected
// component passes once it has read it.
const SUITE: AiBackendInfo = { backend: 'suite', suite_url: 'https://suite.example.com' }
const render = (section: string, info: AiBackendInfo | null) =>
  renderToStaticMarkup(<SuiteNoticeView section={section} info={info} />)

describe('SuiteNoticeView', () => {
  it('shows nothing before the mode is known, or in local mode', () => {
    expect(render('providers', null)).toBe('')
    expect(render('providers', { backend: 'local', suite_url: null })).toBe('')
  })

  it('in suite mode says the suite holds the keys, and opens its pages in a new tab', () => {
    const html = render('providers', SUITE)
    expect(html).toContain('holds the API keys')
    expect(html).toContain('href="https://suite.example.com/providers"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('links the speech tab to routing and providers', () => {
    const html = render('speech', { backend: 'suite', suite_url: 'https://suite.example.com/' })
    expect(html).toContain('href="https://suite.example.com/routing"')
    expect(html).toContain('href="https://suite.example.com/providers"')
  })

  it('shows nothing on a tab the suite does not change, or with no address to link to', () => {
    expect(render('model-catalog', SUITE)).toBe('')
    expect(render('providers', { backend: 'suite', suite_url: null })).toBe('')
  })
})
