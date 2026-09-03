const EMPTY_TEXT = '—'

export function toArray(value) {
  return Array.isArray(value) ? value : []
}

export function normalizeKind(value) {
  return String(value ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
}

export function safeDomId(value, fallback = 'visual') {
  const safe = String(value ?? fallback).replace(/[^a-zA-Z0-9_-]/g, '-')
  return safe || fallback
}

export function stateClass(state) {
  let resolved = state

  if (state && typeof state === 'object') {
    resolved = Object.keys(state).find((key) => state[key])
  }

  const safe = normalizeKind(resolved).replace(/[^a-z0-9-]/g, '')
  return safe ? `is-${safe}` : ''
}

export function displayValue(value, fallback = EMPTY_TEXT) {
  if (value === undefined) return fallback
  if (value === null) return 'null'
  if (typeof value === 'string') return value === '' ? '“”' : value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`

  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? String(value) : serialized
  } catch {
    return String(value)
  }
}

export function shortValue(value, maxLength = 26, fallback = EMPTY_TEXT) {
  const text = displayValue(value, fallback)
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}…` : text
}

export function numericCoordinate(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function cellCoordinates(cell) {
  if (Array.isArray(cell)) {
    return { row: Number(cell[0]), column: Number(cell[1]) }
  }

  if (cell && typeof cell === 'object') {
    return {
      row: Number(cell.row ?? cell.r ?? cell[0]),
      column: Number(cell.column ?? cell.col ?? cell.c ?? cell[1]),
    }
  }

  if (typeof cell === 'string') {
    const [row, column] = cell.split(/[:,]/).map(Number)
    return { row, column }
  }

  return { row: Number.NaN, column: Number.NaN }
}

export function isSameCell(candidate, row, column) {
  const coordinates = cellCoordinates(candidate)
  return coordinates.row === row && coordinates.column === column
}
