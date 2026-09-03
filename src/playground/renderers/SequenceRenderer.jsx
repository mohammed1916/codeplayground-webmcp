import {
  displayValue,
  normalizeKind,
  safeDomId,
  shortValue,
  stateClass,
  toArray,
} from './rendererUtils'

const LINE_HEIGHT = 270
const LINE_PADDING = Object.freeze({ top: 42, right: 28, bottom: 42, left: 58 })
const POINTER_COLORS = Object.freeze([
  '#7c3aed',
  '#0891b2',
  '#e11d48',
  '#16a34a',
  '#d97706',
  '#2563eb',
  '#c026d3',
  '#0f766e',
])

function pointerColor(pointer) {
  const text = String(pointer.id ?? pointer.label ?? '')
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return POINTER_COLORS[(hash >>> 0) % POINTER_COLORS.length]
}

function normalizeItems(items) {
  return toArray(items).map((item, index) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return {
        ...item,
        id: item.id ?? `item-${index}`,
        value: Object.prototype.hasOwnProperty.call(item, 'value') ? item.value : item.label,
        originalIndex: index,
      }
    }

    return { id: `item-${index}`, value: item, originalIndex: index }
  })
}

function normalizePointers(pointers) {
  if (Array.isArray(pointers)) {
    return pointers.map((pointer, index) => {
      if (pointer && typeof pointer === 'object') {
        return {
          ...pointer,
          id: pointer.id ?? `pointer-${index}`,
          label: pointer.label ?? pointer.name ?? pointer.id ?? `p${index}`,
          index: Number(pointer.index ?? pointer.at ?? pointer.target),
        }
      }

      return { id: `pointer-${index}`, label: `p${index}`, index: Number(pointer) }
    })
  }

  if (pointers && typeof pointers === 'object') {
    return Object.entries(pointers).map(([label, value]) => {
      const pointer = value && typeof value === 'object' ? value : { index: value }
      return {
        ...pointer,
        id: pointer.id ?? `pointer-${label}`,
        label: pointer.label ?? label,
        index: Number(pointer.index ?? pointer.at ?? pointer.target),
      }
    })
  }

  return []
}

function emptyLabel(type) {
  if (type === 'string') return 'Empty string'
  if (type === 'stack') return 'Empty stack'
  if (type === 'queue') return 'Empty queue'
  if (type === 'deque') return 'Empty deque'
  return 'Empty sequence'
}

