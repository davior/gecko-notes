import { Mic, X, Check, PhoneOff } from 'lucide-react'
import type { VoiceState } from '@/hooks/useVoiceMode'

interface VoiceModeOverlayProps {
  state: VoiceState
  interimText: string
  errorMessage: string
  // When set, a note-changing plan was read back and is awaiting a spoken "yes"
  // (or a tap on Confirm) before it runs.
  confirmText: string | null
  onConfirm: () => void
  onCancel: () => void
  onEnd: () => void
}

const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  barge_in: 'Go ahead…',
  error: 'Something went wrong',
}

// Orb color per state. Defined as full class strings so Tailwind keeps them.
const ORB_CLASS: Record<VoiceState, string> = {
  idle: 'bg-gray-400',
  connecting: 'bg-gray-400',
  listening: 'bg-indigo-500',
  thinking: 'bg-amber-500',
  speaking: 'bg-green-500',
  barge_in: 'bg-indigo-500',
  error: 'bg-red-500',
}

export default function VoiceModeOverlay({
  state, interimText, errorMessage, confirmText, onConfirm, onCancel, onEnd,
}: VoiceModeOverlayProps) {
  const pulsing = state === 'listening' || state === 'speaking' || state === 'barge_in' || state === 'connecting'

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm rounded-2xl p-6 text-center">
      <button
        className="absolute top-3 right-3 btn-ghost p-1.5 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
        title="Close voice mode"
        onClick={onEnd}
      >
        <X className="w-5 h-5" />
      </button>

      {/* Mic orb */}
      <div className="relative flex items-center justify-center">
        {pulsing && (
          <span className={`absolute inline-flex h-24 w-24 rounded-full opacity-30 animate-ping ${ORB_CLASS[state]}`} />
        )}
        <span className={`relative inline-flex items-center justify-center h-24 w-24 rounded-full text-white shadow-lg ${ORB_CLASS[state]}`}>
          <Mic className="w-10 h-10" />
        </span>
      </div>

      <div className="min-h-[1.5rem]">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{STATE_LABEL[state]}</p>
        {state === 'error' && errorMessage && (
          <p className="text-xs text-red-500 mt-1 max-w-xs">{errorMessage}</p>
        )}
      </div>

      {/* Live transcript of what the user is saying */}
      {interimText && state !== 'error' && (
        <p className="text-sm text-gray-500 dark:text-gray-400 italic max-w-sm break-words">“{interimText}”</p>
      )}

      {/* Spoken-confirmation prompt for note-changing actions */}
      {confirmText && (
        <div className="w-full max-w-sm rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 text-left">
          <p className="text-xs text-amber-800 dark:text-amber-300 mb-2">{confirmText}</p>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">Say “yes” to confirm or “no” to cancel — or tap below.</p>
          <div className="flex items-center gap-2">
            <button className="btn-primary text-xs flex items-center gap-1" onClick={onConfirm}>
              <Check className="w-3.5 h-3.5" /> Confirm
            </button>
            <button className="btn-secondary text-xs flex items-center gap-1" onClick={onCancel}>
              <X className="w-3.5 h-3.5" /> Cancel
            </button>
          </div>
        </div>
      )}

      <button
        className="mt-2 inline-flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors"
        onClick={onEnd}
      >
        <PhoneOff className="w-4 h-4" /> End voice mode
      </button>
    </div>
  )
}
