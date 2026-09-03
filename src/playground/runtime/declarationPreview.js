import {
  PLAYGROUND_TYPES,
  RUNTIME_LIMITS,
  createDeclaredContainer,
  makeDeclarationId,
} from './model.js'

const TYPE_SET = new Set(PLAYGROUND_TYPES)

/**
 * Builds a best-effort scene without executing user code. The scanner is
 * deliberately forgiving: an unfinished call such as `viz.grid("table", {`
 * still produces a container, while comments and string contents are ignored.
 */
export function buildDeclarationPreview(source) {
  const text = (typeof source === 'string' ? source : String(source ?? ''))
    .slice(0, RUNTIME_LIMITS.maxSourceLength)
  const declarations = scanDeclarations(text)
  const counts = new Map()
  const usedIds = new Set()

  const containers = declarations
    .slice(0, RUNTIME_LIMITS.maxContainers)
    .map(({ type, argsText }) => {
      const args = splitTopLevelArguments(argsText)
      const count = (counts.get(type) || 0) + 1
      counts.set(type, count)

      const literalName = parseStringLiteral(args[0])
      const name = literalName || `${displayType(type)} ${count}`
      let id = makeDeclarationId(type, name, count)
      let suffix = 2
      while (usedIds.has(id)) {
        id = `${makeDeclarationId(type, name, count)}-${suffix}`
        suffix += 1
      }
      usedIds.add(id)

      const config = readPreviewConfig(type, args)
      const container = createDeclaredContainer(type, id, name, config)
      applyLiteralPreview(container, type, args, config)
      return container
    })

  const message = containers.length > 0
    ? `${containers.length} visual container${containers.length === 1 ? '' : 's'} ready`
    : 'Declare a container with viz.array(), viz.graph(), viz.dp(), and more.'

  return { containers, message }
}

function scanDeclarations(source) {
  const declarations = []
  let index = 0

  while (index < source.length) {
    const skipped = skipNonCode(source, index)
    if (skipped !== index) {
      index = skipped
      continue
    }

    if (
      source.startsWith('viz', index)
      && !isIdentifierPart(source[index - 1])
      && !isIdentifierPart(source[index + 3])
    ) {
      let cursor = skipWhitespaceAndComments(source, index + 3)
      if (source[cursor] !== '.') {
        index += 3
        continue
      }

      cursor = skipWhitespaceAndComments(source, cursor + 1)
      const identifier = readIdentifier(source, cursor)
      if (!TYPE_SET.has(identifier.value)) {
        index += 3
        continue
      }

      cursor = skipWhitespaceAndComments(source, identifier.end)
      if (source[cursor] !== '(') {
        index += 3
        continue
      }

      const call = readCallContents(source, cursor)
      declarations.push({ type: identifier.value, argsText: call.contents })
      index = Math.max(index + 3, call.end)
      continue
    }

    index += 1
  }

  return declarations
}

function readCallContents(source, openIndex) {
  let depth = 1
  let cursor = openIndex + 1

  while (cursor < source.length) {
    const skipped = skipNonCode(source, cursor)
    if (skipped !== cursor) {
      cursor = skipped
      continue
    }

    if (source[cursor] === '(') depth += 1
    if (source[cursor] === ')') {
      depth -= 1
      if (depth === 0) {
        return {
          contents: source.slice(openIndex + 1, cursor),
          end: cursor + 1,
        }
      }
    }
    cursor += 1
  }

  return {
    contents: source.slice(openIndex + 1),
    end: source.length,
  }
}

function splitTopLevelArguments(input) {
  const args = []
  let start = 0
  let round = 0
  let square = 0
  let curly = 0
  let index = 0

  while (index < input.length) {
    const skipped = skipNonCode(input, index)
    if (skipped !== index) {
      index = skipped
      continue
    }

    switch (input[index]) {
      case '(':
        round += 1
        break
      case ')':
        round = Math.max(0, round - 1)
        break
      case '[':
        square += 1
        break
      case ']':
        square = Math.max(0, square - 1)
        break
      case '{':
        curly += 1
        break
      case '}':
        curly = Math.max(0, curly - 1)
        break
      case ',':
        if (round === 0 && square === 0 && curly === 0) {
          args.push(input.slice(start, index).trim())
          start = index + 1
        }
        break
      default:
        break
    }
    index += 1
  }

  const tail = input.slice(start).trim()
  if (tail || args.length > 0) args.push(tail)
  return args
}

function readPreviewConfig(type, args) {
  const configText = args[1] || ''
  const config = {}

  if (type === 'grid' || type === 'dp') {
    const rowValue = readNumericProperty(configText, 'rows') ?? parsePositiveNumber(args[1])
    const columnValue = readNumericProperty(configText, 'columns')
      ?? readNumericProperty(configText, 'cols')
      ?? parsePositiveNumber(args[2])
    const literalGrid = parseJsonLiteral(args[1])

    config.rows = rowValue ?? (Array.isArray(literalGrid) ? literalGrid.length : 0)
    config.columns = columnValue ?? inferColumnCount(literalGrid)
  }

  if (['graph', 'tree', 'linkedList', 'trie', 'heap'].includes(type)) {
    const directed = readBooleanProperty(configText, 'directed')
    const layout = readStringProperty(configText, 'layout')
    if (directed !== undefined) config.directed = directed
    if (layout) config.layout = layout
  }

  return config
}

