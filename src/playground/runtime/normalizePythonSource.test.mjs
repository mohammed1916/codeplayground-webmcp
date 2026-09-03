import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizePastedPythonSource,
  normalizePythonSource,
} from "./normalizePythonSource.js";

test("normal Python layout keeps its newlines while unicode indentation becomes spaces", () => {
  assert.equal(
    normalizePythonSource("def solve():\n\u00a0\u00a0\u00a0\u00a0return 1"),
    "def solve():\n    return 1",
  );
});

test("collapsed rich-text Python is expanded from non-breaking indentation", () => {
  const pasted = "def solve(values):\u00a0\u00a0\u00a0\u00a0total = 0\u00a0\u00a0\u00a0\u00a0for \\_ in values:\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0total += 1\u00a0\u00a0\u00a0\u00a0return total";
  assert.equal(
    normalizePastedPythonSource(pasted),
    "def solve(values):\n    total = 0\n    for _ in values:\n        total += 1\n    return total",
  );
});

test("paste repair removes escaped multiplication but preserves quoted regex escapes", () => {
  assert.equal(
    normalizePastedPythonSource("values = [0] \\* 3\npattern = r'\\*'"),
    "values = [0] * 3\npattern = r'\\*'",
  );
});
