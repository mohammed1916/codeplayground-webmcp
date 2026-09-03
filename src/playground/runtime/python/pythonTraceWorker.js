import { loadPyodide, version as pyodideVersion } from 'pyodide'
import { PYTHON_TRACER_SOURCE } from './pythonTracerSource.js'

const sendMessage = globalThis.postMessage.bind(globalThis)
const restrictedJsGlobals = Object.freeze({})
let pyodidePromise

function getPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = loadPyodide({
      indexURL: `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full/`,
      jsglobals: restrictedJsGlobals,
      packages: [],
    })
  }
  return pyodidePromise
}

globalThis.addEventListener('message', async (event) => {
  const request = event.data
  if (!request || request.type !== 'run') return

  let globals
  let dictFactory
  try {
    const pyodide = await getPyodide()
    dictFactory = pyodide.globals.get('dict')
    globals = dictFactory()
    globals.set('__trace_source', request.source)
    globals.set('__trace_input_json', JSON.stringify(request.input ?? null))
    globals.set('__trace_entry_json', JSON.stringify(request.entry ?? null))
    globals.set('__trace_max_frames', request.maxFrames)

    const serialized = await pyodide.runPythonAsync(PYTHON_TRACER_SOURCE, { globals })
    const result = JSON.parse(String(serialized))
    if (result?.error) {
      sendMessage({ type: 'error', runId: request.runId, error: result.error })
      return
    }
    sendMessage({ type: 'result', runId: request.runId, result })
  } catch (error) {
    sendMessage({
      type: 'error',
      runId: request.runId,
      error: serializeError(error),
    })
  } finally {
    globals?.destroy?.()
    dictFactory?.destroy?.()
  }
})

function serializeError(error) {
  return {
    name: error?.name || 'PythonWorkerError',
    message: error?.message || String(error),
    code: error?.code || 'PYTHON_WORKER_ERROR',
    stack: typeof error?.stack === 'string' ? error.stack : undefined,
    line: error?.line,
    column: error?.column,
  }
}
