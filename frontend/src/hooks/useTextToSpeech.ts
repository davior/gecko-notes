import { useState, useRef, useEffect, useCallback } from 'react'
import { settingsApi, DEEPGRAM_TTS_SPEED_MIN, DEEPGRAM_TTS_SPEED_MAX } from '@/api/settings'
import { useSettingsStore } from '@/stores/settings'
import { apiErrorMessage } from '@/utils/format'
import { chunkText, chunkTextForPlayback, type SpeechChunk } from '@/utils/speechChunks'

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
  playAndSynthesize: (text: string) => Promise<Blob>
  exportToFile: (text: string, filename?: string) => Promise<void>
}

// How many chunks to keep synthesizing ahead of the one currently playing, so
// playback stays gapless across the smaller fast-start chunks.
const PREFETCH_DEPTH = 2

// Read-aloud volume is a global, device-level preference shared across notes.
// Speed is a global *account* preference instead (Settings → Speech), shared
// with the Deepgram Flux TTS `speed` parameter used by video narration and
// voice mode — see `deepgramTtsSpeed` in the settings store.
const VOLUME_KEY = 'tts_volume'

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

export function useTextToSpeech(options?: { model?: string }): UseTextToSpeechReturn {
  const [status, setStatus] = useState<TTSStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [volume, setVolumeState] = useState(loadStoredVolume)
  const speed = useSettingsStore((s) => s.deepgramTtsSpeed)
  const [isExporting, setIsExporting] = useState(false)

  const modelRef = useRef(options?.model)
  useEffect(() => { modelRef.current = options?.model })

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const queueRef = useRef<SpeechChunk[]>([])
  const indexRef = useRef(0)
  const objectUrlRef = useRef<string | null>(null)
  const pauseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pausedDuringGapRef = useRef(false)
  // In-flight/settled synthesis promises keyed by chunk index, so playback and
  // (for Insert Mode) the background assembly loop share one request per chunk.
  const pipelineRef = useRef<Map<number, Promise<Blob>>>(new Map())
  const cancelledRef = useRef(false)
  const volumeRef = useRef(volume)

  const setVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v))
    volumeRef.current = clamped
    if (audioRef.current) audioRef.current.volume = clamped
    setVolumeState(clamped)
    try { localStorage.setItem(VOLUME_KEY, String(clamped)) } catch { /* ignore */ }
  }, [])

  const setSpeed = useCallback((s: number) => {
    const clamped = Math.min(DEEPGRAM_TTS_SPEED_MAX, Math.max(DEEPGRAM_TTS_SPEED_MIN, s))
    void useSettingsStore.getState().updateSpeechConfig({ deepgram_tts_speed: clamped }).catch(() => { /* toolbar stays at last-known value */ })
  }, [])

  const revokeUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [])

  const clearPauseTimeout = () => {
    if (pauseTimeoutRef.current !== null) {
      clearTimeout(pauseTimeoutRef.current)
      pauseTimeoutRef.current = null
    }
  }

  const stop = useCallback(() => {
    cancelledRef.current = true
    clearPauseTimeout()
    pausedDuringGapRef.current = false
    queueRef.current = []
    indexRef.current = 0
    pipelineRef.current.clear()
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
      clearPauseTimeout()
      audioRef.current?.pause()
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])

  // Synthesize chunk i, memoized in the pipeline so repeated requests (playback
  // + background assembly) reuse a single fal call.
  const fetchChunk = useCallback((i: number): Promise<Blob> | null => {
    const chunk = queueRef.current[i]
    if (chunk === undefined) return null
    const existing = pipelineRef.current.get(i)
    if (existing) return existing
    const p = settingsApi.synthesizeSpeech(chunk.text, modelRef.current)
    // Pre-attach a no-op catch so an early rejection can't raise an unhandled
    // rejection before the awaiting site handles it.
    p.catch(() => { /* surfaced where awaited */ })
    pipelineRef.current.set(i, p)
    return p
  }, [])

  // Keep up to PREFETCH_DEPTH chunks synthesizing ahead of `fromIndex`.
  const ensurePipeline = useCallback((fromIndex: number) => {
    for (let j = fromIndex; j < fromIndex + PREFETCH_DEPTH; j++) fetchChunk(j)
  }, [fetchChunk])

  const playIndex = useCallback(async (i: number) => {
    if (cancelledRef.current) return
    const blobPromise = fetchChunk(i)
    if (!blobPromise) { setStatus('idle'); return }

    // Keep the pipeline topped up so the next chunks are ready before this ends.
    ensurePipeline(i + 1)

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
      // Free the just-played chunk; the assembly loop (if any) already captured it.
      pipelineRef.current.delete(i)
      indexRef.current = i + 1
      if (indexRef.current >= queueRef.current.length) {
        revokeUrl()
        setStatus('idle')
        return
      }
      // Hold real silence between chunks for the pause this chunk's sentence-
      // ending punctuation, paragraph break, or [pause:...] marker asked for
      // (see parsePauseMarkup) — nothing else produces that gap for Deepgram,
      // which has no SSML/break-tag support of its own.
      const pauseMs = queueRef.current[i]?.pauseAfterMs ?? 0
      if (pauseMs <= 0) {
        void playIndex(indexRef.current)
        return
      }
      pauseTimeoutRef.current = setTimeout(() => {
        pauseTimeoutRef.current = null
        if (!cancelledRef.current) void playIndex(indexRef.current)
      }, pauseMs)
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
  }, [fetchChunk, ensurePipeline, revokeUrl])

  // Reset state and begin streaming playback of an already-chunked queue.
  const startPlayback = useCallback((chunks: SpeechChunk[]) => {
    cancelledRef.current = false
    clearPauseTimeout()
    pausedDuringGapRef.current = false
    if (audioRef.current) audioRef.current.pause()
    revokeUrl()
    pipelineRef.current.clear()
    queueRef.current = chunks
    indexRef.current = 0
    setErrorMessage('')
    setStatus('loading')
    void playIndex(0)
  }, [playIndex, revokeUrl])

  const play = useCallback((text: string) => {
    const chunks = chunkTextForPlayback(text)
    if (chunks.length === 0) return
    startPlayback(chunks)
  }, [startPlayback])

  // Play an already-synthesized audio blob through the same element/state machine
  // as chunked playback, so pause/resume/stop and the volume control keep working.
  const playBlob = useCallback((blob: Blob) => {
    cancelledRef.current = false
    if (audioRef.current) audioRef.current.pause()
    revokeUrl()
    queueRef.current = []
    indexRef.current = 0
    pipelineRef.current.clear()
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
    if (status !== 'playing') return
    if (pauseTimeoutRef.current !== null) {
      // Paused during the held silence gap between chunks (see playIndex's
      // onended) — nothing is actually playing yet; stop the scheduled
      // advance and resume by starting the next chunk instead of calling
      // play() on an already-ended audio element.
      clearPauseTimeout()
      pausedDuringGapRef.current = true
      setStatus('paused')
      return
    }
    if (audioRef.current) {
      audioRef.current.pause()
      setStatus('paused')
    }
  }, [status])

  const resume = useCallback(() => {
    if (status !== 'paused') return
    if (pausedDuringGapRef.current) {
      pausedDuringGapRef.current = false
      setStatus('playing')
      void playIndex(indexRef.current)
      return
    }
    if (audioRef.current) {
      void audioRef.current.play().then(() => setStatus('playing')).catch(() => {
        setErrorMessage('Playback was blocked by the browser')
        setStatus('error')
      })
    }
  }, [status, playIndex])

  // Synthesize the whole text into a single MP3 blob. Chunks are fetched
  // sequentially (to stay friendly to the provider's rate limits) and the resulting
  // MP3 segments are concatenated — MP3 is frame-based, so simple byte
  // concatenation plays back correctly. Sets 'loading' while running; on success
  // it leaves the status as 'loading' so the caller decides the next transition
  // (download → idle). On failure it sets 'error' and rethrows.
  const synthesizeBlob = useCallback(async (text: string): Promise<Blob> => {
    if (chunkText(text).length === 0) return new Blob([], { type: 'audio/mpeg' })
    setErrorMessage('')
    setStatus('loading')
    try {
      // One backend call rather than a chunk loop here. Concatenating the MP3
      // bytes client-side, as this did, gave exported audio no gaps at all —
      // the pauses live playback holds with a timer simply vanished from the
      // file. The server splits the text the same way and stitches real
      // silence between the pieces with ffmpeg, which nothing in the browser
      // can do without decoding and re-encoding the whole clip.
      return await settingsApi.narrateSpeech(text, modelRef.current)
    } catch (e) {
      setErrorMessage(apiErrorMessage(e, 'Failed to synthesize speech — set a fal.ai key in Settings → AI Services → Providers'))
      setStatus('error')
      throw e
    }
  }, [])

  // Insert Mode: start streaming playback immediately (small first chunk) while
  // assembling the full clip in the background from the *same* per-chunk audio,
  // so fal isn't billed twice. Resolves with the concatenated MP3 for saving;
  // rejects if playback is stopped before synthesis finishes.
  const playAndSynthesize = useCallback(async (text: string): Promise<Blob> => {
    const chunks = chunkTextForPlayback(text)
    if (chunks.length === 0) return new Blob([], { type: 'audio/mpeg' })
    startPlayback(chunks)
    for (let i = 0; i < chunks.length; i++) {
      if (cancelledRef.current) throw new Error('cancelled')
      const p = fetchChunk(i)
      if (!p) break
      await p
    }
    if (cancelledRef.current) throw new Error('cancelled')
    // Every chunk above is in the server's TTS cache by now, so asking it to
    // narrate the same text with the same ramped split re-uses that audio
    // instead of paying for it again. What the round trip buys is the silence
    // between the chunks: the loop above only ever produced the spoken pieces,
    // so the saved clip lost every pause the listener had just heard.
    return settingsApi.narrateSpeech(text, modelRef.current)
  }, [startPlayback, fetchChunk])

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
    playAndSynthesize,
    exportToFile,
  }
}
