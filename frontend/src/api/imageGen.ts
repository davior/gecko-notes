import client from './client'
import type { FalPrice } from './settings'

export interface ImageGenerateResult {
  url: string
  model: string
  prompt: string
  width?: number
  height?: number
  cost?: number | null
  currency?: string | null
}

// Approximate megapixels for each fal image_size preset (used to estimate the cost of
// megapixel-billed models before generating). fal's presets are ~1024px on the long edge.
export const IMAGE_SIZE_MEGAPIXELS: Record<string, number> = {
  square_hd: 1.05,
  square: 0.26,
  portrait_4_3: 0.79,
  landscape_4_3: 0.79,
  portrait_16_9: 0.59,
  landscape_16_9: 0.59,
}

// Rough per-image cost estimate from a model's fal unit price + the chosen size. Megapixel
// prices scale by the size's megapixels; per-image / per-unit prices are treated as 1 unit.
export function estimateImageCost(price: FalPrice | undefined, imageSize: string): number | null {
  if (!price || typeof price.unit_price !== 'number') return null
  const unit = (price.unit ?? '').toLowerCase()
  if (unit.includes('megapixel')) {
    return price.unit_price * (IMAGE_SIZE_MEGAPIXELS[imageSize] ?? 1)
  }
  return price.unit_price
}

export function formatCost(amount: number, currency?: string | null): string {
  const c = (currency ?? 'USD').toUpperCase()
  const digits = amount < 0.1 ? 4 : amount < 10 ? 3 : 2
  const value = amount.toFixed(digits)
  return c === 'USD' ? `$${value}` : `${value} ${c}`
}

export interface ImageGenerateParams {
  prompt: string
  model?: string
  image_size?: string
}

export const imageGenApi = {
  // Generate an image with fal.ai and persist it to /media; returns the stored URL.
  generate(payload: ImageGenerateParams): Promise<ImageGenerateResult> {
    return client.post('/images/generate', payload).then((r) => r.data)
  },
}
