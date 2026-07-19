import { useMemo } from "react";
import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import powershell from "highlight.js/lib/languages/powershell";
import {
  getSkillFileLanguage,
  normalizeCodeFenceLanguage,
} from "@/features/skills/utils/skill-file-language";

hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("powershell", powershell);

type HighlightedCodeProps = {
  content: string;
  language: string;
  className?: string;
};

type SkillCodePreviewProps = {
  path: string;
  content: string;
};

function highlightSource(content: string, language: string) {
  if (!language || !hljs.getLanguage(language)) {
    return "";
  }
  return hljs.highlight(content, { language, ignoreIllegals: true }).value;
}

export function HighlightedCode({ content, language, className = "" }: HighlightedCodeProps) {
  const normalizedLanguage = normalizeCodeFenceLanguage(language);
  const highlightedHtml = useMemo(
    () => highlightSource(content, normalizedLanguage),
    [content, normalizedLanguage],
  );
  if (!normalizedLanguage) {
    return <code className={className}>{content}</code>;
  }

  const classes = [className, "hljs", `language-${normalizedLanguage}`].filter(Boolean).join(" ");
  // highlight.js escapes source text before adding syntax token spans.
  return <code className={classes} dangerouslySetInnerHTML={{ __html: highlightedHtml }} />;
}

export function SkillCodePreview({ path, content }: SkillCodePreviewProps) {
  const fileLanguage = getSkillFileLanguage(path);
  if (!fileLanguage) {
    return <pre className="skill-file-dialog__plain-preview">{content}</pre>;
  }

  return (
    <pre className="skill-file-dialog__code-preview" data-language={fileLanguage.language}>
      <HighlightedCode content={content} language={fileLanguage.language} />
    </pre>
  );
}
