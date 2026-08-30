import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Circle, Square, Video as VideoIcon, MonitorPlay, Monitor, MicOff } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useVideoRecorder, VIDEO_QUALITY_PRESETS, AUDIO_QUALITY_PRESETS, AUDIO_SOURCES } from '@/hooks/useVideoRecorder'
import type { AudioSourceId, VideoRecordingMode } from '@/hooks/useVideoRecorder'

interface Props {
  onClose: () => void
  onRecorded: (blob: Blob, mimeType: string, wantTranscript: boolean) => void
  canTranscribe: boolean
}

interface ModeOption {
  id: VideoRecordingMode
  label: string
  icon: LucideIcon
  needsScreen: boolean
  hint: string
}

const MODE_OPTIONS: readonly ModeOption[] = [
  { id: 'camera', label: 'Camera', icon: VideoIcon, needsScreen: false, hint: 'Just your camera, full frame' },
  { id: 'presentation', label: 'Screen + camera', icon: MonitorPlay, needsScreen: true, hint: 'Your shared screen with a camera inset in the corner' },
  { id: 'screen', label: 'Screen only', icon: Monitor, needsScreen: true, hint: 'Just your shared screen — no camera inset' },
]

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0')
  const s = (totalSeconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

export default function VideoRecorderModal({ onClose, onRecorded, canTranscribe }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [wantTranscript, setWantTranscript] = useState(canTranscribe)
  const [seconds, setSeconds] = useState(0)
  // Mirrored so the (async) recorder callback below sees the current choice
  // without having to close over the recorder it's being passed to.
  const audioOffRef = useRef(false)

  const recorder = useVideoRecorder((blob, mimeType) => {
    onRecorded(blob, mimeType, wantTranscript && !audioOffRef.current)
    onClose()
  })
  const { open, close } = recorder

  const audioOff = recorder.audioSourceId === 'none'
  audioOffRef.current = audioOff
  const sharingScreen = recorder.mode !== 'camera'

  useEffect(() => {
    open()
    return () => close()
  }, [open, close])

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = recorder.previewStream
  }, [recorder.previewStream])

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
            {sharingScreen && (
              <div className="absolute top-2 right-2 flex items-center gap-1 bg-blue-600/80 text-white text-xs px-2 py-1 rounded-full">
                {recorder.mode === 'presentation' ? <MonitorPlay className="w-3 h-3" /> : <Monitor className="w-3 h-3" />}
                {recorder.mode === 'presentation' ? 'Screen + camera' : 'Screen only'}
              </div>
            )}
            {audioOff && (
              <div className="absolute bottom-2 left-2 flex items-center gap-1 bg-amber-500/90 text-white text-xs px-2 py-1 rounded-full">
                <MicOff className="w-3 h-3" /> No audio
              </div>
            )}
            {recorder.status === 'requesting' && (
              <div className="absolute inset-0 flex items-center justify-center text-white text-sm">
                Requesting camera access…
              </div>
            )}
            {recorder.desktopRequesting && (
              <div className="absolute inset-0 flex items-center justify-center text-white text-sm bg-black/40">
                Choose a screen, window, or tab to share…
              </div>
            )}
            {recorder.status === 'error' && (
              <div className="absolute inset-0 flex items-center justify-center text-white text-sm px-4 text-center">
                {recorder.errorMessage}
              </div>
            )}
          </div>

          {recorder.notice && (
            <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-1.5">
              {recorder.notice}
            </div>
          )}

          {/* Modes stay switchable while recording — the compositor swaps what it
              draws without ever restarting MediaRecorder. */}
          <div className="flex gap-1 p-1 rounded-lg bg-gray-100 dark:bg-gray-700/50" role="group" aria-label="Recording mode">
            {MODE_OPTIONS.map((opt) => {
              const Icon = opt.icon
              const active = recorder.mode === opt.id
              const blocked = opt.needsScreen && !recorder.canShareScreen
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-medium px-2 py-1.5 rounded-md transition-colors ${
                    active
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'text-gray-600 dark:text-gray-300 hover:bg-white/70 dark:hover:bg-gray-600'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                  disabled={blocked || recorder.desktopRequesting}
                  aria-pressed={active}
                  onClick={() => recorder.setMode(opt.id)}
                  title={blocked ? "This browser doesn't support screen sharing" : opt.hint}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{opt.label}</span>
                </button>
              )
            })}
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
              value={recorder.audioSourceId}
              onChange={(e) => recorder.setAudioSource(e.target.value as AudioSourceId)}
              disabled={recorder.audioLockedOff}
              aria-label="Audio source"
              title={
                recorder.audioLockedOff
                  ? 'This recording was started with no audio, so it has no audio track to turn back on'
                  : 'Which sound goes into the recording'
              }
            >
              {AUDIO_SOURCES.map((s) => (
                <option
                  key={s.id}
                  value={s.id}
                  // A restored preference can name computer audio before any share exists;
                  // greying out the value that's actually selected would just look broken,
                  // so only the options you can't switch *to* are disabled.
                  disabled={s.needsSystemAudio && !recorder.hasSystemAudio && s.id !== recorder.audioSourceId}
                >
                  {s.label}
                </option>
              ))}
            </select>
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
              disabled={recorder.status === 'recording' || audioOff}
              aria-label="Audio quality"
            >
              {AUDIO_QUALITY_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>

          {sharingScreen && !recorder.hasSystemAudio && (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              This share has no audio track, so computer audio isn&apos;t available. To capture it, re-share a
              tab with &ldquo;Share tab audio&rdquo; ticked (or your whole screen with &ldquo;Share system audio&rdquo;).
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              checked={wantTranscript && !audioOff}
              disabled={!canTranscribe || audioOff}
              onChange={(e) => setWantTranscript(e.target.checked)}
            />
            Generate transcript after recording
            {!canTranscribe && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                (set a fal.ai key in Settings → AI Services → Providers)
              </span>
            )}
            {canTranscribe && audioOff && (
              <span className="text-xs text-amber-600 dark:text-amber-400">(audio is off)</span>
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
