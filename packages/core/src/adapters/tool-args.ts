/**
 * Tool-call arguments arrive as streamed string fragments, and providers disagree on what
 * those fragments are. OpenAI sends partial JSON that must be concatenated to form one object.
 * Gemini's OpenAI-compatible endpoint can instead send several *complete* objects for the same
 * call (typically empty placeholders followed by the real arguments), so naive concatenation
 * yields `{}{}{"name":"x"}`, which is not valid JSON.
 *
 * Parse the concatenated string, falling back to reading successive JSON values and merging them.
 */
export function parseToolArguments(raw: string): unknown {
  const s = raw.trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    /* fall through to the multi-value scan */
  }
  const values = scanJsonValues(s);
  const objects = values.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v));
  // Later fragments win, so real arguments override the empty placeholders that preceded them.
  if (objects.length) return Object.assign({}, ...objects);
  if (values.length) return values[values.length - 1];
  return { _raw: raw };
}

/** Read successive top-level JSON objects or arrays out of a string, skipping anything unparseable. */
function scanJsonValues(s: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{" || c === "[") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (c === "}" || c === "]") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(s.slice(start, i + 1)));
        } catch {
          /* skip a malformed fragment rather than losing the rest */
        }
        start = -1;
      }
    }
  }
  return out;
}
