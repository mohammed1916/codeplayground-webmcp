import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PlaybackControls from "../components/PlaybackControls";
import { usePlaybackState } from "../hooks/usePlaybackState";
import {
  DEFAULT_PLAYGROUND_CODE,
  buildDeclarationPreview,
  runVisualizationSource,
} from "./runtime";
import { inferPythonInput } from "./runtime/inferPythonInput";
import { normalizePastedPythonSource } from "./runtime/normalizePythonSource";
import {
  DEFAULT_PYTHON_CODE,
  DEFAULT_PYTHON_INPUT,
  compilePythonTrace,
  createDefaultPythonBindings,
  runPythonTrace,
} from "./runtime/python";
import {
  suggestPythonBindings,
  suggestPythonInputs,
} from "./ai/suggestPythonBindings";
import VisualizationCanvas from "./renderers/VisualizationCanvas";
import PlaygroundAIProviderControls from "./PlaygroundAIProviderControls";
import PythonTraceControls from "./PythonTraceControls";
import RuntimeCodeEditor from "./RuntimeCodeEditor";
import AIFixReview from "./AIFixReview";
import { suggestPythonFix } from "./ai/suggestPythonFix";
import {
  PLAYGROUND_WEBMCP_TOOL_COUNT,
  createPlaygroundWebMCPTools,
  getDocumentModelContext,
  sameWorkspaceProposal,
  summarizeScene,
} from "./webmcp/playgroundWebMCP";
import "./RuntimePlayground.css";

const SOURCE_STORAGE_KEY = "cpviz.runtime-playground.source.v1";
const PYTHON_SOURCE_STORAGE_KEY = "cpviz.runtime-playground.python-source.v1";
const PYTHON_INPUT_STORAGE_KEY = "cpviz.runtime-playground.python-input.v1";
const PYTHON_ENTRY_STORAGE_KEY = "cpviz.runtime-playground.python-entry.v1";
const PYTHON_BINDINGS_STORAGE_KEY = "cpviz.runtime-playground.python-bindings.v2";
const MODE_STORAGE_KEY = "cpviz.runtime-playground.mode.v1";
const AUTO_RUN_DELAY_MS = 600;
const PYTHON_AUTO_RUN_DELAY_MS = 900;
const MAX_SOURCE_LENGTH = 50_000;
const RUN_LIMITS = Object.freeze({
  timeoutMs: 1_500,
  maxFrames: 240,
  maxOperations: 4_000,
});
const PYTHON_RUN_LIMITS = Object.freeze({
  timeoutMs: 45_000,
  maxFrames: 240,
});
function readStoredText(key, fallback) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function readStoredObject(key) {
  try {
    const stored = window.localStorage.getItem(key);
    const parsed = stored ? JSON.parse(stored) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "The visualization could not be executed.";
}

function waitForVisibleUpdate() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(finish, 250);
    window.requestAnimationFrame(() => window.requestAnimationFrame(finish));
  });
}

function containerCount(scene) {
  const containers = scene?.containers;
  if (Array.isArray(containers)) return containers.length;
  if (containers && typeof containers === "object") {
    return Object.keys(containers).length;
  }
  return 0;
}

function normalizeRunResult(result, fallbackScene) {
  const frames = Array.isArray(result?.frames)
    ? result.frames.filter((frame) => frame?.scene)
    : [];
  const scene = result?.scene ?? frames.at(-1)?.scene ?? fallbackScene;
  return { frames, scene };
}

function parsePythonInput(inputSource) {
  try {
    return { value: JSON.parse(inputSource), error: null };
  } catch (error) {
    return { value: null, error: `Input JSON: ${errorMessage(error)}` };
  }
}

function mergePythonBindings(defaults, previous, variables) {
  const validNames = new Set(
    (Array.isArray(variables) ? variables : []).map((variable) => String(variable.name)),
  );
  const merged = Object.fromEntries(
    Object.entries(defaults).map(([name, binding]) => {
      const saved = validNames.has(name) ? previous?.[name] : null;
      const preserveSavedRole = saved?.roleExplicit === true;
      return [name, {
        ...binding,
        ...saved,
        ...(!preserveSavedRole && binding.role === "pointer" ? {
          role: binding.role,
          target: binding.target,
          pointerMode: binding.pointerMode,
          indexOffset: binding.indexOffset,
        } : null),
      }];
    }),
  );
  return normalizePythonBindings(merged, variables);
}

