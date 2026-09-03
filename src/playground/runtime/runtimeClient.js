import { RUNTIME_LIMITS, normalizeInteger } from './model.js'

export function runVisualizationSource(source, options = {}) {
  if (typeof source !== 'string') {
    return Promise.reject(createError('Visualizer source must be a string.', 'INVALID_SOURCE'))
  }
  if (source.length > RUNTIME_LIMITS.maxSourceLength) {
    return Promise.reject(createError(
      `Source is limited to ${RUNTIME_LIMITS.maxSourceLength.toLocaleString()} characters.`,
      'SOURCE_LIMIT',
    ))
  }

  const timeoutMs = normalizeInteger(
    options.timeoutMs,
    RUNTIME_LIMITS.defaultTimeoutMs,
    RUNTIME_LIMITS.minTimeoutMs,
    RUNTIME_LIMITS.maxTimeoutMs,
  )
  const maxFrames = normalizeInteger(
    options.maxFrames,
    RUNTIME_LIMITS.defaultFrames,
    RUNTIME_LIMITS.minFrames,
    RUNTIME_LIMITS.maxFrames,
  )
  const signal = options.signal

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError())
      return
    }
    if (typeof Worker === 'undefined') {
      reject(createError('Web Workers are unavailable in this browser.', 'WORKER_UNAVAILABLE'))
      return
    }

    const runId = createRunId()
    let worker
    let settled = false
    let timeoutId

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId)
      signal?.removeEventListener('abort', handleAbort)
      worker?.terminate()
    }
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }
    const handleAbort = () => finish(reject, createAbortError())

    try {
      worker = new Worker(new URL('./runtimeWorker.js', import.meta.url), { type: 'module' })
    } catch (error) {
      finish(reject, createError(error?.message || 'Could not start the visualization worker.', 'WORKER_START_ERROR'))
      return
    }

    worker.addEventListener('message', (event) => {
      const response = event.data
      if (!response || response.runId !== runId) return
      if (response.type === 'result') finish(resolve, response.result)
      if (response.type === 'error') finish(reject, deserializeError(response.error))
    })
    worker.addEventListener('error', (event) => {
      const message = event.message || 'The visualization worker stopped unexpectedly.'
      finish(reject, createError(message, 'WORKER_ERROR'))
    })
    worker.addEventListener('messageerror', () => {
      finish(reject, createError('The visualization result could not be read.', 'WORKER_MESSAGE_ERROR'))
    })

    signal?.addEventListener('abort', handleAbort, { once: true })
    timeoutId = setTimeout(() => {
      finish(reject, createError(
        `Visualization exceeded the ${timeoutMs} ms execution limit.`,
        'TIMEOUT',
      ))
    }, timeoutMs)

    worker.postMessage({
      type: 'run',
      runId,
      source,
      maxFrames,
    })
  })
}

function deserializeError(serialized = {}) {
  const error = createError(serialized.message || 'Visualization failed.', serialized.code || 'RUNTIME_ERROR')
  error.name = serialized.name || 'Error'
  if (serialized.stack) error.stack = serialized.stack
  return error
}

function createError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function createAbortError() {
  const error = createError('Visualization stopped.', 'ABORTED')
  error.name = 'AbortError'
  return error
}

function createRunId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
