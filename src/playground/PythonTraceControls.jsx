import { useMemo, useState } from "react";

const KIND_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "sequence", label: "Sequence" },
  { value: "grid", label: "Grid" },
  { value: "associative", label: "Associative" },
  { value: "graph", label: "Graph" },
  { value: "tree", label: "Tree" },
  { value: "heap", label: "Heap" },
  { value: "scalar", label: "Scalar" },
];

const SEQUENCE_VIEWS = [
  { value: "cells", label: "Cells" },
  { value: "bars", label: "Bars" },
  { value: "line", label: "Line" },
];

const POINTER_MODES = [
  { value: "index", label: "Index" },
  { value: "value", label: "Matching value" },
];

function inferredKind(variable) {
  const kind = String(
    variable?.suggestedKind
    ?? variable?.category
    ?? variable?.type
    ?? "scalar",
  ).toLowerCase();
  const name = String(variable?.name ?? "").toLowerCase();
  if (kind === "heap" || name === "heap" || name.endsWith("heap") || name.includes("priority_queue")) {
    return "heap";
  }
  if (["array", "list", "tuple", "deque", "string", "sequence"].includes(kind)) {
    return "sequence";
  }
  if (["matrix", "table", "dp", "heatmap", "grid"].includes(kind)) return "grid";
  if (["map", "dict", "set", "counter", "associative"].includes(kind)) {
    return "associative";
  }
  if (kind === "graph" || kind === "tree") return kind;
  return "scalar";
}

function effectiveKind(variable, binding) {
  return binding?.kind == null || binding.kind === "" || binding.kind === "auto"
    ? inferredKind(variable)
    : binding.kind;
}

