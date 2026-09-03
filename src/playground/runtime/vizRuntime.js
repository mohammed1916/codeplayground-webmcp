import {
  RUNTIME_LIMITS,
  createDeclaredContainer,
  makeDeclarationId,
  normalizeInteger,
  sanitizeLabel,
} from './model.js'

export class VisualizationRuntimeError extends Error {
  constructor(message, code = 'RUNTIME_ERROR') {
    super(message)
    this.name = 'VisualizationRuntimeError'
    this.code = code
  }
}

export async function executeVisualizationSource(source, options = {}) {
  if (typeof source !== 'string') {
    throw new VisualizationRuntimeError('Visualizer source must be a string.', 'INVALID_SOURCE')
  }
  if (source.length > RUNTIME_LIMITS.maxSourceLength) {
    throw new VisualizationRuntimeError(
      `Source is limited to ${RUNTIME_LIMITS.maxSourceLength.toLocaleString()} characters.`,
      'SOURCE_LIMIT',
    )
  }

  const maxFrames = normalizeInteger(
    options.maxFrames,
    RUNTIME_LIMITS.defaultFrames,
    RUNTIME_LIMITS.minFrames,
    RUNTIME_LIMITS.maxFrames,
  )
  const controller = new RuntimeController(maxFrames)
  const viz = createVizApi(controller)

  // A disposable Worker provides the hard execution boundary. Shadow common
  // browser capabilities as an additional guard against accidental side effects.
  const AsyncFunction = Object.getPrototypeOf(async function visualizerProgram() {}).constructor
  const blockedNames = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker',
    'importScripts', 'indexedDB', 'caches', 'navigator', 'location', 'document',
    'localStorage', 'sessionStorage', 'setTimeout', 'setInterval', 'globalThis',
    'self', 'postMessage', 'Function',
  ]
  let program

  try {
    program = new AsyncFunction(
      'viz',
      ...blockedNames,
      `"use strict";\n${source}\n//# sourceURL=visualizer-playground.js`,
    )
  } catch (error) {
    throw asRuntimeError(error, 'SYNTAX_ERROR')
  }

  try {
    await program(viz, ...blockedNames.map(() => undefined))
    await controller.settlePendingSteps()
  } catch (error) {
    throw asRuntimeError(error)
  }

  return controller.result()
}

class RuntimeController {
  constructor(maxFrames) {
    this.maxFrames = maxFrames
    this.frames = []
    this.containers = new Map()
    this.typeCounts = new Map()
    this.usedIds = new Set()
    this.batchDepth = 0
    this.batchChanged = false
    this.pendingSteps = new Set()
    this.mutationCount = 0
    this.capture('initialize', 'Ready')
  }

  declare(type, requestedName, config, initialize) {
    if (this.containers.size >= RUNTIME_LIMITS.maxContainers) {
      throw new VisualizationRuntimeError(
        `A program may create at most ${RUNTIME_LIMITS.maxContainers} containers.`,
        'CONTAINER_LIMIT',
      )
    }

    const occurrence = (this.typeCounts.get(type) || 0) + 1
    this.typeCounts.set(type, occurrence)
    const name = sanitizeLabel(requestedName, defaultName(type, occurrence))
    const baseId = makeDeclarationId(type, name, occurrence)
    let id = baseId
    let suffix = 2
    while (this.usedIds.has(id)) {
      id = `${baseId}-${suffix}`
      suffix += 1
    }

    const container = createDeclaredContainer(type, id, name, config)
    initialize?.(container)
    this.usedIds.add(id)
    this.containers.set(id, container)
    this.capture(`${type}.declare`, `Created ${name}`)
    return container
  }

  mutate(container, operation, mutate, message) {
    if (!this.containers.has(container.id)) {
      throw new VisualizationRuntimeError('This visual container is no longer available.', 'STALE_CONTAINER')
    }
    this.mutationCount += 1
    if (this.mutationCount > this.maxFrames * 20 + 100) {
      throw new VisualizationRuntimeError(
        'Too many operations were performed without producing playback frames.',
        'OPERATION_LIMIT',
      )
    }

    const value = mutate()
    if (this.batchDepth > 0) {
      this.batchChanged = true
    } else {
      this.capture(operation, message || describeOperation(container, operation))
    }
    return value
  }

  step(message, callback) {
    const label = sanitizeLabel(message, 'Step')
    if (typeof callback !== 'function') {
      this.capture('step', label)
      return undefined
    }

    this.batchDepth += 1
    let result
    try {
      result = callback()
    } catch (error) {
      this.finishBatch(label, false)
      throw error
    }

    if (!result || typeof result.then !== 'function') {
      this.finishBatch(label, true)
      return result
    }

    const pending = Promise.resolve(result).then(
      (value) => {
        this.finishBatch(label, true)
        return value
      },
      (error) => {
        this.finishBatch(label, false)
        throw error
      },
    )
    this.pendingSteps.add(pending)
    pending.finally(() => this.pendingSteps.delete(pending)).catch(() => {})
    return pending
  }

  finishBatch(message, capture) {
    this.batchDepth = Math.max(0, this.batchDepth - 1)
    if (this.batchDepth === 0) {
      const changed = this.batchChanged
      this.batchChanged = false
      if (capture && changed) this.capture('step', message)
      if (capture && !changed) this.capture('step', message)
    }
  }

