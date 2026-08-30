import { useState, useRef, useCallback, useEffect } from 'react'

export interface MediaDeviceOption {
  deviceId: string
  label: string
}

export type VideoRecorderStatus = 'idle' | 'requesting' | 'previewing' | 'recording' | 'error'

/** What the compositor draws each frame: the camera full-frame, the shared
 *  screen with the camera as an inset bubble, or the shared screen on its own. */
export type VideoRecordingMode = 'camera' | 'presentation' | 'screen'

/** Which live sources feed the recording's single audio track. */
export type AudioSourceId = 'mic' | 'system' | 'both' | 'none'

export interface AudioSourceOption {
  id: AudioSourceId
  label: string
  /** True for the options that need the screen share to have carried an audio track. */
  needsSystemAudio: boolean
}

export const AUDIO_SOURCES: readonly AudioSourceOption[] = [
  { id: 'mic', label: 'Microphone', needsSystemAudio: false },
  { id: 'system', label: 'Computer audio', needsSystemAudio: true },
  { id: 'both', label: 'Mic + computer', needsSystemAudio: true },
  { id: 'none', label: 'No audio', needsSystemAudio: false },
]

// Tried in order; the first one MediaRecorder.isTypeSupported() accepts wins.
// Chrome/Edge prefer vp9, Firefox commonly only supports vp8, Safari (14.1+)
// supports plain video/mp4 recording instead of webm.
const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
]

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  return VIDEO_MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
}

export const hasVideoRecordingSupport =
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

export const hasScreenShareSupport =
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia

function getAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

// Asks for the screen share with audio, because whether the browser can hand us
// system audio at all is only discoverable by trying: Chrome/Edge attach an audio
// track when the user ticks "Share tab audio" (or "Share system audio" on Windows),
// Firefox silently returns none, and Safari can reject the constraint outright.
// Only that last case is worth retrying video-only — a dismissed picker must not
// re-prompt the user.
async function requestDisplayStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) throw err
    return await navigator.mediaDevices.getDisplayMedia({ video: true })
  }
}

export interface VideoQualityPreset {
  id: string
  label: string
  width: number
  height: number
  videoBitsPerSecond: number
}

export interface AudioQualityPreset {
  id: string
  label: string
  audioBitsPerSecond: number
}

// Resolution + encoding bitrate. width/height are passed as `ideal` getUserMedia
// constraints (the browser/camera may not support them exactly) and are also
// used as the fixed output size of the compositor canvas (see below); bitrate
// is passed to MediaRecorder at record-start (best-effort, honored to varying
// degrees across browsers).
export const VIDEO_QUALITY_PRESETS: readonly VideoQualityPreset[] = [
  { id: '480p', label: '480p (SD)', width: 640, height: 480, videoBitsPerSecond: 1_000_000 },
  { id: '720p', label: '720p (HD)', width: 1280, height: 720, videoBitsPerSecond: 2_500_000 },
  { id: '1080p', label: '1080p (Full HD)', width: 1920, height: 1080, videoBitsPerSecond: 5_000_000 },
]

export const AUDIO_QUALITY_PRESETS: readonly AudioQualityPreset[] = [
  { id: 'standard', label: 'Standard', audioBitsPerSecond: 64_000 },
  { id: 'high', label: 'High', audioBitsPerSecond: 128_000 },
]

const DEFAULT_VIDEO_QUALITY = '720p'
const DEFAULT_AUDIO_QUALITY = 'standard'
const DEFAULT_AUDIO_SOURCE: AudioSourceId = 'mic'
const VIDEO_QUALITY_STORAGE_KEY = 'gecko-video-recorder-video-quality'
const AUDIO_QUALITY_STORAGE_KEY = 'gecko-video-recorder-audio-quality'
const AUDIO_SOURCE_STORAGE_KEY = 'gecko-video-recorder-audio-source'

// Remembers the last-picked quality in this browser (i.e. "for the current
// device"), the same pattern EditorView uses for TTS dock/insert-mode prefs.
function loadStoredId(key: string, presets: readonly { id: string }[], fallback: string): string {
  try {
    const stored = localStorage.getItem(key)
    if (stored && presets.some((p) => p.id === stored)) return stored
  } catch { /* ignore */ }
  return fallback
}

