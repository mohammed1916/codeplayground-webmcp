import { lineDiff } from './ai/suggestPythonFix.js'

export default function AIFixReview({ proposal, beforeSource, beforeInput, onAccept, onReject }) {
  const sourceDiff = lineDiff(beforeSource, proposal.source).filter((line) => line.type !== 'same')
  const inputDiff = lineDiff(beforeInput, proposal.inputSource).filter((line) => line.type !== 'same')
  return (
    <div className="runtime-playground__ai-fix-review">
      <strong>{proposal.reviewTitle ?? 'AI fix awaiting review'}</strong>
      <p>{proposal.summary}</p>
      {proposal.changes.length > 0 && <ul>{proposal.changes.map((change) => <li key={change}>{change}</li>)}</ul>}
      <div className="runtime-playground__ai-diff" aria-label="Proposed changes">
        {[...sourceDiff, ...inputDiff].map((line, index) => (
          <code className={`is-${line.type}`} key={`${line.type}-${index}`}>
            <b>{line.type === 'add' ? '+' : '-'}</b>{line.text || ' '}
          </code>
        ))}
        {sourceDiff.length + inputDiff.length === 0 && <span>No textual changes proposed.</span>}
      </div>
      <div className="runtime-playground__ai-fix-actions">
        <button type="button" onClick={onReject}>Reject</button>
        <button type="button" className="runtime-playground__button--primary" onClick={onAccept}>Accept and run</button>
      </div>
    </div>
  )
}
