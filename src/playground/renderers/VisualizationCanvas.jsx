import './VisualizationCanvas.css'
import AssociativeRenderer from './AssociativeRenderer'
import GridRenderer from './GridRenderer'
import NodeLinkRenderer from './NodeLinkRenderer'
import ScalarRenderer from './ScalarRenderer'
import SequenceRenderer from './SequenceRenderer'
import UnknownRenderer from './UnknownRenderer'
import { resolveRendererCategory } from './rendererRegistry'
import { normalizeKind, shortValue } from './rendererUtils'

function normalizeContainers(scene, directContainers) {
  const source = directContainers ?? scene
  let containers

  if (Array.isArray(source)) {
    containers = source
  } else if (Array.isArray(source?.containers)) {
    containers = source.containers
  } else if (source?.containers && typeof source.containers === 'object') {
    containers = Object.values(source.containers)
  } else if (source?.scene) {
    return normalizeContainers(source.scene)
  } else if (source?.container) {
    containers = [source.container]
  } else if (source && typeof source === 'object' && (source.category || source.type)) {
    containers = [source]
  } else {
    containers = []
  }

  return containers.filter((container) => container !== null && container !== undefined).map((container, index) => {
    if (container && typeof container === 'object' && !Array.isArray(container)) return container
    return { id: `scalar-${index}`, name: `Value ${index + 1}`, category: 'scalar', type: 'scalar', value: container }
  })
}

function RendererOutlet({ category, container }) {
  if (category === 'sequence') return <SequenceRenderer container={container} />
  if (category === 'grid') return <GridRenderer container={container} />
  if (category === 'node-link') return <NodeLinkRenderer container={container} />
  if (category === 'associative') return <AssociativeRenderer container={container} />
  if (category === 'scalar') return <ScalarRenderer container={container} />
  return <UnknownRenderer container={container} />
}

function ContainerVisual({ container }) {
  const category = resolveRendererCategory(container) || 'unknown'
  const type = normalizeKind(container.type) || category
  const title = container.name ?? container.id ?? `Untitled ${type}`
  const metadata = category === type ? [type] : [category, type]

  return (
    <section className={`playground-visual-card is-${category}`} aria-label={String(title)}>
      <header className="playground-visual-header">
        <div className="playground-visual-title">
          <span className="playground-visual-status" aria-hidden="true" />
          <h3 title={String(title)}>{shortValue(title, 48)}</h3>
        </div>
        <div className="playground-visual-badges" aria-label="Container type">
          {metadata.map((label, metadataIndex) => (
            <span key={`${label}-${metadataIndex}`}>{label}</span>
          ))}
        </div>
      </header>
      <div className="playground-visual-body">
        <RendererOutlet category={category} container={container} />
      </div>
    </section>
  )
}

export default function VisualizationCanvas({
  scene,
  containers,
  className = '',
  emptyMessage = 'Run your code to create a visualization.',
}) {
  const normalizedContainers = normalizeContainers(scene, containers)
  const classes = ['playground-visualization-canvas', className].filter(Boolean).join(' ')

  if (normalizedContainers.length === 0) {
    return (
      <div className={`${classes} is-empty`} aria-live="polite">
        <div className="playground-canvas-empty">
          <span className="playground-canvas-empty-icon" aria-hidden="true"><i /><i /><i /></span>
          <strong>No visual containers yet</strong>
          <p>{emptyMessage}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={classes}>
      {normalizedContainers.map((container, index) => (
        <ContainerVisual container={container} key={`${String(container.id ?? container.name ?? 'container')}-${index}`} />
      ))}
    </div>
  )
}
