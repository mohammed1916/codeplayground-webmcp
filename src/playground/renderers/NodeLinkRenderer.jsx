import { normalizeKind, numericCoordinate, safeDomId, shortValue, stateClass, toArray } from './rendererUtils'

const BASE_WIDTH = 720
const BASE_HEIGHT = 380
const NODE_RADIUS = 27
const LAYOUT_PADDING = 54

function endpointId(endpoint) {
  if (endpoint && typeof endpoint === 'object') return endpoint.id ?? endpoint.key ?? endpoint.label
  return endpoint
}

function normalizeNodes(nodes) {
  return toArray(nodes).map((node, index) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const id = node.id ?? node.key ?? `node-${index}`
      return {
        ...node,
        id,
        label: node.label ?? id,
      }
    }

    return { id: node ?? `node-${index}`, label: node ?? index }
  })
}

function normalizeEdges(edges) {
  return toArray(edges).map((edge, index) => {
    if (Array.isArray(edge)) {
      return {
        id: `edge-${index}`,
        from: endpointId(edge[0]),
        to: endpointId(edge[1]),
        weight: edge[2],
      }
    }

    const normalized = edge && typeof edge === 'object' ? edge : {}
    return {
      ...normalized,
      id: normalized.id ?? `edge-${index}`,
      from: endpointId(normalized.from ?? normalized.fromId ?? normalized.source),
      to: endpointId(normalized.to ?? normalized.toId ?? normalized.target),
    }
  })
}

function circularPositions(nodes, width, height) {
  if (nodes.length === 1) {
    return new Map([[String(nodes[0].id), { x: width / 2, y: height / 2 }]])
  }

  const radiusX = Math.max(80, Math.min(width * 0.39, nodes.length * 35))
  const radiusY = Math.max(76, Math.min(height * 0.34, 132))
  return new Map(nodes.map((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2 - Math.PI / 2
    return [String(node.id), {
      x: width / 2 + Math.cos(angle) * radiusX,
      y: height / 2 + Math.sin(angle) * radiusY,
    }]
  }))
}

function gridPositions(nodes, width) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)))
  const horizontalGap = Math.max(82, (width - LAYOUT_PADDING * 2) / Math.max(columns - 1, 1))
  const verticalGap = 96
  return new Map(nodes.map((node, index) => {
    const row = Math.floor(index / columns)
    const column = index % columns
    const nodesInRow = Math.min(columns, nodes.length - row * columns)
    const rowWidth = (nodesInRow - 1) * horizontalGap
    return [String(node.id), {
      x: width / 2 - rowWidth / 2 + column * horizontalGap,
      y: 68 + row * verticalGap,
    }]
  }))
}

function linearPositions(nodes) {
  const width = Math.max(BASE_WIDTH, nodes.length * 108 + LAYOUT_PADDING * 2)
  const positions = new Map(nodes.map((node, index) => [
    String(node.id),
    { x: LAYOUT_PADDING + 34 + index * 108, y: BASE_HEIGHT / 2 },
  ]))
  return { positions, width, height: BASE_HEIGHT }
}

