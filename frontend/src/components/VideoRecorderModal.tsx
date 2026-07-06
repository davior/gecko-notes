import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Circle, Square, Video as VideoIcon } from 'lucide-react'
import { useVideoRecorder, VIDEO_QUALITY_PRESETS, AUDIO_QUALITY_PRESETS } from '@/hooks/useVideoRecorder'

interface Props {
  onClose: () => void
  onRecorded: (blob: Blob, mimeType: string, wantTranscript: boolean) => void
  canTranscribe: boolean
}

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0')
  const s = (totalSeconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

export default function VideoRecorderModal({ onClose, onRecorded, canTranscribe }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [wantTranscript, setWantTranscript] = useState(canTranscribe)
  const [seconds, setSeconds] = useState(0)

  const recorder = useVideoRecorder((blob, mimeType) => {
    onRecorded(blob, mimeType, wantTranscript)
    onClose()
  })
  const { open, close } = recorder

  useEffect(() => {
    open()
    return () => close()
  }, [open, close])

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = recorder.stream
  }, [recorder.stream])

  useEffect(() => {
    if (recorder.status !== 'recording') return
    setSeconds(0)
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [recorder.status])

  function handleClose() {
    recorder.close()
    onClose()
  }

  if (!recorder.isSupported) {
    return createPortal(
      <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center" onClick={handleClose}>
        <div
          className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Video recording unavailable</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Your browser doesn&apos;t support camera recording (getUserMedia / MediaRecorder).
          </p>
          <button className="btn-secondary w-full" onClick={handleClose}>Close</button>
        </div>
      </div>,
      document.body,
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center" onClick={handleClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden flex flex-col"
        style={{ width: 'min(640px, 94vw)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          <VideoIcon className="w-4 h-4 text-blue-500" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Record video</h3>
          <button className="btn-ghost p-1.5 ml-auto" onClick={handleClose} title="Close" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="relative bg-black rounded-lg overflow-hidden aspect-video flex items-center justify-center">
            <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-contain" />
            {recorder.status === 'recording' && (
              <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-black/60 text-white text-xs px-2 py-1 rounded-full">
                <Circle className="w-2.5 h-2.5 fill-red-500 text-red-500 animate-pulse" />
                {formatTime(seconds)}
              </div>
            )}
            {recorder.status === 'requesting' && (
              <div className="absolute inset-0 flex items-center justify-center text-white text-sm">
                Requesting camera access…
              </div>
            )}
            {recorder.status === 'error' && (
              <div className="absolute inset-0 flex items-center justify-center text-white text-sm px-4 text-center">
                {recorder.errorMessage}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <select
              className="input text-xs flex-1 min-w-[140px]"
              value={recorder.cameraId}
              onChange={(e) => recorder.selectCamera(e.target.value)}
              disabled={recorder.status === 'recording' || recorder.cameras.length === 0}
              aria-label="Camera"
            >
              {recorder.cameras.length === 0 && <option value="">No camera found</option>}
              {recorder.cameras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>{c.label}</option>
              ))}
            </select>
            <select
              className="input text-xs flex-1 min-w-[140px]"
              value={recorder.micId}
              onChange={(e) => recorder.selectMic(e.target.value)}
              disabled={recorder.status === 'recording' || recorder.mics.length === 0}
              aria-label="Microphone"
            >
              {recorder.mics.length === 0 && <option value="">No microphone found</option>}
              {recorder.mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>{m.label}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap gap-2">
            <select
              className="input text-xs flex-1 min-w-[140px]"
              value={recorder.videoQualityId}
              onChange={(e) => recorder.setVideoQuality(e.target.value)}
              disabled={recorder.status === 'recording'}
              aria-label="Video quality"
            >
              {VIDEO_QUALITY_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            <select
              className="input text-xs flex-1 min-w-[140px]"
              value={recorder.audioQualityId}
              onChange={(e) => recorder.setAudioQuality(e.target.value)}
              disabled={recorder.status === 'recording'}
              aria-label="Audio quality"
            >
              {AUDIO_QUALITY_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              checked={wantTranscript}
              disabled={!canTranscribe}
              onChange={(e) => setWantTranscript(e.target.checked)}
            />
            Generate transcript after recording
            {!canTranscribe && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                (set a Deepgram key in Settings → Speech)
              </span>
            )}
          </label>

          <div className="flex justify-end gap-2 pt-1">
            {recorder.status === 'recording' ? (
              <button className="btn-primary flex items-center gap-1.5" onClick={recorder.stopRecording}>
                <Square className="w-4 h-4" /> Stop
              </button>
            ) : (
              <button
                className="btn-primary flex items-center gap-1.5"
                disabled={recorder.status !== 'previewing'}
                onClick={recorder.startRecording}
              >
                <Circle className="w-4 h-4 fill-current" /> Start recording
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
