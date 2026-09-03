import test from "node:test";
import assert from "node:assert/strict";

import {
  createInputSuggestionMessages,
  createVisualSuggestionMessages,
  parseVisualSuggestion,
  suggestPythonBindings,
  suggestPythonInputs,
} from "./suggestPythonBindings.js";
import { lineDiff, suggestPythonFix } from "./suggestPythonFix.js";

const variables = [
  { name: "prices", suggestedKind: "sequence" },
  { name: "price", suggestedKind: "scalar", loopRole: "value", targetHint: "prices" },
  { name: "profit", suggestedKind: "scalar" },
];

test("AI visual suggestions accept fenced JSON and discard invented variables", () => {
  const result = parseVisualSuggestion(`Here is the layout:
\`\`\`json
{"bindings":{"prices":{"enabled":true,"kind":"sequence","view":"bars"},"price":{"enabled":true,"kind":"scalar","role":"pointer","target":"prices","pointerMode":"value"},"invented":{"enabled":true,"kind":"graph"}},"summary":"Track the active price."}
\`\`\``, variables);

  assert.deepEqual(result.bindings, {
    prices: { enabled: true, kind: "sequence", view: "bars" },
    price: {
      enabled: true,
      kind: "scalar",
      role: "pointer",
      target: "prices",
      pointerMode: "value",
    },
  });
  assert.equal(result.summary, "Track the active price.");
});

test("AI visual suggestions reject responses without known traced variables", () => {
  assert.throws(
    () => parseVisualSuggestion('{"bindings":{"fake":{"enabled":true}}}', variables),
    /known traced variables/,
  );
});

test("suggestion requests use bounded trace context and the injected provider", async () => {
  let receivedMessages;
  async function* stream(messages) {
    receivedMessages = messages;
    yield '{"bindings":{"profit":{"enabled":true,"kind":"scalar"}}}';
  }

  const traceResult = {
    variables,
    traceFrames: [{ locals: { prices: [7, 1, 5], price: 5, profit: 4 } }],
  };
  const result = await suggestPythonBindings(
    { source: "def solve(): pass", inputSource: "{}", traceResult, bindings: {} },
    { stream, config: { provider: "ollama-local", model: "test" } },
  );

  assert.equal(result.provider, "Ollama Local");
  assert.equal(result.bindings.profit.kind, "scalar");
  assert.match(receivedMessages[1].text, /"sample":\[7,1,5\]/);
});

test("visual suggestion prompt requires a constrained binding-only response", () => {
  const messages = createVisualSuggestionMessages({
    source: "pass",
    inputSource: "null",
    traceResult: { variables, traceFrames: [] },
    bindings: {},
  });
  assert.match(messages[0].text, /Never invent variables/);
  assert.match(messages[0].text, /Return only one JSON object/);
});

test("AI input suggestions return JSON arguments for an untraced function", async () => {
  const result = await suggestPythonInputs(
    {
      source: "def isMatch(s, p):\n    return True",
      entry: "isMatch",
      inputSource: "{}",
    },
    {
      config: { provider: "ollama-local", model: "gemma2:2b" },
      stream: async function* stream() {
        yield '{"inputs":{"s":"aa","p":"a*"},';
        yield '"summary":"Exercises repeated matching."}';
      },
    },
  );

  assert.deepEqual(JSON.parse(result.inputSource), { s: "aa", p: "a*" });
  assert.match(result.summary, /repeated matching/i);
  assert.equal(result.provider, "Ollama Local");
});

test("AI input prompt asks for signature-shaped JSON rather than Python code", () => {
  const messages = createInputSuggestionMessages({
    source: "def solve(nums, target): pass",
    entry: "solve",
    inputSource: "{}",
    instruction: "Use negative numbers and duplicate values.",
  });
  assert.match(messages[0].text, /multiple named parameters/i);
  assert.match(messages[1].text, /def solve\(nums, target\)/);
  assert.match(messages[1].text, /negative numbers and duplicate values/i);
});

test("AI fixes stay as proposals and expose red-green line changes", async () => {
  const proposal = await suggestPythonFix(
    { source: "def solve(x):\n    return x.val", inputSource: "{\"x\":1}", error: { message: "no val" } },
    {
      config: { provider: "ollama-local", model: "gemma2:2b" },
      stream: async function* stream() {
        yield JSON.stringify({
          source: "def solve(x):\n    return x",
          inputs: { x: 1 },
          summary: "Use the integer directly.",
          changes: ["Removed invalid attribute access."],
        });
      },
    },
  );
  assert.equal(proposal.source, "def solve(x):\n    return x");
  assert.ok(lineDiff("a\nb", "a\nc").some((line) => line.type === "delete" && line.text === "b"));
  assert.ok(lineDiff("a\nb", "a\nc").some((line) => line.type === "add" && line.text === "c"));
});

test("a contradictory no-op node fix becomes a concrete input-shape proposal", async () => {
  const source = "class Solution:\n    def mergeKLists(self, lists):\n        return lists[0].val";
  const proposal = await suggestPythonFix(
    {
      source,
      inputSource: '{"lists":[1,4,5]}',
      error: { message: "'int' object has no attribute 'val'" },
    },
    {
      config: { provider: "ollama-local", model: "gemma2:2b" },
      stream: async function* stream() {
        yield JSON.stringify({ source, inputs: { lists: [1, 4, 5] }, summary: "Add ListNode." });
      },
    },
  );
  assert.deepEqual(JSON.parse(proposal.inputSource), { lists: [[1], [4], [5]] });
  assert.match(proposal.summary, /plain integers/i);
});
