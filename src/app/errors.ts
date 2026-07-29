export class BusinessError extends Error {
  readonly isBusinessError = true;

  constructor(message: string) {
    super(message);
    this.name = "BusinessError";
  }
}

export type FailureClassification = {
  kind: "business" | "unknown";
  message: string;
};

const SYSTEM_ERROR_PATTERNS = [
  /operation not permitted/i,
  /permission denied/i,
  /access is denied/i,
  /os error/i,
  /enoent/i,
  /eacces/i,
  /eperm/i,
  /no such file or directory/i,
];

const GITHUB_RATE_LIMIT_PATTERNS = [
  /github api request limit reached/i,
  /github api 请求受限/i,
  /api rate limit exceeded/i,
];

export function isBusinessError(error: unknown): error is BusinessError {
  return Boolean(
    error instanceof BusinessError ||
      (typeof error === "object" && error !== null && "isBusinessError" in error && (error as { isBusinessError?: boolean }).isBusinessError),
  );
}

export function normalizeErrorMessage(error: unknown, fallbackMessage: string) {
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }

  return fallbackMessage;
}

export function isGithubRateLimitError(error: unknown) {
  const message = normalizeErrorMessage(error, "");
  return GITHUB_RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

function isSystemLikeMessage(message: string) {
  return SYSTEM_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function classifyError(error: unknown, fallbackMessage: string): FailureClassification {
  const message = normalizeErrorMessage(error, fallbackMessage);

  return {
    kind: isBusinessError(error) && !isSystemLikeMessage(message) ? "business" : "unknown",
    message,
  };
}
