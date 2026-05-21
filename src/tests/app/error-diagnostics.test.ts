import { expect, test } from "vitest";
import { buildErrorDiagnostics } from "@/app/error-diagnostics";

test("extracts root cause and cause chain from nested errors", () => {
  const error = new Error("error sending request for url (https://github.com/example/latest.json)", {
    cause: new Error("client error (Connect)"),
  });
  (error.cause as Error).cause = new Error("dns error: failed to lookup address information");

  expect(buildErrorDiagnostics(error)).toEqual(expect.objectContaining({
    message: "error sending request for url (https://github.com/example/latest.json)",
    causeChain: [
      "Error: client error (Connect)",
      "Error: dns error: failed to lookup address information",
    ],
    rootCause: "Error: dns error: failed to lookup address information",
  }));
});

test("omits sensitive extra fields from diagnostics", () => {
  const error = {
    message: "request failed",
    token: "secret-token",
    authorization: "Bearer abc",
    status: 500,
  };

  expect(buildErrorDiagnostics(error)).toEqual({
    message: "request failed",
    extra: {
      status: 500,
    },
  });
});
