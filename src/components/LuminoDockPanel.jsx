import { useEffect, useRef } from 'react'
import { BoxPanel, DockPanel, Widget } from '@lumino/widgets'
import { MessageLoop } from '@lumino/messaging'
import './LuminoDockPanel.css'

// Fraction of a split area a collapsed panel is allowed to keep. Small enough
// that only its ~36px tab strip shows; siblings take the rest.
const COLLAPSED_FRACTION = 0.0001

export default function LuminoDockPanel({ panels, onPanelReady }) {
  const containerRef = useRef(null)
  const onPanelReadyRef = useRef(onPanelReady)
  const dockRef = useRef(null)
  const boxRef = useRef(null)
  const widgetRefsRef = useRef({})
  const contentDivsRef = useRef({})
  // Layout snapshot taken the first time a panel is minimized, so restore can
  // return split fractions to their pre-collapse values.
  const savedSizesRef = useRef({})
  const collapseTimersRef = useRef({})
  // Points at applyCollapse so the per-widget minimize button (created in the
  // PanelWidget constructor) can invoke it once defined below.
  const collapseCallbackRef = useRef(null)

  // Parents often provide an inline callback that stores panel DOM nodes in
  // state. Keep that callback current without treating its identity change as
  // a reason to dispose and recreate the entire Lumino workspace.
  useEffect(() => {
    onPanelReadyRef.current = onPanelReady
  }, [onPanelReady])

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current

    // Be explicit: this is a user-arrangeable workspace. Lumino defaults to
    // movable tabs, but setting it here prevents version/config regressions.
    const dock = new DockPanel({ spacing: 6, tabsMovable: true })
    // Set the runtime property too: it propagates to tab bars created as the
    // layout changes, whereas relying only on constructor options proved
    // inconsistent in some Lumino versions.
    dock.tabsMovable = true
    dock.id = 'dock'
    dockRef.current = dock
    const inlineStatusInCode = panels.some((panel) => panel.id === 'code') && panels.some((panel) => panel.id === 'status')

    class PanelWidget extends Widget {
      constructor(id, title) {
        super({ node: document.createElement('div') })
        this.id = id
        this.title.label = title
        // Not closable — we provide a minimize (collapse) control instead of
        // Lumino's destructive close.
        this.title.closable = false
        this.addClass('lumino-panel-widget')
        this.node.style.display = 'flex'
        this.node.style.flexDirection = 'column'
        this.node.style.overflow = 'hidden'
        this.node.style.position = 'relative'

        // Minimize/restore button pinned to the panel's top-right corner.
        // Stays visible even when the body is collapsed.
        const minBtn = document.createElement('button')
        minBtn.type = 'button'
        minBtn.className = 'lumino-panel-minbtn'
        const setMinButtonState = (collapsed) => {
          const label = collapsed ? 'Restore panel' : 'Collapse panel'
          minBtn.title = label
          minBtn.setAttribute('aria-label', label)
          // A small chevron reads as an affordance without competing with the
          // visualizer content. The static SVG is created locally, not from
          // user content.
          minBtn.innerHTML = collapsed
            ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg>'
            : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 10 3.5-3.5 3.5 3.5" /></svg>'
        }
        setMinButtonState(false)
        minBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          this._collapsed = !this._collapsed
          this.node.classList.toggle('is-collapsed', this._collapsed)
          setMinButtonState(this._collapsed)
          collapseCallbackRef.current?.(id, this._collapsed)
        })
        this.node.appendChild(minBtn)
        this._collapsed = false

        const contentDiv = document.createElement('div')
        contentDiv.style.flex = '1'
        contentDiv.style.overflow = 'hidden'
        contentDiv.style.display = 'flex'
        contentDiv.style.flexDirection = 'column'
        contentDiv.setAttribute('data-panel-id', id)
        this.node.appendChild(contentDiv)

        // Status is metadata for the code trace, not an independently sized
        // workspace.  Mount it above code so its height is exactly its content
        // height; this avoids a second Lumino split with unavoidable empty
        // space below a one-line message.
        if (id === 'code' && inlineStatusInCode) {
          const statusDiv = document.createElement('div')
          statusDiv.className = 'lumino-inline-status'
          statusDiv.setAttribute('data-panel-id', 'status')
          contentDiv.appendChild(statusDiv)

          const codeDiv = document.createElement('div')
          codeDiv.className = 'lumino-code-content'
          codeDiv.style.flex = '1 1 auto'
          codeDiv.style.minHeight = '0'
          codeDiv.style.overflow = 'hidden'
          contentDiv.appendChild(codeDiv)
          contentDivsRef.current.status = statusDiv
          contentDivsRef.current.code = codeDiv
        } else {
          contentDiv.style.overflow = 'auto'
          contentDivsRef.current[id] = contentDiv
        }
      }
    }

    // Create and add all widgets
    let firstWidget = null
    let previousWidget = null
    panels.forEach((panelConfig) => {
      if (inlineStatusInCode && panelConfig.id === 'status') return
      const widget = new PanelWidget(panelConfig.id, panelConfig.title)
      widgetRefsRef.current[panelConfig.id] = widget

      if (!firstWidget) {
        dock.addWidget(widget)
        firstWidget = widget
      } else {
        // A consistent learning layout matters more than the historical order
        // in which each problem happened to register its panels: visualization
        // on the left, code on the right, and the short status readout above
        // the code.  Older visualizers all use these conventional ids.
        const isCode = panelConfig.id === 'code'
        const refWidget = isCode && !panelConfig.dockMode ? firstWidget : previousWidget
        dock.addWidget(widget, {
          mode: panelConfig.dockMode || 'split-right',
          ref: refWidget,
        })
      }
      previousWidget = widget
    })

    // Use BoxPanel to manage dock sizing
    const box = new BoxPanel({ direction: 'top-to-bottom', spacing: 0 })
    box.id = 'lumino-box'
    box.addWidget(dock)
    BoxPanel.setStretch(dock, 1)
    boxRef.current = box

    Widget.attach(box, container)

    const fit = () => {
      // Use clientWidth/Height, not getBoundingClientRect(): under the CSS
      // `zoom` the app applies for page zoom, the rect is in scaled device
      // pixels while these are in unzoomed layout pixels. Lumino sizes and
      // positions its widgets in layout pixels, so feeding it scaled values
      // would shrink or overflow the dock at any zoom level other than 100%.
      const w = Math.max(0, container.clientWidth)
      const h = Math.max(0, container.clientHeight)
      if (w === 0 || h === 0) return
      box.node.style.position = 'absolute'
      box.node.style.top = '0'
      box.node.style.left = '0'
      box.node.style.width = w + 'px'
      box.node.style.height = h + 'px'
      MessageLoop.sendMessage(box, new Widget.ResizeMessage(w, h))
      box.update()
    }

    const resizeObserver = new ResizeObserver(fit)
    resizeObserver.observe(container)
    // The container is `position: absolute; inset: 0`, so it reports height 0
    // until an ancestor supplies a definite one — and `fit()` bails on 0,
    // leaving the dock unsized. Observing the offset parent means a height that
    // resolves later (fonts, flex reflow, layout-width change) still triggers a
    // fit rather than leaving panels stuck at their first measured size.
    const sizingParent = container.parentElement
    if (sizingParent) resizeObserver.observe(sizingParent)
    // Page zoom changes the container's layout size without necessarily
    // notifying the observer, so refit on the resize event too (ZoomContext
    // dispatches one after applying a new zoom level).
    window.addEventListener('resize', fit)
    const raf = requestAnimationFrame(fit)

    // ── Minimize / restore ────────────────────────────────────────────
    // Walk the saveLayout() config tree, find the split-area that directly
    // contains the tab-area holding `widget`, and rewrite that child's size
    // fraction. This collapses the panel in place; siblings absorb the space.
    const findWidgetSplit = (node, widget) => {
      if (!node || node.type !== 'split-area') return null
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        if (
          child.type === 'tab-area' &&
          child.widgets.some((w) => w === widget)
        ) {
          return { split: node, index: i }
        }
        const nested = findWidgetSplit(child, widget)
        if (nested) return nested
      }
      return null
    }

    const applyCollapse = (id, collapsed) => {
      const widget = widgetRefsRef.current[id]
      const contentDiv = contentDivsRef.current[id]
      if (!widget || !contentDiv) return

      // Let the content fade and slide before hiding it; restoring reverses
      // the same motion while Lumino reallocates the panel's space.
      window.clearTimeout(collapseTimersRef.current[id])
      if (collapsed) {
        contentDiv.classList.remove('is-opening')
        contentDiv.classList.add('is-closing')
        contentDiv.setAttribute('aria-hidden', 'true')
        collapseTimersRef.current[id] = window.setTimeout(() => {
          contentDiv.style.display = 'none'
          contentDiv.classList.remove('is-closing')
        }, 180)
      } else {
        contentDiv.style.display = 'flex'
        contentDiv.setAttribute('aria-hidden', 'false')
        contentDiv.classList.add('is-opening')
        requestAnimationFrame(() => {
          requestAnimationFrame(() => contentDiv.classList.remove('is-opening'))
        })
      }

      const config = dock.saveLayout()
      const hit = findWidgetSplit(config.main, widget)
      if (!hit) {
        // Panel isn't in a split (it's the only area) — nothing to reclaim.
        box.update()
        return
      }
      const { split, index } = hit

      if (collapsed) {
        // Remember the pre-collapse fractions once
        if (!savedSizesRef.current[id]) {
          savedSizesRef.current[id] = split.sizes.slice()
        }
        const others = split.sizes.length - 1
        const remaining = 1 - COLLAPSED_FRACTION
        split.sizes = split.sizes.map((_, i) =>
          i === index ? COLLAPSED_FRACTION : remaining / others
        )
      } else {
        const saved = savedSizesRef.current[id]
        if (saved && saved.length === split.sizes.length) {
          split.sizes = saved.slice()
        }
        delete savedSizesRef.current[id]
      }

      dock.restoreLayout(config)
      fit()
    }

    // Wire the ref so per-widget minimize buttons can call applyCollapse
    collapseCallbackRef.current = applyCollapse

    // Expose the collapse API + panel divs to the parent
    onPanelReadyRef.current?.(contentDivsRef.current, { applyCollapse })

    return () => {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      window.removeEventListener('resize', fit)
      Object.values(collapseTimersRef.current).forEach(window.clearTimeout)
      try {
        box.dispose()
      } catch {
        // Already disposed
      }
    }
  }, [panels.length])

  return <div ref={containerRef} className="lumino-dock-container" />
}