// Restores the remembered audio source, except that 'system' is downgraded to
// 'mic': nothing is shared yet when the recorder opens, so restoring it would
// silently record nothing. 'both' is safe to restore as-is — with no system
// audio wired up it just behaves as mic-only until a share with audio arrives.
function loadStoredAudioSource(): AudioSourceId {
  const stored = loadStoredId(AUDIO_SOURCE_STORAGE_KEY, AUDIO_SOURCES, DEFAULT_AUDIO_SOURCE) as AudioSourceId
  return stored === 'system' ? 'mic' : stored
}

function findPreset(id: string): VideoQualityPreset {
  return VIDEO_QUALITY_PRESETS.find((p) => p.id === id) ?? VIDEO_QUALITY_PRESETS[1]
}

// Scales `video` to fill as much of the destination box as possible without
// cropping (letterboxed/pillarboxed as needed) — used for the main frame.
function drawContain(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, dw: number, dh: number) {
  const sw = video.videoWidth
  const sh = video.videoHeight
  if (!sw || !sh) return
  const scale = Math.min(dw / sw, dh / sh)
  const w = sw * scale
  const h = sh * scale
  ctx.drawImage(video, 0, 0, sw, sh, (dw - w) / 2, (dh - h) / 2, w, h)
}

// Crops `video` to exactly fill the given destination box (no letterboxing) —
// used for the small camera-inset bubble in presentation mode.
function drawCover(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, dx: number, dy: number, dw: number, dh: number) {
  const sw = video.videoWidth
  const sh = video.videoHeight
  if (!sw || !sh) return
  const srcAspect = sw / sh
  const dstAspect = dw / dh
  let cropW = sw
  let cropH = sh
  let cropX = 0
  let cropY = 0
  if (srcAspect > dstAspect) {
    cropW = sh * dstAspect
    cropX = (sw - cropW) / 2
  } else {
    cropH = sw / dstAspect
    cropY = (sh - cropH) / 2
  }
  ctx.drawImage(video, cropX, cropY, cropW, cropH, dx, dy, dw, dh)
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const withRoundRect = ctx as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void }
  ctx.beginPath()
  if (typeof withRoundRect.roundRect === 'function') {
    withRoundRect.roundRect(x, y, w, h, r)
    return
  }
  const rr = Math.min(r, w / 2, h / 2)
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

// Fixed layout for the presentation-mode camera bubble: bottom-right corner,
// sized relative to the canvas, same aspect ratio as the canvas itself.
function insetBox(cw: number, ch: number) {
  const w = cw * 0.28
  const h = w * (ch / cw)
  const margin = cw * 0.02
  return { x: cw - w - margin, y: ch - h - margin, w, h, r: cw * 0.015 }
}

export interface UseVideoRecorderReturn {
  status: VideoRecorderStatus
  errorMessage: string
  notice: string
  cameras: MediaDeviceOption[]
  mics: MediaDeviceOption[]
  cameraId: string
  micId: string
  /** Composited stream (canvas video + mixed audio) — bind this to the preview
   *  <video>; it's what gets recorded, in every mode. */
  previewStream: MediaStream | null
  isSupported: boolean
  canShareScreen: boolean
  mode: VideoRecordingMode
  desktopRequesting: boolean
  /** True once a screen share has been acquired that actually carried an audio
   *  track — the computer-audio options are only meaningful then. */
  hasSystemAudio: boolean
  audioSourceId: AudioSourceId
  /** True while a recording that started with no audio source is running: the
   *  file has no audio track, so the choice can't be changed until it stops. */
  audioLockedOff: boolean
  videoQualityId: string
  audioQualityId: string
  open: () => void
  selectCamera: (deviceId: string) => void
  selectMic: (deviceId: string) => void
  setVideoQuality: (id: string) => void
  setAudioQuality: (id: string) => void
  setAudioSource: (id: AudioSourceId) => void
  setMode: (mode: VideoRecordingMode) => void
  startRecording: () => void
  stopRecording: () => void
  close: () => void
}

/** Camera/mic device picker + live preview + MediaRecorder capture, mirroring the
 *  MediaRecorder fallback path in useDictation.ts but for combined video+audio.
 *
 *  Both halves of the recording go through a fixed intermediary rather than the
 *  raw device streams, so that MediaRecorder is bound once to track objects whose
 *  identity never changes: video via an internal <canvas> compositor, audio via a
 *  Web Audio mix graph. Switching mode only changes what the draw loop paints,
 *  and switching audio source only changes two gain values — neither ever needs
 *  the recorder to stop and restart, which is why both can be changed mid-take. */