function layeredPositions(nodes, edges, width) {
  const nodeIds = new Set(nodes.map((node) => String(node.id)))
  const adjacency = new Map(nodes.map((node) => [String(node.id), []]))
  const indegree = new Map(nodes.map((node) => [String(node.id), 0]))

  edges.forEach((edge) => {
    const from = String(edge.from)
    const to = String(edge.to)
    if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) return
    adjacency.get(from).push(to)
    indegree.set(to, (indegree.get(to) ?? 0) + 1)
  })

  const roots = nodes
    .map((node) => String(node.id))
    .filter((id) => (indegree.get(id) ?? 0) === 0)
  if (roots.length === 0 && nodes.length > 0) roots.push(String(nodes[0].id))

  const levelById = new Map()
  const queue = roots.map((id) => ({ id, level: 0 }))
  while (queue.length > 0) {
    const current = queue.shift()
    const previousLevel = levelById.get(current.id)
    if (previousLevel !== undefined && previousLevel <= current.level) continue
    levelById.set(current.id, current.level)
    ;(adjacency.get(current.id) ?? []).forEach((childId) => {
      queue.push({ id: childId, level: current.level + 1 })
    })
  }

  let lastLevel = levelById.size > 0 ? Math.max(...levelById.values()) : 0
  nodes.forEach((node) => {
    const id = String(node.id)
    if (!levelById.has(id)) {
      lastLevel += 1
      levelById.set(id, lastLevel)
    }
  })

  const layers = new Map()
  nodes.forEach((node) => {
    const level = levelById.get(String(node.id)) ?? 0
    if (!layers.has(level)) layers.set(level, [])
    layers.get(level).push(node)
  })

  const layerCount = Math.max(1, layers.size)
  const height = Math.max(BASE_HEIGHT, layerCount * 104 + LAYOUT_PADDING * 2)
  const widestLayer = Math.max(1, ...[...layers.values()].map((layer) => layer.length))
  const resolvedWidth = Math.max(width, widestLayer * 104 + LAYOUT_PADDING * 2)
  const positions = new Map()
  ;[...layers.entries()].sort(([a], [b]) => a - b).forEach(([level, layer]) => {
    const gap = (resolvedWidth - LAYOUT_PADDING * 2) / Math.max(layer.length, 1)
    layer.forEach((node, index) => {
      positions.set(String(node.id), {
        x: LAYOUT_PADDING + gap * (index + 0.5),
        y: LAYOUT_PADDING + 30 + level * ((height - LAYOUT_PADDING * 2 - 40) / Math.max(layerCount - 1, 1)),
      })
    })
  })

  return { positions, width: resolvedWidth, height }
}

function manualPositions(nodes, fallbackPositions, width, height) {
  const supplied = nodes
    .map((node) => ({ x: numericCoordinate(node.x), y: numericCoordinate(node.y) }))
    .filter(({ x, y }) => x !== null && y !== null)
  const normalized = supplied.length > 0 && supplied.every(({ x, y }) => (
    x >= 0 && x <= 1 && y >= 0 && y <= 1
  ))

  return new Map(nodes.map((node) => {
    let x = numericCoordinate(node.x)
    let y = numericCoordinate(node.y)
    const fallback = fallbackPositions.get(String(node.id)) ?? { x: width / 2, y: height / 2 }
    if (x === null || y === null) return [String(node.id), fallback]
    if (normalized) {
      x = LAYOUT_PADDING + x * (width - LAYOUT_PADDING * 2)
      y = LAYOUT_PADDING + y * (height - LAYOUT_PADDING * 2)
    }
    return [String(node.id), { x, y }]
  }))
}

function resolveLayout(nodes, edges, layout, type) {
  const resolvedLayout = normalizeKind(layout)
  const resolvedType = normalizeKind(type)

  if (['horizontal', 'linear', 'list', 'linked-list', 'doubly-linked-list'].includes(resolvedLayout)
    || ['list', 'linked-list', 'doubly-linked-list'].includes(resolvedType)) {
    return linearPositions(nodes)
  }

  if (['tree', 'hierarchical', 'layered'].includes(resolvedLayout)
    || ['tree', 'heap', 'trie', 'binary-tree', 'bst'].includes(resolvedType)) {
    return layeredPositions(nodes, edges, BASE_WIDTH)
  }

  const widestGrid = Math.max(BASE_WIDTH, Math.ceil(Math.sqrt(nodes.length)) * 104 + LAYOUT_PADDING * 2)
  const gridHeight = Math.max(BASE_HEIGHT, Math.ceil(nodes.length / Math.max(1, Math.ceil(Math.sqrt(nodes.length)))) * 96 + 100)
  if (resolvedLayout === 'grid') {
    return { positions: gridPositions(nodes, widestGrid), width: widestGrid, height: gridHeight }
  }

  const width = Math.max(BASE_WIDTH, Math.min(1400, nodes.length * 78))
  const height = BASE_HEIGHT
  const circular = circularPositions(nodes, width, height)
  if (resolvedLayout === 'manual' || nodes.some((node) => numericCoordinate(node.x) !== null && numericCoordinate(node.y) !== null)) {
    return { positions: manualPositions(nodes, circular, width, height), width, height }
  }

  return { positions: circular, width, height }
}

