import test from "node:test";
import assert from "node:assert/strict";

import {
  inferPythonInput,
  normalizePythonInputForEntry,
} from "./inferPythonInput.js";

test("regex matcher receives useful deterministic string and pattern inputs", () => {
  const result = inferPythonInput("def isMatch(s, p):\n    return True", {});
  assert.equal(result.changed, true);
  assert.deepEqual(result.value, { s: "aa", p: "a*" });
});

test("matching user inputs are preserved", () => {
  const input = { s: "mississippi", p: "mis*is*p*." };
  const result = inferPythonInput("def isMatch(s, p):\n    return True", input);
  assert.equal(result.changed, false);
  assert.equal(result.value, input);
});

test("Solution methods ignore self and use annotations for samples", () => {
  const result = inferPythonInput(`
def helper(value):
    return value

class Solution:
    def solve(self, nums: list[int], target: int):
        return False
`, { prices: [1] });
  assert.deepEqual(result.value, { nums: [2, 7, 11, 15], target: 9 });
});

test("AI inputs are constrained to the selected entry signature", () => {
  const normalized = normalizePythonInputForEntry(
    "class Solution:\n    def lengthOfLongestSubstring(self, s: str) -> int:\n        return 0",
    { s: "abcabcbb", p: "a" },
    "Solution.lengthOfLongestSubstring",
  );

  assert.deepEqual(normalized.value, { s: "abcabcbb" });
  assert.deepEqual(normalized.removed, ["p"]);
});
