import { useState, type FormEvent } from "react";
import { useTranslate } from "@/app/i18n";
import { openExternalLink } from "@/features/skills/api/skill-client";
import { saveSkillHubAuthToken } from "@/features/skillhub-publishing/publishing-client";
import { skillHubPublishingAdapter } from "../adapters/skillhub";
import type {
  PublishingAuthenticationProps,
  PublishingPlatformRegistration,
} from "../publishing-platform-registration";

const SKILLHUB_TOKEN_URL = "https://skillhub.cn/dashboard/keys";

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function SkillHubAuthentication({ refreshAuth }: PublishingAuthenticationProps) {
  const { t } = useTranslate();
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      await saveSkillHubAuthToken(token);
      setToken("");
      await refreshAuth();
    } catch (reason) {
      setError(formatError(reason));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="panel-card skillhub-publish-card">
      <h2>{t("publishing.auth.connect", { platform: "SkillHub" })}</h2>
      <p>{t("publishing.auth.tokenDescription")}</p>
      <div className="skillhub-auth-flow" aria-label={t("publishing.auth.stepsAria")}>
        <section className="skillhub-auth-step skillhub-auth-step--generate">
          <div className="skillhub-auth-step__copy">
            <span className="skillhub-auth-step__number">1</span>
            <div>
              <h3>{t("publishing.auth.generateTitle")}</h3>
              <p>{t("publishing.auth.generateDescription")}</p>
            </div>
          </div>
          <button
            className="primary-button skillhub-auth-step__button"
            type="button"
            onClick={() => void openExternalLink(SKILLHUB_TOKEN_URL)}
          >
            {t("publishing.auth.generateAction")}
          </button>
        </section>
        <form className="skillhub-publish-form skillhub-auth-step" onSubmit={(event) => void handleSubmit(event)}>
          <div className="skillhub-auth-step__copy">
            <span className="skillhub-auth-step__number">2</span>
            <div>
              <h3>{t("publishing.auth.pasteTitle")}</h3>
              <p>{t("publishing.auth.pasteDescription")}</p>
            </div>
          </div>
          <label>
            <span>SkillHub Token</span>
            <input
              value={token}
              type="password"
              placeholder="skh_…"
              autoComplete="off"
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <div className="skillhub-publish-card__actions">
            <button
              className="primary-button skillhub-auth-step__button"
              type="submit"
              disabled={isSubmitting || !token.trim()}
            >
              {isSubmitting ? t("publishing.auth.verifying") : t("publishing.auth.verify")}
            </button>
          </div>
        </form>
      </div>
      {error ? <p className="dialog-error">{error}</p> : null}
    </section>
  );
}

const skillHubPublishingRegistration: PublishingPlatformRegistration = {
  adapter: skillHubPublishingAdapter,
  order: 100,
  badgeLabelKey: "publishing.platform.public",
  authorizationActionLabelKey: "publishing.platform.changeToken",
  renderAuthentication: (props) => <SkillHubAuthentication {...props} />,
  manageAuthorization: () => openExternalLink(SKILLHUB_TOKEN_URL),
};

export default skillHubPublishingRegistration;