function buildParallelMetadata(edges) {
  const counts = new Map()
  edges.forEach((edge) => {
    const ends = [String(edge.from), String(edge.to)].sort()
    const key = `${ends[0]}\u0000${ends[1]}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  })

  const seen = new Map()
  return edges.map((edge) => {
    const ends = [String(edge.from), String(edge.to)].sort()
    const key = `${ends[0]}\u0000${ends[1]}`
    const index = seen.get(key) ?? 0
    seen.set(key, index + 1)
    return { index, count: counts.get(key) ?? 1 }
  })
}

function edgeGeometry(from, to, parallel, edge) {
  if (from.x === to.x && from.y === to.y) {
    const spread = parallel.index * 16
    const horizontalReach = 58 + spread
    const verticalReach = 76 + spread
    return {
      path: `M ${from.x - 15} ${from.y - 22} C ${from.x - horizontalReach} ${from.y - verticalReach}, ${from.x + horizontalReach} ${from.y - verticalReach}, ${from.x + 15} ${from.y - 22}`,
      labelX: from.x,
      labelY: from.y - verticalReach + 8,
    }
  }

  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.max(1, Math.hypot(dx, dy))
  const unitX = dx / distance
  const unitY = dy / distance
  const start = { x: from.x + unitX * NODE_RADIUS, y: from.y + unitY * NODE_RADIUS }
  const end = { x: to.x - unitX * (NODE_RADIUS + 3), y: to.y - unitY * (NODE_RADIUS + 3) }
  const centeredIndex = parallel.index - (parallel.count - 1) / 2
  const canonicalDirection = String(edge.from).localeCompare(String(edge.to)) <= 0 ? 1 : -1
  const curve = centeredIndex * 31 * canonicalDirection

  if (Math.abs(curve) < 1) {
    return {
      path: `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
      labelX: (start.x + end.x) / 2,
      labelY: (start.y + end.y) / 2 - 9,
    }
  }

  const perpendicularX = -unitY
  const perpendicularY = unitX
  const control = {
    x: (start.x + end.x) / 2 + perpendicularX * curve,
    y: (start.y + end.y) / 2 + perpendicularY * curve,
  }
  return {
    path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
    labelX: start.x * 0.25 + control.x * 0.5 + end.x * 0.25,
    labelY: start.y * 0.25 + control.y * 0.5 + end.y * 0.25 - 7,
  }
}

function graphDescription(container, nodes, edges) {
  const nodeLimit = 40
  const edgeLimit = 40
  const nodeText = nodes.slice(0, nodeLimit).map((node) => {
    const state = node.state ? `, state ${shortValue(node.state, 18)}` : ''
    return `${shortValue(node.label ?? node.id, 24)}${state}`
  }).join('; ')
  const edgeText = edges.slice(0, edgeLimit).map(({ edge }) => {
    const isDirected = edge.directed ?? container.directed ?? false
    const direction = isDirected ? 'to' : 'connected to'
    const detail = edgeLabel(edge)
    const state = edge.state ? `, state ${shortValue(edge.state, 18)}` : ''
    return `${shortValue(edge.from, 20)} ${direction} ${shortValue(edge.to, 20)}${detail ? `, ${detail}` : ''}${state}`
  }).join('; ')
  const moreNodes = nodes.length > nodeLimit ? `; and ${nodes.length - nodeLimit} more nodes` : ''
  const moreEdges = edges.length > edgeLimit ? `; and ${edges.length - edgeLimit} more edges` : ''
  return `Nodes: ${nodeText || 'none'}${moreNodes}. Edges: ${edgeText || 'none'}${moreEdges}.`
}

function edgeLabel(edge) {
  const hasLabel = edge.label !== undefined && edge.label !== null && edge.label !== ''
  const hasWeight = edge.weight !== undefined && edge.weight !== null
  if (hasLabel && hasWeight) return `${shortValue(edge.label, 18)} · ${shortValue(edge.weight, 12)}`
  if (hasLabel) return shortValue(edge.label, 24)
  if (hasWeight) return shortValue(edge.weight, 16)
  return ''
}

