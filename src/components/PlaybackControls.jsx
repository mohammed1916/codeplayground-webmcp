import { Fragment } from 'react'
import './PlaybackControls.css'

export default function PlaybackControls({
  className,
  buttonsGroupClassName,
  speedOuterClassName,
  speedWrapClassName,
  speedLabelClassName,
  speedInputClassName,
  speedIndicatorClassName,
  buttonClassName,
  ghostButtonClassName,
  playButtonClassName,
  iconButtonClassName,
  onReset,
  onPrev,
  onPlayToggle,
  onTogglePlayback,
  onStepChange,
  onNext,
  resetDisabled,
  prevDisabled,
  nextDisabled,
  canPrev,
  canNext,
  activeStep,
  totalSteps,
  isPlaying,
  isDone,
  resetLabel = 'Reset',
  prevLabel = 'Prev',
  nextLabel = 'Next',
  playLabel = 'Play',
  pauseLabel = 'Pause',
  replayLabel = 'Replay',
  renderResetContent,
  resetTitle,
  leftSlot = null,
  middleSlot = null,
  speedLabel = 'Speed',
  speed,
  onSpeedChange,
  speedMin = 80,
  speedMax = 1400,
  speedStep = 60,
  speedRangeValue,
  speedAriaLabel = 'Playback speed',
  speedIndicator = null,
  showSpeed = true,
  autoScroll = true,
  onAutoScrollChange,
  autoScrollLabel = 'Auto-scroll code',
  showAutoScroll = false,
  showPatternOverlay = true,
  onShowPatternOverlayChange,
  patternOverlayLabel = 'Show pattern overlay',
  showPatternOverlayToggle = false,
  showDpDetails = false,
  onShowDpDetailsChange,
  dpDetailsLabel = 'Show DP details',
  showDpDetailsToggle = false,
  showEdgeFlow = false,
  onShowEdgeFlowChange,
  edgeFlowLabel = 'Show edge flow',
  showEdgeFlowToggle = false,
  showComparisons = false,
  onShowComparisonsChange,
  comparisonsLabel = 'Show comparisons',
  showComparisonsToggle = false,
  showRankHighlight = false,
  onShowRankHighlightChange,
  rankHighlightLabel = 'Highlight ranks',
  showRankHighlightToggle = false,
  showInsertBreakdown = false,
  onShowInsertBreakdownChange,
  insertBreakdownLabel = 'InsertTop3 logic',
  showInsertBreakdownToggle = false,
  showBottomUp = false,
  onShowBottomUpChange,
  bottomUpLabel = 'Bottom-up details',
  showBottomUpToggle = false,
  showTraversalTrail = false,
  onShowTraversalTrailChange,
  traversalTrailLabel = 'Traversal trail',
  showTraversalTrailToggle = false,
  showValueSource = false,
  onShowValueSourceChange,
  valueSourceLabel = 'Value source',
  showValueSourceToggle = false,
}) {

  const resolvedRootClass = className || 'pc'
  const resolvedButtonsGroupClass = buttonsGroupClassName || 'pc-buttons'
  const resolvedSpeedOuterClass = speedOuterClassName || 'pc-speed-outer'
  const resolvedSpeedWrapClass = speedWrapClassName || 'pc-speed-wrap'
  const resolvedSpeedLabelClass = speedLabelClassName || 'pc-speed-label'
  const resolvedSpeedInputClass = speedInputClassName || 'pc-speed-input'
  const resolvedSpeedIndicatorClass = speedIndicatorClassName || 'pc-speed-indicator'
  const ButtonGroup = resolvedButtonsGroupClass ? 'div' : Fragment
  const buttonGroupProps = resolvedButtonsGroupClass ? { className: resolvedButtonsGroupClass } : {}
  const resetClasses = [buttonClassName || 'pc-btn', ghostButtonClassName || 'pc-btn-ghost', iconButtonClassName].filter(Boolean).join(' ')
  const ghostClasses = [buttonClassName || 'pc-btn', ghostButtonClassName || 'pc-btn-ghost'].filter(Boolean).join(' ')
  const playClasses = [buttonClassName || 'pc-btn', playButtonClassName || 'pc-btn-play'].filter(Boolean).join(' ')
  const resolvedPlayLabel = isPlaying ? pauseLabel : isDone ? replayLabel : playLabel
  const resolvedPrevDisabled = prevDisabled ?? (canPrev === undefined
    ? (Number.isInteger(activeStep) && Number.isInteger(totalSteps) ? activeStep <= 0 : undefined)
    : !canPrev)
  const resolvedNextDisabled = nextDisabled ?? (canNext === undefined
    ? (Number.isInteger(activeStep) && Number.isInteger(totalSteps) ? activeStep >= totalSteps - 1 : undefined)
    : !canNext)
  const resolvedPrev = onPrev ?? (onStepChange && Number.isInteger(activeStep)
    ? () => onStepChange(Math.max(0, activeStep - 1)) : undefined)
  const resolvedNext = onNext ?? (onStepChange && Number.isInteger(activeStep)
    ? () => onStepChange(Number.isInteger(totalSteps) ? Math.min(totalSteps - 1, activeStep + 1) : activeStep + 1) : undefined)
  const resolvedPlayToggle = onPlayToggle ?? onTogglePlayback

  return (
    <div className={resolvedRootClass} style={{ padding: '8px' }}>
      <ButtonGroup {...buttonGroupProps}>
        {leftSlot}
        <button type="button" className={resetClasses} onClick={onReset} disabled={resetDisabled} title={resetTitle}>
          {renderResetContent ? renderResetContent() : resetLabel}
        </button>
        <button type="button" className={ghostClasses} onClick={resolvedPrev} disabled={resolvedPrevDisabled}>{prevLabel}</button>
        <button type="button" className={playClasses} onClick={resolvedPlayToggle}>{resolvedPlayLabel}</button>
        <button type="button" className={ghostClasses} onClick={resolvedNext} disabled={resolvedNextDisabled}>{nextLabel}</button>
      </ButtonGroup>

      {middleSlot}

      {showSpeed && (
        <div className={resolvedSpeedOuterClass}>
          <div className={resolvedSpeedWrapClass}>
            <span className={resolvedSpeedLabelClass}>{speedLabel}</span>
            <input
              className={resolvedSpeedInputClass}
              type="range"
              min={speedMin}
              max={speedMax}
              step={speedStep}
              value={speedRangeValue ?? speed}
              onChange={onSpeedChange}
              aria-label={speedAriaLabel}
            />
            {speedIndicator && <span className={resolvedSpeedIndicatorClass}>{speedIndicator}</span>}
          </div>
        </div>
      )}

      {showAutoScroll && onAutoScrollChange && (
        <div className="pc-autoscroll-group">
          <label className="pc-autoscroll-label">
            <input
              type="checkbox"
              className="pc-autoscroll-input"
              checked={autoScroll}
              onChange={(e) => onAutoScrollChange(e.target.checked)}
              aria-label={autoScrollLabel}
            />
            <span className="pc-autoscroll-text">{autoScrollLabel}</span>
          </label>
        </div>
      )}

      {showPatternOverlayToggle && onShowPatternOverlayChange && (
        <div className="pc-pattern-group">
          <label className="pc-pattern-label">
            <input
              type="checkbox"
              className="pc-pattern-input"
              checked={showPatternOverlay}
              onChange={(e) => onShowPatternOverlayChange(e.target.checked)}
              aria-label={patternOverlayLabel}
            />
            <span className="pc-pattern-text">{patternOverlayLabel}</span>
          </label>
        </div>
      )}

      {showDpDetailsToggle && onShowDpDetailsChange && (
        <div className="pc-dp-group">
          <label className="pc-dp-label">
            <input
              type="checkbox"
              className="pc-dp-input"
              checked={showDpDetails}
              onChange={(e) => onShowDpDetailsChange(e.target.checked)}
              aria-label={dpDetailsLabel}
            />
            <span className="pc-dp-text">{dpDetailsLabel}</span>
          </label>
        </div>
      )}

      {showEdgeFlowToggle && onShowEdgeFlowChange && (
        <div className="pc-edge-group">
          <label className="pc-edge-label">
            <input
              type="checkbox"
              className="pc-edge-input"
              checked={showEdgeFlow}
              onChange={(e) => onShowEdgeFlowChange(e.target.checked)}
              aria-label={edgeFlowLabel}
            />
            <span className="pc-edge-text">{edgeFlowLabel}</span>
          </label>
        </div>
      )}

      {showComparisonsToggle && onShowComparisonsChange && (
        <div className="pc-comparison-group">
          <label className="pc-comparison-label">
            <input
              type="checkbox"
              className="pc-comparison-input"
              checked={showComparisons}
              onChange={(e) => onShowComparisonsChange(e.target.checked)}
              aria-label={comparisonsLabel}
            />
            <span className="pc-comparison-text">{comparisonsLabel}</span>
          </label>
        </div>
      )}

      {showRankHighlightToggle && onShowRankHighlightChange && (
        <div className="pc-rank-group">
          <label className="pc-rank-label">
            <input
              type="checkbox"
              className="pc-rank-input"
              checked={showRankHighlight}
              onChange={(e) => onShowRankHighlightChange(e.target.checked)}
              aria-label={rankHighlightLabel}
            />
            <span className="pc-rank-text">{rankHighlightLabel}</span>
          </label>
        </div>
      )}

      {showInsertBreakdownToggle && onShowInsertBreakdownChange && (
        <div className="pc-insert-group">
          <label className="pc-insert-label">
            <input
              type="checkbox"
              className="pc-insert-input"
              checked={showInsertBreakdown}
              onChange={(e) => onShowInsertBreakdownChange(e.target.checked)}
              aria-label={insertBreakdownLabel}
            />
            <span className="pc-insert-text">{insertBreakdownLabel}</span>
          </label>
        </div>
      )}

      {showBottomUpToggle && onShowBottomUpChange && (
        <div className="pc-bottomup-group">
          <label className="pc-bottomup-label">
            <input
              type="checkbox"
              className="pc-bottomup-input"
              checked={showBottomUp}
              onChange={(e) => onShowBottomUpChange(e.target.checked)}
              aria-label={bottomUpLabel}
            />
            <span className="pc-bottomup-text">{bottomUpLabel}</span>
          </label>
        </div>
      )}

      {showTraversalTrailToggle && onShowTraversalTrailChange && (
        <div className="pc-trail-group">
          <label className="pc-trail-label">
            <input
              type="checkbox"
              className="pc-trail-input"
              checked={showTraversalTrail}
              onChange={(e) => onShowTraversalTrailChange(e.target.checked)}
              aria-label={traversalTrailLabel}
            />
            <span className="pc-trail-text">{traversalTrailLabel}</span>
          </label>
        </div>
      )}

      {showValueSourceToggle && onShowValueSourceChange && (
        <div className="pc-source-group">
          <label className="pc-source-label">
            <input
              type="checkbox"
              className="pc-source-input"
              checked={showValueSource}
              onChange={(e) => onShowValueSourceChange(e.target.checked)}
              aria-label={valueSourceLabel}
            />
            <span className="pc-source-text">{valueSourceLabel}</span>
          </label>
        </div>
      )}
    </div>
  )
}
