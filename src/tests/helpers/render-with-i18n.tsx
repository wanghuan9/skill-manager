import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { AppI18nProvider } from "@/app/i18n";
import { NotificationProvider } from "@/app/notifications";

function I18nTestProvider({ children }: { children: ReactNode }) {
  return (
    <AppI18nProvider>
      <NotificationProvider>{children}</NotificationProvider>
    </AppI18nProvider>
  );
}

export function renderWithI18n(ui: ReactElement, options?: RenderOptions) {
  return render(ui, {
    wrapper: I18nTestProvider,
    ...options,
  });
}