export function useVideoRecorder(onComplete: (blob: Blob, mimeType: string) => void): UseVideoRecorderReturn {
  const [status, setStatus] = useState<VideoRecorderStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNoticeState] = useState('')
  const [cameras, setCameras] = useState<MediaDeviceOption[]>([])
  const [mics, setMics] = useState<MediaDeviceOption[]>([])
  const [cameraId, setCameraId] = useState('')
  const [micId, setMicId] = useState('')
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  const [mode, setModeState] = useState<VideoRecordingMode>('camera')
  const [desktopRequesting, setDesktopRequesting] = useState(false)
  const [hasSystemAudio, setHasSystemAudioState] = useState(false)
  const [audioSourceId, setAudioSourceIdState] = useState<AudioSourceId>(loadStoredAudioSource)
  const [audioLockedOff, setAudioLockedOff] = useState(false)
  const [videoQualityId, setVideoQualityIdState] = useState(() => loadStoredId(VIDEO_QUALITY_STORAGE_KEY, VIDEO_QUALITY_PRESETS, DEFAULT_VIDEO_QUALITY))
  const [audioQualityId, setAudioQualityIdState] = useState(() => loadStoredId(AUDIO_QUALITY_STORAGE_KEY, AUDIO_QUALITY_PRESETS, DEFAULT_AUDIO_QUALITY))

  const streamRef = useRef<MediaStream | null>(null)
  const desktopStreamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const onCompleteRef = useRef(onComplete)
  useEffect(() => { onCompleteRef.current = onComplete })

  // Read inside callbacks without adding these to useCallback deps — several
  // of these identities are relied on to stay stable (e.g. across the
  // modal's mount effect) while the values themselves change over time.
  const videoQualityRef = useRef(videoQualityId)
  useEffect(() => { videoQualityRef.current = videoQualityId }, [videoQualityId])
  const previewStreamRef = useRef<MediaStream | null>(null)
  useEffect(() => { previewStreamRef.current = previewStream }, [previewStream])
  const modeRef = useRef<VideoRecordingMode>('camera')
  const audioSourceRef = useRef<AudioSourceId>(audioSourceId)
  const hasSystemAudioRef = useRef(false)

  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const canvasStreamRef = useRef<MediaStream | null>(null)
  const cameraVideoElRef = useRef<HTMLVideoElement | null>(null)
  const desktopVideoElRef = useRef<HTMLVideoElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The audio mix graph: mic and system sources each pass through their own gain
  // node into one destination, whose single output track is what gets recorded.
  const audioCtxRef = useRef<AudioContext | null>(null)
  const mixDestRef = useRef<MediaStreamAudioDestinationNode | null>(null)
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const micGainRef = useRef<GainNode | null>(null)
  const systemSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const systemGainRef = useRef<GainNode | null>(null)

  if (!canvasElRef.current) {
    const preset = findPreset(videoQualityRef.current)
    const canvas = document.createElement('canvas')
    canvas.width = preset.width
    canvas.height = preset.height
    canvasElRef.current = canvas
  }
  if (!cameraVideoElRef.current) {
    const el = document.createElement('video')
    el.muted = true
    el.playsInline = true
    cameraVideoElRef.current = el
  }

  const setNotice = useCallback((msg: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    setNoticeState(msg)
    noticeTimerRef.current = setTimeout(() => setNoticeState(''), 4000)
  }, [])

  // Selecting a source is just a pair of gain changes, so it takes effect
  // instantly and is safe to do while recording.
  const applyGains = useCallback((source: AudioSourceId) => {
    if (micGainRef.current) micGainRef.current.gain.value = source === 'mic' || source === 'both' ? 1 : 0
    if (systemGainRef.current) systemGainRef.current.gain.value = source === 'system' || source === 'both' ? 1 : 0
  }, [])

  const ensureAudioGraph = useCallback((): AudioContext | null => {
    if (!audioCtxRef.current) {
      const Ctor = getAudioContextCtor()
      if (!Ctor) return null
      const ctx = new Ctor()
      const dest = ctx.createMediaStreamDestination()
      const micGain = ctx.createGain()
      const systemGain = ctx.createGain()
      micGain.connect(dest)
      systemGain.connect(dest)
      audioCtxRef.current = ctx
      mixDestRef.current = dest
      micGainRef.current = micGain
      systemGainRef.current = systemGain
      applyGains(audioSourceRef.current)
    }
    // An AudioContext can be handed to us suspended; a suspended graph emits
    // silence, so nudge it every time we touch the graph.
    if (audioCtxRef.current.state === 'suspended') void audioCtxRef.current.resume().catch(() => { /* ignore */ })
    return audioCtxRef.current
  }, [applyGains])

  const connectMicSource = useCallback((src: MediaStream | null) => {
    micSourceRef.current?.disconnect()
    micSourceRef.current = null
    const tracks = src?.getAudioTracks() ?? []
    if (tracks.length === 0) return
    const ctx = ensureAudioGraph()
    if (!ctx || !micGainRef.current) return
    const node = ctx.createMediaStreamSource(new MediaStream(tracks))
    node.connect(micGainRef.current)
    micSourceRef.current = node
  }, [ensureAudioGraph])

  const connectSystemSource = useCallback((src: MediaStream | null) => {
    systemSourceRef.current?.disconnect()
    systemSourceRef.current = null
    const tracks = src?.getAudioTracks() ?? []
    const ctx = tracks.length > 0 ? ensureAudioGraph() : null
    if (!ctx || !systemGainRef.current) {
      hasSystemAudioRef.current = false
      setHasSystemAudioState(false)
      return
    }
    const node = ctx.createMediaStreamSource(new MediaStream(tracks))
    node.connect(systemGainRef.current)
    systemSourceRef.current = node
    hasSystemAudioRef.current = true
    setHasSystemAudioState(true)
  }, [ensureAudioGraph])

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setStream(null)
  }, [])

  const stopDesktopStream = useCallback(() => {
    desktopStreamRef.current?.getTracks().forEach((t) => t.stop())
    desktopStreamRef.current = null
    connectSystemSource(null)
    modeRef.current = 'camera'
    setModeState('camera')
    // Losing the share takes the computer-audio options with it. Fall back to the
    // mic rather than silently recording nothing, but don't persist the fallback
    // — the stored preference should survive to the next share.
    if (audioSourceRef.current === 'system' || audioSourceRef.current === 'both') {
      audioSourceRef.current = 'mic'
      setAudioSourceIdState('mic')
      applyGains('mic')
    }
  }, [connectSystemSource, applyGains])

  const refreshDevices = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices()
    setCameras(
      devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` })),
    )
    setMics(
      devices
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
    )
  }, [])

  // (Re)opens the camera/mic stream, optionally pinned to specific device ids.
  // Device labels are blank until a permission grant, so this also re-enumerates
  // devices afterwards to populate the picker with real labels.
  const openWithDevices = useCallback(async (nextCameraId?: string, nextMicId?: string) => {
    stopStream()
    setStatus('requesting')
    setErrorMessage('')
    try {
      const preset = findPreset(videoQualityRef.current)
      const constraints: MediaStreamConstraints = {
        video: {
          ...(nextCameraId ? { deviceId: { exact: nextCameraId } } : {}),
          width: { ideal: preset.width },
          height: { ideal: preset.height },
        },
        audio: nextMicId ? { deviceId: { exact: nextMicId } } : true,
      }
      const newStream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = newStream
      setStream(newStream)
      await refreshDevices()
      const videoTrack = newStream.getVideoTracks()[0]
      const audioTrack = newStream.getAudioTracks()[0]
      setCameraId(videoTrack?.getSettings().deviceId ?? nextCameraId ?? '')
      setMicId(audioTrack?.getSettings().deviceId ?? nextMicId ?? '')
      setStatus('previewing')
    } catch {
      setErrorMessage('Camera/microphone access denied or unavailable')
      setStatus('error')
    }
  }, [stopStream, refreshDevices])

  const open = useCallback(() => { void openWithDevices() }, [openWithDevices])
  const selectCamera = useCallback((id: string) => { void openWithDevices(id, micId) }, [openWithDevices, micId])
  const selectMic = useCallback((id: string) => { void openWithDevices(cameraId, id) }, [openWithDevices, cameraId])

  // Resolution is a capture constraint, so changing it re-opens the camera
  // stream and resizes the compositor canvas (only allowed pre-recording).
  const setVideoQuality = useCallback((id: string) => {
    setVideoQualityIdState(id)
    try { localStorage.setItem(VIDEO_QUALITY_STORAGE_KEY, id) } catch { /* ignore */ }
    videoQualityRef.current = id
    const preset = findPreset(id)
    if (canvasElRef.current) {
      canvasElRef.current.width = preset.width
      canvasElRef.current.height = preset.height
    }
    void openWithDevices(cameraId, micId)
  }, [openWithDevices, cameraId, micId])

  // Bitrate only affects encoding at record-start, so no need to reopen the stream.
  const setAudioQuality = useCallback((id: string) => {
    setAudioQualityIdState(id)
    try { localStorage.setItem(AUDIO_QUALITY_STORAGE_KEY, id) } catch { /* ignore */ }
  }, [])

  const setAudioSource = useCallback((id: AudioSourceId) => {
    const option = AUDIO_SOURCES.find((o) => o.id === id)
    if (!option || (option.needsSystemAudio && !hasSystemAudioRef.current)) return
    audioSourceRef.current = id
    setAudioSourceIdState(id)
    try { localStorage.setItem(AUDIO_SOURCE_STORAGE_KEY, id) } catch { /* ignore */ }
    ensureAudioGraph()
    applyGains(id)
  }, [ensureAudioGraph, applyGains])

  // Feeds the camera stream into an off-DOM <video> the draw loop reads from.
  useEffect(() => {
    const el = cameraVideoElRef.current
    if (!el) return
    el.srcObject = stream
    if (stream) void el.play().catch(() => { /* autoplay quirks — draw loop just skips frames until ready */ })
  }, [stream])

  // Rebuilds the composited (canvas video + mixed audio) stream whenever the
  // camera stream changes. Switching device or resolution hands us a brand new
  // mic track, so its source node is rewired here; the mix destination's output
  // track survives that, which is why audio keeps flowing mid-recording.
  useEffect(() => {
    if (!stream || !canvasElRef.current) {
      connectMicSource(null)
      setPreviewStream(null)
      return
    }
    if (!canvasStreamRef.current) {
      canvasStreamRef.current = canvasElRef.current.captureStream(30)
    }
    ensureAudioGraph()
    connectMicSource(stream)
    const videoTrack = canvasStreamRef.current.getVideoTracks()[0]
    // Falls back to the raw mic track if this browser has no AudioContext, in
    // which case there's no mixing to be had and system audio stays unavailable.
    const audioTrack = mixDestRef.current?.stream.getAudioTracks()[0] ?? stream.getAudioTracks()[0]
    setPreviewStream(new MediaStream([videoTrack, ...(audioTrack ? [audioTrack] : [])]))
  }, [stream, ensureAudioGraph, connectMicSource])

  // Continuous draw loop: composites whichever source(s) are active onto the
  // canvas every frame. Reads refs only, so it never needs to restart when the
  // mode (or anything else) changes.
  useEffect(() => {
    let active = true
    function frame() {
      if (!active) return
      const canvas = canvasElRef.current
      const ctx = canvas?.getContext('2d')
      if (canvas && ctx) {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, canvas.width, canvas.height)

        const desktopEl = desktopVideoElRef.current
        const cameraEl = cameraVideoElRef.current
        const cameraReady = !!cameraEl && cameraEl.readyState >= 2
        const wantsDesktop = modeRef.current !== 'camera'
        const usingDesktop = wantsDesktop && !!desktopEl && desktopEl.readyState >= 2

        if (usingDesktop && desktopEl) {
          drawContain(ctx, desktopEl, canvas.width, canvas.height)
        } else if (!wantsDesktop && cameraEl && cameraReady) {
          // Only ever fall back to a full-frame camera when a camera mode asked
          // for it — in a screen mode those few frames before the share is ready
          // would put the user's face in a recording that's meant to exclude it.
          drawContain(ctx, cameraEl, canvas.width, canvas.height)
        }

        if (modeRef.current === 'presentation' && usingDesktop && cameraEl && cameraReady) {
          const box = insetBox(canvas.width, canvas.height)
          ctx.save()
          roundRectPath(ctx, box.x, box.y, box.w, box.h, box.r)
          ctx.clip()
          drawCover(ctx, cameraEl, box.x, box.y, box.w, box.h)
          ctx.restore()
          ctx.save()
          roundRectPath(ctx, box.x, box.y, box.w, box.h, box.r)
          ctx.lineWidth = Math.max(2, canvas.width * 0.003)
          ctx.strokeStyle = 'rgba(255,255,255,0.85)'
          ctx.stroke()
          ctx.restore()
        }
      }
      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)
    return () => {
      active = false
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Switching to a screen mode acquires the share on first use; switching between
  // the two screen modes (i.e. dropping or restoring the camera inset) reuses the
  // stream we already hold, so it's instant and never re-prompts the picker.
  // Switching back to 'camera' deliberately keeps the share alive in the
  // background for the same reason — it's only released on close()/session end.
  const changeMode = useCallback(async (next: VideoRecordingMode) => {
    if (next === modeRef.current) return
    if (next !== 'camera' && !hasScreenShareSupport) return
    if (next === 'camera' || desktopStreamRef.current) {
      modeRef.current = next
      setModeState(next)
      return
    }
    setDesktopRequesting(true)
    try {
      const display = await requestDisplayStream()
      desktopStreamRef.current = display
      const track = display.getVideoTracks()[0]
      track.onended = () => {
        const losingSystemAudio = audioSourceRef.current === 'system' || audioSourceRef.current === 'both'
        stopDesktopStream()
        setNotice(losingSystemAudio
          ? 'Screen sharing ended — back to camera and microphone'
          : 'Screen sharing ended — back to camera')
      }
      if (!desktopVideoElRef.current) {
        const el = document.createElement('video')
        el.muted = true
        el.playsInline = true
        desktopVideoElRef.current = el
      }
      desktopVideoElRef.current.srcObject = display
      await desktopVideoElRef.current.play().catch(() => { /* draw loop just skips frames until ready */ })
      connectSystemSource(display)
      modeRef.current = next
      setModeState(next)
    } catch {
      setNotice('Screen sharing was cancelled')
    } finally {
      setDesktopRequesting(false)
    }
  }, [stopDesktopStream, setNotice, connectSystemSource])

  const setMode = useCallback((next: VideoRecordingMode) => { void changeMode(next) }, [changeMode])

  const startRecording = useCallback(() => {
    const preview = previewStreamRef.current
    const videoTrack = preview?.getVideoTracks()[0]
    if (!preview || !videoTrack) return
    void audioCtxRef.current?.resume().catch(() => { /* ignore */ })
    const mimeType = pickMimeType()
    const videoPreset = findPreset(videoQualityId)
    const audioPreset = AUDIO_QUALITY_PRESETS.find((p) => p.id === audioQualityId) ?? AUDIO_QUALITY_PRESETS[0]
    const options: MediaRecorderOptions = {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: videoPreset.videoBitsPerSecond,
      audioBitsPerSecond: audioPreset.audioBitsPerSecond,
    }
    // Choosing "No audio" up front leaves the audio track out entirely, so the
    // file has none at all rather than a silent one. Switching to it mid-take can
    // only mute what's left, since the track is already part of the recording —
    // hence the lock while such a recording runs.
    const silent = audioSourceRef.current === 'none'
    const recordingStream = new MediaStream([videoTrack, ...(silent ? [] : preview.getAudioTracks())])
    chunksRef.current = []
    const recorder = new MediaRecorder(recordingStream, options)

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'video/webm' })
      chunksRef.current = []
      onCompleteRef.current(blob, recorder.mimeType || mimeType || 'video/webm')
    }

    recorderRef.current = recorder
    recorder.start()
    setAudioLockedOff(silent)
    setStatus('recording')
  }, [videoQualityId, audioQualityId])

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop()
    setAudioLockedOff(false)
    setStatus('previewing')
  }, [])

  const close = useCallback(() => {
    recorderRef.current?.stop()
    stopStream()
    desktopStreamRef.current?.getTracks().forEach((t) => t.stop())
    desktopStreamRef.current = null
    connectSystemSource(null)
    connectMicSource(null)
    modeRef.current = 'camera'
    setModeState('camera')
    setAudioLockedOff(false)
    setStatus('idle')
  }, [stopStream, connectSystemSource, connectMicSource])

  // Release everything on unmount regardless of how the modal closes.
  useEffect(() => () => {
    recorderRef.current?.stop()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    desktopStreamRef.current?.getTracks().forEach((t) => t.stop())
    void audioCtxRef.current?.close().catch(() => { /* ignore */ })
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
  }, [])

  return {
    status,
    errorMessage,
    notice,
    cameras,
    mics,
    cameraId,
    micId,
    previewStream,
    isSupported: hasVideoRecordingSupport,
    canShareScreen: hasScreenShareSupport,
    mode,
    desktopRequesting,
    hasSystemAudio,
    audioSourceId,
    audioLockedOff,
    videoQualityId,
    audioQualityId,
    open,
    selectCamera,
    selectMic,
    setVideoQuality,
    setAudioQuality,
    setAudioSource,
    setMode,
    startRecording,
    stopRecording,
    close,
  }
}