  async settlePendingSteps() {
    while (this.pendingSteps.size > 0) {
      await Promise.all([...this.pendingSteps])
    }
  }

  capture(operation, message) {
    if (this.frames.length >= this.maxFrames) {
      throw new VisualizationRuntimeError(
        `Playback is limited to ${this.maxFrames} frames.`,
        'FRAME_LIMIT',
      )
    }

    const scene = {
      containers: [...this.containers.values()].map(clonePlainValue),
      message: sanitizeLabel(message, operation),
    }
    this.frames.push({
      id: this.frames.length,
      message: scene.message,
      operation,
      scene,
    })
  }

  result() {
    const lastScene = this.frames[this.frames.length - 1]?.scene || { containers: [] }
    return {
      frames: this.frames,
      scene: clonePlainValue(lastScene),
    }
  }
}

function createVizApi(controller) {
  return Object.freeze({
    array: (name, initial = []) => createSequence(controller, 'array', name, initial),
    string: (name, initial = '') => createSequence(controller, 'string', name, initial),
    stack: (name, initial = []) => createSequence(controller, 'stack', name, initial),
    queue: (name, initial = []) => createSequence(controller, 'queue', name, initial),
    deque: (name, initial = []) => createSequence(controller, 'deque', name, initial),
    grid: (name, config, columns) => createGrid(controller, 'grid', name, config, columns),
    dp: (name, config, columns) => createGrid(controller, 'dp', name, config, columns),
    graph: (name, config = {}) => createNodeLink(controller, 'graph', name, config),
    tree: (name, config = {}) => createNodeLink(controller, 'tree', name, config),
    linkedList: (name, values = []) => createLinkedList(controller, name, values),
    trie: (name, config = {}) => createTrie(controller, name, config),
    heap: (name, config = {}) => createHeap(controller, name, config),
    map: (name, initial) => createMap(controller, name, initial),
    set: (name, initial) => createSet(controller, name, initial),
    scalar: (name, initial = null) => createScalar(controller, name, initial),
    step: (message, callback) => controller.step(message, callback),
  })
}

function createSequence(controller, type, name, initial) {
  const sourceValues = type === 'string'
    ? [...String(initial ?? '')]
    : sequenceInitialValues(initial)
  assertLimit(sourceValues.length, RUNTIME_LIMITS.maxSequenceItems, 'Sequence item')
  let nextItemId = 1
  const container = controller.declare(type, name, {}, (draft) => {
    draft.items = sourceValues.map((value) => makeItem(draft.id, nextItemId++, value))
  })

  const mutate = (method, callback, message) => (
    controller.mutate(container, `${type}.${method}`, callback, message)
  )
  const assertRoom = (amount = 1) => assertLimit(
    container.items.length + amount,
    RUNTIME_LIMITS.maxSequenceItems,
    'Sequence item',
  )
  const valueAt = (index) => {
    const position = validIndex(index, container.items.length)
    return container.items[position].value
  }

  const handle = {
    get length() { return container.items.length },
    values: () => container.items.map((item) => clonePlainValue(item.value)),
    get: valueAt,
    set(index, value) {
      const position = validIndex(index, container.items.length)
      return mutate('set', () => {
        container.items[position].value = sanitizeValue(value)
        return container.items[position].value
      })
    },
    push(value) {
      assertRoom()
      return mutate('push', () => {
        const item = makeItem(container.id, nextItemId++, value)
        container.items.push(item)
        return container.items.length
      })
    },
    pop() {
      if (container.items.length === 0) return undefined
      return mutate('pop', () => container.items.pop().value)
    },
    unshift(value) {
      assertRoom()
      return mutate('unshift', () => {
        container.items.unshift(makeItem(container.id, nextItemId++, value))
        return container.items.length
      })
    },
    shift() {
      if (container.items.length === 0) return undefined
      return mutate('shift', () => container.items.shift().value)
    },
    insert(index, value) {
      assertRoom()
      const position = validIndex(index, container.items.length, true)
      return mutate('insert', () => {
        container.items.splice(position, 0, makeItem(container.id, nextItemId++, value))
        return container.items.length
      })
    },
    remove(index) {
      const position = validIndex(index, container.items.length)
      return mutate('remove', () => container.items.splice(position, 1)[0].value)
    },
    swap(first, second) {
      const left = validIndex(first, container.items.length)
      const right = validIndex(second, container.items.length)
      return mutate('swap', () => {
        ;[container.items[left], container.items[right]] = [container.items[right], container.items[left]]
      })
    },
    mark(index, state = 'active') {
      const position = validIndex(index, container.items.length)
      return mutate('mark', () => { container.items[position].state = sanitizeState(state) })
    },
    clearMarks() {
      return mutate('clearMarks', () => {
        container.items.forEach((item) => { item.state = null })
        container.pointers = []
      })
    },
    point(pointerName, index, state = 'pointer') {
      const position = validIndex(index, container.items.length)
      return mutate('point', () => {
        const id = sanitizeLabel(pointerName, 'pointer')
        const pointer = { id, name: id, index: position, state: sanitizeState(state) }
        const existing = container.pointers.findIndex((candidate) => candidate.id === id)
        if (existing === -1) container.pointers.push(pointer)
        else container.pointers[existing] = pointer
      })
    },
    clear() {
      if (container.items.length === 0) return undefined
      return mutate('clear', () => { container.items = []; container.pointers = [] })
    },
  }

  if (type === 'stack') {
    handle.peek = () => container.items.at(-1)?.value
  }
  if (type === 'queue') {
    handle.enqueue = handle.push
    handle.dequeue = handle.shift
    handle.front = () => container.items[0]?.value
  }
  if (type === 'deque') {
    handle.pushFront = handle.unshift
    handle.pushBack = handle.push
    handle.popFront = handle.shift
    handle.popBack = handle.pop
    handle.front = () => container.items[0]?.value
    handle.back = () => container.items.at(-1)?.value
  }
  if (type === 'string') {
    handle.toString = () => container.items.map((item) => item.value).join('')
    handle.setValue = (value) => mutate('setValue', () => {
      const characters = [...String(value ?? '')]
      assertLimit(characters.length, RUNTIME_LIMITS.maxSequenceItems, 'String character')
      container.items = characters.map((character) => makeItem(container.id, nextItemId++, character))
    })
    handle.append = (value) => {
      const characters = [...String(value ?? '')]
      assertLimit(container.items.length + characters.length, RUNTIME_LIMITS.maxSequenceItems, 'String character')
      return mutate('append', () => {
        container.items.push(...characters.map((character) => makeItem(container.id, nextItemId++, character)))
      })
    }
  }

  return Object.freeze(handle)
}

