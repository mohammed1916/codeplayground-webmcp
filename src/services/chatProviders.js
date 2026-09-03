const STORAGE_KEY = 'chat.provider.v1'
const PROVIDER_EVENT = 'cpviz-chat-provider-change'

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
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...config, messages }),
  })
  if (!response.ok) throw new Error((await response.text()) || `Chat error ${response.status}`)
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
      try {
        const json = JSON.parse(text)
        const delta = json?.message?.content || json?.candidates?.[0]?.content?.parts?.[0]?.text
        if (delta) yield delta
      } catch {
        // Wait for a complete event.
      }
    }
  }
}
