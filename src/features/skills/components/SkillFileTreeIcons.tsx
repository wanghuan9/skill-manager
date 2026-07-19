import type { SkillFileEntry } from "@/features/skills/state/skill-store";
import { getSkillFileLanguage } from "@/features/skills/utils/skill-file-language";

type TreeChevronIconProps = {
  expanded: boolean;
  visible: boolean;
};

export function TreeChevronIcon({ expanded, visible }: TreeChevronIconProps) {
  return (
    <span
      className={`skill-file-dialog__tree-chevron${expanded ? " is-expanded" : ""}${
        visible ? "" : " is-hidden"
      }`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 12 12" fill="none">
        <path
          d="m4.25 2.25 3.5 3.75-3.5 3.75"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function SkillRootIcon() {
  return (
    <svg
      className="skill-file-dialog__tree-icon skill-file-dialog__tree-icon--root"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M9 2.2 15 5.5v7L9 15.8l-6-3.3v-7L9 2.2Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path
        d="m3.4 5.7 5.6 3 5.6-3M9 8.7v6.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className="skill-file-dialog__tree-icon skill-file-dialog__tree-icon--folder"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
    >
      {expanded ? (
        <>
          <path
            d="M2.5 12.75v-7.1A1.65 1.65 0 0 1 4.15 4h3.1L8.7 5.55h5.15a1.65 1.65 0 0 1 1.65 1.65v1.05"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M3.65 7.75h11.1a1.15 1.15 0 0 1 1.1 1.5l-1.25 4.1a1.55 1.55 0 0 1-1.48 1.1H4.35a1.55 1.55 0 0 1-1.49-1.14L1.8 9.7a1.55 1.55 0 0 1 1.85-1.95Z"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <path
            d="M2.5 5.65A1.65 1.65 0 0 1 4.15 4h3.1L8.7 5.55h5.15A1.65 1.65 0 0 1 15.5 7.2v5.15A1.65 1.65 0 0 1 13.85 14H4.15a1.65 1.65 0 0 1-1.65-1.65v-6.7Z"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M2.75 7.25h12.5"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}

function FileIcon({ path }: { path: string }) {
  const kind = getSkillFileLanguage(path)?.kind ?? "text";
  return (
    <svg
      className={`skill-file-dialog__tree-icon skill-file-dialog__tree-icon--${kind}`}
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 2.25h6l4 4v9.5H4V2.25Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M10 2.6v4h3.7"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      {kind === "code" ? (
        <path
          d="m7.25 9-1.5 1.5 1.5 1.5m3.5-3 1.5 1.5-1.5 1.5"
          stroke="currentColor"
          strokeWidth="1.05"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : kind === "config" ? (
        <path
          d="M6.2 9h5.6M6.2 12h5.6M8 8v2m2-1v2m-2 0v2"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
        />
      ) : kind === "markdown" ? (
        <path
          d="M6 12V8.7L7.5 11l1.5-2.3V12m1.3-1.15 1.1 1.15 1.1-1.15"
          stroke="currentColor"
          strokeWidth="0.95"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M6.2 9h5.5M6.2 11.5h4.4"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export function SkillFileTreeIcon({
  entry,
  expanded,
}: {
  entry: SkillFileEntry;
  expanded: boolean;
}) {
  if (entry.depth === 0) {
    return <SkillRootIcon />;
  }
  if (entry.entryType === "directory") {
    return <FolderIcon expanded={expanded} />;
  }
  return <FileIcon path={entry.path} />;
}
