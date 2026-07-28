import { useCallback, useEffect, useMemo, useState } from "react";

export function useBatchSelection(visibleIds: string[]) {
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const visibleIdSet = useMemo(() => new Set(visibleIds), [visibleIds]);
  const isAllVisibleSelected = visibleIds.length > 0
    && visibleIds.every((id) => selectedIds.has(id));

  useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => visibleIdSet.has(id)));
      if (next.size === current.size) {
        return current;
      }
      return next;
    });
  }, [visibleIdSet]);

  const enterSelection = useCallback(() => {
    setIsSelecting(true);
  }, []);

  const exitSelection = useCallback(() => {
    setIsSelecting(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((current) => {
      if (visibleIds.length === 0) {
        return current;
      }
      const next = new Set(current);
      const shouldDeselect = visibleIds.every((id) => current.has(id));
      for (const id of visibleIds) {
        if (shouldDeselect) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  }, [visibleIds]);

  const keepSelected = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids));
  }, []);

  return {
    enterSelection,
    exitSelection,
    isAllVisibleSelected,
    isSelecting,
    keepSelected,
    selectedIds,
    toggleSelectAll,
    toggleSelection,
  };
}