export default function PythonTraceControls({
  entryValue = "",
  onEntryChange,
  inputValue,
  onInputChange,
  inputError,
  variables = [],
  variablesStale = false,
  bindings = {},
  onBindingsChange,
  onSuggestVisuals,
  onGenerateInputs,
  onProposeWorkspace,
  isSuggestingVisuals = false,
  aiFeedback,
  traceError,
  disabled = false,
}) {
  const [tab, setTab] = useState("inputs");
  const [aiInputPrompt, setAiInputPrompt] = useState("");
  const sequenceVariables = useMemo(
    () => variables.filter((variable) => {
      const binding = bindings[String(variable.name)] ?? {};
      return binding.enabled !== false && effectiveKind(variable, binding) === "sequence";
    }),
    [bindings, variables],
  );
  const sequenceNames = useMemo(
    () => new Set(sequenceVariables.map((variable) => String(variable.name))),
    [sequenceVariables],
  );
  const enabledCount = variables.filter(
    (variable) => bindings[String(variable.name)]?.enabled,
  ).length;
  const suggestionBlockedReason = disabled
    ? "Python is tracing now. Suggestions unlock when the run finishes."
    : "";

  const updateBinding = (variable, patch) => {
    const name = String(variable.name);
    const current = bindings[name] ?? {};
    const next = {
      ...current,
      ...patch,
      ...(Object.hasOwn(patch, "role") ? { roleExplicit: true } : null),
    };
    const kind = effectiveKind(variable, next);

    if (kind !== "scalar") {
      next.role = "value";
      next.target = null;
      next.pointerMode = null;
    } else if (next.role === "pointer") {
      next.target = sequenceNames.has(next.target)
        ? next.target
        : (sequenceVariables[0]?.name ?? null);
      next.pointerMode = ["index", "value"].includes(next.pointerMode)
        ? next.pointerMode
        : (variable.loopRole === "value" ? "value" : "index");
    }

    onBindingsChange?.({ ...bindings, [name]: next });
  };

  return (
    <section
      className="runtime-playground__trace-config"
      aria-label="Python trace configuration"
      aria-busy={disabled || undefined}
    >
      <div className="runtime-playground__trace-tabs" role="tablist" aria-label="Trace configuration">
        <button
          id="runtime-playground-inputs-tab"
          type="button"
          role="tab"
          aria-selected={tab === "inputs"}
          aria-controls="runtime-playground-inputs-pane"
          className={tab === "inputs" ? "is-active" : ""}
          onClick={() => setTab("inputs")}
        >
          Inputs
        </button>
        <button
          id="runtime-playground-visuals-tab"
          type="button"
          role="tab"
          aria-selected={tab === "visuals"}
          aria-controls="runtime-playground-visuals-pane"
          className={tab === "visuals" ? "is-active" : ""}
          onClick={() => setTab("visuals")}
        >
          Visuals <span>{enabledCount}/{variables.length}</span>
        </button>
      </div>

      {tab === "inputs" ? (
        <div
          id="runtime-playground-inputs-pane"
          className="runtime-playground__trace-pane runtime-playground__trace-fields"
          role="tabpanel"
          aria-labelledby="runtime-playground-inputs-tab"
        >
          <label htmlFor="runtime-playground-python-entry">
            Entry
            <small>Optional, for example Solution.maxProfit</small>
          </label>
          <input
            id="runtime-playground-python-entry"
            type="text"
            value={entryValue}
            placeholder="Auto-detect one public method"
            onChange={(event) => onEntryChange?.(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
          />

          <label htmlFor="runtime-playground-python-input">
            Method arguments
            <small>Any JSON value; objects become keyword arguments</small>
          </label>
          <textarea
            id="runtime-playground-python-input"
            value={inputValue}
            onChange={(event) => onInputChange?.(event.target.value)}
            spellCheck={false}
            aria-invalid={Boolean(inputError)}
            aria-describedby={inputError ? "runtime-playground-python-input-error" : undefined}
            disabled={disabled}
          />
          {inputError && (
            <p id="runtime-playground-python-input-error" className="runtime-playground__trace-error" role="alert">
              {inputError}
            </p>
          )}
          <div className="runtime-playground__input-ai">
            <label htmlFor="runtime-playground-python-input-prompt">
              Ask AI for inputs
              <small>Describe the case, constraints, or behavior you want to visualize</small>
            </label>
            <textarea
              id="runtime-playground-python-input-prompt"
              value={aiInputPrompt}
              onChange={(event) => setAiInputPrompt(event.target.value)}
              placeholder="Example: Three sorted linked lists with duplicates and negative values"
              spellCheck={false}
              disabled={disabled || isSuggestingVisuals}
            />
            <div className="runtime-playground__input-ai-actions">
              <button
                type="button"
                onClick={() => onGenerateInputs?.(aiInputPrompt)}
                disabled={disabled || isSuggestingVisuals}
              >
                {isSuggestingVisuals ? "Generating..." : "Generate input JSON"}
              </button>
              <button
                type="button"
                onClick={() => onProposeWorkspace?.(aiInputPrompt)}
                disabled={disabled || isSuggestingVisuals || !aiInputPrompt.trim()}
              >
                Propose code + inputs
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div
          id="runtime-playground-visuals-pane"
          className="runtime-playground__trace-pane runtime-playground__bindings"
          role="tabpanel"
          aria-labelledby="runtime-playground-visuals-tab"
        >
          <div className="runtime-playground__trace-ai">
            <span>
              <strong>AI layout</strong>
              <small>Sends code and a bounded trace summary to the selected AI provider.</small>
            </span>
          <button
            type="button"
            onClick={() => onSuggestVisuals?.()}
            disabled={disabled || isSuggestingVisuals}
            aria-describedby={suggestionBlockedReason ? "runtime-playground-ai-suggestion-reason" : undefined}
            title={suggestionBlockedReason || "Suggest a visual layout with the selected AI provider"}
          >
            {isSuggestingVisuals
              ? "Suggesting..."
              : disabled
                ? "Tracing..."
                : variables.length === 0 || variablesStale || inputError || traceError
                  ? "AI generate inputs"
                  : "Suggest visuals"}
          </button>
          </div>
          {aiFeedback?.message && (
            <p
              className={`runtime-playground__trace-ai-feedback runtime-playground__trace-ai-feedback--${aiFeedback.phase}`}
              role={aiFeedback.phase === "error" ? "alert" : "status"}
            >
              {aiFeedback.message}
            </p>
          )}
          {suggestionBlockedReason && (
            <p
              id="runtime-playground-ai-suggestion-reason"
              className="runtime-playground__trace-ai-reason"
              role="status"
            >
              {suggestionBlockedReason}
            </p>
          )}
          {variables.length === 0 ? (
            <p className="runtime-playground__trace-empty" role="status">
              {variablesStale
                ? "Source or inputs changed. Run Python again to refresh its variables."
                : "Run the Python code once to discover visual variables."}
            </p>
          ) : variables.map((variable) => {
            const name = String(variable.name);
            const binding = bindings[name] ?? {};
            const kind = effectiveKind(variable, binding);
            const role = binding.role ?? "value";
            const target = sequenceNames.has(binding.target) ? binding.target : "";
            const controlsDisabled = disabled || !binding.enabled;

            return (
              <div className="runtime-playground__binding" key={variable.id ?? name}>
                <label className="runtime-playground__binding-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(binding.enabled)}
                    disabled={disabled}
                    onChange={(event) => updateBinding(variable, { enabled: event.target.checked })}
                  />
                  <span>
                    <code title={name}>{name}</code>
                    <small>{inferredKind(variable)}</small>
                  </span>
                </label>

                <div className="runtime-playground__binding-controls">
                  <select
                    value={binding.kind ?? "auto"}
                    disabled={controlsDisabled}
                    aria-label={`${name} visual kind`}
                    onChange={(event) => updateBinding(variable, {
                      kind: event.target.value === "auto" ? null : event.target.value,
                    })}
                  >
                    {KIND_OPTIONS.map((option) => (
                      <option value={option.value} key={option.value}>{option.label}</option>
                    ))}
                  </select>

                  {kind === "sequence" && (
                    <select
                      value={binding.view ?? "cells"}
                      disabled={controlsDisabled}
                      aria-label={`${name} visual style`}
                      onChange={(event) => updateBinding(variable, { view: event.target.value })}
                    >
                      {SEQUENCE_VIEWS.map((view) => (
                        <option value={view.value} key={view.value}>{view.label}</option>
                      ))}
                    </select>
                  )}

                  {kind === "scalar" && (
                    <select
                      value={role}
                      disabled={controlsDisabled}
                      aria-label={`${name} visual role`}
                      onChange={(event) => updateBinding(variable, { role: event.target.value })}
                    >
                      <option value="value">Value</option>
                      <option value="pointer">Highlighter</option>
                    </select>
                  )}

                  {kind === "scalar" && role === "pointer" && (
                    <>
                      <select
                        value={binding.pointerMode ?? (variable.loopRole === "value" ? "value" : "index")}
                        disabled={controlsDisabled}
                        aria-label={`${name} highlighter matching mode`}
                        onChange={(event) => updateBinding(variable, { pointerMode: event.target.value })}
                      >
                        {POINTER_MODES.map((mode) => (
                          <option value={mode.value} key={mode.value}>{mode.label}</option>
                        ))}
                      </select>
                      <select
                        value={target}
                        disabled={controlsDisabled || sequenceVariables.length === 0}
                        aria-label={`${name} highlighter target`}
                        onChange={(event) => updateBinding(variable, { target: event.target.value })}
                      >
                        {sequenceVariables.length === 0 && <option value="">No sequence target</option>}
                        {sequenceVariables.map((candidate) => (
                          <option value={candidate.name} key={candidate.id ?? candidate.name}>
                            {candidate.name}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
