import { RUNTIME_LIMITS, sanitizeLabel } from '../model.js'

const MAX_DEFAULT_BINDINGS = 12

export function createDefaultPythonBindings(variables = [], loopBindings = []) {
  const catalog = Array.isArray(variables?.variables) ? variables.variables : variables
  const loops = Array.isArray(variables?.loopBindings) && arguments.length === 1
    ? variables.loopBindings
    : loopBindings
  const safeCatalog = Array.isArray(catalog) ? catalog : []
  const loopByName = new Map(normalizeLoopBindings(loops).map((binding) => [binding.name, binding]))
  const sequenceNames = safeCatalog
    .filter((variable) => normalizeBindingKind(variable.suggestedKind) === 'sequence')
    .map((variable) => variable.name)

  const bindings = {}
  safeCatalog.forEach((variable, index) => {
    const name = String(variable?.name || '')
    if (!name) return
    const kind = normalizeBindingKind(variable.suggestedKind)
    const loop = loopByName.get(name) || (variable.isLoopBinding ? variable : null)
    const targetHint = normalizeTargetName(loop?.target ?? variable.targetHint)
    const target = targetHint && sequenceNames.includes(targetHint)
      ? targetHint
      : (sequenceNames.length === 1 ? sequenceNames[0] : null)
    const pointerMode = normalizePointerMode(loop?.loopRole ?? loop?.role)
    const isLoopPointer = kind === 'scalar' && pointerMode && target
    const isTransientListNode = kind === 'graph'
      && /listnode/i.test(String(variable?.types ?? variable?.runtimeType ?? ''))
      && !['$return', 'root'].includes(name)

    bindings[name] = {
      enabled: !isTransientListNode && (index < MAX_DEFAULT_BINDINGS || name === '$return'),
      // A null kind means "Auto". Keep inference live across later runs until
      // the user explicitly chooses a visual kind in the controls.
      kind: null,
      label: sanitizeLabel(variable?.label, name),
      view: defaultView(kind),
      role: isLoopPointer ? 'pointer' : 'value',
      target: isLoopPointer ? target : null,
      pointerMode: isLoopPointer ? pointerMode : null,
      indexOffset: isLoopPointer ? finiteInteger(loop?.indexOffset ?? variable.indexOffset, 0) : 0,
    }
  })
  return bindings
}

