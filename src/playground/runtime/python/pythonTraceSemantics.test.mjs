import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { compilePythonTrace, createDefaultPythonBindings } from './compilePythonTrace.js'
import { PYTHON_TRACER_SOURCE } from './pythonTracerSource.js'

function runTrace(source, input, maxFrames = 200) {
  const traceGlobals = {
    __trace_max_frames: maxFrames,
    __trace_source: source,
    __trace_input_json: JSON.stringify(input),
    __trace_entry_json: 'null',
  }
  const wrapper = [
    'import json, sys',
    'scope = json.loads(sys.argv[1])',
    'exec(sys.stdin.read(), scope, scope)',
    'print(scope["__trace_result_json"])',
  ].join('\n')
  const result = spawnSync('python', ['-c', wrapper, JSON.stringify(traceGlobals)], {
    input: PYTHON_TRACER_SOURCE,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const trace = JSON.parse(result.stdout)
  assert.equal(trace.error, undefined, trace.error?.stack || trace.error?.message)
  return trace
}

function runTraceError(source, input, maxFrames = 200) {
  const traceGlobals = {
    __trace_max_frames: maxFrames,
    __trace_source: source,
    __trace_input_json: JSON.stringify(input),
    __trace_entry_json: 'null',
  }
  const wrapper = [
    'import json, sys',
    'scope = json.loads(sys.argv[1])',
    'exec(sys.stdin.read(), scope, scope)',
    'print(scope["__trace_result_json"])',
  ].join('\n')
  const result = spawnSync('python', ['-c', wrapper, JSON.stringify(traceGlobals)], {
    input: PYTHON_TRACER_SOURCE,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const trace = JSON.parse(result.stdout)
  assert.ok(trace.error)
  return trace.error
}

function container(frame, bindingName) {
  return frame.scene.containers.find((candidate) => candidate.bindingName === bindingName)
}

test('1D dp-named lists stay sequences and entry returns are selectable', () => {
  const trace = runTrace(`
class Solution:
    def solve(self, values):
        dp = [0] * len(values)
        if values:
            dp[0] = values[0]
        return dp
`, { values: [4, 2] })
  const dp = trace.variables.find((variable) => variable.name === 'dp')
  const returned = trace.variables.find((variable) => variable.name === '$return')
  assert.equal(dp.suggestedKind, 'sequence')
  assert.equal(returned.suggestedKind, 'sequence')
  assert.deepEqual(trace.traceFrames.at(-1).locals.$return, [4, 0])
  assert.equal(createDefaultPythonBindings(trace).dp.kind, null)
})

test('helper activations disappear while entry locals survive', () => {
  const trace = runTrace(`
def helper(value):
    temporary = value + 1
    return temporary

class Solution:
    def solve(self, value):
        root_value = value
        answer = helper(root_value)
        return answer
`, { value: 4 })
  const compiled = compilePythonTrace(trace)
  assert.ok(compiled.frames.some((frame) => container(frame, 'temporary')))
  assert.equal(container(compiled.frames.at(-1), 'temporary'), undefined)
  assert.equal(container(compiled.frames.at(-1), 'root_value').value, 4)
  assert.equal(container(compiled.frames.at(-1), '$return').value, 5)
})

test('recursive locals resolve to the active call and reserved input envelopes do not collide', () => {
  const trace = runTrace(`
def walk(number):
    marker = number
    if number == 0:
        return marker
    return walk(number - 1) + 1

class Solution:
    def solve(self, args, kwargs):
        answer = walk(args)
        return answer + kwargs
`, { args: 2, kwargs: 3 })
  const compiled = compilePythonTrace(trace)
  const markerValues = compiled.frames.flatMap((frame) => {
    const marker = container(frame, 'marker')
    return marker ? [marker.value] : []
  })
  assert.ok(markerValues.includes(0))
  assert.ok(markerValues.includes(2))
  assert.equal(container(compiled.frames.at(-1), 'marker'), undefined)
  assert.equal(container(compiled.frames.at(-1), '$return').value, 5)
})

test('JSON null is passed to a single-argument entry', () => {
  const trace = runTrace(`
def solve(value):
    return value is None
`, null)
  assert.equal(trace.result, true)
  assert.equal(trace.traceFrames.at(-1).locals.$return, true)
})

test('entry argument mismatches point users to the Inputs tab', () => {
  const error = runTraceError(`
def isMatch(s, p):
    return s == p
`, { prices: [7, 1, 5] })
  assert.match(error.message, /Input JSON does not match entry isMatch/)
  assert.match(error.message, /Inputs tab/)
})

test('regular-expression matching produces a playable DP grid', () => {
  const trace = runTrace(`
def isMatch(s, p):
    m, n = len(s), len(p)
    dp = [[False] * (n + 1) for _ in range(m + 1)]
    dp[0][0] = True
    for j in range(1, n + 1):
        if p[j - 1] == '*':
            dp[0][j] = dp[0][j - 2]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if p[j - 1] != '*':
                matches = p[j - 1] == '.' or s[i - 1] == p[j - 1]
                if matches:
                    dp[i][j] = dp[i - 1][j - 1]
            else:
                dp[i][j] = dp[i][j - 2]
                prev_matches = p[j - 2] == '.' or s[i - 1] == p[j - 2]
                if prev_matches and dp[i - 1][j]:
                    dp[i][j] = True
    return dp[m][n]
`, { s: 'aa', p: 'a*' })
  const compiled = compilePythonTrace(trace)
  const dpVariable = trace.variables.find((variable) => variable.name === 'dp')
  const dpFrames = compiled.frames
    .map((frame) => container(frame, 'dp'))
    .filter(Boolean)

  assert.equal(dpVariable.suggestedKind, 'grid')
  assert.ok(dpFrames.length > 1)
  assert.equal(dpFrames.at(-1).rows, 3)
  assert.equal(dpFrames.at(-1).columns, 3)
  assert.equal(container(compiled.frames.at(-1), '$return').value, true)
})

test('duplicate-value and enumerate(start) loop pointers use actual positions', () => {
  const valueTrace = runTrace(`
class Solution:
    def solve(self, values):
        total = 0
        for value in values:
            total += value
        return total
`, { values: [3, 1, 3] })
  const valueCompiled = compilePythonTrace(valueTrace)
  const valueIndices = valueCompiled.frames.flatMap((frame) => (
    container(frame, 'values')?.pointers
      ?.filter((pointer) => pointer.name === 'value')
      .map((pointer) => pointer.index) ?? []
  ))
  assert.deepEqual([...new Set(valueIndices)], [0, 1, 2])

  const indexTrace = runTrace(`
class Solution:
    def solve(self, values):
        total = 0
        for index, value in enumerate(values, start=5):
            total += value
        return total
`, { values: [8, 9] })
  const indexCompiled = compilePythonTrace(indexTrace)
  const indexIndices = indexCompiled.frames.flatMap((frame) => (
    container(frame, 'values')?.pointers
      ?.filter((pointer) => pointer.name === 'index')
      .map((pointer) => pointer.index) ?? []
  ))
  assert.deepEqual([...new Set(indexIndices)], [0, 1])
})

test('variables used as sequence subscripts become index pointers', () => {
  const trace = runTrace(`
class Solution:
    def threeSumClosest(self, nums, target):
        nums.sort()
        closest = nums[0] + nums[1] + nums[2]
        for i in range(len(nums) - 2):
            l, r = i + 1, len(nums) - 1
            while l < r:
                current = nums[i] + nums[l] + nums[r]
                if current < target:
                    l += 1
                else:
                    r -= 1
        return closest
`, { nums: [-1, 2, 1, -4], target: 1 })
  const defaults = createDefaultPythonBindings(trace)
  assert.deepEqual(
    [defaults.i, defaults.l, defaults.r].map((binding) => ({
      role: binding.role,
      target: binding.target,
      pointerMode: binding.pointerMode,
    })),
    Array.from({ length: 3 }, () => ({
      role: 'pointer',
      target: 'nums',
      pointerMode: 'index',
    })),
  )

  const compiled = compilePythonTrace(trace, defaults)
  const pointerNames = new Set(compiled.frames.flatMap((frame) => (
    container(frame, 'nums')?.pointers?.map((pointer) => pointer.name) ?? []
  )))
  assert.ok(pointerNames.has('l'))
  assert.ok(pointerNames.has('r'))
})

test('linked-list JSON inputs are converted to ListNode chains', () => {
  const trace = runTrace(`
class Solution:
    def mergeKLists(self, lists):
        heap = []
        for i, head in enumerate(lists):
            if head: heappush(heap, (head.val, i, head))
        dummy = ListNode(0)
        tail = dummy
        while heap:
            val, i, node = heappop(heap)
            tail.next = node
            tail = tail.next
            if node.next: heappush(heap, (node.next.val, i, node.next))
        return dummy.next
`, { lists: [[1, 4, 5], [1, 3, 4], [2, 6]] })

  const returned = trace.traceFrames.at(-1).locals.$return
  assert.equal(returned.__class__, '_DefaultListNode')
  assert.equal(returned.val, 1)
  assert.equal(returned.next.val, 1)
  const defaults = createDefaultPythonBindings(trace)
  assert.equal(defaults.lists.kind, null)
  assert.equal(defaults.tail.enabled, false)
  assert.equal(defaults.node.enabled, false)
  const compiled = compilePythonTrace(trace, defaults)
  const listsContainer = compiled.frames.map((frame) => container(frame, 'lists')).find((item) => item?.nodes?.length)
  assert.equal(listsContainer.category, 'node-link')
  assert.ok(listsContainer.nodes.every((item) => typeof item.label === 'number'))
  assert.ok(listsContainer.edges.length > 0)
  const heapContainers = compiled.frames.map((frame) => container(frame, 'heap')).filter(Boolean)
  const heapText = JSON.stringify(heapContainers.flatMap((item) => item.items))
  assert.doesNotMatch(heapText, /__class__/)
  assert.match(heapText, /ListNode\(/)
})

test('explicit heap bindings compile Python lists into tree-shaped node links', () => {
  const trace = runTrace(`
class Solution:
    def solve(self, values):
        heap = []
        for value in values:
            heappush(heap, value)
        return heap[0]
`, { values: [5, 1, 7, 3] })
  const defaults = createDefaultPythonBindings(trace)
  const compiled = compilePythonTrace(trace, {
    ...defaults,
    heap: {
      ...defaults.heap,
      kind: 'heap',
      view: 'tree',
    },
  })
  const heapContainer = compiled.frames.map((frame) => container(frame, 'heap')).find((item) => item?.nodes?.length >= 4)

  assert.equal(heapContainer.category, 'node-link')
  assert.equal(heapContainer.type, 'heap')
  assert.equal(heapContainer.layout, 'tree')
  assert.equal(heapContainer.directed, true)
  assert.deepEqual(heapContainer.edges.map((edge) => (
    [edge.from.split('-heap-').at(-1), edge.to.split('-heap-').at(-1)]
  )), [
    ['0', '1'],
    ['0', '2'],
    ['1', '3'],
  ])
})

test('different executed lines survive unchanged locals and truncation preserves final state', () => {
  const source = `
class Solution:
    def solve(self, value):
        if value > 0:
            value
            value
        return value
`
  const complete = runTrace(source, { value: 2 })
  const executedLines = complete.traceFrames.map((frame) => frame.line)
  assert.ok(executedLines.includes(5))
  assert.ok(executedLines.includes(6))

  const truncated = runTrace(source, { value: 2 }, 3)
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.truncation.finalStatePreserved, true)
  assert.equal(truncated.traceFrames.at(-1).locals.$return, 2)
  const compiled = compilePythonTrace(truncated)
  assert.equal(compiled.truncated, true)
  assert.match(compiled.warning, /limited/i)
  assert.equal(container(compiled.frames.at(-1), '$return').value, 2)
})

test('explicit graph and tree bindings compile to node-link containers', () => {
  const trace = {
    variables: [
      { name: 'network', suggestedKind: 'associative' },
      { name: 'root', suggestedKind: 'scalar' },
    ],
    traceFrames: [{
      event: 'return',
      line: 1,
      function: 'solve',
      locals: {
        network: { A: ['B'], B: ['A', 'C'], C: ['B'] },
        root: { __class__: 'TreeNode', val: 1, left: { val: 2 }, right: { val: 3 } },
      },
      localTypes: { network: 'dict', root: 'TreeNode' },
      changed: ['network', 'root'],
    }],
  }
  const bindings = createDefaultPythonBindings(trace)
  bindings.network.kind = 'graph'
  bindings.root.kind = 'tree'
  const compiled = compilePythonTrace(trace, bindings)
  const graph = container(compiled.frames[0], 'network')
  const tree = container(compiled.frames[0], 'root')
  assert.equal(graph.category, 'node-link')
  assert.equal(graph.nodes.length, 3)
  assert.equal(graph.edges.length, 2)
  assert.equal(tree.category, 'node-link')
  assert.equal(tree.nodes.length, 3)
  assert.equal(tree.edges.length, 2)
})

test('explicit visual kinds override inference, including one-row grids', () => {
  const trace = {
    variables: [{ name: 'dp', suggestedKind: 'sequence' }],
    traceFrames: [{
      event: 'return',
      line: 1,
      locals: { dp: [1, 2, 3] },
      localTypes: { dp: 'list' },
      changed: ['dp'],
    }],
  }
  const compiled = compilePythonTrace(trace, {
    dp: { enabled: true, kind: 'grid' },
  })
  const grid = container(compiled.frames[0], 'dp')
  assert.equal(grid.category, 'grid')
  assert.equal(grid.rows, 1)
  assert.equal(grid.columns, 3)
})