function createGrid(controller, type, name, configOrRows, columnsArgument) {
  const config = normalizeGridConfig(configOrRows, columnsArgument)
  assertGridSize(config.rows, config.columns)
  const container = controller.declare(type, name, config, (draft) => {
    if (config.values) applyGridValues(draft, config.values)
  })
  const mutate = (method, callback) => controller.mutate(container, `${type}.${method}`, callback)
  const cellAt = (row, column) => {
    const rowIndex = validIndex(row, container.rows)
    const columnIndex = validIndex(column, container.columns)
    return container.cells[rowIndex][columnIndex]
  }

  return Object.freeze({
    get rows() { return container.rows },
    get columns() { return container.columns },
    get: (row, column) => clonePlainValue(cellAt(row, column).value),
    values: () => container.cells.map((row) => row.map((cell) => clonePlainValue(cell.value))),
    set(row, column, value) {
      return mutate('set', () => { cellAt(row, column).value = sanitizeValue(value) })
    },
    fill(value) {
      return mutate('fill', () => {
        container.cells.forEach((row) => row.forEach((cell) => { cell.value = sanitizeValue(value) }))
      })
    },
    mark(row, column, state = 'active') {
      return mutate('mark', () => { cellAt(row, column).state = sanitizeState(state) })
    },
    clearMarks() {
      return mutate('clearMarks', () => {
        container.cells.forEach((row) => row.forEach((cell) => { cell.state = null }))
        container.pointers = []
      })
    },
    resize(rows, columns, fillValue = null) {
      const nextRows = positiveInteger(rows, 'rows')
      const nextColumns = positiveInteger(columns, 'columns')
      assertGridSize(nextRows, nextColumns)
      return mutate('resize', () => {
        const previous = container.cells
        container.rows = nextRows
        container.columns = nextColumns
        container.cells = Array.from({ length: nextRows }, (_, row) => (
          Array.from({ length: nextColumns }, (_, column) => previous[row]?.[column] || ({
            id: `${container.id}-cell-${row}-${column}`,
            row,
            column,
            value: sanitizeValue(fillValue),
            state: null,
          }))
        ))
      })
    },
  })
}

