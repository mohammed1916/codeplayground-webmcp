const STORAGE_KEY = 'chat.provider.v1'
const PROVIDER_EVENT = 'cpviz-chat-provider-change'
const MAX_CHAT_REQUEST_CHARS = 90_000

export function defaultChatModel(provider = 'ollama-local') {
  if (provider === 'gemini') return 'gemini-2.5-flash'
  if (provider === 'ollama-cloud') return 'gpt-oss:120b'
  return 'gemma2:2b'
}

export function getChatProvider() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY))
    if (stored && typeof stored === 'object') {
      return {
        provider: stored.provider || 'ollama-local',
        model: stored.model || defaultChatModel(stored.provider),
      }
    }
  } catch {
    // Fall through to the local provider default.
  }
  return { provider: 'ollama-local', model: defaultChatModel('ollama-local') }
}

export function setChatProvider(value) {
  const next = {
    provider: value?.provider || 'ollama-local',
    model: value?.model || defaultChatModel(value?.provider),
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent(PROVIDER_EVENT, { detail: next }))
  } catch {
    // The current component still keeps the selection when storage is disabled.
  }
  return next
}

export function subscribeChatProvider(listener) {
  if (typeof window === 'undefined') return () => {}
  const handleProviderEvent = (event) => listener(event.detail || getChatProvider())
  const handleStorage = (event) => {
    if (event.key === STORAGE_KEY) listener(getChatProvider())
  }
  window.addEventListener(PROVIDER_EVENT, handleProviderEvent)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(PROVIDER_EVENT, handleProviderEvent)
    window.removeEventListener('storage', handleStorage)
  }
}

export async function* streamProviderChat(messages, config = getChatProvider()) {
  if (config.provider === 'ollama-local') {
    yield* streamLocalOllama(messages, config)
    return
  }

  throw new Error('This standalone build can use Ollama Local for AI suggestions. Cloud providers need a hosted /api/chat proxy.')
}

function assertSmallRequest(body) {
  const serialized = JSON.stringify(body)
  if (serialized.length > MAX_CHAT_REQUEST_CHARS) {
    throw new Error('That AI request is too large. Shorten the code, current input JSON, or request text before asking for generated inputs.')
  }
  return serialized
}

async function* streamLocalOllama(messages, config) {
  const body = {
    model: config.model || defaultChatModel('ollama-local'),
    stream: true,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.text,
    })),
  }
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: assertSmallRequest(body),
  })
  if (!response.ok) {
    const detail = (await response.text()).trim()
    throw new Error(detail || `Ollama Local returned ${response.status}`)
  }
  if (!response.body) throw new Error('Ollama Local did not return a streaming response.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      const text = line.replace(/^data:\s*/, '').trim()
      if (!text || text === '[DONE]') continue
      let json
      try {
        json = JSON.parse(text)
      } catch {
        // Wait for a complete event.
        continue
      }
      if (json?.error) throw new Error(String(json.error))
      const delta = json?.message?.content || json?.response || ''
      if (delta) yield delta
    }
  }
}