export function compilePythonTrace(traceResult = {}, bindings) {
  const traceFrames = Array.isArray(traceResult?.traceFrames) ? traceResult.traceFrames : []
  const variables = Array.isArray(traceResult?.variables) ? traceResult.variables : []
  const bindingSource = bindings ?? createDefaultPythonBindings(variables, traceResult?.loopBindings)
  const resolvedBindings = normalizeBindings(bindingSource, variables)
  const valueBindings = resolvedBindings
    .filter((binding) => binding.enabled && binding.role !== 'pointer')
    .slice(0, RUNTIME_LIMITS.maxContainers)
  const pointerBindings = resolvedBindings.filter((binding) => binding.enabled && binding.role === 'pointer')
  const ids = buildStableContainerIds(valueBindings)
  const scopeStates = new Map()
  const previousRenderedValues = new Map()
  const previousRenderedOrigins = new Map()
  const frames = []
  let scopeOrder = 0

  traceFrames.forEach((traceFrame) => {
    const locals = isPlainObject(traceFrame?.locals) ? traceFrame.locals : {}
    const localTypes = isPlainObject(traceFrame?.localTypes) ? traceFrame.localTypes : {}
    const changed = new Set(Array.isArray(traceFrame?.changed) ? traceFrame.changed : [])
    const hasScopedTrace = traceFrame?.scopeId !== undefined && traceFrame?.scopeId !== null
    const scopeId = String(traceFrame?.scopeId ?? '__legacy-python-scope__')
    if (hasScopedTrace && traceFrame?.event === 'return' && traceFrame?.isEntryScope) {
      scopeStates.forEach((_, activeScopeId) => {
        if (activeScopeId !== scopeId) scopeStates.delete(activeScopeId)
      })
    }
    const existingScope = scopeStates.get(scopeId)
    const scopeState = {
      id: scopeId,
      parentId: traceFrame?.parentScopeId == null ? null : String(traceFrame.parentScopeId),
      depth: finiteInteger(traceFrame?.depth, existingScope?.depth ?? 0),
      order: existingScope?.order ?? scopeOrder++,
      locals: new Map(Object.entries(locals)),
      localTypes: new Map(Object.entries(localTypes)),
      loopDetails: new Map(Object.entries(
        isPlainObject(traceFrame?.loopBindingDetails) ? traceFrame.loopBindingDetails : {},
      )),
    }
    scopeStates.set(scopeId, scopeState)
    const visible = resolveVisibleLocals(scopeStates)

    const containers = valueBindings.flatMap((binding) => {
      if (!visible.values.has(binding.name)) return []
      const value = visible.values.get(binding.name)
      const previous = previousRenderedValues.get(binding.name)
      const origin = visible.origins.get(binding.name)
      const wasRendered = previousRenderedValues.has(binding.name)
      const renderedChanged = (
        (changed.has(binding.name) && origin === scopeId)
        || (wasRendered && previousRenderedOrigins.get(binding.name) !== origin)
        || (wasRendered && !sameJsonValue(previous, value))
      )
      const container = createContainer({
        binding,
        id: ids.get(binding.name),
        value,
        previous,
        runtimeType: visible.types.get(binding.name),
        changed: renderedChanged,
      })
      previousRenderedValues.set(binding.name, cloneJsonValue(value))
      previousRenderedOrigins.set(binding.name, origin)
      return container ? [container] : []
    })

    attachPointers(containers, pointerBindings, visible.values, visible.loopDetails)

    const line = finiteLine(traceFrame?.line)
    const functionName = String(traceFrame?.function || traceResult?.entry?.functionName || '<module>')
    const message = sanitizeLabel(
      traceFrame?.message,
      line == null ? `Python ${traceFrame?.event || 'trace'}` : `Line ${line} in ${functionName}`,
    )
    const source = {
      language: 'python',
      line,
      function: functionName,
    }
    const scene = { containers, message }
    frames.push({
      id: frames.length,
      message,
      operation: `python.${normalizeOperation(traceFrame?.event)}`,
      source,
      scene,
    })

    if (hasScopedTrace && traceFrame?.event === 'return' && !traceFrame?.isEntryScope) {
      scopeStates.delete(scopeId)
    }
  })

  if (frames.length === 0) {
    const message = traceResult?.entry?.displayName
      ? `Python trace completed: ${traceResult.entry.displayName}`
      : 'Python trace completed'
    frames.push({
      id: 0,
      message,
      operation: 'python.complete',
      source: { language: 'python', line: null, function: traceResult?.entry?.functionName || '<module>' },
      scene: { containers: [], message },
    })
  }

  const truncation = normalizeTruncation(traceResult)
  const warning = truncation.truncated
    ? sanitizeLabel(
      truncation.message,
      truncation.finalStatePreserved
        ? `Trace was limited to ${truncation.maxFrames || frames.length} frames; final state preserved.`
        : `Trace was limited to ${truncation.maxFrames || frames.length} frames.`,
    )
    : null
  if (warning && frames.length > 0) {
    frames.at(-1).warning = warning
    frames.at(-1).scene.warning = warning
  }

  return {
    frames,
    scene: cloneJsonValue(frames.at(-1).scene),
    truncated: truncation.truncated,
    warning,
    metadata: {
      truncated: truncation.truncated,
      truncation,
    },
  }
}

function resolveVisibleLocals(scopeStates) {
  const orderedScopes = [...scopeStates.values()].sort((first, second) => (
    first.depth - second.depth || first.order - second.order
  ))
  const values = new Map()
  const types = new Map()
  const origins = new Map()
  const loopDetails = new Map()

  orderedScopes.forEach((scope) => {
    scope.locals.forEach((value, name) => {
      values.set(name, value)
      origins.set(name, scope.id)
    })
    scope.localTypes.forEach((value, name) => types.set(name, value))
    scope.loopDetails.forEach((value, name) => loopDetails.set(name, value))
  })

  return { values, types, origins, loopDetails }
}

