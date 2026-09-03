const TOOL_PREFIX = "visualizer";
const SAMPLE_LIMIT = 12;
const OBJECT_ENTRY_LIMIT = 16;
const STRING_LIMIT = 240;

function objectSchema(properties = {}, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function jsonValueSchema(description) {
  return {
    description,
    type: ["object", "array", "string", "number", "boolean", "null"],
  };
}

const TOOL_DEFINITIONS = Object.freeze([
  {
    key: "get_workspace",
    name: `${TOOL_PREFIX}_get_workspace`,
    title: "Inspect visualization workspace",
    description: "Inspect the open Visualizer Playground, its run status, discovered Python variables, and visual mappings. Request a bounded source or input chunk only when needed. This never changes the workspace.",
    inputSchema: objectSchema({
      detail: {
        type: "string",
        enum: ["summary", "source", "inputs"],
        description: "Return a summary, a source-code chunk, or a Python-input chunk.",
        default: "summary",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Character offset for source or input chunks.",
        default: 0,
      },
      limit: {
        type: "integer",
        minimum: 200,
        maximum: 6000,
        description: "Maximum characters in a requested source or input chunk.",
        default: 3000,
      },
    }),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
  },
  {
    key: "run",
    name: `${TOOL_PREFIX}_run`,
    title: "Run current visualization",
    description: "Run the code and inputs already accepted in the Visualizer Playground's isolated worker. This does not edit code or inputs. Optionally begin timeline playback after a successful run.",
    inputSchema: objectSchema({
      play: {
        type: "boolean",
        description: "Start playing the generated timeline after the run succeeds.",
        default: false,
      },
    }),
    annotations: { readOnlyHint: false, untrustedContentHint: true },
  },
  {
    key: "get_frame",
    name: `${TOOL_PREFIX}_get_frame`,
    title: "Inspect visualization frame",
    description: "Read a compact, structured snapshot of the current visualization frame, including rendered containers, highlighted values, pointers, nodes, edges, and the operation message. This never changes playback.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
  },
  {
    key: "control_playback",
    name: `${TOOL_PREFIX}_control_playback`,
    title: "Control visualization playback",
    description: "Control the accepted visualization timeline. This only changes the visible frame or playback speed; it never changes source code, inputs, or visual mappings. Frame numbers are one-based.",
    inputSchema: objectSchema({
      action: {
        type: "string",
        enum: ["play", "pause", "next", "previous", "rewind", "jump"],
        description: "Playback action to perform.",
      },
      frame: {
        type: "integer",
        minimum: 1,
        description: "One-based frame number. Required only for the jump action.",
      },
      speed_ms: {
        type: "integer",
        minimum: 100,
        maximum: 1400,
        description: "Optional delay between frames in milliseconds.",
      },
    }, ["action"]),
    annotations: { readOnlyHint: false, untrustedContentHint: true },
  },
  {
    key: "configure_visuals",
    name: `${TOOL_PREFIX}_configure_visuals`,
    title: "Configure Python visuals",
    description: "Configure how variables from the latest successful Python trace are visualized. This reversible action changes visual mappings only; it never edits or runs source code or inputs. Inspect the workspace first and use only discovered variable names.",
    inputSchema: objectSchema({
      bindings: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        description: "Visual mapping patches for variables discovered by the latest Python trace.",
        items: objectSchema({
          name: { type: "string", minLength: 1, description: "Exact discovered variable name." },
          enabled: { type: "boolean" },
          kind: {
            type: "string",
            enum: ["auto", "sequence", "grid", "associative", "graph", "tree", "heap", "scalar"],
          },
          view: { type: "string", enum: ["cells", "bars", "line"] },
          role: { type: "string", enum: ["value", "pointer"] },
          target: { type: "string", description: "Sequence variable highlighted by a pointer." },
          pointer_mode: { type: "string", enum: ["index", "value"] },
          index_offset: { type: "integer", minimum: -100000, maximum: 100000 },
        }, ["name"]),
      },
    }, ["bindings"]),
    annotations: { readOnlyHint: false, untrustedContentHint: true },
  },
  {
    key: "propose_python_workspace",
    name: `${TOOL_PREFIX}_propose_python`,
    title: "Propose Python workspace change",
    description: "Stage a complete Python source and input change for the person to review. The proposal appears as a red/green diff and does not alter or run the workspace until the person explicitly selects Accept and run. Use this instead of trying to type into the editor.",
    inputSchema: objectSchema({
      source: {
        type: "string",
        minLength: 1,
        maxLength: 50000,
        description: "Complete proposed Python source, including all unchanged code.",
      },
      inputs: jsonValueSchema("Complete proposed JSON-compatible input value."),
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 600,
        description: "Plain-language reason the proposal helps the user's visualization.",
      },
      changes: {
        type: "array",
        maxItems: 12,
        items: { type: "string", maxLength: 240 },
        description: "Short concrete changes shown beside the diff.",
      },
    }, ["source", "inputs", "summary"]),
    annotations: { readOnlyHint: false, untrustedContentHint: false },
  },
]);

