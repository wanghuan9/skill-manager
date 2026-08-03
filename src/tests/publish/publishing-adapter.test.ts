import { expect, test } from "vitest";
import {
  DEFAULT_PUBLISHING_ADAPTER_CAPABILITIES,
  getPublishingAdapterCapabilities,
} from "@/features/publishing/publishing-adapter";

test("uses conservative capability defaults for a publishing platform adapter", () => {
  const capabilities = getPublishingAdapterCapabilities({});

  expect(capabilities).toEqual(DEFAULT_PUBLISHING_ADAPTER_CAPABILITIES);
});

test("allows a platform adapter to opt into only its supported operations", () => {
  const capabilities = getPublishingAdapterCapabilities({
    capabilities: { updatePreview: true, revertUpdateFile: true },
  });

  expect(capabilities).toEqual({
    batchPublishing: false,
    updatePreview: true,
    revertUpdateFile: true,
    revertUpdateHunk: false,
  });
});
