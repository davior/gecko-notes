import client from './client'

export interface ImageGenerateResult {
  url: string
  model: string
  prompt: string
  width?: number
  height?: number
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
