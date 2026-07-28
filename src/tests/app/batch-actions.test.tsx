import { act, render, renderHook, screen } from "@testing-library/react";
import { BatchActionBar } from "@/app/components/BatchActions";
import { useBatchSelection } from "@/app/hooks/useBatchSelection";

test("selects visible items and removes selections hidden by filtering", () => {
  const { result, rerender } = renderHook(
    ({ visibleIds }) => useBatchSelection(visibleIds),
    { initialProps: { visibleIds: ["alpha", "beta"] } },
  );

  act(() => {
    result.current.enterSelection();
    result.current.toggleSelectAll();
  });

  expect(result.current.isSelecting).toBe(true);
  expect(result.current.isAllVisibleSelected).toBe(true);
  expect([...result.current.selectedIds]).toEqual(["alpha", "beta"]);

  rerender({ visibleIds: ["beta"] });

  expect([...result.current.selectedIds]).toEqual(["beta"]);
  expect(result.current.isAllVisibleSelected).toBe(true);
});

test("keeps only failed selections after a batch operation", () => {
  const { result } = renderHook(() => useBatchSelection(["alpha", "beta"]));

  act(() => {
    result.current.enterSelection();
    result.current.toggleSelectAll();
    result.current.keepSelected(["beta"]);
  });

  expect([...result.current.selectedIds]).toEqual(["beta"]);

  act(() => result.current.exitSelection());

  expect(result.current.isSelecting).toBe(false);
  expect(result.current.selectedIds.size).toBe(0);
});

test("places batch actions before the selected count", () => {
  render(
    <BatchActionBar
      actions={[{ key: "delete", label: "删除 2 个", onClick: () => undefined }]}
      ariaLabel="批量操作"
      cancelLabel="取消"
      deselectAllLabel="取消全选"
      hint="请选择"
      isAllVisibleSelected={false}
      isBusy={false}
      selectedLabel="已选 2 个"
      selectAllDisabled={false}
      selectAllLabel="全选"
      onCancel={() => undefined}
      onToggleSelectAll={() => undefined}
    />,
  );

  const actionGroup = screen.getByRole("button", { name: "删除 2 个" }).parentElement;
  const selectedCount = screen.getByText("已选 2 个");
  const actionGroupPosition = actionGroup?.compareDocumentPosition(selectedCount) ?? 0;
  expect(actionGroupPosition & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("uses matching lightweight styles for selection controls", () => {
  render(
    <BatchActionBar
      actions={[{ key: "disable", label: "停用 2 个", tone: "warning", onClick: () => undefined }]}
      ariaLabel="批量操作"
      cancelLabel="取消"
      deselectAllLabel="取消全选"
      hint="请选择"
      isAllVisibleSelected={false}
      isBusy={false}
      selectedLabel="已选 2 个"
      selectAllDisabled={false}
      selectAllLabel="全选"
      onCancel={() => undefined}
      onToggleSelectAll={() => undefined}
    />,
  );

  expect(screen.getByRole("button", { name: "停用 2 个" })).toHaveClass("tone-warning");
  expect(screen.getByRole("button", { name: "全选" })).toHaveClass("batch-selection-action");
  expect(screen.getByRole("button", { name: "全选" }).querySelector("svg")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "取消" })).toHaveClass("batch-selection-action");
  expect(screen.getByRole("button", { name: "取消" }).querySelector("svg")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "全选" }).parentElement).toHaveClass("has-actions");
});

test("hides the selection divider when no resource action is available", () => {
  render(
    <BatchActionBar
      actions={[]}
      ariaLabel="批量操作"
      cancelLabel="取消"
      deselectAllLabel="取消全选"
      hint="请选择"
      isAllVisibleSelected={false}
      isBusy={false}
      selectedLabel=""
      selectAllDisabled={false}
      selectAllLabel="全选"
      onCancel={() => undefined}
      onToggleSelectAll={() => undefined}
    />,
  );

  expect(screen.getByRole("button", { name: "全选" }).parentElement).not.toHaveClass("has-actions");
});