function normalizeTruncation(traceResult) {
  const source = isPlainObject(traceResult?.truncation) ? traceResult.truncation : {}
  const truncated = Boolean(source.truncated ?? traceResult?.truncated)
  return {
    truncated,
    maxFrames: finiteInteger(source.maxFrames, 0),
    recordedFrames: finiteInteger(source.recordedFrames, 0),
    omittedEvents: finiteInteger(source.omittedEvents, 0),
    totalTraceEvents: finiteInteger(source.totalTraceEvents, 0),
    finalStatePreserved: source.finalStatePreserved === true,
    message: typeof source.message === 'string' && source.message.trim() ? source.message : null,
  }
}

function normalizeBindings(bindings, variables) {
  const catalog = new Map(
    variables
      .filter((variable) => variable?.name)
      .map((variable) => [String(variable.name), variable]),
  )
  let entries

  if (Array.isArray(bindings)) {
    entries = bindings.map((binding) => {
      if (typeof binding === 'string') return [binding, {}]
      const name = binding?.name ?? binding?.variable ?? binding?.path
      return [name, binding]
    })
  } else if (isPlainObject(bindings)) {
    entries = Object.entries(bindings)
  } else {
    entries = []
  }

  return entries.flatMap(([rawName, rawConfig]) => {
    const name = String(rawName || '')
    if (!name) return []
    const config = typeof rawConfig === 'string' ? { kind: rawConfig } : (rawConfig || {})
    const variable = catalog.get(name) || {}
    const role = config.role === 'pointer' ? 'pointer' : 'value'
    const requestedKind = String(config.kind || '').trim().toLowerCase()
    const kind = role === 'pointer'
      ? 'scalar'
      : normalizeBindingKind(
        requestedKind && requestedKind !== 'auto' ? requestedKind : variable.suggestedKind,
      )
    return [{
      name,
      variableId: typeof variable.id === 'string' && variable.id ? variable.id : null,
      label: sanitizeLabel(config.label, name),
      enabled: config.enabled !== false,
      kind,
      view: String(config.view || defaultView(kind)),
      role,
      target: normalizeTargetName(config.target),
      pointerMode: normalizePointerMode(config.pointerMode ?? variable.loopRole),
      indexOffset: finiteInteger(config.indexOffset ?? variable.indexOffset, 0),
      directed: typeof config.directed === 'boolean' ? config.directed : undefined,
      layout: typeof config.layout === 'string' ? config.layout : null,
    }]
  })
}

function createContainer({ binding, id, value, previous, runtimeType, changed }) {
  if (binding.name === '$return' && isLinkedListNode(value)) {
    return createSequenceContainer(
      { ...binding, view: binding.view || 'cells' },
      id,
      linkedListToArray(value),
      isLinkedListNode(previous) ? linkedListToArray(previous) : previous,
      'list',
      changed,
    )
  }
  if (binding.kind === 'graph' || binding.kind === 'tree' || binding.kind === 'heap') {
    return createNodeLinkContainer(binding, id, value, previous, changed)
  }
  if (binding.kind === 'grid') {
    return createGridContainer(binding, id, value, previous, changed)
  }
  if (binding.kind === 'associative') {
    return createAssociativeContainer(binding, id, value, previous, runtimeType, changed)
  }
  if (binding.kind === 'scalar') {
    return {
      id,
      name: binding.label,
      category: 'scalar',
      type: normalizeScalarType(runtimeType),
      bindingName: binding.name,
      view: binding.view,
      value: cloneJsonValue(value),
      state: changed ? 'changed' : null,
    }
  }
  return createSequenceContainer(binding, id, value, previous, runtimeType, changed)
}

function createSequenceContainer(binding, id, value, previous, runtimeType, changed) {
  const values = typeof value === 'string'
    ? [...value]
    : (Array.isArray(value) ? value : [value])
  const previousValues = typeof previous === 'string'
    ? [...previous]
    : (Array.isArray(previous) ? previous : [])
  const limitedValues = values.slice(0, RUNTIME_LIMITS.maxSequenceItems)

  return {
    id,
    name: binding.label,
    category: 'sequence',
    type: normalizeSequenceType(runtimeType),
    bindingName: binding.name,
    view: binding.view,
    items: limitedValues.map((item, index) => ({
      id: `${id}-item-${index}`,
      value: compactRuntimeValue(item),
      state: changed && !sameJsonValue(item, previousValues[index]) ? 'changed' : null,
    })),
    pointers: [],
  }
}

