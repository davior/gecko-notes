import { useState, useRef, useEffect, useCallback } from 'react'
import { settingsApi, DEEPGRAM_TTS_SPEED_MIN, DEEPGRAM_TTS_SPEED_MAX } from '@/api/settings'
import { useSettingsStore } from '@/stores/settings'
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
  playAndSynthesize: (text: string) => Promise<Blob>
  exportToFile: (text: string, filename?: string) => Promise<void>
}

// The TTS endpoint caps text per request (~2000 chars). Stay comfortably below
// and split on sentence/line boundaries so each chunk sounds natural.
const MAX_CHUNK_CHARS = 1500

// Progressive per-chunk size targets for playback. The first chunk is kept
// small (~1-2 sentences) so fal renders it in ~1s and audio starts almost
// immediately; later chunks ramp up to full size to keep request overhead low
// and prosody natural. Sizes hold at MAX_CHUNK_CHARS after the ramp.
const PLAYBACK_CHUNK_TARGETS = [220, 500, 1000, MAX_CHUNK_CHARS]

// How many chunks to keep synthesizing ahead of the one currently playing, so
// playback stays gapless across the smaller fast-start chunks.
const PREFETCH_DEPTH = 2

// Matches emoji (pictographs, flag sequences, skin-tone modifiers) plus the
// zero-width joiner / variation-selector / keycap marks used to build them,
// so they can be dropped before synthesis — otherwise the TTS engine reads
// them out by description (e.g. "🚗" becomes the spoken word "car").
const EMOJI_REGEX = new RegExp(
  '[\\u{1F1E6}-\\u{1F1FF}]{2}' + // flag sequences (pairs of regional indicators)
  '|[\\p{Extended_Pictographic}\\u{1F3FB}-\\u{1F3FF}]' + // pictographs + skin-tone modifiers
  '|[\\u200D\\uFE0F\\u20E3]', // ZWJ, variation selector, keycap combiner
  'gu',
)

function stripEmoji(text: string): string {
  return text.replace(EMOJI_REGEX, '')
}

// Greedily pack sentences/lines into chunks, where the size budget for the Nth
// chunk is `limitFor(N)`. Collapses runs of spaces/tabs but preserves newlines
// so list items, table rows and other line-delimited content stay separate
// segments (and the TTS engine pauses between them) rather than being read as
// one line.
function packChunks(text: string, limitFor: (index: number) => number): string[] {
  const clean = stripEmoji(text).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
  if (!clean) return []

  // Split into sentences / lines, then greedily pack into chunks.
  const sentences = clean.match(/[^.!?\n]+[.!?\n]*\s*/g) ?? [clean]
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    const limit = limitFor(chunks.length)
    if (sentence.length > limit) {
      // A single sentence bigger than the current budget: flush what we have.
      // Only hard-split (on word boundaries) if it also exceeds the hard cap;
      // otherwise let it stand as its own chunk so we never split mid-sentence.
      if (current) { chunks.push(current.trim()); current = '' }
      let rest = sentence
      while (rest.length > MAX_CHUNK_CHARS) {
        let cut = rest.lastIndexOf(' ', MAX_CHUNK_CHARS)
        if (cut <= 0) cut = MAX_CHUNK_CHARS
        chunks.push(rest.slice(0, cut).trim())
        rest = rest.slice(cut)
      }
      current = rest
    } else if ((current + sentence).length > limit) {
      chunks.push(current.trim())
      current = sentence
    } else {
      current += sentence
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.filter(Boolean)
}

// Uniform chunks — used for whole-file synthesis (audio export), where there's
// no first-audio latency to optimise.
export function chunkText(text: string): string[] {
  const clean = stripEmoji(text).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
  if (clean && clean.length <= MAX_CHUNK_CHARS) return [clean]
  return packChunks(text, () => MAX_CHUNK_CHARS)
}

// Fast-start chunks for playback: a small first chunk, ramping up to full size.
export function chunkTextForPlayback(text: string): string[] {
  return packChunks(text, (i) => PLAYBACK_CHUNK_TARGETS[Math.min(i, PLAYBACK_CHUNK_TARGETS.length - 1)])
}

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
  const queueRef = useRef<string[]>([])
  const indexRef = useRef(0)
  const objectUrlRef = useRef<string | null>(null)
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

  const stop = useCallback(() => {
    cancelledRef.current = true
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
    const p = settingsApi.synthesizeSpeech(chunk, modelRef.current)
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
  }, [fetchChunk, ensurePipeline, revokeUrl])

  // Reset state and begin streaming playback of an already-chunked queue.
  const startPlayback = useCallback((chunks: string[]) => {
    cancelledRef.current = false
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
  // (download → idle). On failure it sets 'error' and rethrows.
  const synthesizeBlob = useCallback(async (text: string): Promise<Blob> => {
    const chunks = chunkText(text)
    if (chunks.length === 0) return new Blob([], { type: 'audio/mpeg' })
    setErrorMessage('')
    setStatus('loading')
    try {
      const blobs: Blob[] = []
      for (const chunk of chunks) {
        blobs.push(await settingsApi.synthesizeSpeech(chunk, modelRef.current))
      }
      return new Blob(blobs, { type: 'audio/mpeg' })
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
    const blobs: Blob[] = []
    for (let i = 0; i < chunks.length; i++) {
      if (cancelledRef.current) throw new Error('cancelled')
      const p = fetchChunk(i)
      if (!p) break
      blobs.push(await p)
    }
    if (cancelledRef.current) throw new Error('cancelled')
    return new Blob(blobs, { type: 'audio/mpeg' })
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
