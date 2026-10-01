/**
 * The model-parameters editor's rules. The server re-checks everything on save; what
 * matters here is that the editor tells the person what is wrong before they hit Save,
 * and that "blank" means clear rather than an error.
 */

import { describe, expect, it } from 'vitest'

import {
  PARAM_EXAMPLES,
  falModelDocsUrl,
  formatModelParams,
  mergeExample,
  overridesSize,
  parseModelParamsText,
} from './imageParams'

const RESERVED = ['num_images', 'prompt', 'sync_mode']

describe('parseModelParamsText', () => {
  it('treats blank text as "clear" rather than an error', () => {
    expect(parseModelParamsText('', RESERVED)).toEqual({ ok: true, value: null })
    expect(parseModelParamsText('  \n ', RESERVED)).toEqual({ ok: true, value: null })
  })

  it('treats an empty object as "clear" too, matching the server', () => {
    expect(parseModelParamsText('{}', RESERVED)).toEqual({ ok: true, value: null })
  })

  it('returns the parsed object', () => {
    const text = '{"image_size": {"width": 1600, "height": 900}, "seed": 7}'
    expect(parseModelParamsText(text, RESERVED)).toEqual({
      ok: true,
      value: { image_size: { width: 1600, height: 900 }, seed: 7 },
    })
  })

  it('rejects invalid JSON with the parser message', () => {
    const r = parseModelParamsText('{"seed": }', RESERVED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/^Not valid JSON: /)
  })

  it.each(['[1, 2]', '"text"', '42', 'null', 'true'])('rejects %s because it is not an object', (text) => {
    const r = parseModelParamsText(text, RESERVED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/JSON object/)
  })

  it('names every reserved key it finds', () => {
    const r = parseModelParamsText('{"prompt": "x", "seed": 1, "num_images": 4}', RESERVED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('prompt, num_images')
  })

  it('only reserves what the server says is reserved', () => {
    expect(parseModelParamsText('{"prompt": "x"}', []).ok).toBe(true)
  })
})

describe('formatModelParams', () => {
  it('pretty-prints, and gives an empty box for no params', () => {
    expect(formatModelParams({ seed: 1 })).toBe('{\n  "seed": 1\n}')
    expect(formatModelParams({})).toBe('')
    expect(formatModelParams(null)).toBe('')
    expect(formatModelParams(undefined)).toBe('')
  })
})

describe('overridesSize', () => {
  it('is true when either size key is present', () => {
    expect(overridesSize({ image_size: { width: 1, height: 1 } })).toBe(true)
    expect(overridesSize({ aspect_ratio: '16:9' })).toBe(true)
  })

  it('is false for other params, since those go out alongside the dropdown size', () => {
    expect(overridesSize({ resolution: '2K', seed: 1 })).toBe(false)
    expect(overridesSize({})).toBe(false)
    expect(overridesSize(null)).toBe(false)
    expect(overridesSize(undefined)).toBe(false)
  })
})

describe('mergeExample', () => {
  it('starts a draft from an example', () => {
    expect(JSON.parse(mergeExample('', { aspect_ratio: '16:9' }))).toEqual({ aspect_ratio: '16:9' })
  })

  it('stacks examples, keeping keys the example does not set', () => {
    const first = mergeExample('', { resolution: '2K' })
    const second = mergeExample(first, { output_format: 'png' })
    expect(JSON.parse(second)).toEqual({ resolution: '2K', output_format: 'png' })
  })

  it('lets the example win on a clash', () => {
    expect(JSON.parse(mergeExample('{"aspect_ratio": "1:1", "seed": 3}', { aspect_ratio: '16:9' })))
      .toEqual({ aspect_ratio: '16:9', seed: 3 })
  })

  it('replaces a draft that is not valid JSON or not an object', () => {
    expect(JSON.parse(mergeExample('{"seed": ', { resolution: '2K' }))).toEqual({ resolution: '2K' })
    expect(JSON.parse(mergeExample('[1]', { resolution: '2K' }))).toEqual({ resolution: '2K' })
  })
})

describe('PARAM_EXAMPLES', () => {
  it('never offers a key the server would refuse', () => {
    for (const ex of PARAM_EXAMPLES) {
      const text = JSON.stringify(ex.params)
      expect(parseModelParamsText(text, RESERVED).ok, ex.label).toBe(true)
    }
  })
})

describe('falModelDocsUrl', () => {
  it('links to the endpoint API page, keeping the slashes in the id', () => {
    expect(falModelDocsUrl('fal-ai/flux-2-pro')).toBe('https://fal.ai/models/fal-ai/flux-2-pro/api')
    expect(falModelDocsUrl('fal-ai/bytedance/seedream/v4.5/text-to-image'))
      .toBe('https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/text-to-image/api')
  })

  it('escapes anything unsafe in a custom id', () => {
    expect(falModelDocsUrl('fal-ai/x y?z')).toBe('https://fal.ai/models/fal-ai/x%20y%3Fz/api')
  })
})
