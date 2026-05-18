import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { AppI18nProvider } from "@/app/i18n";

function I18nTestProvider({ children }: { children: ReactNode }) {
  return <AppI18nProvider>{children}</AppI18nProvider>;
}

export function renderWithI18n(ui: ReactElement, options?: RenderOptions) {
  return render(ui, {
    wrapper: I18nTestProvider,
    ...options,
  });
}