function compactRuntimeValue(value, depth = 0) {
  if (isLinkedListNode(value)) return `ListNode(${String(value.val)})`
  if (depth >= 3) return cloneJsonValue(value)
  if (Array.isArray(value)) {
    return value.map((item) => compactRuntimeValue(item, depth + 1))
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== '__class__')
        .map(([key, item]) => [key, compactRuntimeValue(item, depth + 1)]),
    )
  }
  return cloneJsonValue(value)
}

function createGridContainer(binding, id, value, previous, changed) {
  const rowsSource = Array.isArray(value)
    ? (value.every((row) => Array.isArray(row)) ? value : [value])
    : []
  const rows = Math.min(rowsSource.length, RUNTIME_LIMITS.maxGridCells)
  const requestedColumns = rowsSource.reduce((maximum, row) => (
    Array.isArray(row) ? Math.max(maximum, row.length) : maximum
  ), 0)
  const columns = rows > 0
    ? Math.min(requestedColumns, Math.floor(RUNTIME_LIMITS.maxGridCells / rows))
    : 0
  const previousRows = Array.isArray(previous)
    ? (previous.every((row) => Array.isArray(row)) ? previous : [previous])
    : []

  return {
    id,
    name: binding.label,
    category: 'grid',
    type: 'dp',
    bindingName: binding.name,
    view: binding.view,
    rows,
    columns,
    cells: Array.from({ length: rows }, (_, row) => (
      Array.from({ length: columns }, (_, column) => {
        const cellValue = rowsSource[row]?.[column] ?? null
        return {
          id: `${id}-cell-${row}-${column}`,
          row,
          column,
          value: cloneJsonValue(cellValue),
          state: changed && !sameJsonValue(cellValue, previousRows[row]?.[column]) ? 'changed' : null,
        }
      })
    )),
    pointers: [],
  }
}

function createAssociativeContainer(binding, id, value, previous, runtimeType, changed) {
  const isSet = runtimeType === 'set'
  const entries = isSet && Array.isArray(value)
    ? value.map((item) => [item, item])
    : (isPlainObject(value) ? Object.entries(value) : [])
  const previousEntries = new Map(
    isSet && Array.isArray(previous)
      ? previous.map((item) => [stableKey(item), item])
      : (isPlainObject(previous)
        ? Object.entries(previous).map(([key, item]) => [stableKey(key), item])
        : []),
  )

  return {
    id,
    name: binding.label,
    category: 'associative',
    type: isSet ? 'set' : 'map',
    bindingName: binding.name,
    view: binding.view,
    entries: entries.slice(0, RUNTIME_LIMITS.maxAssociativeEntries).map(([key, entryValue]) => ({
      id: `${id}-entry-${hashString(stableKey(key))}`,
      key: cloneJsonValue(key),
      value: cloneJsonValue(entryValue),
      state: changed && !sameJsonValue(entryValue, previousEntries.get(stableKey(key))) ? 'changed' : null,
    })),
  }
}

function createNodeLinkContainer(binding, id, value, previous, changed) {
  const build = binding.kind === 'tree'
    ? buildTreeData
    : binding.kind === 'heap'
      ? buildHeapData
      : buildGraphData
  const current = build(value, id, binding)
  const previousData = previous === undefined ? { nodes: [], edges: [] } : build(previous, id, binding)
  const previousNodes = new Map(previousData.nodes.map((node) => [String(node.id), stableKey({
    label: node.label,
    value: node.value,
  })]))
  const previousEdges = new Set(previousData.edges.map((edge) => stableKey({
    from: edge.from,
    to: edge.to,
    weight: edge.weight,
    label: edge.label,
  })))

  return {
    id,
    name: binding.label,
    category: 'node-link',
    type: binding.kind,
    bindingName: binding.name,
    view: binding.view,
    directed: binding.directed ?? current.directed ?? ['tree', 'heap'].includes(binding.kind),
    layout: binding.layout || current.layout || (['tree', 'heap'].includes(binding.kind) ? 'tree' : 'circle'),
    nodes: current.nodes.slice(0, RUNTIME_LIMITS.maxNodes).map((node) => ({
      ...node,
      state: node.state ?? (
        changed && previousNodes.get(String(node.id)) !== stableKey({ label: node.label, value: node.value })
          ? 'changed'
          : null
      ),
    })),
    edges: current.edges.slice(0, RUNTIME_LIMITS.maxEdges).map((edge) => ({
      ...edge,
      state: edge.state ?? (
        changed && !previousEdges.has(stableKey({
          from: edge.from,
          to: edge.to,
          weight: edge.weight,
          label: edge.label,
        }))
          ? 'changed'
          : null
      ),
    })),
  }
}

