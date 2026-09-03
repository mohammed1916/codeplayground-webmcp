const PYTHON_HORIZONTAL_UNICODE_SPACE = /[\u00a0\u2007\u202f]/g;
const PYTHON_INDENT_RUN = /[\u00a0\u2007\u202f]{4,}/g;
const ZERO_WIDTH_CHARACTER = /\u200b|\u200c|\u200d|\ufeff/g;

/** Normalize invisible rich-text characters without changing Python layout. */
export function normalizePythonSource(source) {
  return String(source ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(PYTHON_HORIZONTAL_UNICODE_SPACE, " ")
    .replace(ZERO_WIDTH_CHARACTER, "");
}

/**
 * Repair the common clipboard form where HTML collapsed every source line
 * into one line but preserved indentation as runs of non-breaking spaces.
 */
export function normalizePastedPythonSource(source) {
  let normalized = String(source ?? "").replace(/\r\n?/g, "\n");
  const lineBreaks = (normalized.match(/\n/g) || []).length;
  const indentRuns = normalized.match(PYTHON_INDENT_RUN) || [];

  if (lineBreaks <= 1 && indentRuns.length >= 2) {
    normalized = normalized.replace(PYTHON_INDENT_RUN, (spaces) => (
      `\n${" ".repeat(spaces.length)}`
    ));
  }

  // Markdown-escaped identifiers and multiplication operators are invalid
  // Python when copied literally. Keep quoted regex escapes such as "\\*".
  normalized = normalized
    .replace(/\\_/g, "_")
    .replace(/(\s)\\\*(?=\s)/g, "$1*");

  return normalizePythonSource(normalized);
}
