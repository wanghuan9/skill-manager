import { useEffect, type ReactNode } from "react";
import { useFailureReporter } from "@/app/failure-feedback";

type FailureTrackerProps = {
  children: ReactNode;
};

export function FailureTracker({ children }: FailureTrackerProps) {
  const reportFailure = useFailureReporter();

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      reportFailure(event.error ?? new Error(event.message || "发生未知错误"), {
        operation: event.filename || "unhandled_error",
        fallbackMessage: "发生未知错误",
        context: {
          source: "window.error",
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
      });
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      reportFailure(event.reason ?? new Error("发生未知错误"), {
        operation: "unhandledrejection",
        fallbackMessage: "发生未知错误",
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
  }, [reportFailure]);

  return <>{children}</>;
}