function applyLiteralPreview(container, type, args, config) {
  if (container.category === 'sequence') {
    const initial = parseJsonLiteral(args[1])
    const values = type === 'string'
      ? (typeof initial === 'string' ? [...initial] : [])
      : (Array.isArray(initial) ? initial : [])

    container.items = values
      .slice(0, RUNTIME_LIMITS.maxSequenceItems)
      .map((value, index) => ({
        id: `${container.id}-item-${index + 1}`,
        value,
        state: null,
      }))
    return
  }

  if (container.category === 'grid') {
    const initial = parseJsonLiteral(args[1])
    if (!Array.isArray(initial) || !initial.every(Array.isArray)) return

    const rows = Math.min(initial.length, config.rows || initial.length, RUNTIME_LIMITS.maxGridCells)
    const requestedColumns = config.columns || inferColumnCount(initial)
    const columns = rows > 0
      ? Math.min(requestedColumns, Math.floor(RUNTIME_LIMITS.maxGridCells / rows))
      : 0
    container.rows = rows
    container.columns = columns
    container.cells = Array.from({ length: rows }, (_, row) => (
      Array.from({ length: columns }, (_, column) => ({
        id: `${container.id}-cell-${row}-${column}`,
        row,
        column,
        value: initial[row]?.[column] ?? null,
        state: null,
      }))
    ))
    return
  }

  if (type === 'scalar') {
    const initial = parseJsonLiteral(args[1])
    if (initial !== undefined) container.value = initial
  }
}

function skipNonCode(source, index) {
  const char = source[index]
  const next = source[index + 1]

  if (char === '/' && next === '/') {
    const newline = source.indexOf('\n', index + 2)
    return newline === -1 ? source.length : newline + 1
  }

  if (char === '/' && next === '*') {
    const close = source.indexOf('*/', index + 2)
    return close === -1 ? source.length : close + 2
  }

  if (char === "'" || char === '"' || char === '`') {
    return skipQuoted(source, index, char)
  }

  return index
}

function skipQuoted(source, index, quote) {
  let cursor = index + 1
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2
      continue
    }
    if (source[cursor] === quote) return cursor + 1
    cursor += 1
  }
  return source.length
}

function skipWhitespaceAndComments(source, index) {
  let cursor = index
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1
      continue
    }
    if (source[cursor] === '/' && source[cursor + 1] === '/') {
      const newline = source.indexOf('\n', cursor + 2)
      cursor = newline === -1 ? source.length : newline + 1
      continue
    }
    if (source[cursor] === '/' && source[cursor + 1] === '*') {
      const close = source.indexOf('*/', cursor + 2)
      cursor = close === -1 ? source.length : close + 2
      continue
    }
    break
  }
  return cursor
}

function readIdentifier(source, index) {
  let end = index
  while (isIdentifierPart(source[end])) end += 1
  return { value: source.slice(index, end), end }
}

function isIdentifierPart(char) {
  return Boolean(char && /[A-Za-z0-9_$]/.test(char))
}

function parseStringLiteral(input) {
  const text = String(input || '').trim()
  if (text.length < 2) return undefined
  const quote = text[0]
  if (!['"', "'", '`'].includes(quote) || text[text.length - 1] !== quote) return undefined
  if (quote === '`' && text.includes('${')) return undefined

  let output = ''
  for (let index = 1; index < text.length - 1; index += 1) {
    if (text[index] !== '\\') {
      output += text[index]
      continue
    }

    index += 1
    if (index >= text.length - 1) break
    const escaped = text[index]
    const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }
    output += escapes[escaped] ?? escaped
  }
  return output
}

function parseJsonLiteral(input) {
  const text = String(input || '').trim()
  if (!text) return undefined
  const quoted = parseStringLiteral(text)
  if (quoted !== undefined) return quoted
  if (text === 'undefined') return undefined

  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function readNumericProperty(text, property) {
  const match = String(text).match(new RegExp(`\\b${property}\\s*:\\s*(\\d+)`))
  return match ? Number(match[1]) : undefined
}

function readBooleanProperty(text, property) {
  const match = String(text).match(new RegExp(`\\b${property}\\s*:\\s*(true|false)\\b`))
  return match ? match[1] === 'true' : undefined
}

function readStringProperty(text, property) {
  const match = String(text).match(new RegExp(`\\b${property}\\s*:\\s*(["'\\x60])([^"'\\x60]*)\\1`))
  return match?.[2]
}

function parsePositiveNumber(value) {
  const text = String(value || '').trim()
  if (!/^\d+$/.test(text)) return undefined
  return Number(text)
}

function inferColumnCount(value) {
  if (!Array.isArray(value)) return 0
  return value.reduce((maximum, row) => (
    Array.isArray(row) ? Math.max(maximum, row.length) : maximum
  ), 0)
}

function displayType(type) {
  return type === 'linkedList'
    ? 'Linked list'
    : `${type[0].toUpperCase()}${type.slice(1)}`
}
