import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AssistantSteps, TurnCost } from '@/components/AssistantSteps'

const STEPS = [
  { kind: 'search', text: 'Searching the web: owl diet' },
  { kind: 'read', text: 'Reading “Owl facts”' },
  { kind: 'edit', text: 'Proposed: Rename “Owl facts” to “Owls”' },
]

describe('AssistantSteps', () => {
  it('lists every step while the turn runs', () => {
    const html = renderToStaticMarkup(<AssistantSteps steps={STEPS} live />)
    expect(html).toContain('3 steps')
    expect(html).toContain('Searching the web: owl diet')
    expect(html).toContain('Proposed: Rename “Owl facts” to “Owls”')
  })

  it('is collapsed to a count under a finished reply', () => {
    const html = renderToStaticMarkup(<AssistantSteps steps={STEPS} live={false} />)
    expect(html).toContain('3 steps')
    expect(html).not.toContain('owl diet')
  })

  it('shows nothing for a turn that took no steps', () => {
    expect(renderToStaticMarkup(<AssistantSteps steps={[]} live />)).toBe('')
  })
})

describe('TurnCost', () => {
  it('shows a known cost as an estimate, and nothing for an unknown one', () => {
    expect(renderToStaticMarkup(<TurnCost cost={0.0123} label="So far: " />)).toContain(
      'So far: about $0.0123 (estimate)',
    )
    expect(renderToStaticMarkup(<TurnCost cost={null} />)).toBe('')
    expect(renderToStaticMarkup(<TurnCost cost={undefined} />)).toBe('')
  })
})
