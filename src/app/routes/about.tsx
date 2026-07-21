import { useEffect, useMemo, useState } from "react";
import { useTranslate } from "@/app/i18n";
import { fetchCurrentAppVersion } from "@/features/app-update/app-update-client";
import { openExternalLink } from "@/features/skills/api/skill-client";

const APP_REPOSITORY_URL = "https://github.com/wanghuan9/skilldock";
const APP_ISSUES_URL = `${APP_REPOSITORY_URL}/issues/new/choose`;
const APP_RELEASES_URL = `${APP_REPOSITORY_URL}/releases`;

type AboutActionCard = {
  title: string;
  description: string;
  linkText: string;
  url: string;
  icon: "github" | "message" | "tag";
};

function AboutAppIcon() {
  return (
    <div className="about-hero__icon" aria-hidden="true">
      <svg viewBox="0 0 64 64">
        <path
          d="M32 13c4.4 8.5 7.5 11.6 16 16c-8.5 4.4-11.6 7.5-16 16c-4.4-8.5-7.5-11.6-16-16c8.5-4.4 11.6-7.5 16-16Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinejoin="round"
        />
        <path
          d="M32 24c1.8 3.4 3.1 4.7 6.5 6.5c-3.4 1.8-4.7 3.1-6.5 6.5c-1.8-3.4-3.1-4.7-6.5-6.5c3.4-1.8 4.7-3.1 6.5-6.5Z"
          fill="currentColor"
        />
      </svg>
    </div>
  );
}

function AboutActionIcon({ icon }: { icon: AboutActionCard["icon"] }) {
  if (icon === "github") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 2.8a9.2 9.2 0 0 0-2.9 17.93c.46.08.62-.2.62-.44v-1.63c-2.55.55-3.09-1.1-3.09-1.1c-.42-1.06-1.02-1.34-1.02-1.34c-.83-.57.06-.56.06-.56c.92.07 1.41.95 1.41.95c.82 1.4 2.15 1 2.67.76c.08-.6.32-1 .58-1.23c-2.04-.23-4.18-1.02-4.18-4.54c0-1 .36-1.82.95-2.46c-.1-.23-.41-1.17.09-2.43c0 0 .77-.25 2.53.94A8.8 8.8 0 0 1 12 7.3c.78 0 1.55.1 2.28.31c1.76-1.19 2.53-.94 2.53-.94c.5 1.26.19 2.2.09 2.43c.59.64.95 1.46.95 2.46c0 3.53-2.15 4.3-4.19 4.53c.33.29.62.85.62 1.72v2.48c0 .24.16.53.63.44A9.2 9.2 0 0 0 12 2.8Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (icon === "message") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M6 5.5h12a2 2 0 0 1 2 2v7.2a2 2 0 0 1-2 2H9.2L5 19.6v-2.9H6a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4.8 5.2h6.7l7.7 7.7a2 2 0 0 1 0 2.8l-3.5 3.5a2 2 0 0 1-2.8 0l-7.7-7.7V5.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.4 8.6h.01" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function AboutRoute() {
  const { t } = useTranslate();
  const [currentAppVersion, setCurrentAppVersion] = useState("");
  const aboutActionCards = useMemo<AboutActionCard[]>(() => [
    {
      title: t("about.repo.title"),
      description: t("about.repo.description"),
      linkText: "wanghuan9/skilldock",
      url: APP_REPOSITORY_URL,
      icon: "github",
    },
    {
      title: t("about.feedback.title"),
      description: t("about.feedback.description"),
      linkText: "GitHub Issues",
      url: APP_ISSUES_URL,
      icon: "message",
    },
    {
      title: t("about.release.title"),
      description: t("about.release.description"),
      linkText: "Releases",
      url: APP_RELEASES_URL,
      icon: "tag",
    },
  ], [t]);

  useEffect(() => {
    let shouldIgnore = false;

    void fetchCurrentAppVersion()
      .then((version) => {
        if (!shouldIgnore) {
          setCurrentAppVersion(version);
        }
      })
      .catch(() => {
        if (!shouldIgnore) {
          setCurrentAppVersion(t("settings.about.versionUnknown"));
        }
      });

    return () => {
      shouldIgnore = true;
    };
  }, [t]);

  return (
    <div className="about-page">
      <section className="about-hero" aria-labelledby="about-title">
        <AboutAppIcon />
        <div className="about-hero__copy">
          <h2 id="about-title">SkillDock</h2>
          <p>{t("about.summary")}</p>
        </div>
        <div className="about-hero__meta" aria-label={t("about.meta")}>
          <span>v{currentAppVersion || t("about.versionLoading")}</span>
        </div>
      </section>

      <section className="about-action-grid" aria-label={t("about.links")}>
        {aboutActionCards.map((card) => (
          <a
            key={card.title}
            className="about-action-card"
            href={card.url}
            onClick={(event) => {
              event.preventDefault();
              void openExternalLink(card.url);
            }}
          >
            <span className="about-action-card__icon">
              <AboutActionIcon icon={card.icon} />
            </span>
            <span className="about-action-card__copy">
              <span className="about-action-card__title">{card.title}</span>
              <span className="about-action-card__description">{card.description}</span>
              <span className="about-action-card__link">{card.linkText}</span>
            </span>
          </a>
        ))}
      </section>
    </div>
  );
}
