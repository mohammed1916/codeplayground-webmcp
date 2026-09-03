export const PLAYGROUND_TYPES = Object.freeze([
  'array',
  'string',
  'stack',
  'queue',
  'deque',
  'grid',
  'dp',
  'graph',
  'tree',
  'linkedList',
  'trie',
  'heap',
  'map',
  'set',
  'scalar',
])

export const CATEGORY_BY_TYPE = Object.freeze({
  array: 'sequence',
  string: 'sequence',
  stack: 'sequence',
  queue: 'sequence',
  deque: 'sequence',
  grid: 'grid',
  dp: 'grid',
  graph: 'node-link',
  tree: 'node-link',
  linkedList: 'node-link',
  trie: 'node-link',
  heap: 'node-link',
  map: 'associative',
  set: 'associative',
  scalar: 'scalar',
})

export const RUNTIME_LIMITS = Object.freeze({
  maxSourceLength: 100_000,
  maxContainers: 32,
  maxSequenceItems: 500,
  maxGridCells: 2_500,
  maxNodes: 300,
  maxEdges: 1_000,
  maxAssociativeEntries: 500,
  maxValueDepth: 5,
  maxObjectEntries: 100,
  maxStringLength: 2_000,
  minFrames: 1,
  maxFrames: 1_000,
  defaultFrames: 300,
  minTimeoutMs: 100,
  maxTimeoutMs: 10_000,
  defaultTimeoutMs: 2_000,
})

export function createEmptyScene(message) {
  return message
    ? { containers: [], message }
    : { containers: [] }
}

export function createDeclaredContainer(type, id, name, config = {}) {
  const category = CATEGORY_BY_TYPE[type]

  if (!category) {
    throw new Error(`Unknown visualization type: ${type}`)
  }

  const base = {
    id: String(id),
    name: String(name),
    category,
    type,
  }

  if (category === 'sequence') {
    return {
      ...base,
      items: [],
      pointers: [],
    }
  }

  if (category === 'grid') {
    const requestedRows = Math.min(normalizeDimension(config.rows), RUNTIME_LIMITS.maxGridCells)
    const requestedColumns = Math.min(
      normalizeDimension(config.columns ?? config.cols),
      RUNTIME_LIMITS.maxGridCells,
    )
    const rows = requestedRows
    const columns = rows > 0
      ? Math.min(requestedColumns, Math.floor(RUNTIME_LIMITS.maxGridCells / rows))
      : requestedColumns

    return {
      ...base,
      rows,
      columns,
      cells: createEmptyCells(id, rows, columns),
      pointers: [],
    }
  }

  if (category === 'node-link') {
    const defaults = nodeLinkDefaults(type)
    return {
      ...base,
      nodes: [],
      edges: [],
      directed: typeof config.directed === 'boolean' ? config.directed : defaults.directed,
      layout: typeof config.layout === 'string' ? config.layout : defaults.layout,
    }
  }

  if (category === 'associative') {
    return {
      ...base,
      entries: [],
    }
  }

  return {
    ...base,
    value: null,
    state: null,
  }
}

export function normalizeInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
}

export function makeDeclarationId(type, name, occurrence = 1) {
  const slug = String(name || type)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || type.toLowerCase()

  return occurrence > 1 ? `${type}-${slug}-${occurrence}` : `${type}-${slug}`
}

export function sanitizeLabel(value, fallback = '') {
  const text = value == null ? fallback : String(value)
  if (text.length <= 120) return text
  return `${text.slice(0, 117)}...`
}

function normalizeDimension(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.floor(parsed)
}

function createEmptyCells(containerId, rows, columns) {
  return Array.from({ length: rows }, (_, row) => (
    Array.from({ length: columns }, (_, column) => ({
      id: `${containerId}-cell-${row}-${column}`,
      row,
      column,
      value: null,
      state: null,
    }))
  ))
}

function nodeLinkDefaults(type) {
  switch (type) {
    case 'tree':
    case 'trie':
    case 'heap':
      return { directed: true, layout: 'tree' }
    case 'linkedList':
      return { directed: true, layout: 'horizontal' }
    default:
      return { directed: false, layout: 'force' }
  }
}
