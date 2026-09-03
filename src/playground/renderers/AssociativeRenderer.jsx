import { normalizeKind, shortValue, stateClass } from './rendererUtils'

function normalizeEntries(entries) {
  if (Array.isArray(entries)) {
    return entries.map((entry, index) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        return { ...entry, id: entry.id ?? `entry-${index}` }
      }
      return { id: `entry-${index}`, key: entry, value: entry }
    })
  }

  if (entries && typeof entries === 'object') {
    return Object.entries(entries).map(([key, value], index) => ({ id: `entry-${index}`, key, value }))
  }

  return []
}

export default function AssociativeRenderer({ container = {} }) {
  const entries = normalizeEntries(container.entries)
  const type = normalizeKind(container.type) || 'map'
  const isSet = type === 'set' || type.endsWith('-set')

  if (entries.length === 0) {
    return (
      <div className="playground-renderer-empty associative-empty">
        <span className="playground-empty-braces" aria-hidden="true">{'{ }'}</span>
        <span>{isSet ? 'Empty set' : 'Empty map'}</span>
        <small>Ready for entries</small>
      </div>
    )
  }

  return (
    <div className={`playground-associative playground-associative-${isSet ? 'set' : 'map'}`} role="list">
      {entries.map((entry, index) => {
        const key = entry.key ?? entry.value ?? index
        return (
          <div className={`playground-associative-entry ${stateClass(entry.state)}`} key={`${String(entry.id)}-${index}`} role="listitem">
            <span className="playground-associative-key" title={shortValue(key, 160)}>{shortValue(key, 24)}</span>
            {!isSet && (
              <>
                <span className="playground-associative-arrow" aria-hidden="true">→</span>
                <span className="playground-associative-value" title={shortValue(entry.value, 160)}>{shortValue(entry.value, 30)}</span>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