function createNodeLink(controller, type, name, rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const container = controller.declare(type, name, config, (draft) => {
    const nodes = Array.isArray(config.nodes) ? config.nodes : []
    const edges = Array.isArray(config.edges) ? config.edges : []
    assertLimit(nodes.length, RUNTIME_LIMITS.maxNodes, 'Node')
    assertLimit(edges.length, RUNTIME_LIMITS.maxEdges, 'Edge')
    nodes.forEach((node) => rawAddNode(draft, node?.id ?? node, node))
    edges.forEach((edge) => rawAddEdge(draft, edge.from, edge.to, edge))
    if (config.root != null) draft.rootId = normalizeNodeId(config.root)
  })
  const mutate = (method, callback) => controller.mutate(container, `${type}.${method}`, callback)

  const handle = {
    addNode(id, valueOrOptions) {
      assertLimit(container.nodes.length + 1, RUNTIME_LIMITS.maxNodes, 'Node')
      return mutate('addNode', () => rawAddNode(container, id, valueOrOptions))
    },
    removeNode(id) {
      const nodeId = requireNode(container, id).id
      return mutate('removeNode', () => {
        container.nodes = container.nodes.filter((node) => node.id !== nodeId)
        container.edges = container.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId)
        if (container.rootId === nodeId) delete container.rootId
      })
    },
    addEdge(from, to, options = {}) {
      assertLimit(container.edges.length + 1, RUNTIME_LIMITS.maxEdges, 'Edge')
      requireNode(container, from)
      requireNode(container, to)
      return mutate('addEdge', () => rawAddEdge(container, from, to, options))
    },
    removeEdge(idOrFrom, maybeTo) {
      const edge = findEdge(container, idOrFrom, maybeTo)
      if (!edge) return false
      return mutate('removeEdge', () => {
        container.edges = container.edges.filter((candidate) => candidate.id !== edge.id)
        return true
      })
    },
    setNode(id, valueOrOptions) {
      const node = requireNode(container, id)
      return mutate('setNode', () => applyNodeOptions(node, valueOrOptions))
    },
    markNode(id, state = 'active') {
      const node = requireNode(container, id)
      return mutate('markNode', () => { node.state = sanitizeState(state) })
    },
    markEdge(idOrFrom, maybeTo, state = 'active') {
      let edge
      let nextState = state
      if (maybeTo !== undefined && findEdge(container, idOrFrom, maybeTo)) {
        edge = findEdge(container, idOrFrom, maybeTo)
      } else {
        edge = findEdge(container, idOrFrom)
        nextState = maybeTo ?? state
      }
      if (!edge) throw new VisualizationRuntimeError('Edge was not found.', 'MISSING_EDGE')
      return mutate('markEdge', () => { edge.state = sanitizeState(nextState) })
    },
    clearMarks() {
      return mutate('clearMarks', () => {
        container.nodes.forEach((node) => { node.state = null })
        container.edges.forEach((edge) => { edge.state = null })
      })
    },
    neighbors(id) {
      const nodeId = requireNode(container, id).id
      return container.edges.flatMap((edge) => {
        if (edge.from === nodeId) return [edge.to]
        if (!edge.directed && edge.to === nodeId) return [edge.from]
        return []
      })
    },
  }

  if (type === 'tree') {
    handle.setRoot = (id) => {
      const nodeId = requireNode(container, id).id
      return mutate('setRoot', () => { container.rootId = nodeId })
    }
    handle.addChild = (parentId, id, valueOrOptions) => {
      requireNode(container, parentId)
      assertLimit(container.nodes.length + 1, RUNTIME_LIMITS.maxNodes, 'Node')
      assertLimit(container.edges.length + 1, RUNTIME_LIMITS.maxEdges, 'Edge')
      return mutate('addChild', () => {
        rawAddNode(container, id, valueOrOptions)
        rawAddEdge(container, parentId, id, { directed: true })
      })
    }
  }

  return Object.freeze(handle)
}

function createLinkedList(controller, name, values) {
  const initial = Array.isArray(values) ? values : (Array.isArray(values?.values) ? values.values : [])
  assertLimit(initial.length, RUNTIME_LIMITS.maxNodes, 'Linked-list node')
  let nextId = 1
  const container = controller.declare('linkedList', name, {}, (draft) => {
    initial.forEach((value) => draft.nodes.push(makeListNode(draft.id, nextId++, value)))
    rebuildListEdges(draft)
  })
  const mutate = (method, callback) => controller.mutate(container, `linkedList.${method}`, callback)
  const makeNode = (value, id) => {
    const nodeId = id == null ? `${container.id}-node-${nextId++}` : normalizeNodeId(id)
    if (container.nodes.some((node) => node.id === nodeId)) duplicateNode(nodeId)
    return { id: nodeId, label: displayValue(value), value: sanitizeValue(value), state: null }
  }

  return Object.freeze({
    get length() { return container.nodes.length },
    values: () => container.nodes.map((node) => clonePlainValue(node.value)),
    append(value, id) {
      assertLimit(container.nodes.length + 1, RUNTIME_LIMITS.maxNodes, 'Linked-list node')
      return mutate('append', () => { container.nodes.push(makeNode(value, id)); rebuildListEdges(container) })
    },
    prepend(value, id) {
      assertLimit(container.nodes.length + 1, RUNTIME_LIMITS.maxNodes, 'Linked-list node')
      return mutate('prepend', () => { container.nodes.unshift(makeNode(value, id)); rebuildListEdges(container) })
    },
    insertAfter(afterId, value, id) {
      const index = container.nodes.findIndex((node) => node.id === normalizeNodeId(afterId))
      if (index === -1) throw new VisualizationRuntimeError('Linked-list node was not found.', 'MISSING_NODE')
      assertLimit(container.nodes.length + 1, RUNTIME_LIMITS.maxNodes, 'Linked-list node')
      return mutate('insertAfter', () => { container.nodes.splice(index + 1, 0, makeNode(value, id)); rebuildListEdges(container) })
    },
    remove(id) {
      const index = container.nodes.findIndex((node) => node.id === normalizeNodeId(id))
      if (index === -1) return undefined
      return mutate('remove', () => { const [node] = container.nodes.splice(index, 1); rebuildListEdges(container); return node.value })
    },
    set(id, value) {
      const node = requireNode(container, id)
      return mutate('set', () => { node.value = sanitizeValue(value); node.label = displayValue(value) })
    },
    mark(id, state = 'active') {
      const node = requireNode(container, id)
      return mutate('mark', () => { node.state = sanitizeState(state) })
    },
    clearMarks() {
      return mutate('clearMarks', () => { container.nodes.forEach((node) => { node.state = null }) })
    },
  })
}

