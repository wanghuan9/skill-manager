import { renderHook } from "@testing-library/react";
import { useStableListOrder } from "@/app/hooks/useStableListOrder";

test("preserves the current order until a new item requires a refreshed sort", () => {
  const { result, rerender } = renderHook(
    ({ items }) => useStableListOrder(items, (item) => item.id, "skills", true),
    {
      initialProps: {
        items: [
          { id: "newer", updatedAt: 2 },
          { id: "older", updatedAt: 1 },
        ],
      },
    },
  );

  expect(result.current.map((item) => item.id)).toEqual(["newer", "older"]);

  rerender({
    items: [
      { id: "older", updatedAt: 3 },
      { id: "newer", updatedAt: 2 },
    ],
  });

  expect(result.current.map((item) => item.id)).toEqual(["newer", "older"]);

  rerender({
    items: [
      { id: "latest", updatedAt: 4 },
      { id: "older", updatedAt: 3 },
      { id: "newer", updatedAt: 2 },
    ],
  });

  expect(result.current.map((item) => item.id)).toEqual(["latest", "older", "newer"]);
});
