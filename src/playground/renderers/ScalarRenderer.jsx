import { displayValue, shortValue, stateClass } from './rendererUtils'

export default function ScalarRenderer({ container = {} }) {
  const isInitialized = Object.prototype.hasOwnProperty.call(container, 'value') && container.value !== undefined

  return (
    <div className={`playground-scalar ${stateClass(container.state)} ${isInitialized ? '' : 'is-uninitialized'}`}>
      <span className="playground-scalar-value" title={isInitialized ? displayValue(container.value) : 'Uninitialized'}>
        {isInitialized ? shortValue(container.value, 80) : '∅'}
      </span>
      <small>{isInitialized ? (container.type || 'value') : 'uninitialized'}</small>
    </div>
  )
}