function buildHeapData(value, id) {
  const values = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.items)
      ? value.items
      : []
  const nodes = values.slice(0, RUNTIME_LIMITS.maxNodes).map((item, index) => ({
    id: `${id}-heap-${index}`,
    label: cloneJsonValue(item),
    value: cloneJsonValue(item),
    index,
  }))
  const edges = []
  for (let index = 1; index < nodes.length && edges.length < RUNTIME_LIMITS.maxEdges; index += 1) {
    const parent = Math.floor((index - 1) / 2)
    if (!nodes[parent]) continue
    edges.push({
      id: `${id}-heap-edge-${parent}-${index}`,
      from: nodes[parent].id,
      to: nodes[index].id,
      directed: true,
    })
  }
  return { nodes, edges, directed: true, layout: 'tree' }
}

function buildGraphData(value, id, binding) {
  if (isLinkedListNode(value) || (Array.isArray(value) && value.some(isLinkedListNode))) {
    return buildLinkedListData(value, id)
  }
  const structuredDirected = isPlainObject(value) && typeof value.directed === 'boolean'
    ? value.directed
    : binding.directed
  const graph = createGraphBuilder(id, structuredDirected ?? false)

  if (isPlainObject(value) && (Array.isArray(value.nodes) || Array.isArray(value.edges))) {
    ;(Array.isArray(value.nodes) ? value.nodes : []).forEach((node) => graph.addNode(node))
    ;(Array.isArray(value.edges) ? value.edges : []).forEach((edge) => graph.addEdge(edge))
    return graph.finish({
      directed: typeof value.directed === 'boolean' ? value.directed : binding.directed,
      layout: typeof value.layout === 'string' ? value.layout : binding.layout,
    })
  }

  if (isPlainObject(value)) {
    Object.entries(value).forEach(([from, neighbors]) => {
      if (from === '__class__') return
      graph.addNode(from)
      if (Array.isArray(neighbors)) {
        neighbors.forEach((neighbor) => {
          if (Array.isArray(neighbor)) {
            graph.addEdge([from, neighbor[0], neighbor[1]])
          } else if (isPlainObject(neighbor)) {
            graph.addEdge({
              from,
              to: neighbor.to ?? neighbor.target ?? neighbor.id ?? neighbor.node,
              weight: neighbor.weight,
              label: neighbor.label,
            })
          } else {
            graph.addEdge([from, neighbor])
          }
        })
      } else if (isPlainObject(neighbors)) {
        Object.entries(neighbors).forEach(([to, weight]) => graph.addEdge([from, to, weight]))
      }
    })
    return graph.finish()
  }

  if (Array.isArray(value)) {
    value.forEach((edgeOrNode) => {
      if (
        (Array.isArray(edgeOrNode) && edgeOrNode.length >= 2)
        || (isPlainObject(edgeOrNode) && hasEdgeEndpoints(edgeOrNode))
      ) {
        graph.addEdge(edgeOrNode)
      } else {
        graph.addNode(edgeOrNode)
      }
    })
  } else if (value !== null && value !== undefined) {
    graph.addNode(value)
  }

  return graph.finish()
}

function buildLinkedListData(value, id) {
  const heads = Array.isArray(value) ? value : [value]
  const nodes = []
  const edges = []
  heads.forEach((head, chainIndex) => {
    let current = head
    let position = 0
    while (isLinkedListNode(current) && nodes.length < RUNTIME_LIMITS.maxNodes) {
      const nodeId = `${id}-list-${chainIndex}-${position}`
      nodes.push({
        id: nodeId,
        label: cloneJsonValue(current.val),
        value: cloneJsonValue(current.val),
      })
      if (position > 0 && edges.length < RUNTIME_LIMITS.maxEdges) {
        edges.push({
          id: `${id}-list-edge-${chainIndex}-${position - 1}`,
          from: `${id}-list-${chainIndex}-${position - 1}`,
          to: nodeId,
          directed: true,
        })
      }
      current = current.next
      position += 1
    }
  })
  return { nodes, edges, directed: true, layout: heads.length > 1 ? 'tree' : 'linear' }
}

