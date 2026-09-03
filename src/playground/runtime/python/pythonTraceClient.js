const DEFAULT_TIMEOUT_MS = 30_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_MAX_FRAMES = 240
const MAX_FRAMES = 1_000
const MAX_SOURCE_LENGTH = 100_000
const MAX_INPUT_LENGTH = 250_000

let warmWorker = null
let cancelActiveRun = null

export function runPythonTrace(source, options = {}) {
  if (typeof source !== 'string') {
    return Promise.reject(createError('Python source must be a string.', 'INVALID_SOURCE'))
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    return Promise.reject(createError(
      `Python source is limited to ${MAX_SOURCE_LENGTH.toLocaleString()} characters.`,
      'SOURCE_LIMIT',
    ))
  }

  let input
  try {
    input = normalizeInput(options.input)
  } catch (error) {
    return Promise.reject(error)
  }

  const timeoutMs = clampInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const maxFrames = clampInteger(options.maxFrames, DEFAULT_MAX_FRAMES, 1, MAX_FRAMES)
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

    cancelActiveRun?.(createError(
      'Python execution was superseded by a newer run.',
      'SUPERSEDED',
    ))

    const runId = createRunId()
    let worker
    let timeoutId
    let settled = false

    const cleanup = (terminateWorker) => {
      if (timeoutId) clearTimeout(timeoutId)
      signal?.removeEventListener('abort', handleAbort)
      worker?.removeEventListener('message', handleMessage)
      worker?.removeEventListener('error', handleWorkerError)
      worker?.removeEventListener('messageerror', handleMessageError)
      if (cancelActiveRun === cancelRun) cancelActiveRun = null
      if (terminateWorker) terminateWarmWorker(worker)
    }
    const finish = (callback, value, { terminateWorker = false } = {}) => {
      if (settled) return
      settled = true
      cleanup(terminateWorker)
      callback(value)
    }
    const cancelRun = (error) => finish(reject, error, { terminateWorker: true })
    const handleAbort = () => cancelRun(createAbortError())
    const handleMessage = (event) => {
      const response = event.data
      if (!response || response.runId !== runId) return
      if (response.type === 'result') finish(resolve, response.result)
      if (response.type === 'error') {
        const error = deserializeError(response.error)
        finish(reject, error, { terminateWorker: isWorkerFailure(error) })
      }
    }
    const handleWorkerError = (event) => {
      finish(reject, createError(
        event.message || 'The Python trace worker stopped unexpectedly.',
        'WORKER_ERROR',
      ), { terminateWorker: true })
    }
    const handleMessageError = () => {
      finish(
        reject,
        createError('The Python trace result could not be read.', 'WORKER_MESSAGE_ERROR'),
        { terminateWorker: true },
      )
    }

    try {
      worker = warmWorker || new Worker(
        new URL('./pythonTraceWorker.js', import.meta.url),
        { type: 'module' },
      )
      warmWorker = worker
    } catch (error) {
      finish(reject, createError(
        error?.message || 'Could not start the Python trace worker.',
        'WORKER_START_ERROR',
      ), { terminateWorker: true })
      return
    }

    worker.addEventListener('message', handleMessage)
    worker.addEventListener('error', handleWorkerError)
    worker.addEventListener('messageerror', handleMessageError)

    cancelActiveRun = cancelRun
    signal?.addEventListener('abort', handleAbort, { once: true })
    timeoutId = setTimeout(() => {
      cancelRun(createError(
        `Python execution exceeded the ${timeoutMs} ms limit.`,
        'TIMEOUT',
      ))
    }, timeoutMs)

    try {
      worker.postMessage({
        type: 'run',
        runId,
        source,
        input,
        entry: normalizeEntry(options.entry),
        maxFrames,
      })
    } catch (error) {
      finish(
        reject,
        createError(error?.message || 'Could not send Python source to the worker.', 'WORKER_MESSAGE_ERROR'),
        { terminateWorker: true },
      )
    }
  })
}

function normalizeInput(input) {
  const value = input
  if (value === undefined) return null

  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw createError('Python input must contain only JSON-compatible values.', 'INVALID_INPUT')
  }
  if (serialized === undefined) {
    throw createError('Python input must be a JSON-compatible value.', 'INVALID_INPUT')
  }
  if (serialized.length > MAX_INPUT_LENGTH) {
    throw createError(
      `Python input is limited to ${MAX_INPUT_LENGTH.toLocaleString()} characters.`,
      'INPUT_LIMIT',
    )
  }
  return JSON.parse(serialized)
}

function terminateWarmWorker(worker) {
  worker?.terminate()
  if (warmWorker === worker) warmWorker = null
}

function isWorkerFailure(error) {
  return [
    'PYTHON_WORKER_ERROR',
    'WORKER_ERROR',
    'WORKER_MESSAGE_ERROR',
    'WORKER_START_ERROR',
  ].includes(error?.code)
}

function normalizeEntry(entry) {
  if (entry == null || entry === '') return null
  if (typeof entry === 'string') return entry.trim().slice(0, 200)
  if (isPlainObject(entry)) {
    const value = entry.path ?? entry.name ?? entry.entry
    return typeof value === 'string' ? value.trim().slice(0, 200) : null
  }
  return null
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
}

function deserializeError(serialized = {}) {
  const error = createError(serialized.message || 'Python execution failed.', serialized.code || 'PYTHON_ERROR')
  error.name = serialized.name || 'PythonError'
  if (serialized.stack) error.stack = serialized.stack
  if (serialized.line != null) error.line = serialized.line
  if (serialized.column != null) error.column = serialized.column
  return error
}

function createError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function createAbortError() {
  const error = createError('Python execution stopped.', 'ABORTED')
  error.name = 'AbortError'
  return error
}

function createRunId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `python-run-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
