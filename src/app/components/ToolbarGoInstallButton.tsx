import { useTranslate } from "@/app/i18n";

function GoInstallIcon() {
  return (
    <svg
      className="skills-toolbar-button__svg"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M10 4.25v7.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="m7.25 9.25 2.75 2.75 2.75-2.75"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.25 14.75h9.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

type ToolbarGoInstallButtonProps = {
  onClick: () => void;
};

export function ToolbarGoInstallButton(props: ToolbarGoInstallButtonProps) {
  const { t } = useTranslate();

  return (
    <button
      className="secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--go-install"
      type="button"
      onClick={props.onClick}
    >
      <span aria-hidden="true" className="skills-toolbar-button__icon">
        <GoInstallIcon />
      </span>
      <span>{t("toolbar.goInstall")}</span>
    </button>
  );
}
