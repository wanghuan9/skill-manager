import { useCallback } from "react";
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
      actionLabel: "反馈",
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
            message: normalizeErrorMessage(feedbackError, "打开反馈页面失败"),
          });
          });
      },
    });
  }, [notify]);
}
