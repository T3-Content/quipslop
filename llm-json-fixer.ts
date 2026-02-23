export type JSONFix =
  | "markdown_stripped"
  | "trailing_removed"
  | "unescaped_quote"
  | "missing_comma";

export type ParseJSONResult<T = unknown> = {
  data: T | null;
  fixes: JSONFix[];
  warnings: string[];
};

function extractFromMarkdown(input: string): string {
  if (/```(?:json|JSON)?\s*\r?\n\s*\r?\n```/.test(input)) {
    return "";
  }

  const fencedJson = /```(?:json|JSON)\s*\r?\n([\s\S]*?)\r?\n\s*```/g;
  let match: RegExpExecArray | null;
  while ((match = fencedJson.exec(input)) !== null) {
    const candidate = (match[1] ?? "").trim();
    if (candidate) {
      return candidate;
    }
  }

  const fenced = /```\s*\r?\n([\s\S]*?)\r?\n\s*```/g;
  while ((match = fenced.exec(input)) !== null) {
    const candidate = (match[1] ?? "").trim();
    if (candidate.startsWith("{") || candidate.startsWith("[")) {
      return candidate;
    }
  }

  const inline = /`([^`]+)`/g;
  while ((match = inline.exec(input)) !== null) {
    const candidate = (match[1] ?? "").trim();
    if (candidate.startsWith("{") || candidate.startsWith("[")) {
      return candidate;
    }
  }

  return input;
}

function findFirstJSONStart(input: string): number {
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString && char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && (char === "{" || char === "[")) {
      return i;
    }
  }
  return -1;
}

function removeTrailingContent(input: string): string {
  const start = findFirstJSONStart(input);
  if (start === -1) {
    return input.trim();
  }

  const source = input.slice(start);
  let inString = false;
  let escapeNext = false;
  const stack: string[] = [];

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString && char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char === "}" || char === "]") {
      const opening = stack.pop();
      if (!opening) {
        continue;
      }
      if ((opening === "{" && char !== "}") || (opening === "[" && char !== "]")) {
        continue;
      }
      if (stack.length === 0) {
        return source.slice(0, i + 1).trimEnd();
      }
    }
  }

  return source.trim();
}

function fixUnescapedQuotes(input: string): string {
  let out = "";
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (escapeNext) {
      out += char;
      escapeNext = false;
      continue;
    }

    if (char === "\\" && inString) {
      out += char;
      escapeNext = true;
      continue;
    }

    if (char === '"' && !inString) {
      inString = true;
      out += char;
      continue;
    }

    if (char === '"' && inString) {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) {
        j++;
      }
      const next = input[j] ?? "";
      const closesString =
        next === "" || next === "," || next === ":" || next === "}" || next === "]";
      if (closesString) {
        inString = false;
        out += char;
      } else {
        out += "\\\"";
      }
      continue;
    }

    out += char;
  }

  return out;
}

function addMissingCommas(input: string): string {
  if (!input.includes("\n")) {
    return input
      .replace(/([\]}"\d]|true|false|null)\s+("[^"]+"\s*:)/g, "$1, $2")
      .replace(/([\]}"\d]|true|false|null)\s+("|\{|\[|\d|true|false|null)/g, "$1, $2");
  }

  const lines = input.split("\n");
  const output: string[] = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    output.push(line);

    if (
      !trimmed ||
      trimmed.endsWith(",") ||
      trimmed.endsWith("{") ||
      trimmed.endsWith("[") ||
      trimmed.endsWith(":")
    ) {
      for (const char of line) {
        if (char === "{" || char === "[") depth++;
        else if (char === "}" || char === "]") depth--;
      }
      continue;
    }

    let nextIndex = i + 1;
    while (nextIndex < lines.length && lines[nextIndex]!.trim() === "") {
      nextIndex++;
    }

    const next = nextIndex < lines.length ? lines[nextIndex]!.trim() : "";
    const canTakeComma = depth > 0 && next && !next.startsWith("}") && !next.startsWith("]");
    if (canTakeComma) {
      output[output.length - 1] = `${line},`;
    }

    for (const char of line) {
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
    }
  }

  return output.join("\n");
}

export function tryParseJSON<T = unknown>(input: string): ParseJSONResult<T> {
  const fixes: JSONFix[] = [];
  const warnings: string[] = [];
  let processed = input.trim();

  if (!processed) {
    return { data: null, fixes, warnings: ["Input is empty"] };
  }

  const attempts: Array<() => string> = [
    () => {
      const next = extractFromMarkdown(processed);
      if (next !== processed) fixes.push("markdown_stripped");
      return next;
    },
    () => {
      const next = removeTrailingContent(processed);
      if (next !== processed) fixes.push("trailing_removed");
      return next;
    },
    () => {
      const next = fixUnescapedQuotes(processed);
      if (next !== processed) fixes.push("unescaped_quote");
      return next;
    },
    () => {
      const next = addMissingCommas(processed);
      if (next !== processed) fixes.push("missing_comma");
      return next;
    },
  ];

  for (let i = 0; i <= attempts.length; i++) {
    try {
      return {
        data: JSON.parse(processed) as T,
        fixes,
        warnings,
      };
    } catch (error) {
      warnings.push((error as Error).message);
      if (i === attempts.length) {
        break;
      }
      const next = attempts[i]!();
      if (next !== processed) {
        processed = next;
      }
    }
  }

  return { data: null, fixes, warnings };
}

export function parseJSON<T = unknown>(input: string): T | null {
  return tryParseJSON<T>(input).data;
}

export function extractJSON(text: string): unknown {
  const parsed = tryParseJSON(text);
  if (parsed.data === null) {
    throw new Error(`Failed to parse JSON from AI response: ${parsed.warnings.join(" | ")}`);
  }
  return parsed.data;
}