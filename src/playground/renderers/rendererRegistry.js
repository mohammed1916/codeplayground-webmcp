import AssociativeRenderer from './AssociativeRenderer'
import GridRenderer from './GridRenderer'
import NodeLinkRenderer from './NodeLinkRenderer'
import ScalarRenderer from './ScalarRenderer'
import SequenceRenderer from './SequenceRenderer'
import UnknownRenderer from './UnknownRenderer'
import { normalizeKind } from './rendererUtils'

export const rendererRegistry = Object.freeze({
  sequence: SequenceRenderer,
  grid: GridRenderer,
  'node-link': NodeLinkRenderer,
  associative: AssociativeRenderer,
  scalar: ScalarRenderer,
})

const typeCategories = Object.freeze({
  array: 'sequence',
  arrays: 'sequence',
  string: 'sequence',
  strings: 'sequence',
  sequence: 'sequence',
  stack: 'sequence',
  stacks: 'sequence',
  queue: 'sequence',
  queues: 'sequence',
  deque: 'sequence',
  deques: 'sequence',
  matrix: 'grid',
  board: 'grid',
  table: 'grid',
  grid: 'grid',
  dp: 'grid',
  'dp-table': 'grid',
  graph: 'node-link',
  graphs: 'node-link',
  tree: 'node-link',
  trees: 'node-link',
  'binary-tree': 'node-link',
  bst: 'node-link',
  heap: 'node-link',
  heaps: 'node-link',
  trie: 'node-link',
  tries: 'node-link',
  list: 'node-link',
  'linked-list': 'node-link',
  'doubly-linked-list': 'node-link',
  map: 'associative',
  maps: 'associative',
  dictionary: 'associative',
  object: 'associative',
  'hash-map': 'associative',
  set: 'associative',
  sets: 'associative',
  'hash-set': 'associative',
  scalar: 'scalar',
  variable: 'scalar',
  number: 'scalar',
  boolean: 'scalar',
  counter: 'scalar',
  pointer: 'scalar',
})

function inferCategory(container) {
  if (Array.isArray(container?.nodes) || Array.isArray(container?.edges)) return 'node-link'
  if (Array.isArray(container?.cells) || container?.rows !== undefined || container?.columns !== undefined) return 'grid'
  if (Array.isArray(container?.items)) return 'sequence'
  if (Array.isArray(container?.entries)) return 'associative'
  if (container && Object.prototype.hasOwnProperty.call(container, 'value')) return 'scalar'
  return ''
}

export function resolveRendererCategory(container = {}) {
  const category = normalizeKind(container.category)
  if (rendererRegistry[category]) return category

  const type = normalizeKind(container.type)
  return typeCategories[type] ?? inferCategory(container)
}

export function resolveRenderer(container = {}) {
  return rendererRegistry[resolveRendererCategory(container)] ?? UnknownRenderer
}

export default rendererRegistry
