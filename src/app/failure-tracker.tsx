import { useEffect, type ReactNode } from "react";
import { useTranslate } from "@/app/i18n";
import { useFailureReporter } from "@/app/failure-feedback";

type FailureTrackerProps = {
  children: ReactNode;
};

export function FailureTracker({ children }: FailureTrackerProps) {
  const { t } = useTranslate();
  const reportFailure = useFailureReporter();

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      reportFailure(event.error ?? new Error(event.message || t("errors.unknown")), {
        operation: event.filename || "unhandled_error",
        fallbackMessage: t("errors.unknown"),
        context: {
          source: "window.error",
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
      });
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      reportFailure(event.reason ?? new Error(t("errors.unknown")), {
        operation: "unhandledrejection",
        fallbackMessage: t("errors.unknown"),
        context: {
          source: "window.unhandledrejection",
        },
      });
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, [reportFailure, t]);

  return <>{children}</>;
}
