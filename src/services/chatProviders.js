const STORAGE_KEY = 'chat.provider.v1'
const PROVIDER_EVENT = 'cpviz-chat-provider-change'
const MAX_CHAT_REQUEST_CHARS = 90_000
export const DEFAULT_LOCAL_OLLAMA_URL = 'http://127.0.0.1:11434'

export function defaultChatModel(provider = 'ollama-local') {
  if (provider === 'gemini') return 'gemini-2.5-flash'
  if (provider === 'ollama-cloud') return 'gpt-oss:120b'
  return 'gemma2:2b'
}

export function getChatProvider() {
  const fallbackProvider = canUseLocalOllama() ? 'ollama-local' : 'ollama-cloud'
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY))
    if (stored && typeof stored === 'object') {
      const provider = stored.provider || fallbackProvider
      return {
        provider,
        model: stored.model || defaultChatModel(provider),
        localBaseUrl: stored.localBaseUrl || DEFAULT_LOCAL_OLLAMA_URL,
        allowHostedLocal: Boolean(stored.allowHostedLocal),
      }
    }
  } catch {
    // Fall through to the environment-aware default.
  }
  return {
    provider: fallbackProvider,
    model: defaultChatModel(fallbackProvider),
    localBaseUrl: DEFAULT_LOCAL_OLLAMA_URL,
    allowHostedLocal: false,
  }
}

export function setChatProvider(value) {
  const next = {
    provider: value?.provider || 'ollama-local',
    model: value?.model || defaultChatModel(value?.provider),
    localBaseUrl: value?.localBaseUrl || DEFAULT_LOCAL_OLLAMA_URL,
    allowHostedLocal: Boolean(value?.allowHostedLocal),
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

  yield* streamHostedProxy(messages, config)
}

export function canUseLocalOllama() {
  if (typeof window === 'undefined') return true
  const host = window.location.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function assertSmallRequest(body) {
  const serialized = JSON.stringify(body)
  if (serialized.length > MAX_CHAT_REQUEST_CHARS) {
    throw new Error('That AI request is too large. Shorten the code, current input JSON, or request text before asking for generated inputs.')
  }
  return serialized
}

function normalizeOllamaBaseUrl(value) {
  return String(value || DEFAULT_LOCAL_OLLAMA_URL).trim().replace(/\/+$/, '')
}

function isLoopbackOllamaUrl(value) {
  try {
    const url = new URL(normalizeOllamaBaseUrl(value))
    return url.hostname === '127.0.0.1'
      || url.hostname === 'localhost'
      || url.hostname === '[::1]'
      || url.hostname === '::1'
  } catch {
    return true
  }
}

async function* streamLocalOllama(messages, config) {
  const baseUrl = normalizeOllamaBaseUrl(config.localBaseUrl)
  if (!canUseLocalOllama() && isLoopbackOllamaUrl(baseUrl) && !config.allowHostedLocal) {
    throw new Error('Local Ollama from the hosted app needs browser access to your computer. Enable the hosted Local Ollama option after starting Ollama with CORS for this site, or use Ollama Cloud/Gemini.')
  }
  const body = {
    model: config.model || defaultChatModel('ollama-local'),
    stream: true,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.text,
    })),
  }
  let response
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: assertSmallRequest(body),
    })
  } catch (error) {
    throw new Error(
      `Could not reach Ollama Local from this page. Make sure Ollama is running and, if this is the hosted app, allow this origin in Ollama CORS settings. Original error: ${error?.message || 'fetch failed'}`,
      { cause: error },
    )
  }
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

async function* streamHostedProxy(messages, config) {
  const body = {
    provider: config.provider,
    model: config.model || defaultChatModel(config.provider),
    ollamaApiKey: config.ollamaApiKey || '',
    geminiApiKey: config.geminiApiKey || '',
    messages,
  }
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: assertSmallRequest(body),
  })
  if (!response.ok) {
    const detail = (await response.text()).trim()
    throw new Error(detail || `AI proxy returned ${response.status}`)
  }
  if (!response.body) throw new Error('AI proxy did not return a streaming response.')

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
        yield text
        continue
      }
      if (json?.error) throw new Error(String(json.error))
      const delta = json?.message?.content
        || json?.response
        || json?.candidates?.[0]?.content?.parts?.[0]?.text
        || ''
      if (delta) yield delta
    }
  }
}
