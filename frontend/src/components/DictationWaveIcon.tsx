// Animated equalizer-style waveform shown in place of the mic icon while a
// dictation session is actively recording. Sized to match the w-4 h-4
// footprint the Mic/MicOff icons use everywhere else.
const BARS = [
  { peak: 0.45, delay: '0ms' },
  { peak: 1, delay: '150ms' },
  { peak: 0.7, delay: '300ms' },
  { peak: 0.55, delay: '450ms' },
]

export default function DictationWaveIcon({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex h-4 w-4 items-end justify-center gap-[2px] ${className}`} aria-hidden="true">
      {BARS.map((bar, i) => (
        <span
          key={i}
          className="h-full w-[3px] origin-bottom rounded-sm bg-current animate-dictation-wave"
          style={{ animationDelay: bar.delay, ['--wave-peak' as string]: bar.peak }}
        />
      ))}
    </span>
  )
}
