import { useCallback } from "react";
import { useTranslate } from "@/app/i18n";
import { useNotifications } from "@/app/notifications";
import { classifyError, normalizeErrorMessage } from "@/app/errors";
import { openExternalLink, recordFailureFeedback } from "@/features/skills/api/skill-client";
import type { FailureFeedbackInput } from "@/features/skills/state/skill-store";

export async function openFailureFeedbackIssue(input: FailureFeedbackInput) {
  const draft = await recordFailureFeedback(input);
  await openExternalLink(draft.issueUrl);
}

type UseFailureReporterInput = {
  operation: string;
  fallbackMessage: string;
  context?: Record<string, unknown>;
};

export function useFailureReporter() {
  const { t } = useTranslate();
  const { notify } = useNotifications();

  return useCallback((error: unknown, input: UseFailureReporterInput) => {
    const classification = classifyError(error, input.fallbackMessage);
    const feedbackInput: FailureFeedbackInput = {
      operation: input.operation,
      message: classification.message,
      kind: classification.kind,
      context: input.context,
    };

    const feedbackDraftPromise = recordFailureFeedback(feedbackInput).catch(() => null);

    if (classification.kind === "business") {
      notify({ tone: "error", message: classification.message });
      return;
    }

    notify({
      tone: "error",
      message: classification.message,
      actionLabel: t("mcp.feedback.action"),
      onAction: () => {
        void feedbackDraftPromise
          .then((draft) => {
            if (draft) {
              return openExternalLink(draft.issueUrl);
            }
            return openFailureFeedbackIssue(feedbackInput);
          })
          .catch((feedbackError) => {
          notify({
            tone: "error",
            message: normalizeErrorMessage(feedbackError, t("mcp.feedback.openFailed")),
          });
          });
      },
    });
  }, [notify, t]);
}
