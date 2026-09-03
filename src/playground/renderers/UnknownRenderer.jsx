import { displayValue } from './rendererUtils'

export default function UnknownRenderer({ container = {} }) {
  const details = Object.keys(container).length > 0 ? displayValue(container) : 'No data'

  return (
    <div className="playground-renderer-empty unknown-empty">
      <span className="playground-empty-symbol" aria-hidden="true">?</span>
      <span>Unknown container type</span>
      <small title={details}>Add a supported category or type</small>
    </div>
  )
}
