/**
 * Per-model image parameters — the free-text JSON a user attaches to a fal model and
 * the app merges into the request (exact pixel sizes, resolution tiers, steps, ...).
 *
 * The server is the authority on what it accepts; this module exists so the editor can
 * say what is wrong while the person is typing, and so the "what do I put here?" guide
 * lives next to the rules it describes.
 */

export type ModelParams = Record<string, unknown>

export type ParseResult =
  | { ok: true; value: ModelParams | null }
  | { ok: false; error: string }

/** Keys whose presence replaces the size the app would otherwise send for the dropdown. */
const SIZE_KEYS = ['image_size', 'aspect_ratio'] as const

const isPlainObject = (v: unknown): v is ModelParams =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Parse the textarea. Blank means "no custom parameters" (`value: null`, which the
 * server treats as a clear). Anything else must be a JSON object free of the keys the
 * app builds itself.
 */
export function parseModelParamsText(text: string, reservedKeys: readonly string[]): ParseResult {
  if (!text.trim()) return { ok: true, value: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'Parameters must be a JSON object, e.g. {"seed": 42}' }
  }
  const reserved = Object.keys(parsed).filter((k) => reservedKeys.includes(k))
  if (reserved.length > 0) {
    return { ok: false, error: `These are managed by the app and can't be set: ${reserved.join(', ')}` }
  }
  return { ok: true, value: Object.keys(parsed).length > 0 ? parsed : null }
}

/** Pretty-printed params for the textarea; empty when the model has none. */
export function formatModelParams(params: ModelParams | null | undefined): string {
  return params && Object.keys(params).length > 0 ? JSON.stringify(params, null, 2) : ''
}

/** Whether the params set the image size themselves (so the size dropdown is bypassed). */
export function overridesSize(params: ModelParams | null | undefined): boolean {
  return !!params && SIZE_KEYS.some((k) => k in params)
}

export interface ParamExample {
  label: string
  /** What the chip adds to the draft. */
  params: ModelParams
  /** Shown on hover, to say when the example applies. */
  hint: string
}

/**
 * Starting points for the guide. They're examples, not a promise every model accepts
 * them: each endpoint has its own input schema (linked from the editor), and fal's
 * error comes back in the generate dialog if a key doesn't fit.
 */
export const PARAM_EXAMPLES: readonly ParamExample[] = [
  {
    label: 'Exact pixels',
    params: { image_size: { width: 1600, height: 900 } },
    hint: 'For models that take a width/height object instead of a named size.',
  },
  {
    label: 'Aspect ratio',
    params: { aspect_ratio: '16:9' },
    hint: 'For models that take a ratio such as 16:9, 3:2 or 21:9.',
  },
  {
    label: 'Resolution tier',
    params: { resolution: '2K' },
    hint: 'For models with a 1K / 2K / 4K style output tier. Sent alongside the size dropdown.',
  },
  {
    label: 'Quality',
    params: { num_inference_steps: 28, guidance_scale: 3.5 },
    hint: 'More steps is slower and usually sharper; guidance is how closely to follow the prompt.',
  },
  {
    label: 'PNG output',
    params: { output_format: 'png' },
    hint: 'Most models default to JPEG.',
  },
]

/**
 * Fold an example into the current draft. Draft keys the example doesn't set are kept,
 * so chips can be stacked, and the example wins on a clash. An unparseable or non-object
 * draft is replaced rather than left half-merged.
 */
export function mergeExample(text: string, example: ModelParams): string {
  let current: ModelParams = {}
  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isPlainObject(parsed)) current = parsed
    } catch {
      current = {}
    }
  }
  return JSON.stringify({ ...current, ...example }, null, 2)
}

/** fal's API-schema page for an endpoint: the authoritative list of keys it accepts. */
export function falModelDocsUrl(modelId: string): string {
  return `https://fal.ai/models/${modelId.split('/').map(encodeURIComponent).join('/')}/api`
}