function linkedListToArray(head) {
  const values = []
  const seen = new Set()
  let current = head
  while (isLinkedListNode(current) && values.length < RUNTIME_LIMITS.maxSequenceItems) {
    if (seen.has(current)) break
    seen.add(current)
    values.push(cloneJsonValue(current.val))
    current = current.next
  }
  return values
}

function buildTreeData(value, id, binding) {
  if (isPlainObject(value) && (Array.isArray(value.nodes) || Array.isArray(value.edges))) {
    const data = buildGraphData(
      { ...value, directed: true, layout: 'tree' },
      id,
      { ...binding, directed: true, layout: 'tree' },
    )
    return { ...data, directed: true, layout: 'tree' }
  }

  if (isTreeNodeObject(value)) {
    const nodes = []
    const edges = []
    const queue = [{ node: value, path: 'root', parentId: null }]
    while (queue.length > 0 && nodes.length < RUNTIME_LIMITS.maxNodes) {
      const current = queue.shift()
      if (!isTreeNodeObject(current.node)) continue
      const nodeId = `${id}-tree-${current.path}`
      const nodeValue = current.node.val ?? current.node.value ?? current.node.label ?? current.path
      nodes.push({
        id: nodeId,
        label: cloneJsonValue(nodeValue),
        value: current.node.value !== undefined && current.node.val !== undefined
          ? cloneJsonValue(current.node.value)
          : undefined,
      })
      if (current.parentId && edges.length < RUNTIME_LIMITS.maxEdges) {
        edges.push({
          id: `${id}-edge-${hashString(`${current.parentId}\u0000${nodeId}`)}`,
          from: current.parentId,
          to: nodeId,
          directed: true,
        })
      }
      const children = []
      if (isTreeNodeObject(current.node.left)) children.push(['l', current.node.left])
      if (isTreeNodeObject(current.node.right)) children.push(['r', current.node.right])
      if (Array.isArray(current.node.children)) {
        current.node.children.forEach((child, index) => {
          if (isTreeNodeObject(child)) children.push([`c${index}`, child])
        })
      }
      children.forEach(([suffix, child]) => {
        queue.push({ node: child, path: `${current.path}-${suffix}`, parentId: nodeId })
      })
    }
    return { nodes, edges, directed: true, layout: 'tree' }
  }

  if (Array.isArray(value)) {
    const nodes = []
    const edges = []
    const rootValue = value[0]
    if (rootValue === null || rootValue === undefined || isUnavailableNode(rootValue)) {
      return { nodes, edges, directed: true, layout: 'tree' }
    }
    const rootId = `${id}-tree-0`
    nodes.push({ id: rootId, label: cloneJsonValue(rootValue) })
    const queue = [rootId]
    let sourceIndex = 1
    while (
      queue.length > 0
      && sourceIndex < value.length
      && nodes.length < RUNTIME_LIMITS.maxNodes
    ) {
      const parentId = queue.shift()
      for (let side = 0; side < 2 && sourceIndex < value.length; side += 1) {
        const nodeIndex = sourceIndex
        const nodeValue = value[sourceIndex]
        sourceIndex += 1
        if (nodeValue === null || nodeValue === undefined || isUnavailableNode(nodeValue)) continue
        const nodeId = `${id}-tree-${nodeIndex}`
        nodes.push({ id: nodeId, label: cloneJsonValue(nodeValue) })
        queue.push(nodeId)
        if (edges.length < RUNTIME_LIMITS.maxEdges) {
          edges.push({
            id: `${id}-edge-${hashString(`${parentId}\u0000${nodeId}`)}`,
            from: parentId,
            to: nodeId,
            directed: true,
          })
        }
        if (nodes.length >= RUNTIME_LIMITS.maxNodes) break
      }
    }
    return { nodes, edges, directed: true, layout: 'tree' }
  }

  if (isPlainObject(value)) {
    const data = buildGraphData(value, id, { ...binding, directed: true, layout: 'tree' })
    return { ...data, directed: true, layout: 'tree' }
  }

  if (value === null || value === undefined) {
    return { nodes: [], edges: [], directed: true, layout: 'tree' }
  }
  return {
    nodes: [{ id: `${id}-tree-root`, label: cloneJsonValue(value) }],
    edges: [],
    directed: true,
    layout: 'tree',
  }
}