function emptyLabel(type) {
  if (type.includes('tree')) return 'Empty tree'
  if (type.includes('list')) return 'Empty linked list'
  if (type === 'trie') return 'Empty trie'
  if (type === 'heap') return 'Empty heap'
  return 'Empty graph'
}

export default function NodeLinkRenderer({ container = {} }) {
  const nodes = normalizeNodes(container.nodes)
  const edges = normalizeEdges(container.edges)
  const type = normalizeKind(container.type) || 'graph'

  if (nodes.length === 0) {
    return (
      <div className="playground-renderer-empty node-link-empty">
        <span className="playground-empty-node-link" aria-hidden="true"><i /><i /><i /></span>
        <span>{emptyLabel(type)}</span>
        <small>Nodes and edges will appear here</small>
      </div>
    )
  }

  const { positions, width, height } = resolveLayout(nodes, edges, container.layout, type)
  const markerId = `playground-arrow-${safeDomId(container.id, type)}`
  const titleId = `${markerId}-title`
  const descriptionId = `${markerId}-description`
  const parallelMetadata = buildParallelMetadata(edges)
  const validEdges = edges.map((edge, index) => ({ edge, parallel: parallelMetadata[index] })).filter(({ edge }) => (
    positions.has(String(edge.from)) && positions.has(String(edge.to))
  ))

  return (
    <div className="playground-node-link-viewport">
      <svg
        className="playground-node-link"
        viewBox={`-110 -110 ${width + 220} ${height + 220}`}
        style={{ minWidth: `${Math.min(width, 1080)}px` }}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
      >
        <title id={titleId}>{container.name ?? type}: {nodes.length} nodes and {validEdges.length} edges</title>
        <desc id={descriptionId}>{graphDescription(container, nodes, validEdges)}</desc>
        <defs>
          <marker id={markerId} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="strokeWidth">
            <path className="playground-arrowhead" d="M 0 0 L 9 4.5 L 0 9 z" />
          </marker>
        </defs>

        <g className="playground-edges">
          {validEdges.map(({ edge, parallel }, index) => {
            const from = positions.get(String(edge.from))
            const to = positions.get(String(edge.to))
            const geometry = edgeGeometry(from, to, parallel, edge)
            const label = edgeLabel(edge)
            const isDirected = edge.directed ?? container.directed ?? false
            return (
              <g className={`playground-edge ${stateClass(edge.state)}`} key={`${String(edge.id)}-${index}`}>
                <path
                  className="playground-edge-path"
                  d={geometry.path}
                  markerEnd={isDirected ? `url(#${markerId})` : undefined}
                />
                {label && (
                  <g className="playground-edge-label" transform={`translate(${geometry.labelX} ${geometry.labelY})`}>
                    <rect x={-Math.max(16, label.length * 3.8)} y="-11" width={Math.max(32, label.length * 7.6)} height="21" rx="7" />
                    <text textAnchor="middle" dominantBaseline="middle">{label}</text>
                  </g>
                )}
              </g>
            )
          })}
        </g>

        <g className="playground-nodes">
          {nodes.map((node, index) => {
            const position = positions.get(String(node.id)) ?? { x: width / 2, y: height / 2 }
            const label = shortValue(node.label ?? node.id, 12)
            const hasValue = node.value !== undefined && String(node.value) !== String(node.label ?? node.id)
            return (
              <g
                className={`playground-node ${stateClass(node.state)}`}
                key={`${String(node.id)}-${index}`}
                transform={`translate(${position.x} ${position.y})`}
              >
                <circle r={NODE_RADIUS} />
                <text className="playground-node-label" textAnchor="middle" dominantBaseline={hasValue ? 'auto' : 'middle'} y={hasValue ? -3 : 1}>
                  {label}
                </text>
                {hasValue && (
                  <text className="playground-node-value" textAnchor="middle" dominantBaseline="middle" y="12">
                    {shortValue(node.value, 14)}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}
