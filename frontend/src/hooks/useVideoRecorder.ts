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
// constraints (the browser/camera may not support them exactly); bitrate is
// passed to MediaRecorder at record-start (best-effort, honored to varying
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

export interface UseVideoRecorderReturn {
  status: VideoRecorderStatus
  errorMessage: string
  cameras: MediaDeviceOption[]
  mics: MediaDeviceOption[]
  cameraId: string
  micId: string
  stream: MediaStream | null
  isSupported: boolean
  videoQualityId: string
  audioQualityId: string
  open: () => void
  selectCamera: (deviceId: string) => void
  selectMic: (deviceId: string) => void
  setVideoQuality: (id: string) => void
  setAudioQuality: (id: string) => void
  startRecording: () => void
  stopRecording: () => void
  close: () => void
}

/** Camera/mic device picker + live preview + MediaRecorder capture, mirroring the
 *  MediaRecorder fallback path in useDictation.ts but for combined video+audio. */
export function useVideoRecorder(onComplete: (blob: Blob, mimeType: string) => void): UseVideoRecorderReturn {
  const [status, setStatus] = useState<VideoRecorderStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [cameras, setCameras] = useState<MediaDeviceOption[]>([])
  const [mics, setMics] = useState<MediaDeviceOption[]>([])
  const [cameraId, setCameraId] = useState('')
  const [micId, setMicId] = useState('')
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [videoQualityId, setVideoQualityIdState] = useState(() => loadStoredId(VIDEO_QUALITY_STORAGE_KEY, VIDEO_QUALITY_PRESETS, DEFAULT_VIDEO_QUALITY))
  const [audioQualityId, setAudioQualityIdState] = useState(() => loadStoredId(AUDIO_QUALITY_STORAGE_KEY, AUDIO_QUALITY_PRESETS, DEFAULT_AUDIO_QUALITY))

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const onCompleteRef = useRef(onComplete)
  useEffect(() => { onCompleteRef.current = onComplete })
  // Read inside openWithDevices without adding videoQualityId to its useCallback
  // deps — that identity is relied on to run exactly once on modal mount.
  const videoQualityRef = useRef(videoQualityId)
  useEffect(() => { videoQualityRef.current = videoQualityId }, [videoQualityId])

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setStream(null)
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
      const preset = VIDEO_QUALITY_PRESETS.find((p) => p.id === videoQualityRef.current) ?? VIDEO_QUALITY_PRESETS[1]
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

  // Resolution is a capture constraint, so changing it re-opens the stream.
  const setVideoQuality = useCallback((id: string) => {
    setVideoQualityIdState(id)
    try { localStorage.setItem(VIDEO_QUALITY_STORAGE_KEY, id) } catch { /* ignore */ }
    videoQualityRef.current = id
    void openWithDevices(cameraId, micId)
  }, [openWithDevices, cameraId, micId])

  // Bitrate only affects encoding at record-start, so no need to reopen the stream.
  const setAudioQuality = useCallback((id: string) => {
    setAudioQualityIdState(id)
    try { localStorage.setItem(AUDIO_QUALITY_STORAGE_KEY, id) } catch { /* ignore */ }
  }, [])

  const startRecording = useCallback(() => {
    if (!streamRef.current) return
    const mimeType = pickMimeType()
    const videoPreset = VIDEO_QUALITY_PRESETS.find((p) => p.id === videoQualityId) ?? VIDEO_QUALITY_PRESETS[1]
    const audioPreset = AUDIO_QUALITY_PRESETS.find((p) => p.id === audioQualityId) ?? AUDIO_QUALITY_PRESETS[0]
    const options: MediaRecorderOptions = {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: videoPreset.videoBitsPerSecond,
      audioBitsPerSecond: audioPreset.audioBitsPerSecond,
    }
    chunksRef.current = []
    const recorder = new MediaRecorder(streamRef.current, options)

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
    setStatus('idle')
  }, [stopStream])

  // Release the camera/mic on unmount regardless of how the modal closes.
  useEffect(() => () => {
    recorderRef.current?.stop()
    streamRef.current?.getTracks().forEach((t) => t.stop())
  }, [])

  return {
    status,
    errorMessage,
    cameras,
    mics,
    cameraId,
    micId,
    stream,
    isSupported: hasVideoRecordingSupport,
    videoQualityId,
    audioQualityId,
    open,
    selectCamera,
    selectMic,
    setVideoQuality,
    setAudioQuality,
    startRecording,
    stopRecording,
    close,
  }
}
