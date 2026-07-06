import { useState, useRef, useCallback, useEffect } from 'react'

export interface MediaDeviceOption {
  deviceId: string
  label: string
}

export type VideoRecorderStatus = 'idle' | 'requesting' | 'previewing' | 'recording' | 'error'

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
const VIDEO_QUALITY_STORAGE_KEY = 'gecko-video-recorder-video-quality'
const AUDIO_QUALITY_STORAGE_KEY = 'gecko-video-recorder-audio-quality'

// Remembers the last-picked quality in this browser (i.e. "for the current
// device"), the same pattern EditorView uses for TTS dock/insert-mode prefs.
function loadStoredId(key: string, presets: readonly { id: string }[], fallback: string): string {
  try {
    const stored = localStorage.getItem(key)
    if (stored && presets.some((p) => p.id === stored)) return stored
  } catch { /* ignore */ }
  return fallback
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
  /** Composited stream (canvas video + mic audio) — bind this to the preview
   *  <video>; it's exactly what gets recorded, whether or not presentation
   *  mode is on. */
  previewStream: MediaStream | null
  isSupported: boolean
  canPresentationMode: boolean
  presentationMode: boolean
  desktopRequesting: boolean
  videoQualityId: string
  audioQualityId: string
  open: () => void
  selectCamera: (deviceId: string) => void
  selectMic: (deviceId: string) => void
  setVideoQuality: (id: string) => void
  setAudioQuality: (id: string) => void
  togglePresentationMode: () => void
  startRecording: () => void
  stopRecording: () => void
  close: () => void
}

/** Camera/mic device picker + live preview + MediaRecorder capture, mirroring the
 *  MediaRecorder fallback path in useDictation.ts but for combined video+audio.
 *
 *  Recording always goes through an internal <canvas> compositor rather than
 *  the raw camera stream directly: in normal mode the canvas just draws the
 *  camera full-frame, and in presentation mode it draws a screen/window/tab
 *  capture full-frame with the camera as a small inset bubble. Because
 *  MediaRecorder is bound to the canvas's stream (not to whichever source is
 *  "current"), toggling presentation mode only flips what gets drawn each
 *  frame — the recorder never needs to stop/restart. */
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
  const [presentationMode, setPresentationModeState] = useState(false)
  const [desktopRequesting, setDesktopRequesting] = useState(false)
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
  const presentationModeRef = useRef(false)

  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const canvasStreamRef = useRef<MediaStream | null>(null)
  const cameraVideoElRef = useRef<HTMLVideoElement | null>(null)
  const desktopVideoElRef = useRef<HTMLVideoElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setStream(null)
  }, [])

  const stopDesktopStream = useCallback(() => {
    desktopStreamRef.current?.getTracks().forEach((t) => t.stop())
    desktopStreamRef.current = null
    presentationModeRef.current = false
    setPresentationModeState(false)
  }, [])

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

  // Feeds the camera stream into an off-DOM <video> the draw loop reads from.
  useEffect(() => {
    const el = cameraVideoElRef.current
    if (!el) return
    el.srcObject = stream
    if (stream) void el.play().catch(() => { /* autoplay quirks — draw loop just skips frames until ready */ })
  }, [stream])

  // Rebuilds the composited (canvas video + mic audio) stream whenever the
  // camera stream changes, e.g. switching devices swaps in a new audio track.
  useEffect(() => {
    if (!stream || !canvasElRef.current) { setPreviewStream(null); return }
    if (!canvasStreamRef.current) {
      canvasStreamRef.current = canvasElRef.current.captureStream(30)
    }
    const videoTrack = canvasStreamRef.current.getVideoTracks()[0]
    const audioTrack = stream.getAudioTracks()[0]
    setPreviewStream(new MediaStream([videoTrack, ...(audioTrack ? [audioTrack] : [])]))
  }, [stream])

  // Continuous draw loop: composites whichever source(s) are active onto the
  // canvas every frame. Reads refs only, so it never needs to restart when
  // presentation mode (or anything else) toggles.
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
        const usingDesktop = presentationModeRef.current && desktopEl && desktopEl.readyState >= 2
        if (usingDesktop && desktopEl) {
          drawContain(ctx, desktopEl, canvas.width, canvas.height)
        } else if (cameraEl && cameraEl.readyState >= 2) {
          drawContain(ctx, cameraEl, canvas.width, canvas.height)
        }

        if (presentationModeRef.current && usingDesktop && cameraEl && cameraEl.readyState >= 2) {
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

  const enablePresentationMode = useCallback(async () => {
    if (!hasScreenShareSupport || presentationModeRef.current) return
    if (desktopStreamRef.current) {
      presentationModeRef.current = true
      setPresentationModeState(true)
      return
    }
    setDesktopRequesting(true)
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true })
      desktopStreamRef.current = display
      const track = display.getVideoTracks()[0]
      track.onended = () => {
        stopDesktopStream()
        setNotice('Screen sharing ended — back to camera')
      }
      if (!desktopVideoElRef.current) {
        const el = document.createElement('video')
        el.muted = true
        el.playsInline = true
        desktopVideoElRef.current = el
      }
      desktopVideoElRef.current.srcObject = display
      await desktopVideoElRef.current.play().catch(() => { /* draw loop just skips frames until ready */ })
      presentationModeRef.current = true
      setPresentationModeState(true)
    } catch {
      setNotice('Screen sharing was cancelled')
    } finally {
      setDesktopRequesting(false)
    }
  }, [stopDesktopStream, setNotice])

  // Turning presentation mode off keeps the desktop stream alive in the
  // background (just stops drawing it) so toggling back on is instant and
  // doesn't re-prompt the browser's share picker. It's fully released on
  // close()/session end.
  const disablePresentationMode = useCallback(() => {
    presentationModeRef.current = false
    setPresentationModeState(false)
  }, [])

  const togglePresentationMode = useCallback(() => {
    if (presentationModeRef.current) disablePresentationMode()
    else void enablePresentationMode()
  }, [enablePresentationMode, disablePresentationMode])

  const startRecording = useCallback(() => {
    const recordingStream = previewStreamRef.current
    if (!recordingStream) return
    const mimeType = pickMimeType()
    const videoPreset = findPreset(videoQualityId)
    const audioPreset = AUDIO_QUALITY_PRESETS.find((p) => p.id === audioQualityId) ?? AUDIO_QUALITY_PRESETS[0]
    const options: MediaRecorderOptions = {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: videoPreset.videoBitsPerSecond,
      audioBitsPerSecond: audioPreset.audioBitsPerSecond,
    }
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
    setStatus('recording')
  }, [videoQualityId, audioQualityId])

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop()
    setStatus('previewing')
  }, [])

  const close = useCallback(() => {
    recorderRef.current?.stop()
    stopStream()
    desktopStreamRef.current?.getTracks().forEach((t) => t.stop())
    desktopStreamRef.current = null
    presentationModeRef.current = false
    setPresentationModeState(false)
    setStatus('idle')
  }, [stopStream])

  // Release everything on unmount regardless of how the modal closes.
  useEffect(() => () => {
    recorderRef.current?.stop()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    desktopStreamRef.current?.getTracks().forEach((t) => t.stop())
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
    canPresentationMode: hasScreenShareSupport,
    presentationMode,
    desktopRequesting,
    videoQualityId,
    audioQualityId,
    open,
    selectCamera,
    selectMic,
    setVideoQuality,
    setAudioQuality,
    togglePresentationMode,
    startRecording,
    stopRecording,
    close,
  }
}
