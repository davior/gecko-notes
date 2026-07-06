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

export interface UseVideoRecorderReturn {
  status: VideoRecorderStatus
  errorMessage: string
  cameras: MediaDeviceOption[]
  mics: MediaDeviceOption[]
  cameraId: string
  micId: string
  stream: MediaStream | null
  isSupported: boolean
  open: () => void
  selectCamera: (deviceId: string) => void
  selectMic: (deviceId: string) => void
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

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const onCompleteRef = useRef(onComplete)
  useEffect(() => { onCompleteRef.current = onComplete })

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
      const constraints: MediaStreamConstraints = {
        video: nextCameraId ? { deviceId: { exact: nextCameraId } } : true,
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

  const startRecording = useCallback(() => {
    if (!streamRef.current) return
    const mimeType = pickMimeType()
    chunksRef.current = []
    const recorder = mimeType ? new MediaRecorder(streamRef.current, { mimeType }) : new MediaRecorder(streamRef.current)

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
  }, [])

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
    open,
    selectCamera,
    selectMic,
    startRecording,
    stopRecording,
    close,
  }
}
