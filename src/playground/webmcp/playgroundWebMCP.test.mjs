import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAYGROUND_WEBMCP_TOOL_COUNT,
  PLAYGROUND_WEBMCP_TOOL_NAMES,
  createPlaygroundWebMCPTools,
  getDocumentModelContext,
  registerPlaygroundWebMCPTools,
  sameWorkspaceProposal,
  summarizeScene,
} from "./playgroundWebMCP.js";

test("defines a compact, unique set of strict WebMCP tools", () => {
  const tools = createPlaygroundWebMCPTools(async () => ({ ok: true }));

  assert.equal(tools.length, PLAYGROUND_WEBMCP_TOOL_COUNT);
  assert.deepEqual(tools.map(({ name }) => name), PLAYGROUND_WEBMCP_TOOL_NAMES);
  assert.equal(new Set(tools.map(({ name }) => name)).size, tools.length);
  tools.forEach((tool) => {
    assert.match(tool.name, /^[A-Za-z0-9_.-]{1,128}$/);
    assert.ok(tool.description.length > 0 && tool.description.length <= 500);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(typeof tool.execute, "function");
  });
});

test("tool execution dispatches by key and returns serialized JSON", async () => {
  const calls = [];
  const tools = createPlaygroundWebMCPTools(async (key, input, signal) => {
    calls.push({ key, input, signal });
    return { ok: true, key };
  });
  const signal = new AbortController().signal;

  const result = await tools[0].execute({ detail: "summary" }, { signal });

  assert.deepEqual(JSON.parse(result), { ok: true, key: "get_workspace" });
  assert.deepEqual(calls, [{ key: "get_workspace", input: { detail: "summary" }, signal }]);
});

test("tool execution rejects an already cancelled invocation", async () => {
  const lifecycle = new AbortController();
  lifecycle.abort();
  const [tool] = createPlaygroundWebMCPTools(async () => ({ ok: true }));

  await assert.rejects(
    tool.execute({}, { signal: lifecycle.signal }),
    (error) => error?.name === "AbortError",
  );
});

test("registers every tool with a shared abort-controlled lifecycle", async () => {
  const registrations = [];
  const root = {
    modelContext: {
      registerTool: async (tool, options) => registrations.push({ tool, options }),
    },
  };
  const lifecycle = new AbortController();

  const names = await registerPlaygroundWebMCPTools(
    root,
    async () => ({ ok: true }),
    lifecycle.signal,
  );

  assert.deepEqual(names, PLAYGROUND_WEBMCP_TOOL_NAMES);
  assert.equal(registrations.length, PLAYGROUND_WEBMCP_TOOL_COUNT);
  registrations.forEach(({ options }) => assert.equal(options.signal, lifecycle.signal));
  assert.equal(getDocumentModelContext(root), root.modelContext);
});

test("summarizes large runtime scenes without returning unbounded collections", () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ value: index }));
  const summary = summarizeScene({
    message: "sorting",
    containers: [{
      id: "array-values",
      name: "values",
      type: "array",
      category: "sequence",
      items,
      pointers: [{ label: "i", index: 4 }],
    }],
  });

  assert.equal(summary.message, "sorting");
  assert.equal(summary.containerCount, 1);
  assert.equal(summary.containers[0].items.count, 30);
  assert.equal(summary.containers[0].items.sample.length, 12);
  assert.equal(summary.containers[0].items.truncated, true);
});

test("proposal equality ignores source formatting and JSON whitespace", () => {
  assert.equal(sameWorkspaceProposal(
    "def solve():\r\n    return 1\r\n",
    "{\n  \"nums\": [1, 2]\n}",
    "def solve():\n    return 1",
    { nums: [1, 2] },
  ), true);
  assert.equal(sameWorkspaceProposal("return 1", "{}", "return 2", {}), false);
});