function createGraphBuilder(containerId, defaultDirected) {
  const nodes = []
  const edges = []
  const nodeIdByKey = new Map()
  const edgeKeys = new Set()

  const addNode = (node) => {
    const objectNode = isPlainObject(node)
    const rawId = objectNode ? (node.id ?? node.key ?? node.label ?? node.value) : node
    if (rawId === undefined || rawId === null || isUnavailableNode(rawId)) return null
    const key = stableKey(rawId)
    if (nodeIdByKey.has(key)) return nodeIdByKey.get(key)
    if (nodes.length >= RUNTIME_LIMITS.maxNodes) return null
    const nodeId = `${containerId}-node-${hashString(key)}`
    nodeIdByKey.set(key, nodeId)
    nodes.push({
      id: nodeId,
      label: cloneJsonValue(objectNode ? (node.label ?? rawId) : rawId),
      value: objectNode && node.value !== undefined ? cloneJsonValue(node.value) : undefined,
      state: objectNode ? node.state ?? null : null,
    })
    return nodeId
  }

  const addEdge = (edge) => {
    if (edges.length >= RUNTIME_LIMITS.maxEdges) return
    const objectEdge = isPlainObject(edge)
    const fromValue = Array.isArray(edge)
      ? edge[0]
      : (objectEdge ? edge.from ?? edge.fromId ?? edge.source : undefined)
    const toValue = Array.isArray(edge)
      ? edge[1]
      : (objectEdge ? edge.to ?? edge.toId ?? edge.target : undefined)
    if (fromValue === undefined || toValue === undefined) return
    const from = addNode(fromValue)
    const to = addNode(toValue)
    if (!from || !to) return
    const directed = objectEdge && typeof edge.directed === 'boolean' ? edge.directed : defaultDirected
    const weight = Array.isArray(edge) ? edge[2] : edge.weight
    const label = objectEdge ? edge.label : undefined
    const endKey = directed
      ? `${from}\u0000${to}`
      : [from, to].sort().join('\u0000')
    const edgeKey = stableKey({ endKey, weight, label, directed })
    if (edgeKeys.has(edgeKey)) return
    edgeKeys.add(edgeKey)
    edges.push({
      id: `${containerId}-edge-${hashString(edgeKey)}`,
      from,
      to,
      weight: cloneJsonValue(weight),
      label: label == null ? undefined : cloneJsonValue(label),
      directed,
      state: objectEdge ? edge.state ?? null : null,
    })
  }

  return {
    addNode,
    addEdge,
    finish(options = {}) {
      return {
        nodes,
        edges,
        directed: typeof options.directed === 'boolean' ? options.directed : defaultDirected,
        layout: options.layout || null,
      }
    },
  }
}

function hasEdgeEndpoints(value) {
  return (
    (value.from !== undefined || value.fromId !== undefined || value.source !== undefined)
    && (value.to !== undefined || value.toId !== undefined || value.target !== undefined)
  )
}

function isTreeNodeObject(value) {
  return isPlainObject(value) && (
    Object.prototype.hasOwnProperty.call(value, 'val')
    || Object.prototype.hasOwnProperty.call(value, 'left')
    || Object.prototype.hasOwnProperty.call(value, 'right')
    || Array.isArray(value.children)
  ) && !isUnavailableNode(value)
}

function isLinkedListNode(value) {
  return isPlainObject(value)
    && Object.prototype.hasOwnProperty.call(value, 'val')
    && Object.prototype.hasOwnProperty.call(value, 'next')
    && (/listnode/i.test(String(value.__class__ || '')) || !Object.hasOwn(value, 'left'))
    && !isUnavailableNode(value)
}

