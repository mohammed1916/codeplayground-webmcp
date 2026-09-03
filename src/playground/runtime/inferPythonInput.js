function splitParameters(source) {
  const parameters = [];
  let current = "";
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (const character of source) {
    if (quote) {
      current += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
    } else if ("([{<".includes(character)) {
      depth += 1;
      current += character;
    } else if (")]} >".replace(" ", "").includes(character)) {
      depth = Math.max(0, depth - 1);
      current += character;
    } else if (character === "," && depth === 0) {
      parameters.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) parameters.push(current.trim());
  return parameters;
}

function entryDefinition(source, requestedEntry = "") {
  const definitions = [...String(source || "").matchAll(
    /(?:^|\n)([ \t]*)def\s+([A-Za-z_]\w*)\s*\(([\s\S]*?)\)\s*(?:->[\s\S]*?)?:/g,
  )].map((match) => ({
    indentation: match[1].length,
    name: match[2],
    parametersSource: match[3],
    index: match.index,
  })).filter((definition) => !definition.name.startsWith("_"));
  if (definitions.length === 0) return null;

  const requestedName = String(requestedEntry || "").trim().split(".").at(-1);
  if (requestedName) {
    const requested = definitions.find((definition) => definition.name === requestedName);
    if (requested) return requested;
  }

  const solutionIndex = String(source || "").search(/(?:^|\n)class\s+Solution\b/);
  if (solutionIndex >= 0) {
    const method = definitions.find((definition) => (
      definition.index > solutionIndex && definition.indentation > 0
    ));
    if (method) return method;
  }
  return definitions.find((definition) => definition.indentation === 0) ?? definitions[0];
}

function parameterDescriptor(rawParameter) {
  const text = rawParameter.trim();
  if (!text || text === "/" || text === "*" || text.startsWith("**") || text.startsWith("*")) {
    return null;
  }
  const equalsIndex = text.indexOf("=");
  const required = equalsIndex < 0;
  const withoutDefault = required ? text : text.slice(0, equalsIndex).trim();
  const colonIndex = withoutDefault.indexOf(":");
  const name = (colonIndex < 0 ? withoutDefault : withoutDefault.slice(0, colonIndex)).trim();
  const annotation = colonIndex < 0 ? "" : withoutDefault.slice(colonIndex + 1).trim();
  if (!/^[A-Za-z_]\w*$/.test(name) || name === "self" || name === "cls") return null;
  return { name, annotation, required };
}

function sampleValue(parameter, allNames) {
  const name = parameter.name.toLowerCase();
  const annotation = parameter.annotation.toLowerCase();
  if (name === "p" && allNames.has("s")) return "a*";
  if (/pattern|regex/.test(name)) return "a*";
  if (/prices?/.test(name)) return [7, 1, 5, 3, 6, 4];
  if (/matrix|grid|board/.test(name)) return [[1, 2], [3, 4]];
  if (/edges?|graph/.test(name)) return [[0, 1], [1, 2]];
  if (/^(lists|heads)$/.test(name) || /list\s*\[\s*(?:optional\s*\[\s*)?listnode/i.test(annotation)) {
    return [[1, 4, 5], [1, 3, 4], [2, 6]];
  }
  if (/head|linked/.test(name) || /listnode/i.test(annotation)) return [1, 2, 3];
  if (/nums?|values?|array|arr|list/.test(name) || /list|tuple|deque|set/.test(annotation)) {
    return [2, 7, 11, 15];
  }
  if (/words?/.test(name)) return ["cat", "cats", "dog"];
  if (/str|string|text|word/.test(name) || name === "s" || annotation === "str") return "aa";
  if (/target|amount|capacity/.test(name)) return 9;
  if (/bool/.test(annotation)) return true;
  if (/float/.test(annotation)) return 1.5;
  if (/int/.test(annotation) || /^(n|m|k|x|y|count|size)$/.test(name)) return 4;
  return 1;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function inferPythonInput(source, currentInput, requestedEntry = "") {
  const definition = entryDefinition(source, requestedEntry);
  if (!definition) return { changed: false, value: currentInput, parameters: [] };

  const parameters = splitParameters(definition.parametersSource)
    .map(parameterDescriptor)
    .filter(Boolean);
  const required = parameters.filter((parameter) => parameter.required);
  if (required.length === 0) return { changed: false, value: currentInput, parameters };

  const current = isPlainObject(currentInput) ? currentInput : {};
  const missing = required.filter((parameter) => !Object.hasOwn(current, parameter.name));
  if (missing.length === 0) return { changed: false, value: currentInput, parameters };

  const parameterNames = new Set(parameters.map((parameter) => parameter.name.toLowerCase()));
  const allowedNames = new Set(parameters.map((parameter) => parameter.name));
  const value = Object.fromEntries(
    Object.entries(current).filter(([name]) => allowedNames.has(name)),
  );
  missing.forEach((parameter) => {
    value[parameter.name] = sampleValue(parameter, parameterNames);
  });

  return {
    changed: true,
    value,
    parameters,
    entry: definition.name,
  };
}

export function normalizePythonInputForEntry(source, candidateInput, requestedEntry = "") {
  const definition = entryDefinition(source, requestedEntry);
  if (!definition) return { value: candidateInput, removed: [], added: [] };

  const parameters = splitParameters(definition.parametersSource)
    .map(parameterDescriptor)
    .filter(Boolean);
  if (parameters.length === 0) {
    return {
      value: {},
      removed: isPlainObject(candidateInput) ? Object.keys(candidateInput) : [],
      added: [],
      entry: definition.name,
    };
  }

  const allowedNames = new Set(parameters.map((parameter) => parameter.name));
  const parameterNames = new Set(parameters.map((parameter) => parameter.name.toLowerCase()));
  const candidate = isPlainObject(candidateInput) ? candidateInput : {};
  const value = Object.fromEntries(
    Object.entries(candidate).filter(([name]) => allowedNames.has(name)),
  );
  const removed = Object.keys(candidate).filter((name) => !allowedNames.has(name));
  const added = [];

  parameters.forEach((parameter) => {
    if (parameter.required && !Object.hasOwn(value, parameter.name)) {
      value[parameter.name] = sampleValue(parameter, parameterNames);
      added.push(parameter.name);
    }
  });

  return { value, removed, added, entry: definition.name, parameters };
}
