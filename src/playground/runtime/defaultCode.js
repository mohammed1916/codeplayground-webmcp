export const DEFAULT_PLAYGROUND_CODE = `// Containers appear in the preview as soon as they are declared.
const graph = viz.graph('Traversal graph', { directed: true, layout: 'circle' })
const distance = viz.dp('Distances', { rows: 1, columns: 4 })

viz.step('Build the graph', () => {
  graph.addNode('A')
  graph.addNode('B')
  graph.addNode('C')
  graph.addNode('D')
  graph.addEdge('A', 'B', { weight: 2 })
  graph.addEdge('A', 'C', { weight: 5 })
  graph.addEdge('B', 'D', { weight: 1 })
})

const order = ['A', 'B', 'C', 'D']
const values = [0, 2, 5, 3]

for (let index = 0; index < order.length; index += 1) {
  viz.step(\`Visit \${order[index]}\`, () => {
    graph.markNode(order[index], 'active')
    distance.set(0, index, values[index])
    distance.mark(0, index, 'current')
  })
}
`
