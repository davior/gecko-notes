import { useState, useRef, useEffect, useCallback } from 'react'

declare global {
  interface Window {
    webkitSpeechRecognition: typeof SpeechRecognition
  }
}

export type DictationStatus = 'idle' | 'recording' | 'error' | 'unsupported'

export interface UseDictationReturn {
  status: DictationStatus
  interimText: string
  errorMessage: string
  isSupported: boolean
  startDictation: () => void
  stopDictation: () => void
  toggleDictation: () => void
}

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'Microphone access denied',
  'no-speech': 'No speech detected',
  'network': 'Network error — check your connection',
  'audio-capture': 'No microphone found',
  'aborted': 'Dictation was aborted',
}

export function useDictation(onFinalResult: (text: string) => void): UseDictationReturn {
  const isSupported =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)

  const [status, setStatus] = useState<DictationStatus>(isSupported ? 'idle' : 'unsupported')
  const [interimText, setInterimText] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const onFinalResultRef = useRef(onFinalResult)
  const userStoppedRef = useRef(false)

  useEffect(() => {
    onFinalResultRef.current = onFinalResult
  })

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort()
    }
  }, [])

  const startDictation = useCallback(() => {
    if (!isSupported) {
      setStatus('unsupported')
      return
    }

    userStoppedRef.current = false

    const SpeechRecognitionImpl =
      (window as Window).SpeechRecognition ?? window.webkitSpeechRecognition

    const recognition = new SpeechRecognitionImpl()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = navigator.language ?? 'en-US'

    recognition.onstart = () => {
      setStatus('recording')
      setInterimText('')
      setErrorMessage('')
    }

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalText = ''
      let interim = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          finalText += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }

      setInterimText(interim)

      if (finalText.trim()) {
        onFinalResultRef.current(finalText)
      }
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'aborted' && userStoppedRef.current) return
      const msg = ERROR_MESSAGES[event.error] ?? `Speech recognition error: ${event.error}`
      setErrorMessage(msg)
      setStatus('error')
      setInterimText('')
    }

    recognition.onend = () => {
      setStatus((prev) => (prev === 'recording' ? 'idle' : prev))
      setInterimText('')
    }

    recognitionRef.current = recognition
    recognition.start()
  }, [isSupported])

  const stopDictation = useCallback(() => {
    userStoppedRef.current = true
    recognitionRef.current?.stop()
    setStatus('idle')
    setInterimText('')
  }, [])

  const toggleDictation = useCallback(() => {
    if (status === 'recording') {
      stopDictation()
    } else {
      startDictation()
    }
  }, [status, startDictation, stopDictation])

  return { status, interimText, errorMessage, isSupported, startDictation, stopDictation, toggleDictation }
}
