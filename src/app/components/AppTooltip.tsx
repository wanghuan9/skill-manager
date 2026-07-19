import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

type TooltipAnchor = {
  element: HTMLElement;
  text: string;
};

type TooltipPlacement = "top" | "bottom";

type TooltipPosition = {
  arrowLeft: number;
  left: number;
  placement: TooltipPlacement;
  top: number;
};

type TooltipStyle = CSSProperties & {
  "--app-tooltip-arrow-left": string;
};

const TOOLTIP_DELAY_MS = 600;
const TOOLTIP_OFFSET_PX = 8;
const VIEWPORT_GAP_PX = 12;
const MIN_ARROW_INSET_PX = 12;

function findTooltipAnchor(target: EventTarget | null) {
  return target instanceof Element
    ? target.closest<HTMLElement>("[data-tooltip]")
    : null;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function resolveTooltipPosition(
  anchorRect: DOMRect,
  tooltipRect: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
): TooltipPosition {
  const anchorCenter = anchorRect.left + anchorRect.width / 2;
  const maximumLeft = Math.max(VIEWPORT_GAP_PX, viewportWidth - tooltipRect.width - VIEWPORT_GAP_PX);
  const left = clamp(anchorCenter - tooltipRect.width / 2, VIEWPORT_GAP_PX, maximumLeft);
  const topPosition = anchorRect.top - tooltipRect.height - TOOLTIP_OFFSET_PX;
  const bottomPosition = anchorRect.bottom + TOOLTIP_OFFSET_PX;
  const fitsAbove = topPosition >= VIEWPORT_GAP_PX;
  const fitsBelow = bottomPosition + tooltipRect.height <= viewportHeight - VIEWPORT_GAP_PX;
  const placement = fitsAbove || !fitsBelow ? "top" : "bottom";
  const preferredTop = placement === "top" ? topPosition : bottomPosition;
  const maximumTop = Math.max(VIEWPORT_GAP_PX, viewportHeight - tooltipRect.height - VIEWPORT_GAP_PX);
  const top = clamp(preferredTop, VIEWPORT_GAP_PX, maximumTop);
  const maximumArrowLeft = Math.max(MIN_ARROW_INSET_PX, tooltipRect.width - MIN_ARROW_INSET_PX);
  const arrowLeft = clamp(anchorCenter - left, MIN_ARROW_INSET_PX, maximumArrowLeft);

  return { arrowLeft, left, placement, top };
}

export function AppTooltip() {
  const [activeAnchor, setActiveAnchor] = useState<TooltipAnchor | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const trackedElementRef = useRef<HTMLElement | null>(null);

  const clearPendingTimer = useCallback(() => {
    if (pendingTimerRef.current == null) {
      return;
    }

    window.clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = null;
  }, []);

  const hideTooltip = useCallback(() => {
    clearPendingTimer();
    trackedElementRef.current = null;
    setActiveAnchor(null);
    setPosition(null);
  }, [clearPendingTimer]);

  const scheduleTooltip = useCallback((element: HTMLElement) => {
    const text = element.dataset.tooltip?.trim();
    if (!text) {
      return;
    }

    clearPendingTimer();
    setActiveAnchor(null);
    setPosition(null);
    trackedElementRef.current = element;
    pendingTimerRef.current = window.setTimeout(() => {
      if (!element.isConnected || trackedElementRef.current !== element) {
        return;
      }

      setPosition(null);
      setActiveAnchor({ element, text });
      pendingTimerRef.current = null;
    }, TOOLTIP_DELAY_MS);
  }, [clearPendingTimer]);

  useEffect(() => {
    function handleMouseMove(event: MouseEvent) {
      const anchor = findTooltipAnchor(event.target);
      if (!anchor) {
        if (trackedElementRef.current) {
          hideTooltip();
        }
        return;
      }

      if (trackedElementRef.current === anchor) {
        return;
      }

      scheduleTooltip(anchor);
    }

    function handleFocusIn(event: FocusEvent) {
      const anchor = findTooltipAnchor(event.target);
      if (anchor) {
        scheduleTooltip(anchor);
      }
    }

    function handleFocusOut(event: FocusEvent) {
      const anchor = findTooltipAnchor(event.target);
      if (anchor && trackedElementRef.current === anchor) {
        hideTooltip();
      }
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    window.addEventListener("resize", hideTooltip);
    window.addEventListener("scroll", hideTooltip, true);

    return () => {
      clearPendingTimer();
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      window.removeEventListener("resize", hideTooltip);
      window.removeEventListener("scroll", hideTooltip, true);
    };
  }, [clearPendingTimer, hideTooltip, scheduleTooltip]);

  useLayoutEffect(() => {
    if (!activeAnchor || !tooltipRef.current) {
      return;
    }

    const anchorRect = activeAnchor.element.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    setPosition(resolveTooltipPosition(anchorRect, tooltipRect, window.innerWidth, window.innerHeight));
  }, [activeAnchor]);

  if (!activeAnchor || typeof document === "undefined") {
    return null;
  }

  const style: TooltipStyle | undefined = position
    ? {
        "--app-tooltip-arrow-left": `${position.arrowLeft}px`,
        left: position.left,
        top: position.top,
      }
    : undefined;

  return createPortal(
    <div
      ref={tooltipRef}
      className={`app-tooltip${position ? ` is-${position.placement}` : ""}`}
      role="tooltip"
      style={style}
    >
      {activeAnchor.text}
    </div>,
    document.body,
  );
}
