import { useState, type FormEvent } from "react";
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
      <h2>连接 SkillHub</h2>
      <p>生成一次 Token 并粘贴到这里；验证成功后会保存到 `~/.skilldock/skillhub-auth.json`，下次启动自动复用。</p>
      <div className="skillhub-auth-flow" aria-label="连接步骤">
        <section className="skillhub-auth-step skillhub-auth-step--generate">
          <div className="skillhub-auth-step__copy">
            <span className="skillhub-auth-step__number">1</span>
            <div>
              <h3>先生成 Token</h3>
              <p>将在浏览器打开 SkillHub 的密钥管理页。</p>
            </div>
          </div>
          <button
            className="primary-button skillhub-auth-step__button"
            type="button"
            onClick={() => void openExternalLink(SKILLHUB_TOKEN_URL)}
          >
            去 SkillHub 生成 Token ↗
          </button>
        </section>
        <form className="skillhub-publish-form skillhub-auth-step" onSubmit={(event) => void handleSubmit(event)}>
          <div className="skillhub-auth-step__copy">
            <span className="skillhub-auth-step__number">2</span>
            <div>
              <h3>粘贴并验证</h3>
              <p>粘贴以 <code>skh_</code> 开头的 Token。</p>
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
              {isSubmitting ? "验证中…" : "验证并登录"}
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
  badgeLabel: "公开",
  authorizationActionLabel: "更换 Token",
  renderAuthentication: (props) => <SkillHubAuthentication {...props} />,
  manageAuthorization: () => openExternalLink(SKILLHUB_TOKEN_URL),
};

export default skillHubPublishingRegistration;
