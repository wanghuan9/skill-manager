export type SkillFileLanguageKind = "markdown" | "code" | "config" | "text";

export type SkillFileLanguage = {
  language: string;
  label: string;
  kind: SkillFileLanguageKind;
};

const LANGUAGE_BY_EXTENSION: Record<string, SkillFileLanguage> = {
  bash: { language: "bash", label: "Shell", kind: "code" },
  c: { language: "c", label: "C", kind: "code" },
  cc: { language: "cpp", label: "C++", kind: "code" },
  cjs: { language: "javascript", label: "JavaScript", kind: "code" },
  conf: { language: "ini", label: "Config", kind: "config" },
  cpp: { language: "cpp", label: "C++", kind: "code" },
  cs: { language: "csharp", label: "C#", kind: "code" },
  css: { language: "css", label: "CSS", kind: "code" },
  cts: { language: "typescript", label: "TypeScript", kind: "code" },
  cxx: { language: "cpp", label: "C++", kind: "code" },
  diff: { language: "diff", label: "Diff", kind: "code" },
  gql: { language: "graphql", label: "GraphQL", kind: "code" },
  go: { language: "go", label: "Go", kind: "code" },
  graphql: { language: "graphql", label: "GraphQL", kind: "code" },
  h: { language: "c", label: "C", kind: "code" },
  hpp: { language: "cpp", label: "C++", kind: "code" },
  hxx: { language: "cpp", label: "C++", kind: "code" },
  htm: { language: "xml", label: "HTML", kind: "code" },
  html: { language: "xml", label: "HTML", kind: "code" },
  ini: { language: "ini", label: "INI", kind: "config" },
  java: { language: "java", label: "Java", kind: "code" },
  js: { language: "javascript", label: "JavaScript", kind: "code" },
  json: { language: "json", label: "JSON", kind: "config" },
  jsonc: { language: "json", label: "JSON", kind: "config" },
  jsx: { language: "javascript", label: "JSX", kind: "code" },
  kt: { language: "kotlin", label: "Kotlin", kind: "code" },
  kts: { language: "kotlin", label: "Kotlin", kind: "code" },
  less: { language: "less", label: "Less", kind: "code" },
  log: { language: "plaintext", label: "Log", kind: "text" },
  lua: { language: "lua", label: "Lua", kind: "code" },
  m: { language: "objectivec", label: "Objective-C", kind: "code" },
  mm: { language: "objectivec", label: "Objective-C++", kind: "code" },
  markdown: { language: "markdown", label: "Markdown", kind: "markdown" },
  md: { language: "markdown", label: "Markdown", kind: "markdown" },
  mjs: { language: "javascript", label: "JavaScript", kind: "code" },
  mts: { language: "typescript", label: "TypeScript", kind: "code" },
  patch: { language: "diff", label: "Diff", kind: "code" },
  php: { language: "php", label: "PHP", kind: "code" },
  pl: { language: "perl", label: "Perl", kind: "code" },
  pm: { language: "perl", label: "Perl", kind: "code" },
  properties: { language: "ini", label: "Properties", kind: "config" },
  ps1: { language: "powershell", label: "PowerShell", kind: "code" },
  py: { language: "python", label: "Python", kind: "code" },
  r: { language: "r", label: "R", kind: "code" },
  rb: { language: "ruby", label: "Ruby", kind: "code" },
  rs: { language: "rust", label: "Rust", kind: "code" },
  scss: { language: "scss", label: "SCSS", kind: "code" },
  sh: { language: "bash", label: "Shell", kind: "code" },
  sql: { language: "sql", label: "SQL", kind: "code" },
  svg: { language: "xml", label: "SVG", kind: "code" },
  swift: { language: "swift", label: "Swift", kind: "code" },
  toml: { language: "ini", label: "TOML", kind: "config" },
  ts: { language: "typescript", label: "TypeScript", kind: "code" },
  tsx: { language: "typescript", label: "TypeScript", kind: "code" },
  txt: { language: "plaintext", label: "Text", kind: "text" },
  wat: { language: "wasm", label: "WebAssembly", kind: "code" },
  xml: { language: "xml", label: "XML", kind: "config" },
  yaml: { language: "yaml", label: "YAML", kind: "config" },
  yml: { language: "yaml", label: "YAML", kind: "config" },
  zsh: { language: "bash", label: "Shell", kind: "code" },
};

const LANGUAGE_BY_FILE_NAME: Record<string, SkillFileLanguage> = {
  ".editorconfig": { language: "ini", label: "EditorConfig", kind: "config" },
  ".gitignore": { language: "plaintext", label: "Git Ignore", kind: "config" },
  ".npmrc": { language: "ini", label: "npm Config", kind: "config" },
  dockerfile: { language: "dockerfile", label: "Dockerfile", kind: "config" },
  gemfile: { language: "ruby", label: "Ruby", kind: "code" },
  makefile: { language: "makefile", label: "Makefile", kind: "config" },
  rakefile: { language: "ruby", label: "Ruby", kind: "code" },
};

const CODE_FENCE_LANGUAGE_ALIASES: Record<string, string> = {
  "c++": "cpp",
  cs: "csharp",
  env: "ini",
  gql: "graphql",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  kt: "kotlin",
  md: "markdown",
  objc: "objectivec",
  plain: "plaintext",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  text: "plaintext",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  yml: "yaml",
  zsh: "bash",
};

const SUPPORTED_HIGHLIGHT_LANGUAGES = new Set([
  ...Object.values(LANGUAGE_BY_EXTENSION).map((item) => item.language),
  ...Object.values(LANGUAGE_BY_FILE_NAME).map((item) => item.language),
]);

export function getSkillFileLanguage(path: string): SkillFileLanguage | null {
  const fileName = path.split("/").pop()?.trim().toLowerCase() ?? "";
  if (!fileName) {
    return null;
  }
  const namedLanguage = LANGUAGE_BY_FILE_NAME[fileName];
  if (namedLanguage) {
    return namedLanguage;
  }
  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return { language: "bash", label: "Environment", kind: "config" };
  }

  const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}

export function normalizeCodeFenceLanguage(value: string) {
  const normalized = value.trim().toLowerCase().replace(/^language-/, "");
  const language = CODE_FENCE_LANGUAGE_ALIASES[normalized] ?? normalized;
  return SUPPORTED_HIGHLIGHT_LANGUAGES.has(language) ? language : "";
}
