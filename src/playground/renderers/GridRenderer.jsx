import { isSameCell, shortValue, stateClass, toArray } from './rendererUtils'

const MAX_DIMENSION = 80

function safeDimension(value) {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) && number > 0 ? Math.min(number, MAX_DIMENSION) : 0
}

function inferredDimensions(cells) {
  if (!Array.isArray(cells)) return { rows: 0, columns: 0 }

  if (cells.some(Array.isArray)) {
    return {
      rows: cells.length,
      columns: cells.reduce((maximum, row) => Math.max(maximum, Array.isArray(row) ? row.length : 0), 0),
    }
  }

  let rows = 0
  let columns = 0
  cells.forEach((cell) => {
    if (!cell || typeof cell !== 'object') return
    const row = Number(cell.row ?? cell.r)
    const column = Number(cell.column ?? cell.col ?? cell.c)
    if (Number.isFinite(row)) rows = Math.max(rows, row + 1)
    if (Number.isFinite(column)) columns = Math.max(columns, column + 1)
  })
  return { rows, columns }
}

function cellAt(cells, row, column, columns) {
  if (!Array.isArray(cells)) return undefined

  if (cells.some(Array.isArray)) {
    return Array.isArray(cells[row]) ? cells[row][column] : undefined
  }

  const coordinateCell = cells.find((cell) => (
    cell
    && typeof cell === 'object'
    && Number(cell.row ?? cell.r) === row
    && Number(cell.column ?? cell.col ?? cell.c) === column
  ))
  if (coordinateCell !== undefined) return coordinateCell

  return cells[row * columns + column]
}

function normalizeCell(cell, row, column) {
  if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
    return {
      ...cell,
      id: cell.id ?? `cell-${row}-${column}`,
      value: Object.prototype.hasOwnProperty.call(cell, 'value') ? cell.value : cell.label,
    }
  }

  return { id: `cell-${row}-${column}`, value: cell }
}

export default function GridRenderer({ container = {} }) {
  const cells = toArray(container.cells)
  const inferred = inferredDimensions(cells)
  const requestedRows = Number(container.rows)
  const requestedColumns = Number(container.columns)
  const rows = safeDimension(container.rows) || safeDimension(inferred.rows)
  const columns = safeDimension(container.columns) || safeDimension(inferred.columns)
  const relatedCells = toArray(container.relatedCells)
  const rowLabels = toArray(container.rowLabels)
  const columnLabels = toArray(container.columnLabels)
  const wasClamped = requestedRows > MAX_DIMENSION || requestedColumns > MAX_DIMENSION

  if (rows === 0 || columns === 0) {
    return (
      <div className="playground-renderer-empty grid-empty">
        <span className="playground-empty-grid-icon" aria-hidden="true">
          <i /><i /><i /><i />
        </span>
        <span>Empty grid</span>
        <small>Set rows and columns to initialize cells</small>
      </div>
    )
  }

  const renderedRows = Array.from({ length: rows }, (_, row) => row)
  const renderedColumns = Array.from({ length: columns }, (_, column) => column)

  return (
    <div className="playground-grid-viewport">
      <div
        className="playground-grid"
        role="grid"
        aria-rowcount={rows}
        aria-colcount={columns}
        style={{ gridTemplateColumns: `minmax(32px, auto) repeat(${columns}, minmax(46px, 1fr))` }}
      >
        <span className="playground-grid-corner" aria-hidden="true" />
        {renderedColumns.map((column) => (
          <span className="playground-grid-axis-label" key={`column-${column}`} role="columnheader">
            {shortValue(columnLabels[column] ?? column, 12)}
          </span>
        ))}

        {renderedRows.map((row) => (
          <div className="playground-grid-row" role="row" key={`row-${row}`}>
            <span className="playground-grid-axis-label" role="rowheader">
              {shortValue(rowLabels[row] ?? row, 12)}
            </span>
            {renderedColumns.map((column) => {
              const cell = normalizeCell(cellAt(cells, row, column, columns), row, column)
              const isActive = isSameCell(container.activeCell, row, column)
              const isRelated = relatedCells.some((candidate) => isSameCell(candidate, row, column))
              const classes = [
                'playground-grid-cell',
                stateClass(cell.state),
                isActive ? 'is-active' : '',
                isRelated ? 'is-related' : '',
              ].filter(Boolean).join(' ')

              return (
                <span
                  className={classes}
                  key={`${String(cell.id)}-${row}-${column}`}
                  role="gridcell"
                  aria-label={`Row ${row}, column ${column}: ${shortValue(cell.value ?? undefined, 80, 'empty')}`}
                  title={shortValue(cell.value ?? undefined, 160)}
                >
                  {shortValue(cell.value ?? undefined, 16)}
                </span>
              )
            })}
          </div>
        ))}
      </div>
      {wasClamped && <small className="playground-render-note">Showing the first {MAX_DIMENSION} rows and columns.</small>}
    </div>
  )
}