function createTrie(controller, name, rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  let nextNodeId = 1
  const container = controller.declare('trie', name, config, (draft) => {
    draft.rootId = `${draft.id}-root`
    draft.nodes.push({ id: draft.rootId, label: 'root', value: '', terminal: false, state: null })
  })
  const mutate = (method, callback) => controller.mutate(container, `trie.${method}`, callback)
  const childFor = (parentId, character) => {
    const edge = container.edges.find((candidate) => candidate.from === parentId && candidate.label === character)
    return edge ? container.nodes.find((node) => node.id === edge.to) : undefined
  }

  const handle = {
    insert(word) {
      const characters = [...String(word ?? '')]
      const missing = countMissingTrieNodes(container, characters)
      assertLimit(container.nodes.length + missing, RUNTIME_LIMITS.maxNodes, 'Trie node')
      assertLimit(container.edges.length + missing, RUNTIME_LIMITS.maxEdges, 'Trie edge')
      return mutate('insert', () => {
        let parent = container.rootId
        characters.forEach((character) => {
          let child = childFor(parent, character)
          if (!child) {
            child = {
              id: `${container.id}-node-${nextNodeId++}`,
              label: character,
              value: character,
              terminal: false,
              state: null,
            }
            container.nodes.push(child)
            container.edges.push({
              id: `${container.id}-edge-${container.edges.length + 1}`,
              from: parent,
              to: child.id,
              label: character,
              weight: null,
              directed: true,
              state: null,
            })
          }
          parent = child.id
        })
        requireNode(container, parent).terminal = true
      })
    },
    contains(word) {
      const node = findTrieWord(container, word)
      return Boolean(node?.terminal)
    },
    markWord(word, state = 'active') {
      const path = triePath(container, word)
      if (!path) throw new VisualizationRuntimeError('Trie word was not found.', 'MISSING_NODE')
      return mutate('markWord', () => path.forEach((node) => { node.state = sanitizeState(state) }))
    },
    clearMarks() {
      return mutate('clearMarks', () => { container.nodes.forEach((node) => { node.state = null }) })
    },
  }
  if (Array.isArray(config.words)) config.words.forEach((word) => handle.insert(word))
  return Object.freeze(handle)
}

function createHeap(controller, name, rawConfig) {
  const config = Array.isArray(rawConfig) ? { values: rawConfig } : (rawConfig || {})
  const kind = config.kind === 'max' ? 'max' : 'min'
  const values = Array.isArray(config.values) ? config.values.map(sanitizeValue) : []
  assertLimit(values.length, RUNTIME_LIMITS.maxNodes, 'Heap node')
  heapify(values, kind)
  const container = controller.declare('heap', name, { layout: 'tree' }, (draft) => {
    draft.kind = kind
    rebuildHeap(draft, values)
  })
  const mutate = (method, callback) => controller.mutate(container, `heap.${method}`, callback)

  return Object.freeze({
    get size() { return values.length },
    values: () => values.map(clonePlainValue),
    peek: () => clonePlainValue(values[0]),
    push(value) {
      assertLimit(values.length + 1, RUNTIME_LIMITS.maxNodes, 'Heap node')
      return mutate('push', () => { values.push(sanitizeValue(value)); siftUp(values, values.length - 1, kind); rebuildHeap(container, values); return values.length })
    },
    pop() {
      if (values.length === 0) return undefined
      return mutate('pop', () => {
        const root = values[0]
        const tail = values.pop()
        if (values.length > 0) { values[0] = tail; siftDown(values, 0, kind) }
        rebuildHeap(container, values)
        return root
      })
    },
    mark(index, state = 'active') {
      const position = validIndex(index, container.nodes.length)
      return mutate('mark', () => { container.nodes[position].state = sanitizeState(state) })
    },
    clearMarks() {
      return mutate('clearMarks', () => { container.nodes.forEach((node) => { node.state = null }) })
    },
  })
}

function createMap(controller, name, initial) {
  const entries = normalizeMapEntries(initial)
  assertLimit(entries.length, RUNTIME_LIMITS.maxAssociativeEntries, 'Map entry')
  let nextId = 1
  const records = []
  const container = controller.declare('map', name, {}, () => {})
  entries.forEach(([key, value]) => records.push({ rawKey: key, id: `${container.id}-entry-${nextId++}`, value: sanitizeValue(value), state: null }))
  syncMapEntries(container, records)
  // Initial values are folded into the declaration frame by replacing it.
  replaceLastSceneContainer(controller, container)
  const mutate = (method, callback) => controller.mutate(container, `map.${method}`, callback)
  const findRecord = (key) => records.find((record) => Object.is(record.rawKey, key))

  const api = {
    get size() { return records.length },
    has: (key) => Boolean(findRecord(key)),
    get: (key) => clonePlainValue(findRecord(key)?.value),
    entries: () => records.map((record) => [sanitizeValue(record.rawKey), clonePlainValue(record.value)]),
    set(key, value) {
      const existing = findRecord(key)
      if (!existing) assertLimit(records.length + 1, RUNTIME_LIMITS.maxAssociativeEntries, 'Map entry')
      return mutate('set', () => {
        if (existing) existing.value = sanitizeValue(value)
        else records.push({ rawKey: key, id: `${container.id}-entry-${nextId++}`, value: sanitizeValue(value), state: null })
        syncMapEntries(container, records)
        return api
      })
    },
    delete(key) {
      const index = records.findIndex((record) => Object.is(record.rawKey, key))
      if (index === -1) return false
      return mutate('delete', () => { records.splice(index, 1); syncMapEntries(container, records); return true })
    },
    mark(key, state = 'active') {
      const record = findRecord(key)
      if (!record) throw new VisualizationRuntimeError('Map key was not found.', 'MISSING_KEY')
      return mutate('mark', () => { record.state = sanitizeState(state); syncMapEntries(container, records) })
    },
    clear() {
      if (records.length === 0) return undefined
      return mutate('clear', () => { records.length = 0; syncMapEntries(container, records) })
    },
  }
  return Object.freeze(api)
}

