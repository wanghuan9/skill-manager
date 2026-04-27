import "@testing-library/jest-dom";

const storageState = new Map<string, string>();

if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        return storageState.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storageState.set(key, value);
      },
      removeItem(key: string) {
        storageState.delete(key);
      },
      clear() {
        storageState.clear();
      },
    },
  });
}