function resolveView(container) {
  if (typeof container.view === 'string') {
    return { mode: normalizeKind(container.view) }
  }

  if (container.view && typeof container.view === 'object') {
    return {
      ...container.view,
      mode: normalizeKind(container.view.mode),
    }
  }

  return { mode: 'cells' }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function readDomain(domain) {
  let minimum
  let maximum

  if (Array.isArray(domain)) {
    ;[minimum, maximum] = domain
  } else if (domain && typeof domain === 'object') {
    minimum = domain.min
    maximum = domain.max
  }

  minimum = Number(minimum)
  maximum = Number(maximum)
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return null
  if (minimum > maximum) return { minimum: maximum, maximum: minimum, supplied: true }
  return { minimum, maximum, supplied: true }
}

function resolveDomain(items, suppliedDomain) {
  const supplied = readDomain(suppliedDomain)
  let minimum = supplied?.minimum ?? Math.min(0, ...items.map((item) => item.value))
  let maximum = supplied?.maximum ?? Math.max(0, ...items.map((item) => item.value))

  if (minimum === maximum) {
    const padding = Math.max(1, Math.abs(minimum) * 0.1)
    minimum -= padding
    maximum += padding
  }

  return {
    minimum,
    maximum,
    supplied: Boolean(supplied),
    span: maximum - minimum,
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function yPercent(value, domain) {
  const clamped = clamp(value, domain.minimum, domain.maximum)
  return ((domain.maximum - clamped) / domain.span) * 100
}

function axisLabel(value) {
  const absolute = Math.abs(value)
  if (absolute !== 0 && (absolute >= 1_000_000 || absolute < 0.001)) {
    return value.toExponential(2)
  }
  return String(Number(value.toFixed(4)))
}

function itemDescription(item, itemPointers) {
  const details = [`Index ${item.originalIndex}`, `value ${displayValue(item.value)}`]
  if (item.state) details.push(`state ${displayValue(item.state)}`)
  if (itemPointers.length > 0) {
    details.push(`pointers ${itemPointers.map((pointer) => displayValue(pointer.label)).join(', ')}`)
  }
  return details.join(', ')
}

function PointerLabels({ pointers, ariaHidden = false }) {
  return (
    <div className="playground-pointer-slot" aria-hidden={ariaHidden || undefined}>
      {pointers.map((pointer) => (
        <span
          className={`playground-pointer ${stateClass(pointer.state)}`}
          key={String(pointer.id)}
          title={`Points to index ${pointer.index}`}
          style={{ '--playground-pointer-color': pointerColor(pointer) }}
        >
          {shortValue(pointer.label, 14)}
        </span>
      ))}
    </div>
  )
}

function CellsView({ items, pointers, type }) {
  return (
    <div className={`playground-sequence playground-sequence-${type}`}>
      <div className="playground-sequence-track" role="list" aria-label={`${type} values`}>
        {items.map((item, visualIndex) => {
          const itemPointers = pointers.filter((pointer) => pointer.index === item.originalIndex)
          const isFront = item.originalIndex === 0
          const isBack = item.originalIndex === items.length - 1

          return (
            <div className="playground-sequence-item-shell" key={String(item.id ?? visualIndex)} role="listitem">
              <PointerLabels pointers={itemPointers} />
              <div
                className={`playground-sequence-cell ${stateClass(item.state)}`}
                data-state={item.state == null ? undefined : displayValue(item.state)}
                title={displayValue(item.value)}
              >
                <span>{shortValue(item.value, 18)}</span>
              </div>
              <div className="playground-sequence-index">
                <span>{item.originalIndex}</span>
                {type === 'stack' && visualIndex === 0 && <b>top</b>}
                {type === 'queue' && isFront && <b>front</b>}
                {type === 'queue' && isBack && <b>back</b>}
                {type === 'deque' && isFront && <b>front</b>}
                {type === 'deque' && isBack && <b>back</b>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function BarsView({ items, pointers, view, type }) {
  const domain = resolveDomain(items, view.domain)
  const zeroPosition = yPercent(0, domain)
  const showLabels = view.labels !== false
  const minimumWidth = Math.max(360, items.length * 58 + 76)

  return (
    <div className="playground-chart-viewport playground-bars-viewport">
      <div
        className={`playground-bars playground-bars-${type}`}
        style={{ minWidth: `${minimumWidth}px`, '--playground-zero': `${zeroPosition}%` }}
        role="list"
        aria-label={`${type} bar chart, domain ${axisLabel(domain.minimum)} to ${axisLabel(domain.maximum)}`}
      >
        <div className="playground-chart-axis playground-chart-axis-y" aria-hidden="true">
          <span>{axisLabel(domain.maximum)}</span>
          {domain.minimum < 0 && domain.maximum > 0 && <span style={{ top: `${zeroPosition}%` }}>0</span>}
          <span>{axisLabel(domain.minimum)}</span>
        </div>
        <div className="playground-bars-track">
          {items.map((item, visualIndex) => {
            const itemPointers = pointers.filter((pointer) => pointer.index === item.originalIndex)
            const valuePosition = yPercent(item.value, domain)
            const barTop = Math.min(valuePosition, zeroPosition)
            const barHeight = Math.abs(zeroPosition - valuePosition)
            const negative = item.value < 0
            const clipped = item.value < domain.minimum || item.value > domain.maximum

            return (
              <div
                className="playground-bar-column"
                key={String(item.id ?? visualIndex)}
                role="listitem"
                aria-label={`${itemDescription(item, itemPointers)}${clipped ? ', clipped to chart domain' : ''}`}
              >
                <PointerLabels pointers={itemPointers} ariaHidden />
                <div className="playground-bar-plot" aria-hidden="true">
                  <span
                    className={`playground-bar-fill ${stateClass(item.state)} ${negative ? 'is-negative-value' : ''} ${clipped ? 'is-clipped' : ''}`}
                    style={{
                      '--playground-bar-top': `${barTop}%`,
                      '--playground-bar-height': `${barHeight}%`,
                    }}
                  >
                    {showLabels && <span className="playground-bar-value">{shortValue(item.value, 10)}</span>}
                  </span>
                </div>
                <span className="playground-chart-index" aria-hidden="true">{item.originalIndex}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function LineView({ items, pointers, view, type, containerId }) {
  const domain = resolveDomain(items, view.domain)
  const width = Math.max(600, (items.length - 1) * 64 + LINE_PADDING.left + LINE_PADDING.right)
  const maximumPointers = Math.max(
    0,
    ...items.map((item) => pointers.filter((pointer) => pointer.index === item.originalIndex).length),
  )
  const topPadding = Math.max(LINE_PADDING.top, 26 + maximumPointers * 22)
  const plotWidth = width - LINE_PADDING.left - LINE_PADDING.right
  const plotHeight = LINE_HEIGHT - topPadding - LINE_PADDING.bottom
  const showLabels = view.labels ?? items.length <= 24
  const xFor = (index) => (
    items.length === 1
      ? LINE_PADDING.left + plotWidth / 2
      : LINE_PADDING.left + (index / (items.length - 1)) * plotWidth
  )
  const yFor = (value) => topPadding + (yPercent(value, domain) / 100) * plotHeight
  const points = items.map((item, index) => ({
    item,
    x: xFor(index),
    y: yFor(item.value),
    pointers: pointers.filter((pointer) => pointer.index === item.originalIndex),
  }))
  const zeroY = yFor(0)
  const description = items
    .slice(0, 50)
    .map((item) => `${item.originalIndex}: ${displayValue(item.value)}`)
    .join('; ')
  const moreDescription = items.length > 50 ? `; and ${items.length - 50} more values` : ''
  const safeId = safeDomId(containerId, 'sequence')
  const titleId = `playground-line-${safeId}-title`
  const descriptionId = `playground-line-${safeId}-description`
  const chartDescription = `Domain ${axisLabel(domain.minimum)} to ${axisLabel(domain.maximum)}. Values: ${description}${moreDescription}.`

  return (
    <div className="playground-chart-viewport playground-line-viewport">
      <svg
        className={`playground-line-chart playground-line-${type}`}
        viewBox={`0 0 ${width} ${LINE_HEIGHT}`}
        style={{ minWidth: `${width}px` }}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
      >
        <title id={titleId}>{`${type} line chart`}</title>
        <desc id={descriptionId}>{chartDescription}</desc>

        <g className="playground-line-grid" aria-hidden="true">
          <line x1={LINE_PADDING.left} y1={topPadding} x2={width - LINE_PADDING.right} y2={topPadding} />
          <line x1={LINE_PADDING.left} y1={topPadding + plotHeight / 2} x2={width - LINE_PADDING.right} y2={topPadding + plotHeight / 2} />
          <line x1={LINE_PADDING.left} y1={topPadding + plotHeight} x2={width - LINE_PADDING.right} y2={topPadding + plotHeight} />
          {domain.minimum < 0 && domain.maximum > 0 && (
            <line className="playground-line-zero" x1={LINE_PADDING.left} y1={zeroY} x2={width - LINE_PADDING.right} y2={zeroY} />
          )}
        </g>

        <g className="playground-line-axis-labels" aria-hidden="true">
          <text x={LINE_PADDING.left - 9} y={topPadding + 3}>{axisLabel(domain.maximum)}</text>
          <text x={LINE_PADDING.left - 9} y={topPadding + plotHeight + 3}>{axisLabel(domain.minimum)}</text>
        </g>

        <g className="playground-line-series">
          {points.slice(1).map((point, index) => {
            const previous = points[index]
            return (
              <line
                className={`playground-line-segment ${stateClass(point.item.state)}`}
                key={`segment-${String(previous.item.id)}-${String(point.item.id)}`}
                x1={previous.x}
                y1={previous.y}
                x2={point.x}
                y2={point.y}
                aria-hidden="true"
              />
            )
          })}
          {points.map(({ item, x, y, pointers: itemPointers }) => (
            <g className="playground-line-datum" key={String(item.id)}>
              {itemPointers.map((pointer, pointerIndex) => {
                const label = shortValue(pointer.label, 12)
                const labelWidth = Math.max(28, label.length * 7 + 12)
                const labelY = y - 26 - pointerIndex * 22
                return (
                  <g className={`playground-line-pointer ${stateClass(pointer.state)}`} key={String(pointer.id)} aria-hidden="true">
                    <line x1={x} y1={labelY + 9} x2={x} y2={Math.max(labelY + 12, y - 8)} />
                    <rect x={x - labelWidth / 2} y={labelY - 9} width={labelWidth} height="18" rx="9" />
                    <text x={x} y={labelY + 3}>{label}</text>
                  </g>
                )
              })}
              <circle
                className={`playground-line-point ${stateClass(item.state)}`}
                cx={x}
                cy={y}
                r="5"
                tabIndex="0"
                aria-label={itemDescription(item, itemPointers)}
              >
                <title>{itemDescription(item, itemPointers)}</title>
              </circle>
              {showLabels && (
                <text
                  className="playground-line-value"
                  x={x}
                  y={itemPointers.length > 0 ? Math.min(LINE_HEIGHT - 24, y + 17) : Math.max(14, y - 11)}
                  aria-hidden="true"
                >
                  {shortValue(item.value, 10)}
                </text>
              )}
              <text className="playground-line-index" x={x} y={LINE_HEIGHT - 14} aria-hidden="true">
                {item.originalIndex}
              </text>
            </g>
          ))}
        </g>
      </svg>
      <ul className="playground-chart-sr-only" aria-label={`${type} line chart data`}>
        {points.map(({ item, pointers: itemPointers }) => (
          <li key={`description-${String(item.id)}`}>{itemDescription(item, itemPointers)}</li>
        ))}
      </ul>
    </div>
  )
}

export default function SequenceRenderer({ container = {} }) {
  const type = normalizeKind(container.type) || 'array'
  const sourceItems = normalizeItems(container.items)
  const isStack = type === 'stack'
  const items = isStack ? [...sourceItems].reverse() : sourceItems
  const pointers = normalizePointers(container.pointers)
  const view = resolveView(container)

  if (items.length === 0) {
    return (
      <div className={`playground-renderer-empty sequence-empty is-${type}`}>
        <span className="playground-empty-symbol" aria-hidden="true">[ ]</span>
        <span>{emptyLabel(type)}</span>
        <small>Ready for values</small>
      </div>
    )
  }

  const requestedChart = view.mode === 'bars' || view.mode === 'line'
  const numeric = items.every((item) => isFiniteNumber(item.value))

  if (requestedChart && !numeric) {
    return (
      <div className="playground-sequence-fallback">
        <CellsView items={items} pointers={pointers} type={type} />
        <small role="status">{view.mode === 'bars' ? 'Bars' : 'Line'} view requires finite numeric values. Showing cells instead.</small>
      </div>
    )
  }

  if (view.mode === 'bars') {
    return <BarsView items={items} pointers={pointers} view={view} type={type} />
  }

  if (view.mode === 'line') {
    return (
      <LineView
        items={items}
        pointers={pointers}
        view={view}
        type={type}
        containerId={container.id}
      />
    )
  }

  return <CellsView items={items} pointers={pointers} type={type} />
}