function createSet(controller, name, initial) {
  const values = initial == null ? [] : [...initial]
  assertLimit(values.length, RUNTIME_LIMITS.maxAssociativeEntries, 'Set entry')
  let nextId = 1
  const records = []
  values.forEach((value) => {
    if (!records.some((record) => Object.is(record.rawValue, value))) {
      records.push({ rawValue: value, id: '', state: null })
    }
  })
  const container = controller.declare('set', name, {}, () => {})
  records.forEach((record) => { record.id = `${container.id}-entry-${nextId++}` })
  syncSetEntries(container, records)
  replaceLastSceneContainer(controller, container)
  const mutate = (method, callback) => controller.mutate(container, `set.${method}`, callback)

  return Object.freeze({
    get size() { return records.length },
    has: (value) => records.some((record) => Object.is(record.rawValue, value)),
    values: () => records.map((record) => sanitizeValue(record.rawValue)),
    add(value) {
      if (records.some((record) => Object.is(record.rawValue, value))) return false
      assertLimit(records.length + 1, RUNTIME_LIMITS.maxAssociativeEntries, 'Set entry')
      return mutate('add', () => { records.push({ rawValue: value, id: `${container.id}-entry-${nextId++}`, state: null }); syncSetEntries(container, records); return true })
    },
    delete(value) {
      const index = records.findIndex((record) => Object.is(record.rawValue, value))
      if (index === -1) return false
      return mutate('delete', () => { records.splice(index, 1); syncSetEntries(container, records); return true })
    },
    mark(value, state = 'active') {
      const record = records.find((candidate) => Object.is(candidate.rawValue, value))
      if (!record) throw new VisualizationRuntimeError('Set value was not found.', 'MISSING_KEY')
      return mutate('mark', () => { record.state = sanitizeState(state); syncSetEntries(container, records) })
    },
    clear() {
      if (records.length === 0) return undefined
      return mutate('clear', () => { records.length = 0; syncSetEntries(container, records) })
    },
  })
}

function createScalar(controller, name, initial) {
  const container = controller.declare('scalar', name, {}, (draft) => { draft.value = sanitizeValue(initial) })
  const mutate = (method, callback) => controller.mutate(container, `scalar.${method}`, callback)

  return Object.freeze({
    get: () => clonePlainValue(container.value),
    set(value) { return mutate('set', () => { container.value = sanitizeValue(value); return container.value }) },
    increment(amount = 1) {
      if (typeof container.value !== 'number' || typeof amount !== 'number') {
        throw new VisualizationRuntimeError('increment() requires numeric values.', 'INVALID_VALUE')
      }
      return mutate('increment', () => { container.value += amount; return container.value })
    },
    decrement(amount = 1) {
      if (typeof container.value !== 'number' || typeof amount !== 'number') {
        throw new VisualizationRuntimeError('decrement() requires numeric values.', 'INVALID_VALUE')
      }
      return mutate('decrement', () => { container.value -= amount; return container.value })
    },
    mark(state = 'active') { return mutate('mark', () => { container.state = sanitizeState(state) }) },
    clearMark() { return mutate('clearMark', () => { container.state = null }) },
  })
}

function normalizeGridConfig(configOrRows, columnsArgument) {
  if (Array.isArray(configOrRows)) {
    return {
      rows: configOrRows.length,
      columns: configOrRows.reduce((max, row) => Array.isArray(row) ? Math.max(max, row.length) : max, 0),
      values: configOrRows,
    }
  }
  if (typeof configOrRows === 'number') {
    return {
      rows: positiveInteger(configOrRows, 'rows'),
      columns: positiveInteger(columnsArgument, 'columns'),
    }
  }
  const config = configOrRows && typeof configOrRows === 'object' ? configOrRows : {}
  const values = Array.isArray(config.values) ? config.values : undefined
  const inferredRows = values?.length || 0
  const inferredColumns = values?.reduce((max, row) => Array.isArray(row) ? Math.max(max, row.length) : max, 0) || 0
  return {
    rows: config.rows == null ? inferredRows : nonNegativeInteger(config.rows, 'rows'),
    columns: (config.columns ?? config.cols) == null
      ? inferredColumns
      : nonNegativeInteger(config.columns ?? config.cols, 'columns'),
    values,
  }
}

function applyGridValues(container, values) {
  container.cells.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
    cell.value = sanitizeValue(values[rowIndex]?.[columnIndex] ?? null)
  }))
}

function rawAddNode(container, rawId, valueOrOptions) {
  const id = normalizeNodeId(rawId)
  if (container.nodes.some((node) => node.id === id)) duplicateNode(id)
  const options = valueOrOptions && typeof valueOrOptions === 'object' && !Array.isArray(valueOrOptions)
    ? valueOrOptions
    : { value: valueOrOptions }
  const value = options.value ?? options.label ?? rawId
  const node = {
    id,
    label: sanitizeLabel(options.label, displayValue(value)),
    value: sanitizeValue(value),
    state: sanitizeState(options.state),
  }
  container.nodes.push(node)
  return id
}