function abortError() {
  if (typeof DOMException === "function") {
    return new DOMException("The WebMCP tool call was cancelled.", "AbortError");
  }
  const error = new Error("The WebMCP tool call was cancelled.");
  error.name = "AbortError";
  return error;
}

function jsonResult(value) {
  return JSON.stringify(value ?? null);
}

function createTool(definition, invoke) {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: definition.annotations,
    execute: async (input = {}, options = {}) => {
      if (options?.signal?.aborted) throw abortError();
      const result = await invoke(definition.key, input ?? {}, options?.signal);
      if (options?.signal?.aborted) throw abortError();
      return jsonResult(result);
    },
  };
}

export const PLAYGROUND_WEBMCP_TOOL_COUNT = TOOL_DEFINITIONS.length;
export const PLAYGROUND_WEBMCP_TOOL_NAMES = Object.freeze(
  TOOL_DEFINITIONS.map(({ name }) => name),
);

export function createPlaygroundWebMCPTools(invoke) {
  if (typeof invoke !== "function") {
    throw new TypeError("A WebMCP tool dispatcher is required.");
  }
  return TOOL_DEFINITIONS.map((definition) => createTool(definition, invoke));
}

export function getDocumentModelContext(root = globalThis.document) {
  const modelContext = root?.modelContext;
  return modelContext && typeof modelContext.registerTool === "function"
    ? modelContext
    : null;
}

export async function registerPlaygroundWebMCPTools(root, invoke, signal) {
  if (!root?.modelContext || typeof root.modelContext.registerTool !== "function") {
    throw new TypeError("WebMCP is unavailable in this document.");
  }
  const tools = createPlaygroundWebMCPTools(invoke);
  await Promise.all(tools.map((tool) => (
    root.modelContext.registerTool(tool, { signal })
  )));
  return tools.map(({ name }) => name);
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function compactValue(value, depth = 0) {
  if (typeof value === "string") {
    return value.length > STRING_LIMIT
      ? `${value.slice(0, STRING_LIMIT - 3)}...`
      : value;
  }
  if (value == null || typeof value !== "object") return value;
  if (depth >= 3) return "[nested value]";
  if (Array.isArray(value)) {
    return value.slice(0, OBJECT_ENTRY_LIMIT).map((item) => compactValue(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, OBJECT_ENTRY_LIMIT)
      .map(([key, item]) => [key, compactValue(item, depth + 1)]),
  );
}

function sample(values, limit = SAMPLE_LIMIT) {
  const items = arrayValue(values);
  return {
    count: items.length,
    sample: items.slice(0, limit).map((item) => compactValue(item)),
    truncated: items.length > limit,
  };
}

function flattenCells(cells) {
  if (!Array.isArray(cells)) return [];
  return cells.flatMap((row) => (Array.isArray(row) ? row : [row]));
}

function summarizeContainer(container = {}) {
  const base = {
    id: container.id ?? null,
    name: container.name ?? null,
    type: container.type ?? null,
    category: container.category ?? null,
  };

  if (container.category === "sequence") {
    return {
      ...base,
      items: sample(container.items),
      pointers: sample(container.pointers),
      view: container.view ?? null,
    };
  }
  if (container.category === "grid") {
    return {
      ...base,
      rows: container.rows ?? null,
      columns: container.columns ?? container.cols ?? null,
      cells: sample(flattenCells(container.cells)),
      activeCell: container.activeCell ?? null,
      relatedCells: sample(container.relatedCells),
    };
  }
  if (container.category === "node-link") {
    return {
      ...base,
      nodes: sample(container.nodes),
      edges: sample(container.edges),
      directed: container.directed ?? null,
      layout: container.layout ?? null,
    };
  }
  if (container.category === "associative") {
    return { ...base, entries: sample(container.entries) };
  }
  return {
    ...base,
    value: Object.hasOwn(container, "value") ? compactValue(container.value) : null,
    state: compactValue(container.state ?? null),
  };
}

export function summarizeScene(scene) {
  const containers = Array.isArray(scene?.containers)
    ? scene.containers
    : scene?.containers && typeof scene.containers === "object"
      ? Object.values(scene.containers)
      : [];
  return {
    message: scene?.message ?? null,
    containerCount: containers.length,
    containers: containers.slice(0, 16).map(summarizeContainer),
    containersTruncated: containers.length > 16,
  };
}

export function sameWorkspaceProposal(currentSource, currentInputSource, proposalSource, proposalInputs) {
  const normalizeText = (value) => String(value ?? "").replace(/\r\n/g, "\n").trim();
  let currentInputs = normalizeText(currentInputSource);
  let nextInputs = JSON.stringify(proposalInputs);
  try {
    currentInputs = JSON.stringify(JSON.parse(String(currentInputSource)));
  } catch {
    // Invalid editor input remains a textual comparison.
  }
  return normalizeText(currentSource) === normalizeText(proposalSource)
    && currentInputs === nextInputs;
}
