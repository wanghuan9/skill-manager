export function isToolEnabledStatus(statusLabel: string) {
  return ["已同步", "已启用", "需要重同步"].includes(statusLabel);
}
