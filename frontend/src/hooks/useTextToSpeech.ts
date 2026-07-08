import { useState, useRef, useEffect, useCallback } from 'react'
import { settingsApi } from '@/api/settings'
import { apiErrorMessage } from '@/utils/format'

export type TTSStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export interface UseTextToSpeechReturn {
  status: TTSStatus
  errorMessage: string
  isSpeaking: boolean
  volume: number
  setVolume: (v: number) => void
  speed: number
  setSpeed: (s: number) => void
  isExporting: boolean
  play: (text: string) => void
  playBlob: (blob: Blob) => void
  pause: () => void
  resume: () => void
  stop: () => void
  synthesizeBlob: (text: string) => Promise<Blob>
  exportToFile: (text: string, filename?: string) => Promise<void>
}

// The TTS endpoint caps text per request (~2000 chars). Stay comfortably below
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

// Read-aloud volume and speed are global, device-level preferences shared across notes.
const VOLUME_KEY = 'tts_volume'
const SPEED_KEY = 'tts_speed'

function loadStoredVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY)
    if (raw !== null) {
      const v = parseFloat(raw)
      if (!Number.isNaN(v)) return Math.min(1, Math.max(0, v))
    }
  } catch { /* ignore */ }
  return 1
}

function loadStoredSpeed(): number {
  try {
    const raw = localStorage.getItem(SPEED_KEY)
    if (raw !== null) {
      const v = parseFloat(raw)
      if (!Number.isNaN(v)) return Math.min(2, Math.max(0.25, v))
    }
  } catch { /* ignore */ }
  return 1
}

export function useTextToSpeech(options?: { model?: string }): UseTextToSpeechReturn {
  const [status, setStatus] = useState<TTSStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [volume, setVolumeState] = useState(loadStoredVolume)
  const [speed, setSpeedState] = useState(loadStoredSpeed)
  const [isExporting, setIsExporting] = useState(false)

  const modelRef = useRef(options?.model)
  useEffect(() => { modelRef.current = options?.model })

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const queueRef = useRef<string[]>([])
  const indexRef = useRef(0)
  const objectUrlRef = useRef<string | null>(null)
  const prefetchRef = useRef<Promise<Blob> | null>(null)
  const cancelledRef = useRef(false)
  const volumeRef = useRef(volume)
  const speedRef = useRef(speed)

  const setVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v))
    volumeRef.current = clamped
    if (audioRef.current) audioRef.current.volume = clamped
    setVolumeState(clamped)
    try { localStorage.setItem(VOLUME_KEY, String(clamped)) } catch { /* ignore */ }
  }, [])

  const setSpeed = useCallback((s: number) => {
    const clamped = Math.min(2, Math.max(0.25, s))
    speedRef.current = clamped
    setSpeedState(clamped)
    try { localStorage.setItem(SPEED_KEY, String(clamped)) } catch { /* ignore */ }
  }, [])

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

  // Stop and clean up on unmount. Reset the cancelled flag on (re)mount so a
  // StrictMode unmount/remount in dev can't leave playback permanently cancelled.
  useEffect(() => {
    cancelledRef.current = false
    return () => {
      cancelledRef.current = true
      audioRef.current?.pause()
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])

  const fetchChunk = useCallback((i: number): Promise<Blob> | null => {
    const chunk = queueRef.current[i]
    if (chunk === undefined) return null
    return settingsApi.synthesizeSpeech(chunk, modelRef.current, speedRef.current)
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
    } catch (err) {
      if (cancelledRef.current) return
      setErrorMessage(apiErrorMessage(err, 'Failed to synthesize speech — set a fal.ai key in Settings → AI Services → Providers'))
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
    audio.volume = volumeRef.current
    // Drive the 'playing' status from the element's own event rather than the
    // play() promise — on a freshly created element the promise can resolve in
    // a way that races the status update, leaving the first play stuck showing
    // "play" with Stop disabled even though audio is playing.
    audio.onplaying = () => { if (!cancelledRef.current) setStatus('playing') }
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
    audio.src = url

    try {
      await audio.play()
    } catch {
      if (cancelledRef.current) return
      // Some browsers reject play() spuriously even though playback started;
      // only surface an error if audio is not actually playing.
      if (!audio.paused) return
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

  // Play an already-synthesized audio blob through the same element/state machine
  // as chunked playback, so pause/resume/stop and the volume control keep working.
  // Used by "Insert Mode" so the inserted clip plays without re-synthesizing.
  const playBlob = useCallback((blob: Blob) => {
    cancelledRef.current = false
    if (audioRef.current) audioRef.current.pause()
    revokeUrl()
    queueRef.current = []
    indexRef.current = 0
    prefetchRef.current = null
    setErrorMessage('')
    setStatus('loading')

    const url = URL.createObjectURL(blob)
    objectUrlRef.current = url

    const audio = audioRef.current ?? new Audio()
    audioRef.current = audio
    audio.volume = volumeRef.current
    audio.onplaying = () => { if (!cancelledRef.current) setStatus('playing') }
    audio.onended = () => {
      if (cancelledRef.current) return
      revokeUrl()
      setStatus('idle')
    }
    audio.src = url

    audio.play().catch(() => {
      if (cancelledRef.current) return
      if (!audio.paused) return
      setErrorMessage('Playback was blocked by the browser')
      setStatus('error')
    })
  }, [revokeUrl])

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

  // Synthesize the whole text into a single MP3 blob. Chunks are fetched
  // sequentially (to stay friendly to the provider's rate limits) and the resulting
  // MP3 segments are concatenated — MP3 is frame-based, so simple byte
  // concatenation plays back correctly. Sets 'loading' while running; on success
  // it leaves the status as 'loading' so the caller decides the next transition
  // (download → idle, or playBlob → playing). On failure it sets 'error' and rethrows.
  const synthesizeBlob = useCallback(async (text: string): Promise<Blob> => {
    const chunks = chunkText(text)
    if (chunks.length === 0) return new Blob([], { type: 'audio/mpeg' })
    setErrorMessage('')
    setStatus('loading')
    try {
      const blobs: Blob[] = []
      for (const chunk of chunks) {
        blobs.push(await settingsApi.synthesizeSpeech(chunk, modelRef.current, speedRef.current))
      }
      return new Blob(blobs, { type: 'audio/mpeg' })
    } catch (e) {
      setErrorMessage(apiErrorMessage(e, 'Failed to synthesize speech — set a fal.ai key in Settings → AI Services → Providers'))
      setStatus('error')
      throw e
    }
  }, [])

  // Synthesize the whole text and download it as a single MP3 file.
  const exportToFile = useCallback(async (text: string, filename = 'note.mp3') => {
    if (chunkText(text).length === 0) return
    setIsExporting(true)
    try {
      const combined = await synthesizeBlob(text)
      const url = URL.createObjectURL(combined)
      const a = document.createElement('a')
      a.href = url
      a.download = filename.toLowerCase().endsWith('.mp3') ? filename : `${filename}.mp3`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      // Export doesn't play; clear the 'loading' state synthesizeBlob set.
      setStatus('idle')
    } catch {
      // synthesizeBlob already set the error status/message.
    } finally {
      setIsExporting(false)
    }
  }, [synthesizeBlob])

  return {
    status,
    errorMessage,
    isSpeaking: status === 'loading' || status === 'playing' || status === 'paused',
    volume,
    setVolume,
    speed,
    setSpeed,
    isExporting,
    play,
    playBlob,
    pause,
    resume,
    stop,
    synthesizeBlob,
    exportToFile,
  }
}