function isUnavailableNode(value) {
  return value === '[Circular]' || value === '[Max depth]' || value === '[Unavailable]'
}

function attachPointers(containers, pointerBindings, latestValues, loopDetails = new Map()) {
  const byBindingName = new Map(containers.map((container) => [container.bindingName, container]))

  pointerBindings.forEach((binding) => {
    if (!binding.target || !latestValues.has(binding.name)) return
    const target = byBindingName.get(binding.target)
    if (!target || target.category !== 'sequence') return
    const pointerValue = latestValues.get(binding.name)
    const detail = loopDetails.get(binding.name)
    let index = Number.isInteger(detail?.index) ? detail.index : null
    if (index === null && binding.pointerMode === 'value') {
      const matches = target.items.flatMap((item, itemIndex) => (
        sameJsonValue(item.value, pointerValue) ? [itemIndex] : []
      ))
      index = matches.length === 1 ? matches[0] : null
    } else if (index === null && binding.pointerMode === 'index') {
      index = Number(pointerValue) - finiteInteger(binding.indexOffset, 0)
    }
    if (!Number.isInteger(index) || index < 0 || index >= target.items.length) return
    target.pointers.push({
      id: `${target.id}-pointer-${slug(binding.name)}-${hashString(binding.name)}`,
      name: binding.label,
      label: binding.label,
      index,
      state: 'pointer',
    })
    target.items[index].state = 'active'
  })
}

function buildStableContainerIds(bindings) {
  return new Map(bindings.map((binding) => ([
    binding.name,
    binding.variableId || `python-${slug(binding.name)}-${hashString(binding.name)}`,
  ])))
}

function normalizeBindingKind(value) {
  const kind = String(value || 'scalar').trim().toLowerCase()
  if (['array', 'list', 'tuple', 'deque', 'string', 'sequence'].includes(kind)) return 'sequence'
  if (['grid', 'matrix', 'table', 'dp', 'heatmap'].includes(kind)) return 'grid'
  if (['map', 'dict', 'set', 'counter', 'associative'].includes(kind)) return 'associative'
  if (['graph', 'network', 'node-link'].includes(kind)) return 'graph'
  if (['tree', 'binary-tree', 'bst'].includes(kind)) return 'tree'
  if (['heap', 'priority-queue', 'priorityqueue'].includes(kind)) return 'heap'
  return 'scalar'
}

function defaultView(kind) {
  if (kind === 'sequence') return 'cells'
  if (kind === 'grid') return 'table'
  if (kind === 'graph') return 'circle'
  if (kind === 'tree' || kind === 'heap') return 'tree'
  return 'auto'
}

function normalizeSequenceType(runtimeType) {
  if (runtimeType === 'str') return 'string'
  if (runtimeType === 'deque') return 'deque'
  return 'array'
}

function normalizeScalarType(runtimeType) {
  return ['int', 'float', 'bool', 'str', 'none'].includes(runtimeType)
    ? runtimeType
    : 'scalar'
}

function normalizeLoopBindings(loopBindings) {
  if (Array.isArray(loopBindings)) {
    return loopBindings.flatMap((binding) => {
      if (typeof binding === 'string') return [{ name: binding }]
      return binding?.name ? [binding] : []
    })
  }
  if (isPlainObject(loopBindings)) {
    return Object.entries(loopBindings).map(([name, binding]) => ({
      name,
      ...(isPlainObject(binding) ? binding : {}),
    }))
  }
  return []
}

function normalizeTargetName(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  return value.trim().split('.').at(-1)
}

function normalizeOperation(event) {
  return ['call', 'line', 'return', 'exception'].includes(event) ? event : 'line'
}

function normalizePointerMode(value) {
  return value === 'value' ? 'value' : (value === 'index' ? 'index' : null)
}

function finiteLine(value) {
  const line = Number(value)
  return Number.isInteger(line) && line > 0 ? line : null
}

function finiteInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isInteger(number) ? number : fallback
}

function slug(value) {
  return String(value || 'value')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'value'
}

function hashString(value) {
  let hash = 2166136261
  const text = String(value)
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).slice(0, 7)
}

function stableKey(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function sameJsonValue(first, second) {
  return stableKey(first) === stableKey(second)
}

function cloneJsonValue(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
