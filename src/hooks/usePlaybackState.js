import { useState, useRef, useCallback, useEffect } from 'react'

/**
 * Custom hook for managing playback state across visualizers.
 * Consolidates: stepIndex, isPlaying, speed management + interval loop + handlers
 * 
 * @param {number} stepsLength - Total number of steps available
 * @param {number} initialSpeed - Initial speed in milliseconds per step
 * @returns {Object} Playback state and handlers
 */
export function usePlaybackState(stepsLength, initialSpeed = 500, legacySetCurrentStep) {
  // Some of the older visualizers own their step index in the component and
  // call this hook as usePlaybackState(steps, currentStep, setCurrentStep).
  // Keep that contract working while new visualizers use the simpler
  // usePlaybackState(steps.length) form.  Treating an array as a number here
  // previously made Play appear to do nothing.
  const isLegacyExternalIndex = Array.isArray(stepsLength) && typeof legacySetCurrentStep === 'function'
  const resolvedStepsLength = Array.isArray(stepsLength) ? stepsLength.length : Math.max(0, Number(stepsLength) || 0)
  const externalStepIndex = isLegacyExternalIndex ? initialSpeed : null
  const resolvedInitialSpeed = isLegacyExternalIndex ? 500 : initialSpeed
  const [internalStepIndex, setInternalStepIndex] = useState(-1)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(resolvedInitialSpeed)
  const intervalRef = useRef(null)

  const stepIndex = isLegacyExternalIndex ? externalStepIndex : internalStepIndex
  const setStepIndex = useCallback((next) => {
    if (isLegacyExternalIndex) {
      legacySetCurrentStep((previous) => typeof next === 'function' ? next(previous) : next)
      return
    }
    setInternalStepIndex(next)
  }, [isLegacyExternalIndex, legacySetCurrentStep])

  const isDone = stepIndex >= resolvedStepsLength - 1
  const currentStep = stepIndex >= 0 ? stepIndex : null
  const canNext = stepIndex < resolvedStepsLength - 1
  const canPrev = stepIndex > 0

  // Step forward
  const stepForward = useCallback(() => {
    setStepIndex((prev) => {
      if (prev >= resolvedStepsLength - 1) {
        setIsPlaying(false)
        return prev
      }
      return prev + 1
    })
  }, [resolvedStepsLength, setStepIndex])

  // Step backward
  const stepBack = useCallback(() => {
    setStepIndex((prev) => Math.max(-1, prev - 1))
  }, [setStepIndex])

  // Toggle play/pause
  const togglePlay = useCallback(() => {
    setStepIndex((prev) => {
      if (prev >= resolvedStepsLength - 1) return -1
      return prev
    })
    setIsPlaying((prev) => !prev)
  }, [resolvedStepsLength, setStepIndex])

  // Reset to beginning
  const handleReset = useCallback(() => {
    setStepIndex(-1)
    setIsPlaying(false)
  }, [setStepIndex])

  // Playback interval effect
  useEffect(() => {
    clearInterval(intervalRef.current)
    if (isPlaying && resolvedStepsLength > 0) {
      intervalRef.current = setInterval(() => {
        setStepIndex((prev) => {
          if (prev >= resolvedStepsLength - 1) {
            setIsPlaying(false)
            return prev
          }
          return prev + 1
        })
      }, speed)
    }
    return () => clearInterval(intervalRef.current)
  }, [isPlaying, speed, resolvedStepsLength, setStepIndex])

  return {
    stepIndex,
    setStepIndex,
    isPlaying,
    setIsPlaying,
    speed,
    setSpeed,
    stepForward,
    stepBack,
    togglePlay,
    handleReset,
    isDone,
    canNext,
    canPrev,
    currentStep,
    // Legacy names retained for older visualizers.  They deliberately point
    // to the same state/actions as the current API, rather than maintaining a
    // second playback loop.
    activeStepIndex: stepIndex,
    setActiveStepIndex: setStepIndex,
    togglePlayback: togglePlay,
    reset: handleReset,
  }
}
