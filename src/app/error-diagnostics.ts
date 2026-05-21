type SerializableRecord = Record<string, unknown>;

const MAX_STACK_CHARS = 2_000;
const MAX_CAUSE_DEPTH = 6;
const MAX_STRING_LENGTH = 500;
const SENSITIVE_KEY_PATTERNS = [
  "token",
  "apikey",
  "authorization",
  "secret",
  "password",
  "privatekey",
  "cookie",
  "setcookie",
];

export function buildErrorDiagnostics(error: unknown): SerializableRecord | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const source = error as SerializableRecord;
  const diagnostics: SerializableRecord = {};

  const errorName = readTrimmedString(source.name);
  if (errorName) {
    diagnostics.name = errorName;
  }

  const message = readTrimmedString(source.message);
  if (message) {
    diagnostics.message = message;
  }

  const stack = readTrimmedString(source.stack);
  if (stack) {
    diagnostics.stack = stack.slice(0, MAX_STACK_CHARS);
  }

  const causeChain = buildCauseChain(source);
  if (causeChain.length > 0) {
    diagnostics.causeChain = causeChain;
    diagnostics.rootCause = causeChain[causeChain.length - 1];
  }

  const extra = extractExtraFields(source);
  if (Object.keys(extra).length > 0) {
    diagnostics.extra = extra;
  }

  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}

function buildCauseChain(source: SerializableRecord) {
  const chain: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = source.cause;
  let depth = 0;

  while (current && depth < MAX_CAUSE_DEPTH && !visited.has(current)) {
    visited.add(current);
    const summary = summarizeCause(current);
    if (!summary) {
      break;
    }
    chain.push(summary);
    current = typeof current === "object" && current !== null ? (current as SerializableRecord).cause : undefined;
    depth += 1;
  }

  return chain;
}

function summarizeCause(value: unknown) {
  if (typeof value === "string") {
    return trimForLog(value);
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const source = value as SerializableRecord;
  const name = readTrimmedString(source.name);
  const message = readTrimmedString(source.message);

  if (name && message) {
    return trimForLog(`${name}: ${message}`);
  }
  if (message) {
    return trimForLog(message);
  }
  if (name) {
    return trimForLog(name);
  }

  return undefined;
}

function extractExtraFields(source: SerializableRecord) {
  const extra: SerializableRecord = {};
  for (const [key, value] of Object.entries(source)) {
    if (["name", "message", "stack", "cause"].includes(key) || isSensitiveKey(key)) {
      continue;
    }

    const normalized = toSerializableValue(value);
    if (normalized !== undefined) {
      extra[key] = normalized;
    }
  }
  return extra;
}

function toSerializableValue(value: unknown): unknown {
  if (typeof value === "string") {
    return trimForLog(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value
      .map((item) => toSerializableValue(item))
      .filter((item) => item !== undefined)
      .slice(0, 10);
    return items.length > 0 ? items : undefined;
  }
  if (value && typeof value === "object") {
    const next: SerializableRecord = {};
    for (const [key, nestedValue] of Object.entries(value as SerializableRecord)) {
      if (isSensitiveKey(key)) {
        continue;
      }
      const normalized = toSerializableValue(nestedValue);
      if (normalized !== undefined) {
        next[key] = normalized;
      }
    }
    return Object.keys(next).length > 0 ? next : undefined;
  }

  return undefined;
}

function isSensitiveKey(key: string) {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function readTrimmedString(value: unknown) {
  return typeof value === "string" && value.trim() ? trimForLog(value) : "";
}

function trimForLog(value: string) {
  return value.trim().slice(0, MAX_STRING_LENGTH);
}
