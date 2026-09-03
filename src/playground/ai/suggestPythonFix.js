import { getChatProvider, streamProviderChat } from '../../services/chatProviders.js'

function providerConfig() {
  const config = getChatProvider()
  try {
    return {
      ...config,
      ollamaApiKey: window.sessionStorage.getItem('chat.ollama-api-key') || '',
      geminiApiKey: window.sessionStorage.getItem('chat.gemini-api-key') || '',
    }
  } catch {
    return config
  }
}

function parseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('The AI did not return a valid fix proposal.')
  return JSON.parse(cleaned.slice(start, end + 1))
}

function sameText(first, second) {
  return String(first ?? '').replace(/\r\n/g, '\n').trim() === String(second ?? '').replace(/\r\n/g, '\n').trim()
}

function sameJson(first, second) {
  try {
    return JSON.stringify(JSON.parse(first)) === JSON.stringify(JSON.parse(second))
  } catch {
    return sameText(first, second)
  }
}

function nodeInputFallback({ source, inputSource, error }) {
  if (!/object has no attribute ['"](?:val|next|left|right)['"]/i.test(String(error?.message || error || ''))) {
    return null
  }
  let inputs
  try {
    inputs = JSON.parse(inputSource)
  } catch {
    return null
  }
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return null
  const key = ['lists', 'heads'].find((name) => Array.isArray(inputs[name]))
  if (key && inputs[key].some((item) => !Array.isArray(item))) {
    const fixed = {
      ...inputs,
      [key]: inputs[key].map((item) => (Array.isArray(item) ? item : [item])),
    }
    return {
      source,
      inputSource: JSON.stringify(fixed, null, 2),
      summary: `The method expects ${key} to contain linked-list heads, but it received plain integers. Each value is wrapped as a list so the runtime can construct ListNode chains.`,
      changes: [`Changed ${key} from a flat integer array to an array of linked-list value arrays.`],
    }
  }
  return null
}

export async function suggestPythonFix({ source, inputSource, entry, error, instruction }, dependencies = {}) {
  const config = dependencies.config ?? providerConfig()
  const stream = dependencies.stream ?? streamProviderChat
  const messages = [
    {
      role: 'system',
      text: `Propose a minimal repair or user-requested workspace change for Python visualization code. Return only JSON, no markdown.
Schema: {"source":"complete repaired Python source","inputs":<complete JSON input value>,"summary":"what failed and why","changes":["short change description"]}
Preserve the algorithm. You may repair input shape, add conventional ListNode or TreeNode definitions when genuinely required, or make a minimal source correction. Never omit unchanged source.`,
    },
    {
      role: 'user',
      text: `Entry: ${entry || 'auto-detected'}
Runtime error: ${error?.message || error || 'Unknown error'}
User-requested change: ${instruction || 'Repair the reported runtime error.'}
Current inputs:
${String(inputSource || 'null').slice(0, 8000)}
Current source:
${String(source || '').slice(0, 40000)}`,
    },
  ]
  let response = ''
  for await (const delta of stream(messages, config)) response += delta
  const parsed = parseJson(response)
  if (typeof parsed.source !== 'string' || !parsed.source.trim()) {
    throw new Error('The AI fix is missing the complete repaired source.')
  }
  if (!Object.hasOwn(parsed, 'inputs')) throw new Error('The AI fix is missing its input proposal.')
  const proposal = {
    source: parsed.source,
    inputSource: JSON.stringify(parsed.inputs, null, 2),
    summary: typeof parsed.summary === 'string' ? parsed.summary : 'AI repair proposal',
    changes: Array.isArray(parsed.changes) ? parsed.changes.map(String).slice(0, 12) : [],
  }
  if (sameText(proposal.source, source) && sameJson(proposal.inputSource, inputSource)) {
    const fallback = nodeInputFallback({ source, inputSource, error })
    if (fallback) return fallback
    throw new Error('The AI described a fix but returned no code or input changes. Try again or choose a stronger model.')
  }
  return proposal
}

export function lineDiff(before, after) {
  const oldLines = String(before).split('\n')
  const newLines = String(after).split('\n')
  const rows = Array.from({ length: oldLines.length + 1 }, () => Array(newLines.length + 1).fill(0))
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      rows[i][j] = oldLines[i] === newLines[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1])
    }
  }
  const diff = []
  let i = 0
  let j = 0
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      diff.push({ type: 'same', text: oldLines[i++] }); j += 1
    } else if (j < newLines.length && (i === oldLines.length || rows[i][j + 1] >= rows[i + 1][j])) {
      diff.push({ type: 'add', text: newLines[j++] })
    } else {
      diff.push({ type: 'delete', text: oldLines[i++] })
    }
  }
  return diff
}