function applyNodeOptions(node, valueOrOptions) {
  const options = valueOrOptions && typeof valueOrOptions === 'object' && !Array.isArray(valueOrOptions)
    ? valueOrOptions
    : { value: valueOrOptions }
  if ('value' in options) node.value = sanitizeValue(options.value)
  if ('label' in options) node.label = sanitizeLabel(options.label, displayValue(node.value))
  else if ('value' in options) node.label = displayValue(options.value)
  if ('state' in options) node.state = sanitizeState(options.state)
}

function rawAddEdge(container, rawFrom, rawTo, rawOptions = {}) {
  const from = normalizeNodeId(rawFrom)
  const to = normalizeNodeId(rawTo)
  requireNode(container, from)
  requireNode(container, to)
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : { weight: rawOptions }
  const id = options.id == null
    ? `${container.id}-edge-${container.edges.length + 1}`
    : sanitizeLabel(options.id)
  if (container.edges.some((edge) => edge.id === id)) {
    throw new VisualizationRuntimeError(`Edge "${id}" already exists.`, 'DUPLICATE_EDGE')
  }
  container.edges.push({
    id,
    from,
    to,
    label: options.label == null ? null : sanitizeLabel(options.label),
    weight: options.weight == null ? null : sanitizeValue(options.weight),
    directed: typeof options.directed === 'boolean' ? options.directed : container.directed,
    state: sanitizeState(options.state),
  })
  return id
}

function requireNode(container, rawId) {
  const id = normalizeNodeId(rawId)
  const node = container.nodes.find((candidate) => candidate.id === id)
  if (!node) throw new VisualizationRuntimeError(`Node "${id}" was not found.`, 'MISSING_NODE')
  return node
}

function findEdge(container, idOrFrom, maybeTo) {
  if (maybeTo === undefined) {
    const id = String(idOrFrom)
    return container.edges.find((edge) => edge.id === id)
  }
  const from = normalizeNodeId(idOrFrom)
  const to = normalizeNodeId(maybeTo)
  return container.edges.find((edge) => edge.from === from && edge.to === to)
}

function makeListNode(containerId, sequence, value) {
  return {
    id: `${containerId}-node-${sequence}`,
    label: displayValue(value),
    value: sanitizeValue(value),
    state: null,
  }
}

function rebuildListEdges(container) {
  container.edges = container.nodes.slice(0, -1).map((node, index) => ({
    id: `${container.id}-link-${node.id}-${container.nodes[index + 1].id}`,
    from: node.id,
    to: container.nodes[index + 1].id,
    label: null,
    weight: null,
    directed: true,
    state: null,
  }))
}

function countMissingTrieNodes(container, characters) {
  let parent = container.rootId
  let missing = 0
  for (const character of characters) {
    const edge = container.edges.find((candidate) => candidate.from === parent && candidate.label === character)
    if (!edge) { missing += 1; parent = Symbol('missing') }
    else parent = edge.to
  }
  return missing
}

function triePath(container, word) {
  const path = [requireNode(container, container.rootId)]
  let parent = container.rootId
  for (const character of String(word ?? '')) {
    const edge = container.edges.find((candidate) => candidate.from === parent && candidate.label === character)
    if (!edge) return undefined
    const node = requireNode(container, edge.to)
    path.push(node)
    parent = node.id
  }
  return path
}

function findTrieWord(container, word) {
  return triePath(container, word)?.at(-1)
}

function rebuildHeap(container, values) {
  const priorStates = new Map(container.nodes.map((node) => [node.id, node.state]))
  container.nodes = values.map((value, index) => ({
    id: `${container.id}-node-${index}`,
    label: displayValue(value),
    value: clonePlainValue(value),
    index,
    state: priorStates.get(`${container.id}-node-${index}`) || null,
  }))
  container.edges = values.slice(1).map((_, index) => {
    const child = index + 1
    const parent = Math.floor((child - 1) / 2)
    return {
      id: `${container.id}-edge-${parent}-${child}`,
      from: `${container.id}-node-${parent}`,
      to: `${container.id}-node-${child}`,
      label: null,
      weight: null,
      directed: true,
      state: null,
    }
  })
}

function heapify(values, kind) {
  for (let index = Math.floor(values.length / 2) - 1; index >= 0; index -= 1) siftDown(values, index, kind)
}

function siftUp(values, start, kind) {
  let index = start
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (!heapBefore(values[index], values[parent], kind)) break
    ;[values[index], values[parent]] = [values[parent], values[index]]
    index = parent
  }
}

function siftDown(values, start, kind) {
  let index = start
  while (true) {
    const left = index * 2 + 1
    const right = left + 1
    let best = index
    if (left < values.length && heapBefore(values[left], values[best], kind)) best = left
    if (right < values.length && heapBefore(values[right], values[best], kind)) best = right
    if (best === index) return
    ;[values[index], values[best]] = [values[best], values[index]]
    index = best
  }
}

function heapBefore(first, second, kind) {
  return kind === 'max' ? first > second : first < second
}

function normalizeMapEntries(initial) {
  if (initial == null) return []
  if (initial instanceof Map) return [...initial.entries()]
  if (Array.isArray(initial)) return initial
  if (typeof initial === 'object') return Object.entries(initial)
  throw new VisualizationRuntimeError('Map initial data must be an object, Map, or entry array.', 'INVALID_VALUE')
}

