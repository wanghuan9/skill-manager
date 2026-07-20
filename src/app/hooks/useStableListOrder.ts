import { useEffect, useRef } from "react";

export function useStableListOrder<T>(
  items: T[],
  getItemKey: (item: T) => string,
  resetKey: string | number,
) {
  const orderRef = useRef<string[]>([]);
  const resetKeyRef = useRef(resetKey);
  const itemByKey = new Map(items.map((item) => [getItemKey(item), item]));
  const shouldResetOrder = resetKeyRef.current !== resetKey;
  const previousOrder = shouldResetOrder ? [] : orderRef.current;
  const nextOrder = previousOrder.filter((itemKey) => itemByKey.has(itemKey));
  const orderedItemKeys = new Set(nextOrder);

  for (const item of items) {
    const itemKey = getItemKey(item);
    if (!orderedItemKeys.has(itemKey)) {
      nextOrder.push(itemKey);
      orderedItemKeys.add(itemKey);
    }
  }

  const orderedItems = nextOrder.map((itemKey) => itemByKey.get(itemKey) as T);

  useEffect(() => {
    orderRef.current = nextOrder;
    resetKeyRef.current = resetKey;
  }, [nextOrder, resetKey]);

  return orderedItems;
}
