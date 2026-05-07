const FALLBACK_FRAME_DELAY_MS = 16;

function scheduleAnimationFrame(callback: FrameRequestCallback) {
  if (typeof window === "undefined") {
    callback(0);
    return 0;
  }

  if (typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }

  return window.setTimeout(() => callback(Date.now()), FALLBACK_FRAME_DELAY_MS);
}

export async function waitForNextPaint() {
  await new Promise<void>((resolve) => {
    scheduleAnimationFrame(() => {
      scheduleAnimationFrame(() => resolve());
    });
  });
}
