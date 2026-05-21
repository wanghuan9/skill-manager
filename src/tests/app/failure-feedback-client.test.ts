import { expect, test, vi } from "vitest";

vi.mock("@/app/is-tauri-runtime", () => ({
  isTauriRuntime: () => false,
}));

const { recordFailureFeedback } = await import("@/features/skills/api/skill-client");

test("includes root cause details in fallback feedback draft", async () => {
  const draft = await recordFailureFeedback({
    operation: "check_for_app_update",
    message: "error sending request for url (https://github.com/example/latest.json)",
    context: {
      errorDetails: {
        rootCause: "dns error: failed to lookup address information",
        causeChain: [
          "client error (Connect)",
          "dns error: failed to lookup address information",
        ],
      },
    },
  });

  expect(draft.body).toContain("rootCause: dns error: failed to lookup address information");
  expect(draft.body).toContain(
    "causeChain: client error (Connect) -> dns error: failed to lookup address information",
  );
});
