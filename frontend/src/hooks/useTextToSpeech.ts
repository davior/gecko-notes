import { useState, useRef, useEffect, useCallback } from 'react'
import { settingsApi } from '@/api/settings'

export type TTSStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export interface UseTextToSpeechReturn {
  status: TTSStatus
  errorMessage: string
  isSpeaking: boolean
  play: (text: string) => void
  pause: () => void
  resume: () => void
  stop: () => void
}

// Deepgram /v1/speak caps text per request (~2000 chars). Stay comfortably below
// and split on sentence/line boundaries so each chunk sounds natural.
const MAX_CHUNK_CHARS = 1500

export function chunkText(text: string): string[] {
  // Collapse runs of spaces/tabs but preserve newlines so list items, table
  // rows and other line-delimited content remain separate segments (and the
  // TTS engine pauses between them) rather than being read as one line.
  const clean = text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
  if (!clean) return []
  if (clean.length <= MAX_CHUNK_CHARS) return [clean]

  // Split into sentences / lines, then greedily pack into chunks.
  const sentences = clean.match(/[^.!?\n]+[.!?\n]*\s*/g) ?? [clean]
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (sentence.length > MAX_CHUNK_CHARS) {
      // A single very long sentence: hard-split on word boundaries.
      if (current) { chunks.push(current.trim()); current = '' }
      let rest = sentence
      while (rest.length > MAX_CHUNK_CHARS) {
        let cut = rest.lastIndexOf(' ', MAX_CHUNK_CHARS)
        if (cut <= 0) cut = MAX_CHUNK_CHARS
        chunks.push(rest.slice(0, cut).trim())
        rest = rest.slice(cut)
      }
      current = rest
    } else if ((current + sentence).length > MAX_CHUNK_CHARS) {
      chunks.push(current.trim())
      current = sentence
    } else {
      current += sentence
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.filter(Boolean)
}

export function useTextToSpeech(options?: { model?: string }): UseTextToSpeechReturn {
  const [status, setStatus] = useState<TTSStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  const modelRef = useRef(options?.model)
  useEffect(() => { modelRef.current = options?.model })

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const queueRef = useRef<string[]>([])
  const indexRef = useRef(0)
  const objectUrlRef = useRef<string | null>(null)
  const prefetchRef = useRef<Promise<Blob> | null>(null)
  const cancelledRef = useRef(false)

  const revokeUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    cancelledRef.current = true
    queueRef.current = []
    indexRef.current = 0
    prefetchRef.current = null
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
    }
    revokeUrl()
    setStatus('idle')
  }, [revokeUrl])

  // Stop and clean up on unmount.
  useEffect(() => {
    return () => {
      cancelledRef.current = true
      audioRef.current?.pause()
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])

  const fetchChunk = useCallback((i: number): Promise<Blob> | null => {
    const chunk = queueRef.current[i]
    if (chunk === undefined) return null
    return settingsApi.synthesizeSpeech(chunk, modelRef.current)
  }, [])

  const playIndex = useCallback(async (i: number) => {
    if (cancelledRef.current) return
    const blobPromise = i === indexRef.current && prefetchRef.current
      ? prefetchRef.current
      : fetchChunk(i)
    if (!blobPromise) { setStatus('idle'); return }

    let blob: Blob
    try {
      blob = await blobPromise
    } catch {
      if (cancelledRef.current) return
      setErrorMessage('Failed to synthesize speech — check your Deepgram key in Settings → Speech')
      setStatus('error')
      return
    }
    if (cancelledRef.current) return

    // Kick off prefetch of the next chunk while this one plays.
    prefetchRef.current = null
    const next = fetchChunk(i + 1)
    if (next) {
      prefetchRef.current = next
      next.catch(() => { /* surfaced when we await it */ })
    }

    revokeUrl()
    const url = URL.createObjectURL(blob)
    objectUrlRef.current = url

    const audio = audioRef.current ?? new Audio()
    audioRef.current = audio
    audio.src = url
    audio.onended = () => {
      if (cancelledRef.current) return
      indexRef.current = i + 1
      if (indexRef.current < queueRef.current.length) {
        void playIndex(indexRef.current)
      } else {
        revokeUrl()
        setStatus('idle')
      }
    }

    try {
      await audio.play()
      if (!cancelledRef.current) setStatus('playing')
    } catch {
      if (cancelledRef.current) return
      setErrorMessage('Playback was blocked by the browser')
      setStatus('error')
    }
  }, [fetchChunk, revokeUrl])

  const play = useCallback((text: string) => {
    // Stop anything currently playing first.
    cancelledRef.current = false
    if (audioRef.current) audioRef.current.pause()
    revokeUrl()

    const chunks = chunkText(text)
    if (chunks.length === 0) return

    queueRef.current = chunks
    indexRef.current = 0
    prefetchRef.current = null
    setErrorMessage('')
    setStatus('loading')
    void playIndex(0)
  }, [playIndex, revokeUrl])

  const pause = useCallback(() => {
    if (audioRef.current && status === 'playing') {
      audioRef.current.pause()
      setStatus('paused')
    }
  }, [status])

  const resume = useCallback(() => {
    if (audioRef.current && status === 'paused') {
      void audioRef.current.play().then(() => setStatus('playing')).catch(() => {
        setErrorMessage('Playback was blocked by the browser')
        setStatus('error')
      })
    }
  }, [status])

  return {
    status,
    errorMessage,
    isSpeaking: status === 'loading' || status === 'playing' || status === 'paused',
    play,
    pause,
    resume,
    stop,
  }
}