function syncMapEntries(container, records) {
  container.entries = records.map((record) => ({
    id: record.id,
    key: sanitizeValue(record.rawKey),
    value: clonePlainValue(record.value),
    state: record.state,
  }))
}

function syncSetEntries(container, records) {
  container.entries = records.map((record) => ({
    id: record.id,
    key: sanitizeValue(record.rawValue),
    value: sanitizeValue(record.rawValue),
    state: record.state,
  }))
}

function replaceLastSceneContainer(controller, container) {
  const frame = controller.frames.at(-1)
  if (!frame) return
  const index = frame.scene.containers.findIndex((candidate) => candidate.id === container.id)
  if (index !== -1) frame.scene.containers[index] = clonePlainValue(container)
}

function sequenceInitialValues(initial) {
  if (Array.isArray(initial)) return initial
  if (initial && Array.isArray(initial.values)) return initial.values
  if (initial == null) return []
  throw new VisualizationRuntimeError('Sequence initial data must be an array.', 'INVALID_VALUE')
}

function makeItem(containerId, sequence, value) {
  return {
    id: `${containerId}-item-${sequence}`,
    value: sanitizeValue(value),
    state: null,
  }
}

function sanitizeValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean') return value ?? null
  if (typeof value === 'string') return value.slice(0, RUNTIME_LIMITS.maxStringLength)
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') return value.description ? `Symbol(${value.description})` : 'Symbol'
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (depth >= RUNTIME_LIMITS.maxValueDepth) return '[Max depth]'
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.slice(0, RUNTIME_LIMITS.maxObjectEntries).map((item) => sanitizeValue(item, depth + 1, seen))
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  if (value instanceof Map) {
    return [...value.entries()].slice(0, RUNTIME_LIMITS.maxObjectEntries).map(([key, item]) => ([
      sanitizeValue(key, depth + 1, seen),
      sanitizeValue(item, depth + 1, seen),
    ]))
  }
  if (value instanceof Set) {
    return [...value.values()].slice(0, RUNTIME_LIMITS.maxObjectEntries).map((item) => sanitizeValue(item, depth + 1, seen))
  }

  const output = {}
  let entries
  try {
    entries = Object.entries(value).slice(0, RUNTIME_LIMITS.maxObjectEntries)
  } catch {
    return String(value)
  }
  entries.forEach(([key, item]) => {
    try { output[key] = sanitizeValue(item, depth + 1, seen) } catch { output[key] = '[Unavailable]' }
  })
  return output
}

function clonePlainValue(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function sanitizeState(state) {
  if (state == null || state === false) return null
  return sanitizeValue(state)
}

function displayValue(value) {
  const sanitized = sanitizeValue(value)
  if (typeof sanitized === 'string') return sanitizeLabel(sanitized)
  try { return sanitizeLabel(JSON.stringify(sanitized)) } catch { return sanitizeLabel(String(sanitized)) }
}

function normalizeNodeId(value) {
  if (value == null || value === '') {
    throw new VisualizationRuntimeError('Node IDs cannot be empty.', 'INVALID_NODE_ID')
  }
  return sanitizeLabel(value)
}

function validIndex(value, length, allowEnd = false) {
  const index = Number(value)
  const upperBound = allowEnd ? length : length - 1
  if (!Number.isInteger(index) || index < 0 || index > upperBound) {
    throw new VisualizationRuntimeError(`Index ${value} is outside 0..${upperBound}.`, 'INDEX_OUT_OF_RANGE')
  }
  return index
}

function positiveInteger(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new VisualizationRuntimeError(`${label} must be a positive integer.`, 'INVALID_DIMENSION')
  }
  return number
}

function nonNegativeInteger(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw new VisualizationRuntimeError(`${label} must be a non-negative integer.`, 'INVALID_DIMENSION')
  }
  return number
}

function assertGridSize(rows, columns) {
  if (rows * columns > RUNTIME_LIMITS.maxGridCells) {
    throw new VisualizationRuntimeError(
      `A grid may contain at most ${RUNTIME_LIMITS.maxGridCells} cells.`,
      'GRID_LIMIT',
    )
  }
}

function assertLimit(value, maximum, label) {
  if (value > maximum) {
    throw new VisualizationRuntimeError(`${label} limit is ${maximum}.`, 'STRUCTURE_LIMIT')
  }
}

function duplicateNode(id) {
  throw new VisualizationRuntimeError(`Node "${id}" already exists.`, 'DUPLICATE_NODE')
}

function defaultName(type, occurrence) {
  const label = type === 'linkedList' ? 'Linked list' : `${type[0].toUpperCase()}${type.slice(1)}`
  return `${label} ${occurrence}`
}

function describeOperation(container, operation) {
  const action = operation.slice(operation.lastIndexOf('.') + 1)
  return `${container.name}: ${action}`
}

function asRuntimeError(error, fallbackCode = 'RUNTIME_ERROR') {
  if (error instanceof VisualizationRuntimeError) return error
  const runtimeError = new VisualizationRuntimeError(error?.message || String(error), error?.code || fallbackCode)
  if (error?.stack) runtimeError.stack = error.stack
  return runtimeError
}
