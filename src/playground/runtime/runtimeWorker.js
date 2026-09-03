import { executeVisualizationSource } from './vizRuntime.js'

const sendMessage = globalThis.postMessage.bind(globalThis)

globalThis.addEventListener('message', async (event) => {
  const request = event.data
  if (!request || request.type !== 'run') return

  try {
    const result = await executeVisualizationSource(request.source, {
      maxFrames: request.maxFrames,
    })
    sendMessage({
      type: 'result',
      runId: request.runId,
      result,
    })
  } catch (error) {
    sendMessage({
      type: 'error',
      runId: request.runId,
      error: serializeError(error),
    })
  }
})

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || 'RUNTIME_ERROR',
    stack: typeof error?.stack === 'string' ? error.stack : undefined,
  }
}
