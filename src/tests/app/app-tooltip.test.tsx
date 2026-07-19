import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AppTooltip } from "@/app/components/AppTooltip";

function mockRect(input: Partial<DOMRect>): DOMRect {
  const left = input.left ?? 0;
  const top = input.top ?? 0;
  const width = input.width ?? 0;
  const height = input.height ?? 0;
  const right = input.right ?? left + width;
  const bottom = input.bottom ?? top + height;

  return {
    bottom,
    height,
    left,
    right,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("renders tooltips in the document body and flips below top-edge anchors", async () => {
  const getBoundingClientRectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains("app-tooltip")) {
      return mockRect({ width: 108, height: 28 });
    }

    if (this.hasAttribute("data-tooltip")) {
      return mockRect({ left: 4, top: 4, width: 88, height: 28 });
    }

    return mockRect({});
  });

  render(
    <>
      <div data-testid="clipping-container" style={{ overflow: "hidden" }}>
        <button data-tooltip="未启用，点击启用" type="button">
          Gemini CLI
        </button>
      </div>
      <AppTooltip />
    </>,
  );

  const button = screen.getByRole("button", { name: "Gemini CLI" });
  fireEvent.mouseMove(button);

  await act(async () => {
    vi.advanceTimersByTime(600);
  });

  const tooltip = screen.getByRole("tooltip");
  await act(async () => undefined);

  expect(tooltip.parentElement).toBe(document.body);
  expect(tooltip).toHaveClass("is-bottom");
  expect(tooltip.style.left).toBe("12px");
  expect(tooltip.style.top).toBe("40px");
  getBoundingClientRectSpy.mockRestore();
});

test("hides the active tooltip when the pointer leaves its anchor", async () => {
  render(
    <>
      <button data-tooltip="打开文件夹" type="button">
        打开
      </button>
      <div data-testid="outside">页面内容</div>
      <AppTooltip />
    </>,
  );

  fireEvent.mouseMove(screen.getByRole("button", { name: "打开" }));
  await act(async () => {
    vi.advanceTimersByTime(600);
  });
  expect(screen.getByRole("tooltip")).toBeInTheDocument();

  fireEvent.mouseMove(screen.getByTestId("outside"));
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});