function inferredPythonKind(variable) {
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

function effectivePythonKind(variable, binding) {
  const selected = binding?.kind;
  return selected == null || selected === "" || selected === "auto"
    ? inferredPythonKind(variable)
    : selected;
}

function normalizePythonBindings(bindings, variables) {
  const safeBindings = bindings && typeof bindings === "object"
    ? bindings
    : {};
  const variableByName = new Map(
    (Array.isArray(variables) ? variables : [])
      .filter((variable) => variable?.name != null)
      .map((variable) => [String(variable.name), variable]),
  );
  const sequenceTargets = new Set(
    Object.entries(safeBindings).flatMap(([name, binding]) => {
      const variable = variableByName.get(name);
      return binding?.enabled !== false
        && effectivePythonKind(variable, binding) === "sequence"
        ? [name]
        : [];
    }),
  );
  const firstTarget = sequenceTargets.values().next().value ?? null;

  return Object.fromEntries(
    Object.entries(safeBindings).map(([name, binding]) => {
      const config = binding && typeof binding === "object" ? binding : {};
      const variable = variableByName.get(name);
      const canPoint = effectivePythonKind(variable, config) === "scalar";
      if (config.role !== "pointer" || !canPoint) {
        return [name, {
          ...config,
          role: "value",
          target: null,
          pointerMode: null,
        }];
      }

      const target = sequenceTargets.has(config.target)
        ? config.target
        : firstTarget;
      const inferredMode = variable?.loopRole === "value" ? "value" : "index";
      return [name, {
        ...config,
        role: "pointer",
        target,
        pointerMode: ["index", "value"].includes(config.pointerMode)
          ? config.pointerMode
          : inferredMode,
      }];
    }),
  );
}

function executionErrorKind(error) {
  if (String(error?.code || "").includes("INPUT")) return "Input";
  if (String(error?.code || "").includes("SYNTAX")) return "Syntax";
  if (String(error?.code || "").startsWith("PYTHON")) return "Python";
  return "Runtime";
}

export default function RuntimePlayground({
  onBack,
  utilityControls = null,
  layoutWidth = "full",
  onLayoutChange,
}) {
  const [mode, setMode] = useState(() => {
    const stored = readStoredText(MODE_STORAGE_KEY, "python");
    return stored === "python" ? "python" : "script";
  });
  const [scriptSource, setScriptSource] = useState(() => (
    readStoredText(SOURCE_STORAGE_KEY, DEFAULT_PLAYGROUND_CODE)
  ));
  const [pythonSource, setPythonSource] = useState(() => (
    normalizePastedPythonSource(
      readStoredText(PYTHON_SOURCE_STORAGE_KEY, DEFAULT_PYTHON_CODE),
    )
  ));
  const [pythonInputSource, setPythonInputSource] = useState(() => (
    (() => {
      const storedInput = readStoredText(
      PYTHON_INPUT_STORAGE_KEY,
      JSON.stringify(DEFAULT_PYTHON_INPUT, null, 2),
      );
      const parsedInput = parsePythonInput(storedInput);
      if (parsedInput.error) return storedInput;
      const inferred = inferPythonInput(pythonSource, parsedInput.value);
      return inferred.changed
        ? JSON.stringify(inferred.value, null, 2)
        : storedInput;
    })()
  ));
  const [pythonEntry, setPythonEntry] = useState(() => (
    readStoredText(PYTHON_ENTRY_STORAGE_KEY, "")
  ));
  const [pythonVariables, setPythonVariables] = useState([]);
  const [pythonVariablesStale, setPythonVariablesStale] = useState(false);
  const [pythonBindings, setPythonBindings] = useState(() => (
    readStoredObject(PYTHON_BINDINGS_STORAGE_KEY)
  ));
  const pythonBindingsRef = useRef(pythonBindings);
  const isPython = mode === "python";
  const source = isPython ? pythonSource : scriptSource;
  const pythonInputState = useMemo(
    () => parsePythonInput(pythonInputSource),
    [pythonInputSource],
  );
  const [lastGoodRun, setLastGoodRun] = useState(null);
  const [executionError, setExecutionError] = useState(null);
  const [phase, setPhase] = useState(() =>
    source.trim() ? "waiting" : "idle",
  );
  const [isRunning, setIsRunning] = useState(false);
  const [aiVisualState, setAiVisualState] = useState({
    phase: "idle",
    message: "",
  });
  const [aiFixState, setAiFixState] = useState({ phase: "idle", proposal: null, message: "" });
  const [webMcpState, setWebMcpState] = useState({
    phase: "checking",
    message: "Checking for browser agent support...",
    lastAction: null,
  });
  const requestVersionRef = useRef(0);
  const suggestionVersionRef = useRef(0);
  const debounceRef = useRef(null);
  const abortControllerRef = useRef(null);
  const webMcpApiRef = useRef(null);

  const invokeWebMcpTool = useCallback(async (tool, input, signal) => {
    const handler = webMcpApiRef.current?.[tool];
    if (typeof handler !== "function") {
      throw new Error(`The ${tool} tool is not available in the current workspace.`);
    }
    if (signal?.aborted) throw new DOMException("The WebMCP tool call was cancelled.", "AbortError");
    setWebMcpState((previous) => ({
      ...previous,
      lastAction: { tool, phase: "running", message: `Agent is using ${tool.replaceAll("_", " ")}...` },
    }));
    try {
      const result = await handler(input, signal);
      setWebMcpState((previous) => ({
        ...previous,
        lastAction: {
          tool,
          phase: "success",
          message: result?.activity ?? `${tool.replaceAll("_", " ")} completed.`,
        },
      }));
      return result;
    } catch (error) {
      setWebMcpState((previous) => ({
        ...previous,
        lastAction: { tool, phase: "error", message: errorMessage(error) },
      }));
      throw error;
    }
  }, []);

  useEffect(() => {
    pythonBindingsRef.current = pythonBindings;
  }, [pythonBindings]);

  const declarationState = useMemo(() => {
    if (isPython) {
      return { scene: { containers: [] }, error: null };
    }
    try {
      return {
        scene: buildDeclarationPreview(source),
        error: null,
      };
    } catch (error) {
      return {
        scene: null,
        error: errorMessage(error),
      };
    }
  }, [isPython, source]);

  const frames = lastGoodRun?.mode === mode ? lastGoodRun.frames ?? [] : [];
  const {
    stepIndex,
    setStepIndex,
    isPlaying,
    setIsPlaying,
    speed,
    setSpeed,
    stepForward,
    stepBack,
    handleReset,
    isDone,
    canNext,
    canPrev,
  } = usePlaybackState(frames.length, 620);

  const cancelExecution = useCallback(
    (nextPhase) => {
      requestVersionRef.current += 1;
      suggestionVersionRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      window.clearTimeout(debounceRef.current);
      setIsRunning(false);
      setAiVisualState({ phase: "idle", message: "" });
      setIsPlaying(false);
      handleReset();
      setPhase(nextPhase);
    },
    [handleReset, setIsPlaying],
  );

  const executeSource = useCallback(
    async (runSource, { play = false } = {}) => {
      const runEntry = isPython ? pythonEntry : null;
      if (!runSource.trim()) {
        setPhase("idle");
        setExecutionError(null);
        handleReset();
        return { ok: false, status: "idle", message: "There is no source code to run." };
      }

      if (isPython && pythonInputState.error) {
        setExecutionError({
          source: runSource,
          mode,
          inputSource: pythonInputSource,
          entrySource: runEntry,
          code: "INVALID_INPUT",
          message: pythonInputState.error,
        });
        setPhase("error");
        return { ok: false, status: "error", code: "INVALID_INPUT", message: pythonInputState.error };
      }

      if (runSource.length > MAX_SOURCE_LENGTH) {
        setExecutionError({
          source: runSource,
          mode,
          inputSource: isPython ? pythonInputSource : null,
          entrySource: runEntry,
          code: "SOURCE_LIMIT",
          message: `Source is limited to ${MAX_SOURCE_LENGTH.toLocaleString()} characters.`,
        });
        setPhase("error");
        return {
          ok: false,
          status: "error",
          code: "SOURCE_LIMIT",
          message: `Source is limited to ${MAX_SOURCE_LENGTH.toLocaleString()} characters.`,
        };
      }

      const requestVersion = ++requestVersionRef.current;
      suggestionVersionRef.current += 1;
      setAiVisualState({ phase: "idle", message: "" });
      abortControllerRef.current?.abort();
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      setIsRunning(true);
      setPhase("running");
      setExecutionError(null);
      handleReset();

      try {
        const result = isPython
          ? await runPythonTrace(runSource, {
              ...PYTHON_RUN_LIMITS,
              input: pythonInputState.value,
              entry: runEntry,
              signal: abortController.signal,
            })
          : await runVisualizationSource(runSource, {
              ...RUN_LIMITS,
              signal: abortController.signal,
            });
        if (requestVersion !== requestVersionRef.current) {
          return { ok: false, status: "superseded", message: "A newer run replaced this one." };
        }

        let normalized;
        let traceResult = null;
        let resolvedBindings = pythonBindingsRef.current;
        if (isPython) {
          const defaults = createDefaultPythonBindings(result);
          resolvedBindings = mergePythonBindings(
            defaults,
            pythonBindingsRef.current,
            result.variables,
          );
          normalized = compilePythonTrace(result, resolvedBindings);
          traceResult = result;
          setPythonVariables(result.variables ?? []);
          setPythonVariablesStale(false);
          pythonBindingsRef.current = resolvedBindings;
          setPythonBindings(resolvedBindings);
        } else {
          normalized = normalizeRunResult(
            result,
            buildDeclarationPreview(runSource),
          );
        }
        setLastGoodRun({
          ...normalized,
          source: runSource,
          mode,
          inputSource: isPython ? pythonInputSource : null,
          entrySource: runEntry,
          traceResult,
          bindings: resolvedBindings,
        });
        abortControllerRef.current = null;
        setIsRunning(false);
        setPhase("ready");

        if (play && normalized.frames.length > 0) {
          setStepIndex(0);
          setIsPlaying(normalized.frames.length > 1);
        }
        return {
          ok: true,
          status: "ready",
          mode,
          frameCount: normalized.frames.length,
          containerCount: containerCount(normalized.scene),
          truncated: Boolean(result?.truncated || result?.metadata?.truncated),
          message: normalized.frames.at(-1)?.message ?? "Visualization completed successfully.",
        };
      } catch (error) {
        if (requestVersion !== requestVersionRef.current) {
          return { ok: false, status: "superseded", message: "A newer run replaced this one." };
        }
        abortControllerRef.current = null;
        setIsRunning(false);
        setPhase("error");
        setExecutionError({
          source: runSource,
          mode,
          inputSource: isPython ? pythonInputSource : null,
          entrySource: runEntry,
          message: errorMessage(error),
          code: error?.code,
          line: error?.line,
        });
        return {
          ok: false,
          status: "error",
          code: error?.code ?? "RUNTIME_ERROR",
          line: error?.line ?? null,
          message: errorMessage(error),
        };
      }
    },
    [
      handleReset,
      isPython,
      mode,
      pythonEntry,
      pythonInputSource,
      pythonInputState.error,
      pythonInputState.value,
      setIsPlaying,
      setStepIndex,
    ],
  );

  const stopRun = useCallback(() => {
    cancelExecution("stopped");
  }, [cancelExecution]);

  const updateSource = useCallback(
    (nextSource) => {
      cancelExecution(nextSource.trim() ? "waiting" : "idle");
      setExecutionError(null);
      if (isPython) {
        setPythonSource(nextSource);
        setPythonVariables([]);
        setPythonVariablesStale(true);
        if (!pythonInputState.error) {
          const inferred = inferPythonInput(
            nextSource,
            pythonInputState.value,
            pythonEntry,
          );
          if (inferred.changed) {
            setPythonInputSource(JSON.stringify(inferred.value, null, 2));
          }
        }
      } else {
        setScriptSource(nextSource);
      }
    },
    [
      cancelExecution,
      isPython,
      pythonEntry,
      pythonInputState.error,
      pythonInputState.value,
    ],
  );

  const updatePythonInput = useCallback(
    (nextInput) => {
      cancelExecution(source.trim() ? "waiting" : "idle");
      setExecutionError(null);
      setPythonInputSource(nextInput);
      setPythonVariables([]);
      setPythonVariablesStale(true);
    },
    [cancelExecution, source],
  );

  const updatePythonEntry = useCallback(
    (nextEntry) => {
      cancelExecution(source.trim() ? "waiting" : "idle");
      setExecutionError(null);
      setPythonEntry(nextEntry);
      setPythonVariables([]);
      setPythonVariablesStale(true);
    },
    [cancelExecution, source],
  );

  const changeMode = useCallback(
    (nextMode) => {
      if (nextMode === mode) return;
      const nextSource = nextMode === "python" ? pythonSource : scriptSource;
      cancelExecution(nextSource.trim() ? "waiting" : "idle");
      setExecutionError(null);
      setLastGoodRun(null);
      setMode(nextMode);
    },
    [cancelExecution, mode, pythonSource, scriptSource],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(SOURCE_STORAGE_KEY, scriptSource);
    } catch {
      // The playground still works when storage is disabled.
    }
  }, [scriptSource]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PYTHON_SOURCE_STORAGE_KEY, pythonSource);
      window.localStorage.setItem(PYTHON_INPUT_STORAGE_KEY, pythonInputSource);
      window.localStorage.setItem(PYTHON_ENTRY_STORAGE_KEY, pythonEntry);
      window.localStorage.setItem(PYTHON_BINDINGS_STORAGE_KEY, JSON.stringify(pythonBindings));
      window.localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      // The trace mode still works when storage is disabled.
    }
  }, [mode, pythonBindings, pythonEntry, pythonInputSource, pythonSource]);

  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    if (
      !source.trim()
      || declarationState.error
      || (isPython && pythonInputState.error)
    ) return undefined;

    debounceRef.current = window.setTimeout(() => {
      executeSource(source);
    }, isPython ? PYTHON_AUTO_RUN_DELAY_MS : AUTO_RUN_DELAY_MS);

    return () => window.clearTimeout(debounceRef.current);
  }, [declarationState.error, executeSource, isPython, pythonInputState.error, source]);

  useEffect(
    () => () => {
      requestVersionRef.current += 1;
      suggestionVersionRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      window.clearTimeout(debounceRef.current);
    },
    [],
  );

  const hasCurrentRun = Boolean(
    lastGoodRun?.mode === mode
    && lastGoodRun?.source === source
    && (!isPython || (
      lastGoodRun?.inputSource === pythonInputSource
      && lastGoodRun?.entrySource === pythonEntry
    )),
  );
  const currentFrames = hasCurrentRun ? frames : [];
  const currentFrame =
    stepIndex >= 0 ? currentFrames[stepIndex] ?? null : null;
  const currentError = declarationState.error
    ? { message: declarationState.error, kind: "Declaration" }
    : isPython && pythonInputState.error
      ? { message: pythonInputState.error, kind: "Input", line: null }
    : executionError?.source === source
      && executionError?.mode === mode
      && (!isPython || (
        executionError?.inputSource === pythonInputSource
        && executionError?.entrySource === pythonEntry
      ))
      ? {
          message: executionError.message,
          kind: executionErrorKind(executionError),
          line: executionError.line,
        }
      : null;
  const declarationCount = containerCount(declarationState.scene);
  const showingDeclarations = !hasCurrentRun && declarationCount > 0;
  const showingLastGood = Boolean(
    currentError && lastGoodRun && !showingDeclarations,
  );

  const displayScene = currentFrame?.scene
    ?? (hasCurrentRun ? lastGoodRun.scene : null)
    ?? (showingDeclarations ? declarationState.scene : null)
    ?? (showingLastGood ? lastGoodRun.scene : null)
    ?? declarationState.scene
    ?? (!isPython ? lastGoodRun?.scene : null)
    ?? { containers: [] };
  const traceWasTruncated = Boolean(
    isPython
    && hasCurrentRun
    && (
      lastGoodRun?.truncated
      || lastGoodRun?.metadata?.truncated
      || lastGoodRun?.traceResult?.truncated
    ),
  );
  const traceWarning = typeof lastGoodRun?.warning === "string"
    ? lastGoodRun.warning
    : `Playback is limited to the first ${currentFrames.length.toLocaleString()} captured frames; the Python result still ran to completion.`;

  const playCurrentSource = useCallback(() => {
    window.clearTimeout(debounceRef.current);

    if (isRunning) {
      stopRun();
      return;
    }
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    if (!hasCurrentRun || frames.length === 0) {
      executeSource(source, { play: true });
      return;
    }
    if (stepIndex < 0 || isDone) {
      setStepIndex(0);
      setIsPlaying(frames.length > 1);
      return;
    }
    setIsPlaying(true);
  }, [
    executeSource,
    frames.length,
    hasCurrentRun,
    isDone,
    isPlaying,
    isRunning,
    setIsPlaying,
    setStepIndex,
    source,
    stepIndex,
    stopRun,
  ]);

  const runWithoutPlayback = useCallback(() => {
    window.clearTimeout(debounceRef.current);
    executeSource(source);
  }, [executeSource, source]);

  const rewindPlayback = useCallback(() => {
    setIsPlaying(false);
    setStepIndex(currentFrames.length > 0 ? 0 : -1);
  }, [currentFrames.length, setIsPlaying, setStepIndex]);

  const resetExample = useCallback(() => {
    if (isPython) {
      const nextInput = JSON.stringify(DEFAULT_PYTHON_INPUT, null, 2);
      cancelExecution("waiting");
      setExecutionError(null);
      setPythonVariables([]);
      setPythonVariablesStale(true);
      pythonBindingsRef.current = {};
      setPythonBindings({});
      setLastGoodRun(null);
      setPythonSource(DEFAULT_PYTHON_CODE);
      setPythonInputSource(nextInput);
      setPythonEntry("");
      return;
    }
    if (source === DEFAULT_PLAYGROUND_CODE) {
      executeSource(DEFAULT_PLAYGROUND_CODE);
      return;
    }
    updateSource(DEFAULT_PLAYGROUND_CODE);
  }, [cancelExecution, executeSource, isPython, source, updateSource]);

  const updatePythonBindings = useCallback(
    (bindings) => {
      const nextBindings = normalizePythonBindings(bindings, pythonVariables);
      pythonBindingsRef.current = nextBindings;
      setPythonBindings(nextBindings);
      if (
        !hasCurrentRun
        || !lastGoodRun?.traceResult
        || lastGoodRun.mode !== "python"
      ) return;

      const normalized = compilePythonTrace(lastGoodRun.traceResult, nextBindings);
      setLastGoodRun({
        ...lastGoodRun,
        ...normalized,
        bindings: nextBindings,
      });
      setIsPlaying(false);
      setStepIndex((previous) => (
        previous < normalized.frames.length
          ? previous
          : Math.max(-1, normalized.frames.length - 1)
      ));
    },
    [
      hasCurrentRun,
      lastGoodRun,
      pythonVariables,
      setIsPlaying,
      setStepIndex,
    ],
  );

  const suggestVisualBindings = useCallback(async ({ forceInputs = false, instruction = "" } = {}) => {
    if (!isPython || !pythonSource.trim()) return;

    const suggestionVersion = ++suggestionVersionRef.current;
    const needsTrace = forceInputs || !hasCurrentRun
      || !lastGoodRun?.traceResult
      || pythonVariables.length === 0
      || pythonVariablesStale;
    setAiVisualState({
      phase: "running",
      message: needsTrace
        ? "Asking the selected AI provider for runnable example inputs..."
        : "Asking the selected AI provider for a visual layout...",
    });

    try {
      if (needsTrace) {
        const suggestion = await suggestPythonInputs({
          source: pythonSource,
          inputSource: pythonInputSource,
          entry: pythonEntry,
          instruction,
        });
        if (suggestionVersion !== suggestionVersionRef.current) return;
        setPythonInputSource(suggestion.inputSource);
        setExecutionError(null);
        setPythonVariables([]);
        setPythonVariablesStale(true);
        setPhase("waiting");
        setAiVisualState({
          phase: "success",
          message: `${suggestion.provider}: ${suggestion.summary}${suggestion.removedInputs.length > 0
            ? ` Removed unsupported argument${suggestion.removedInputs.length === 1 ? "" : "s"}: ${suggestion.removedInputs.join(", ")}.`
            : ""} Running the trace...`,
        });
        return;
      }

      const suggestion = await suggestPythonBindings({
        source: pythonSource,
        inputSource: pythonInputSource,
        entry: pythonEntry,
        traceResult: lastGoodRun.traceResult,
        bindings: pythonBindingsRef.current,
      });
      if (suggestionVersion !== suggestionVersionRef.current) return;

      const nextBindings = normalizePythonBindings({
        ...pythonBindingsRef.current,
        ...Object.fromEntries(
          Object.entries(suggestion.bindings).map(([name, binding]) => [
            name,
            { ...pythonBindingsRef.current[name], ...binding },
          ]),
        ),
      }, pythonVariables);
      updatePythonBindings(nextBindings);
      setAiVisualState({
        phase: "success",
        message: `${suggestion.provider}: ${suggestion.summary}`,
      });
    } catch (error) {
      if (suggestionVersion !== suggestionVersionRef.current) return;
      setAiVisualState({
        phase: "error",
        message: `${errorMessage(error)} Check the AI visual provider settings.`,
      });
    }
  }, [
    hasCurrentRun,
    isPython,
    lastGoodRun,
    pythonEntry,
    pythonInputSource,
    pythonSource,
    pythonVariables,
    pythonVariablesStale,
    updatePythonBindings,
  ]);

  const currentErrorMessage = currentError?.message ?? "";
  const requestAiFix = useCallback(async () => {
    if (!isPython || !currentErrorMessage || aiFixState.phase === "running") return;
    setAiFixState({ phase: "running", proposal: null, message: "Asking the selected AI provider for a minimal repair..." });
    try {
      const proposal = await suggestPythonFix({
        source: pythonSource,
        inputSource: pythonInputSource,
        entry: pythonEntry,
        error: { message: currentErrorMessage },
      });
      setAiFixState({ phase: "review", proposal, message: "" });
    } catch (error) {
      setAiFixState({ phase: "error", proposal: null, message: errorMessage(error) });
    }
  }, [aiFixState.phase, currentErrorMessage, isPython, pythonEntry, pythonInputSource, pythonSource]);

  const requestAiWorkspaceChange = useCallback(async (instruction) => {
    if (!isPython || !instruction.trim() || aiFixState.phase === "running") return;
    setAiFixState({ phase: "running", proposal: null, message: "Preparing a code and input proposal..." });
    try {
      const proposal = await suggestPythonFix({
        source: pythonSource,
        inputSource: pythonInputSource,
        entry: pythonEntry,
        instruction,
        error: { message: "No runtime error; follow the user's requested workspace change." },
      });
      setAiFixState({ phase: "review", proposal, message: "" });
    } catch (error) {
      setAiFixState({ phase: "error", proposal: null, message: errorMessage(error) });
    }
  }, [aiFixState.phase, isPython, pythonEntry, pythonInputSource, pythonSource]);

  const acceptAiFix = useCallback(() => {
    const proposal = aiFixState.proposal;
    if (!proposal) return;
    cancelExecution("waiting");
    setExecutionError(null);
    setPythonSource(proposal.source);
    setPythonInputSource(proposal.inputSource);
    setPythonVariables([]);
    setPythonVariablesStale(true);
    setAiFixState({ phase: "idle", proposal: null, message: "" });
  }, [aiFixState.proposal, cancelExecution]);

  const previewStatus = isRunning
    ? "Running"
    : showingDeclarations && currentError
      ? "Declarations only"
    : showingLastGood
      ? "Last good preview"
    : currentError
        ? "Error"
      : traceWasTruncated
        ? "Trace limited"
      : hasCurrentRun
        ? "Live"
      : phase === "stopped"
          ? "Stopped"
          : isPython
            ? "Awaiting run"
            : "Declarations";

  const statusMessage = currentFrame?.message
    ?? (showingLastGood
      ? "The editor has an error, so the last successful preview is preserved."
      : hasCurrentRun
        ? "Ready to play the generated timeline."
        : phase === "waiting"
          ? isPython
            ? "Python changed. The isolated auto-run starts after you pause typing."
            : "Updating the live preview..."
          : phase === "stopped"
            ? "Execution stopped. Edit the code or press Play to run it again."
            : isPython
              ? "Provide inputs, then run the Python solution."
              : "Declare a structure with the viz API to begin.");
  const activeSourceLine = currentFrame?.source?.line ?? currentError?.line ?? null;

  webMcpApiRef.current = {
    get_workspace: async ({ detail = "summary", offset = 0, limit = 3000 } = {}) => {
      const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
      const safeLimit = Math.min(6000, Math.max(200, Math.floor(Number(limit) || 3000)));
      if (detail === "source" || detail === "inputs") {
        if (detail === "inputs" && !isPython) {
          throw new Error("Python inputs are available only while the workspace is in Python mode.");
        }
        const text = detail === "source" ? source : pythonInputSource;
        const end = Math.min(text.length, safeOffset + safeLimit);
        return {
          ok: true,
          detail,
          mode,
          offset: safeOffset,
          totalLength: text.length,
          chunk: text.slice(safeOffset, end),
          nextOffset: end < text.length ? end : null,
          activity: `Agent inspected a ${detail} chunk without changing the workspace.`,
        };
      }

      const variables = pythonVariables.slice(0, 24).map((variable) => ({
        name: String(variable.name),
        type: variable.type ?? null,
        category: variable.category ?? null,
        suggestedKind: variable.suggestedKind ?? null,
        loopRole: variable.loopRole ?? null,
      }));
      const bindings = Object.fromEntries(
        Object.entries(pythonBindings).slice(0, 24),
      );
      return {
        ok: true,
        mode,
        run: {
          phase,
          isRunning,
          hasCurrentRun,
          error: currentError
            ? {
                kind: currentError.kind,
                line: currentError.line ?? null,
                message: String(currentError.message).slice(0, 600),
              }
            : null,
        },
        timeline: {
          frame: stepIndex >= 0 ? stepIndex + 1 : null,
          frameCount: currentFrames.length,
          isPlaying,
          speedMs: speed,
          operation: currentFrame?.operation ?? null,
        },
        source: { length: source.length },
        python: isPython
          ? {
              entry: pythonEntry || null,
              inputLength: pythonInputSource.length,
              inputValid: !pythonInputState.error,
              variables,
              variableCount: pythonVariables.length,
              variablesTruncated: pythonVariables.length > variables.length,
              bindings,
              bindingsTruncated: Object.keys(pythonBindings).length > Object.keys(bindings).length,
            }
          : null,
        pendingReview: aiFixState.phase === "review"
          ? { summary: aiFixState.proposal?.summary ?? "A workspace proposal is awaiting review." }
          : null,
        activity: "Agent inspected the workspace without changing it.",
      };
    },
    run: async ({ play = false } = {}, signal) => {
      const handleAbort = () => stopRun();
      signal?.addEventListener("abort", handleAbort, { once: true });
      try {
        const result = await executeSource(source, { play: Boolean(play) });
        await waitForVisibleUpdate();
        return {
          ...result,
          activity: result.ok
            ? `Agent ran the accepted workspace and generated ${result.frameCount} frame${result.frameCount === 1 ? "" : "s"}.`
            : `Agent run finished with ${result.status}.`,
        };
      } finally {
        signal?.removeEventListener("abort", handleAbort);
      }
    },
    get_frame: async () => ({
      ok: true,
      frame: stepIndex >= 0 ? stepIndex + 1 : null,
      frameCount: currentFrames.length,
      isPlaying,
      operation: currentFrame?.operation ?? null,
      message: String(currentFrame?.message ?? statusMessage).slice(0, 600),
      source: currentFrame?.source ?? (activeSourceLine ? { line: activeSourceLine } : null),
      scene: summarizeScene(displayScene),
      activity: "Agent inspected the visible frame without changing playback.",
    }),
    control_playback: async ({ action, frame, speed_ms: speedMs } = {}) => {
      const total = currentFrames.length;
      let nextIndex = stepIndex;
      let nextPlaying;
      if (speedMs != null) {
        setSpeed(Math.min(1400, Math.max(100, Math.floor(Number(speedMs)))));
      }
      if (action === "pause") {
        nextPlaying = false;
        setIsPlaying(false);
      } else {
        if (total === 0) throw new Error("Run the visualization before controlling playback.");
        if (action === "play") {
          nextIndex = stepIndex < 0 || stepIndex >= total - 1 ? 0 : stepIndex;
          nextPlaying = total > 1;
        } else if (action === "next") {
          nextIndex = Math.min(total - 1, Math.max(-1, stepIndex) + 1);
          nextPlaying = false;
        } else if (action === "previous") {
          nextIndex = Math.max(0, stepIndex - 1);
          nextPlaying = false;
        } else if (action === "rewind") {
          nextIndex = 0;
          nextPlaying = false;
        } else if (action === "jump") {
          if (!Number.isInteger(frame)) throw new Error("The jump action requires an integer frame number.");
          nextIndex = Math.min(total - 1, Math.max(0, frame - 1));
          nextPlaying = false;
        } else {
          throw new Error("Unknown playback action.");
        }
        setStepIndex(nextIndex);
        setIsPlaying(nextPlaying);
      }
      await waitForVisibleUpdate();
      return {
        ok: true,
        action,
        frame: nextIndex >= 0 ? nextIndex + 1 : null,
        frameCount: total,
        isPlaying: nextPlaying,
        speedMs: speedMs == null ? speed : Math.min(1400, Math.max(100, Math.floor(Number(speedMs)))),
        activity: {
          play: "Agent started playback.",
          pause: "Agent paused playback.",
          next: `Agent advanced to frame ${nextIndex + 1}.`,
          previous: `Agent moved back to frame ${nextIndex + 1}.`,
          rewind: "Agent rewound playback to frame 1.",
          jump: `Agent opened frame ${nextIndex + 1}.`,
        }[action],
      };
    },
    configure_visuals: async ({ bindings: patches } = {}) => {
      if (!isPython) throw new Error("Visual mappings can be configured only in Python mode.");
      if (!hasCurrentRun || pythonVariablesStale || pythonVariables.length === 0) {
        throw new Error("Run Python successfully before configuring discovered variables.");
      }
      if (!Array.isArray(patches) || patches.length === 0) {
        throw new Error("At least one visual binding is required.");
      }
      const variableNames = new Set(pythonVariables.map((variable) => String(variable.name)));
      const nextBindings = { ...pythonBindingsRef.current };
      const applied = [];
      const ignored = [];
      patches.forEach((patch) => {
        const name = String(patch?.name ?? "");
        if (!variableNames.has(name)) {
          ignored.push(name || "(missing name)");
          return;
        }
        const next = { ...(nextBindings[name] ?? {}) };
        if (Object.hasOwn(patch, "enabled")) next.enabled = Boolean(patch.enabled);
        if (Object.hasOwn(patch, "kind")) next.kind = patch.kind === "auto" ? null : patch.kind;
        if (Object.hasOwn(patch, "view")) next.view = patch.view;
        if (Object.hasOwn(patch, "role")) {
          next.role = patch.role;
          next.roleExplicit = true;
        }
        if (Object.hasOwn(patch, "target")) next.target = patch.target;
        if (Object.hasOwn(patch, "pointer_mode")) next.pointerMode = patch.pointer_mode;
        if (Object.hasOwn(patch, "index_offset")) next.indexOffset = patch.index_offset;
        nextBindings[name] = next;
        applied.push(name);
      });
      if (applied.length === 0) throw new Error("None of the requested variable names exist in the current trace.");
      updatePythonBindings(nextBindings);
      await waitForVisibleUpdate();
      return {
        ok: true,
        applied,
        ignored,
        bindings: Object.fromEntries(applied.map((name) => [name, pythonBindingsRef.current[name]])),
        activity: `Agent configured ${applied.length} visual mapping${applied.length === 1 ? "" : "s"}.`,
      };
    },
    propose_python_workspace: async ({ source: proposedSource, inputs, summary, changes = [] } = {}) => {
      if (!isPython) throw new Error("Switch the workspace to Python mode before proposing Python changes.");
      if (aiFixState.phase === "review") {
        throw new Error("A workspace proposal is already awaiting human review.");
      }
      if (typeof proposedSource !== "string" || !proposedSource.trim()) {
        throw new Error("A complete non-empty Python source is required.");
      }
      if (proposedSource.length > MAX_SOURCE_LENGTH) {
        throw new Error(`Source is limited to ${MAX_SOURCE_LENGTH.toLocaleString()} characters.`);
      }
      const proposedInputSource = JSON.stringify(inputs, null, 2);
      if (typeof proposedInputSource !== "string" || proposedInputSource.length > MAX_SOURCE_LENGTH) {
        throw new Error(`Serialized inputs are limited to ${MAX_SOURCE_LENGTH.toLocaleString()} characters.`);
      }
      if (typeof summary !== "string" || !summary.trim()) {
        throw new Error("Explain why the proposed workspace change helps the user.");
      }
      if (sameWorkspaceProposal(pythonSource, pythonInputSource, proposedSource, inputs)) {
        throw new Error("The proposal does not change the current source or inputs.");
      }
      const safeChanges = Array.isArray(changes)
        ? changes.map(String).filter(Boolean).slice(0, 12)
        : [];
      setAiFixState({
        phase: "review",
        message: "",
        proposal: {
          source: proposedSource,
          inputSource: proposedInputSource,
          summary: summary.trim().slice(0, 600),
          changes: safeChanges,
          reviewTitle: "Agent change awaiting review",
        },
      });
      await waitForVisibleUpdate();
      return {
        ok: true,
        status: "pending_user_review",
        changedSource: proposedSource.trim() !== pythonSource.trim(),
        changedInputs: proposedInputSource.trim() !== pythonInputSource.trim(),
        activity: "Agent staged a code/input proposal. Accept or reject it in Playback & Diagnostics.",
      };
    },
  };

  useEffect(() => {
    if (!getDocumentModelContext()) {
      setWebMcpState({
        phase: "unavailable",
        message: "Open this page in ChatGPT's in-app browser or enable Chrome's WebMCP testing flag.",
        lastAction: null,
      });
      return undefined;
    }

    const lifecycle = new AbortController();
    let active = true;
    setWebMcpState({
      phase: "registering",
      message: "Registering structured tools for browser agents...",
      lastAction: null,
    });
    const tools = createPlaygroundWebMCPTools(invokeWebMcpTool);
    Promise.all(tools.map((tool) => (
      document.modelContext.registerTool(tool, { signal: lifecycle.signal })
    )))
      .then(() => {
        if (!active) return;
        setWebMcpState({
          phase: "ready",
          message: `${PLAYGROUND_WEBMCP_TOOL_COUNT} browser-agent tools are ready.`,
          lastAction: null,
        });
      })
      .catch((error) => {
        if (!active || lifecycle.signal.aborted) return;
        setWebMcpState({ phase: "error", message: errorMessage(error), lastAction: null });
      });

    return () => {
      active = false;
      lifecycle.abort();
    };
  }, [invokeWebMcpTool]);

  const webMcpStatusLabel = webMcpState.phase === "ready"
    ? `Agent-ready · ${PLAYGROUND_WEBMCP_TOOL_COUNT} tools`
    : webMcpState.phase === "registering" || webMcpState.phase === "checking"
      ? "Connecting agent tools"
      : webMcpState.phase === "error"
        ? "Agent tools error"
        : "WebMCP preview unavailable";

  return (
    <div
      className={`runtime-playground runtime-playground--${layoutWidth}`}
      data-layout-width={layoutWidth}
    >
      <header className="runtime-playground__header">
        <div className="runtime-playground__header-main">
          {onBack && (
            <button
              type="button"
              className="runtime-playground__back"
              onClick={onBack}
              aria-label="Back to problems"
            >
              <span aria-hidden="true">&larr;</span>
              Problems
            </button>
          )}
          <div className="runtime-playground__title-group">
            <span className="runtime-playground__eyebrow">Visualizer Playground</span>
            <h1>Build visualizations with code</h1>
          </div>
        </div>

        <div className="runtime-playground__header-actions">
          <div
            className={`runtime-playground__webmcp-status is-${webMcpState.phase}`}
            role="status"
            title={webMcpState.message}
          >
            <span aria-hidden="true" />
            <strong>WebMCP</strong>
            <small>{webMcpStatusLabel}</small>
          </div>
          {onLayoutChange && (
            <div className="runtime-playground__layout" aria-label="Workspace width">
              {["normal", "wide", "full"].map((width) => (
                <button
                  type="button"
                  key={width}
                  className={layoutWidth === width ? "is-active" : ""}
                  onClick={() => onLayoutChange(width)}
                  aria-pressed={layoutWidth === width}
                >
                  {width}
                </button>
              ))}
            </div>
          )}
          {utilityControls && (
            <div className="runtime-playground__utilities">{utilityControls}</div>
          )}
        </div>
      </header>

      <main className="runtime-playground__workspace">
        <section className="runtime-playground__panel runtime-playground__editor-panel">
          <div className="runtime-playground__panel-header">
            <div>
              <h2>{isPython ? "Python Trace" : "JavaScript"}</h2>
              <p>
                {isPython
                  ? "Run ordinary Python, then choose which variables become visuals."
                  : <><span>Use </span><code>viz</code><span> to declare structures and emit steps.</span></>}
              </p>
            </div>
            <div className="runtime-playground__editor-actions">
              <div className="runtime-playground__mode-switch" aria-label="Editor mode">
                <button
                  type="button"
                  className={!isPython ? "is-active" : ""}
                  aria-pressed={!isPython}
                  onClick={() => changeMode("script")}
                >
                  Viz script
                </button>
                <button
                  type="button"
                  className={isPython ? "is-active" : ""}
                  aria-pressed={isPython}
                  onClick={() => changeMode("python")}
                >
                  Python
                </button>
              </div>
              <button type="button" className="runtime-playground__button" onClick={resetExample}>
                Reset example
              </button>
              {isRunning ? (
                <button
                  type="button"
                  className="runtime-playground__button runtime-playground__button--danger"
                  onClick={stopRun}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="runtime-playground__button runtime-playground__button--primary"
                  onClick={runWithoutPlayback}
                  disabled={isPython && Boolean(pythonInputState.error)}
                >
                  {isPython ? "Run Python" : "Run"}
                </button>
              )}
            </div>
          </div>
          <div className="runtime-playground__editor-body">
            <RuntimeCodeEditor
              value={source}
              onChange={updateSource}
              onRun={playCurrentSource}
              isBusy={isRunning}
              language={isPython ? "python" : "javascript"}
              activeLine={activeSourceLine}
            />
          </div>
          <div className="runtime-playground__editor-foot">
            <span>{isPython ? "Python · isolated Worker · auto-run" : "JavaScript · viz API"}</span>
            <span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> to run and play</span>
            <span>{source.length.toLocaleString()} / {MAX_SOURCE_LENGTH.toLocaleString()}</span>
          </div>
        </section>

        <section className="runtime-playground__panel runtime-playground__preview-panel">
          <div className="runtime-playground__panel-header">
            <div>
              <h2>Live preview</h2>
              <p>{containerCount(displayScene)} visible structure{containerCount(displayScene) === 1 ? "" : "s"}</p>
            </div>
            <span
              className={`runtime-playground__status runtime-playground__status--${currentError ? "error" : traceWasTruncated ? "warning" : phase}`}
              role="status"
              aria-live="polite"
            >
              <span aria-hidden="true" />
              {previewStatus}
            </span>
          </div>
          <div className="runtime-playground__canvas">
            <VisualizationCanvas
              scene={displayScene}
              emptyMessage={
                isPython
                  ? "Run the Python solution, then enable its arrays and variables in Visuals."
                  : "Declare an array, grid, graph, tree, or another structure in the editor."
              }
            />
          </div>
        </section>

        <section className="runtime-playground__panel runtime-playground__configuration-panel">
          <PlaygroundAIProviderControls />
          {isPython ? (
            <PythonTraceControls
              entryValue={pythonEntry}
              onEntryChange={updatePythonEntry}
              inputValue={pythonInputSource}
              onInputChange={updatePythonInput}
              inputError={pythonInputState.error}
              variables={pythonVariables}
              variablesStale={pythonVariablesStale}
              bindings={pythonBindings}
              onBindingsChange={updatePythonBindings}
              onSuggestVisuals={suggestVisualBindings}
              onGenerateInputs={(instruction) => suggestVisualBindings({ forceInputs: true, instruction })}
              onProposeWorkspace={requestAiWorkspaceChange}
                isSuggestingVisuals={aiVisualState.phase === "running"}
                aiFeedback={aiVisualState}
                traceError={currentError}
                disabled={isRunning}
            />
          ) : (
            <div className="runtime-playground__configuration-empty">
              Switch the Code panel to Python to configure traced inputs and visuals.
            </div>
          )}
        </section>

        <section className="runtime-playground__panel runtime-playground__timeline-panel">
          <div className="runtime-playground__playback">
            <PlaybackControls
              onReset={rewindPlayback}
              onPrev={stepBack}
              onPlayToggle={playCurrentSource}
              onNext={stepForward}
              resetDisabled={!hasCurrentRun || (stepIndex <= 0 && !isPlaying)}
              prevDisabled={!hasCurrentRun || !canPrev}
              nextDisabled={!hasCurrentRun || !canNext}
              activeStep={stepIndex}
              totalSteps={currentFrames.length}
              isPlaying={isPlaying}
              isDone={
                !isRunning && hasCurrentRun && currentFrames.length > 0
                  ? isDone
                  : false
              }
              playLabel={isRunning ? "Stop" : "Play"}
              pauseLabel="Pause"
              replayLabel="Replay"
              resetLabel="Rewind"
              speed={speed}
              onSpeedChange={(event) => setSpeed(Number(event.target.value))}
              speedMin={100}
              speedMax={1_400}
              speedStep={50}
              speedIndicator={`${(1_000 / speed).toFixed(1)} steps/s`}
            />
            <div className="runtime-playground__scrubber">
              <label htmlFor="runtime-playground-timeline">Timeline</label>
              <input
                id="runtime-playground-timeline"
                type="range"
                min="0"
                max={Math.max(0, currentFrames.length - 1)}
                value={Math.max(0, stepIndex)}
                disabled={!hasCurrentRun || currentFrames.length === 0}
                onChange={(event) => {
                  setIsPlaying(false);
                  setStepIndex(Number(event.target.value));
                }}
                aria-valuetext={
                  stepIndex >= 0
                    ? `Frame ${stepIndex + 1} of ${currentFrames.length}`
                    : "Timeline not started"
                }
              />
              <output>
                {stepIndex >= 0 ? stepIndex + 1 : 0} / {currentFrames.length}
              </output>
            </div>
          </div>

          <div className="runtime-playground__diagnostics" aria-live="polite">
            {webMcpState.lastAction && (
              <div className={`runtime-playground__webmcp-activity is-${webMcpState.lastAction.phase}`}>
                <span className="runtime-playground__operation">WebMCP</span>
                <span>{webMcpState.lastAction.message}</span>
              </div>
            )}
            {aiFixState.phase === "review" && aiFixState.proposal && (
              <AIFixReview
                proposal={aiFixState.proposal}
                beforeSource={pythonSource}
                beforeInput={pythonInputSource}
                onAccept={acceptAiFix}
                onReject={() => setAiFixState({ phase: "idle", proposal: null, message: "" })}
              />
            )}
            {!currentError && aiFixState.message && (
              <div className="runtime-playground__timeline-message" role="status">
                <span className="runtime-playground__operation">AI</span>
                <span>{aiFixState.message}</span>
              </div>
            )}
            {currentError ? (
              <>
                <div className="runtime-playground__error" role="alert">
                  <strong>{currentError.kind} error</strong>
                  <span>{currentError.message}</span>
                  {isPython && aiFixState.phase !== "review" && (
                    <button type="button" onClick={requestAiFix} disabled={aiFixState.phase === "running"}>
                      {aiFixState.phase === "running" ? "Preparing fix..." : "Fix with AI"}
                    </button>
                  )}
                  {aiFixState.message && <small>{aiFixState.message}</small>}
                </div>
              </>
            ) : (
              <>
                {traceWasTruncated && (
                  <div className="runtime-playground__warning" role="status">
                    <strong>Trace limit reached</strong>
                    <span>{traceWarning}</span>
                  </div>
                )}
                <div className="runtime-playground__timeline-message">
                  <span className="runtime-playground__operation">
                    {currentFrame?.operation ?? phase}
                  </span>
                  <span>{statusMessage}</span>
                </div>
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
