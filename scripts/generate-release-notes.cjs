#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const DEFAULT_OUTPUT = "release-notes.md";
const DEFAULT_SUMMARY_OUTPUT = "release-summary.txt";
// Keep updater release notes scannable: all sections combined may contain at most eight bullets.
const MAX_RELEASE_NOTE_ITEMS = 8;
const SECTION_ORDER = ["features", "fixes", "improvements"];
const SECTION_TITLES = {
  features: "新增",
  fixes: "修复",
  improvements: "优化",
};
const SECTION_NAME_MAP = {
  feature: "features",
  features: "features",
  fix: "fixes",
  fixes: "fixes",
  improvement: "improvements",
  improvements: "improvements",
  新增: "features",
  修复: "fixes",
  优化: "improvements",
};
const RELEASE_NOTE_COVERAGE_RULES = [
  {
    id: "workspace",
    label: "工作区与目录迁移",
    pathPatterns: [
      /^src-tauri\/src\/(?:workspace|backup_snapshot)\.rs$/,
      /^src\/app\/(?:path-utils\.ts|routes\/settings\.tsx)$/,
    ],
    notePattern: /工作区|目录|路径|迁移/i,
  },
  {
    id: "backup",
    label: "云端备份",
    pathPatterns: [
      /^src-tauri\/src\/backup_(?:repository|merge)\.rs$/,
    ],
    notePattern: /备份|恢复|云端/i,
  },
  {
    id: "mcp",
    label: "MCP 管理",
    pathPatterns: [
      /^src-tauri\/src\/mcp_manager\.rs$/,
      /^src\/app\/routes\/mcp\.tsx$/,
      /^src\/features\/install\/components\/McpMarketplacePanel\.tsx$/,
      /^src\/features\/skills\/utils\/mcp-workspace-cache\.ts$/,
    ],
    notePattern: /MCP/i,
  },
  {
    id: "plugins",
    label: "插件管理与宿主运行时",
    pathPatterns: [
      /^src-tauri\/src\/plugin_(?:manager|watcher)\.rs$/,
      /^src\/app\/routes\/plugins\.tsx$/,
      /^src\/features\/install\/components\/PluginInstallPanel\.tsx$/,
      /^src\/features\/skills\/utils\/plugin-cache\.ts$/,
    ],
    notePattern: /插件|plugin|Cursor|Codex|Claude Code|OpenCode/i,
  },
  {
    id: "git-workflow",
    label: "Git 状态与差异工作流",
    pathPatterns: [
      /^src-tauri\/src\/git_(?:state|changes|divergence|metadata)\.rs$/,
      /^src-tauri\/src\/skill_watcher\.rs$/,
      /^src\/features\/skills\/components\/(?:GitPreviewIcons|SkillDiffView|SkillFileDialog)\.tsx$/,
    ],
    notePattern: /Git|差异|待提交|待推送|回退/i,
  },
  {
    id: "publishing",
    label: "Skill 发布",
    pathPatterns: [
      /^src\/features\/publishing\//,
      /^src-tauri\/src\/(?:publishing_|github_(?:api|credentials)\.rs$)/,
    ],
    addedPathPatterns: [],
    notePattern: /发布|SkillHub/i,
  },
  {
    id: "app-update",
    label: "应用更新提示",
    pathPatterns: [
      /^src\/features\/app-update\//,
    ],
    addedPathPatterns: [],
    notePattern: /应用更新|版本更新|更新提示/i,
  },
  {
    id: "skills",
    label: "Skill 管理",
    pathPatterns: [
      /^src-tauri\/src\/(?:agent_skills_cli|clawhub_market|commands|library|models|skillhub_market|state)\.rs$/,
      /^src\/app\/routes\/skills\.tsx$/,
      /^src\/features\/skills\//,
    ],
    addedPathPatterns: [
      /^src\/features\/skills\/utils\/skill-tag-color\.ts$/,
      /^src\/features\/skills\/utils\/skill-tag-filter\.ts$/,
    ],
    notePattern: /\bSkill\b|技能/i,
  },
  {
    id: "interface",
    label: "界面与交互",
    pathPatterns: [
      /^src-tauri\/src\/lib\.rs$/,
      /^src\/app\/(?:App\.tsx|components\/AppSelect\.tsx)$/,
      /^src\/app\/hooks\/useStableListOrder\.ts$/,
      /^src\/app\/routes\/market\.tsx$/,
      /^src\/app\/i18n\.tsx$/,
      /^src\/styles\//,
    ],
    addedPathPatterns: [
      /^src-tauri\/src\/lib\.rs$/,
      /^src\/app\/i18n\.tsx$/,
    ],
    notePattern: /界面|交互|弹窗|提示|角标/i,
  },
];
const PRODUCTION_CODE_PATH_PATTERNS = [
  /^src-tauri\/src\/.*\.rs$/,
  /^src\/.*\.(?:ts|tsx|css)$/,
];
const NON_PRODUCTION_CODE_PATH_PATTERNS = [
  /^src\/tests\//,
];
const SKIPPED_SUBJECT_PATTERNS = [
  /^fix$/i,
  /^[a-z]+:\[release-[^\]]+\]/i,
  /^chore:\s*bump version/i,
  /^chore:\s*发布\s+/,
  /^chore:\s*调整本地发布私钥路径/,
  /^chore:\s*优化发布密钥校验流程/,
  /^chore:\s*同步 Cargo\.lock 版本/i,
];
const SKIPPED_COMMIT_PATTERNS = [
  /(发布说明|发布日志).*(分类规则|用户视角文案)/i,
  /(TypeScript 校验|测试类型|mock 参数断言|前置校验)/i,
  /(npm run build|本地发布脚本).*(通过|校验)/i,
];
const SKIPPED_ITEM_PATTERNS = [
  /(测试|测试覆盖|断言|mock|验证|校验)/i,
  /(Rust|前端验证|fallback 逻辑)/i,
];
const NON_USER_FACING_TYPES = new Set(["chore", "docs", "test"]);
const FEATURE_DEVELOPMENT_FIX_PATTERN = /(?:修复|解决|避免).*(?:问题|异常|丢失|覆盖|崩溃|报错|错误|失败)|(?:问题|异常|丢失|覆盖|崩溃|报错|错误|失败).*(?:修复|解决|避免)/i;
const USER_FACING_PRODUCT_PATTERN = /SkillHub|ClawHub|ZCode|OpenCode|Claude Code|Codex|Cursor|Gemini CLI/i;
const COMMIT_HIGHLIGHT_RULES = [
  {
    pattern: /skillhub.*(?:发布|工作台)|(?:发布|工作台).*skillhub/i,
    section: "features",
    text: "新增 SkillHub 发布功能，支持 Token 连接、SkillDock 与 Agent CLI 托管 Skill 发布、状态缓存、版本差异预览和逐块回滚",
  },
  {
    pattern: /zcode.*(?:skill|mcp)|(?:skill|mcp).*zcode/i,
    section: "features",
    text: "新增 ZCode 工具支持，可管理 ZCode Skills 和 MCP",
  },
  {
    pattern: /opencode.*(?:插件|plugin)|(?:插件|plugin).*opencode/i,
    section: "features",
    text: "新增 OpenCode 插件管理，支持仓库探测，并优先通过 SkillDock 托管目录软连接完成安装、启停、更新、删除和便携恢复",
  },
  {
    pattern: /opencode.*mcp.*(?:启停|兼容|配置)|(?:启停|兼容|配置).*opencode.*mcp/i,
    section: "fixes",
    text: "完善 OpenCode MCP 启停和 JSON/JSONC 配置兼容，保留注释及原生字段，并避免误删同名配置",
  },
];
const COMMIT_HIGHLIGHT_PRIORITY = new Map(
  COMMIT_HIGHLIGHT_RULES.map((rule, index) => [rule.text, index]),
);
const USER_FACING_REWRITE_RULES = [
  {
    pattern: /(mcp).*(support matrix|支持矩阵|支持信息|适配状态)/i,
    section: "features",
    text: "新增更多 MCP 支持信息展示",
  },
  {
    pattern: /toolbar.*go[- ]?install|工具栏.*去安装|go-install shortcut/i,
    section: "features",
    text: "技能、插件和 MCP 管理页工具栏新增「去安装」快捷入口",
  },
  {
    pattern: /(skill).*(商店搜索|搜索).*(提前切换|页面切换|保持当前列表|不切换)/i,
    section: "fixes",
    text: "修复 skill 商店搜索中页面提前切换的问题",
  },
  {
    pattern: /(skill).*(商店搜索|搜索).*(mcp 商店一致|旧列表|占位|正在搜索可安装技能)/i,
    section: "fixes",
    text: "修复 skill 商店搜索中页面提前切换的问题",
  },
  {
    pattern: /(默认编辑器).*(实际打开|打开行为|MCP 配置打开|同步到实际打开)/i,
    section: "fixes",
    text: "修复首次安装默认编辑器未同步到实际打开行为",
  },
  {
    pattern: /(默认编辑器).*(优先级|直开支持|finder|系统默认文本编辑器|workspace)/i,
    section: "fixes",
    text: "修复首次安装默认编辑器未同步到实际打开行为",
  },
  {
    pattern: /(mcp).*(导入|import).*(reprobe|probe|探测|状态|队列|跳过|重试|结果不完整)/i,
    section: "fixes",
    text: "修复了 MCP 导入后偶尔状态异常、结果不完整的问题",
  },
  {
    pattern: /(mcp).*(tools\/list|tool probing|tool|tools|分页|加载|显示不全|显示部分|多 tools)/i,
    section: "fixes",
    text: "修复了 MCP 工具加载不稳定、部分工具显示不全的问题",
  },
  {
    pattern: /(失败反馈|失败提示|反馈入口|尾部场景|异常场景)/i,
    section: "fixes",
    text: "修复了失败提示不够统一、部分异常场景反馈不明显的问题",
  },
  {
    pattern: /(分组切换|可访问性|辅助功能)/i,
    section: "fixes",
    text: "修复了分组切换的辅助功能问题",
  },
  {
    pattern: /(本地 skill|local skill).*(残留|回滚|失败)/i,
    section: "fixes",
    text: "修复了本地 Skill 导入失败后可能留下残留内容的问题",
  },
  {
    pattern: /(本地 skill|local skill).*(替换|兼容|现有工具目录)/i,
    section: "fixes",
    text: "修复了本地 Skill 替换导入时的兼容性问题",
  },
  {
    pattern: /(mcp).*(导入通知|新增数量)/i,
    section: "improvements",
    text: "优化了导入完成后的提示信息，更容易看懂新增了什么",
  },
  {
    pattern: /(mcp).*(刷新|导入|import progress|reprobe|probe)/i,
    section: "improvements",
    text: "优化了 MCP 导入和刷新流程，整体体验更稳定",
  },
  {
    pattern: /(mcp).*(分页|列表|显示不完整|多 tools 服务)/i,
    section: "improvements",
    text: "优化了 MCP 工具列表的加载方式，避免内容过多时显示不完整",
  },
  {
    pattern: /(限制 mcp 和 skill 列表一次只展开一个|一次只展开一个|展开交互)/i,
    section: "improvements",
    text: "优化了 MCP 和 Skill 列表的展开交互，界面更清爽",
  },
  {
    pattern: /(发布构建|本地发布构建|release build)/i,
    section: "improvements",
    text: "优化了发布流程，减少发版时的等待时间",
  },
  {
    pattern: /(首次安装|默认语言).*(ip|locale|系统语言|系统 locale|地理位置)/i,
    section: "improvements",
    text: "默认语言为选择由 IP 改为识别系统语言规则",
  },
  {
    pattern: /(zh\*|简体中文|其余 locale 默认使用英文)/i,
    section: "improvements",
    text: "默认语言为选择由 IP 改为识别系统语言规则",
  },
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = value;
    i += 1;
  }

  return args;
}

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.ignoreError ? "ignore" : "pipe"],
  }).trim();
}

function tryGit(args) {
  try {
    return runGit(args, { ignoreError: true });
  } catch (_error) {
    return "";
  }
}

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  return packageJson.version;
}

function readVersionTags() {
  return tryGit(["tag", "--sort=version:refname"])
    .split("\n")
    .map((item) => item.trim())
    .filter(isPublicVersionTag);
}

function isPublicVersionTag(tag) {
  return /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag);
}

function tagExists(tag) {
  return tryGit(["rev-parse", "--verify", "--quiet", tag]) !== "";
}

function resolveCurrentRef(tag) {
  return tagExists(tag) ? tag : "HEAD";
}

function resolvePreviousTag(tag, currentRef) {
  if (tagExists(tag)) {
    const previous = tryGit(["describe", "--tags", "--match", "v[0-9]*", "--abbrev=0", `${tag}^`]);
    if (isPublicVersionTag(previous)) {
      return previous;
    }
  }

  const tags = tryGit(["tag", "--sort=-version:refname", "--merged", currentRef])
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter(isPublicVersionTag)
    .filter((item) => item !== tag);

  return tags[0] || "";
}

function versionFromTag(tag) {
  return tag.replace(/^v/i, "");
}

function resolveRefDate(ref) {
  return tryGit(["log", "-1", "--format=%cI", ref]);
}

function normalizeSubject(subject) {
  const match = subject.match(/^[a-z]+(?:\([^)]+\))?!?:\s*(.+)$/i);
  return (match ? match[1] : subject).trim();
}

function commitType(subject) {
  const match = subject.match(/^([a-z]+)(?:\([^)]+\))?!?:/i);
  return match ? match[1].toLowerCase() : "";
}

function bodyBullets(body) {
  return body
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function shouldSkipSubject(subject) {
  return SKIPPED_SUBJECT_PATTERNS.some((pattern) => pattern.test(subject));
}

function shouldSkipCommit(commit, type) {
  if (shouldSkipSubject(commit.subject)) {
    return true;
  }

  if (NON_USER_FACING_TYPES.has(type)) {
    return true;
  }

  const combined = `${normalizeSubject(commit.subject)}\n${commit.body}`.trim();
  return SKIPPED_COMMIT_PATTERNS.some((pattern) => pattern.test(combined));
}

function rewriteCommitHighlight(commit) {
  const text = `${normalizeSubject(commit.subject)}\n${commit.body}`.trim();
  const rule = COMMIT_HIGHLIGHT_RULES.find((item) => item.pattern.test(text));
  return rule ? { section: rule.section, text: rule.text } : null;
}

function classify(text, type) {
  if (/^优化/.test(text)) {
    return "improvements";
  }

  if (type === "feat" || /新增|增加|支持|接入|添加|上线/.test(text)) {
    return "features";
  }

  if (type === "fix" || /修复|兼容|避免|空白|失败|错误|问题/.test(text)) {
    return "fixes";
  }

  return "improvements";
}

function cleanBullet(text) {
  return text
    .replace(/[。.]?$/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/^(?:新增|增加)[:：]?\s*/, "")
    .replace(/^修复[:：]?\s*/, "")
    .replace(/^优化[:：]?\s*/, "")
    .trim();
}

function resolveSectionName(text) {
  const normalized = text.trim().toLowerCase();
  return SECTION_NAME_MAP[normalized] || SECTION_NAME_MAP[text.trim()] || "";
}

function shouldSkipItem(text) {
  return SKIPPED_ITEM_PATTERNS.some((pattern) => pattern.test(text));
}

function explicitReleaseNoteHeading(text) {
  return /^(发布说明|发布日志|release notes?|user-facing notes?)$/i.test(text.trim());
}

function parseExplicitReleaseNoteLine(text, fallbackSection = "") {
  const normalized = text.trim();
  const match = normalized.match(/^(新增|修复|优化|feature|features|fix|fixes|improvement|improvements)\s*[:：]\s*(.+)$/i);
  if (!match) {
    return null;
  }

  const section = resolveSectionName(match[1]);
  const itemText = cleanBullet(match[2]);
  if (!section || !itemText) {
    return null;
  }

  return {
    section,
    text: itemText,
  };
}

function extractExplicitReleaseNotes(body) {
  const items = [];
  const lines = body.replace(/\\n/g, "\n").split(/\r?\n/).map((line) => line.trim());
  let inReleaseNotesBlock = false;
  let currentSection = "";

  for (const line of lines) {
    if (!line) {
      continue;
    }

    const headingText = line.replace(/^#{1,6}\s*/, "").trim();
    if (explicitReleaseNoteHeading(headingText)) {
      inReleaseNotesBlock = true;
      currentSection = "";
      continue;
    }

    const directItem = parseExplicitReleaseNoteLine(line.replace(/^[-*]\s*/, ""));
    if (directItem) {
      items.push(directItem);
      continue;
    }

    if (!inReleaseNotesBlock) {
      continue;
    }

    const sectionFromHeading = resolveSectionName(headingText);
    if (sectionFromHeading) {
      currentSection = sectionFromHeading;
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch && currentSection) {
      items.push({
        section: currentSection,
        text: cleanBullet(bulletMatch[1]),
      });
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      inReleaseNotesBlock = false;
      currentSection = "";
    }
  }

  return items.filter((item) => item.text);
}

function rewriteUserFacing(text, type) {
  const section = classify(text.trim(), type);
  const cleaned = cleanBullet(text);
  if (!cleaned || shouldSkipItem(cleaned)) {
    return null;
  }

  for (const rule of USER_FACING_REWRITE_RULES) {
    if (rule.pattern.test(cleaned)) {
      return {
        section: rule.section,
        text: rule.text,
      };
    }
  }

  const asciiHeavy = /[A-Za-z]{4,}|\/|_/i.test(cleaned);
  if (asciiHeavy && !USER_FACING_PRODUCT_PATTERN.test(cleaned)) {
    return {
      section,
      text:
        section === "features"
          ? "新增了更多可用能力"
          : section === "fixes"
          ? "修复了一些影响使用体验和稳定性的问题"
          : "优化了部分使用体验和稳定性",
    };
  }

  if (section === "features") {
    return {
      section,
      text: /^新增/.test(cleaned) ? cleaned : `新增${cleaned}`,
    };
  }

  if (section === "fixes") {
    return {
      section,
      text: /^修复了/.test(cleaned) ? cleaned : `修复了${cleaned}的问题`,
    };
  }

  return {
    section,
    text: /^优化了/.test(cleaned) ? cleaned : `优化了${cleaned}`,
  };
}

function uniquePush(list, value) {
  if (!value || list.includes(value)) {
    return;
  }
  list.push(value);
}

function parseCommits(range) {
  const output = tryGit([
    "log",
    "--no-merges",
    "--format=%H%x1f%s%x1f%b%x1e",
    range,
  ]);

  if (!output) {
    return [];
  }

  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, subject, body = ""] = record.split("\x1f");
      return { hash, subject, body };
    });
}

function buildSections(commits) {
  const sections = {
    features: [],
    fixes: [],
    improvements: [],
  };

  for (const commit of commits) {
    const type = commitType(commit.subject);
    const explicitItems = extractExplicitReleaseNotes(commit.body);
    if (explicitItems.length > 0) {
      for (const item of explicitItems) {
        uniquePush(sections[item.section], item.text);
      }
      continue;
    }

    if (shouldSkipCommit(commit, type)) {
      continue;
    }

    const highlight = rewriteCommitHighlight(commit);
    if (highlight) {
      uniquePush(sections[highlight.section], highlight.text);
      continue;
    }

    const bullets = bodyBullets(commit.body);
    const items = bullets.length > 0 ? bullets : [normalizeSubject(commit.subject)];
    let addedItem = false;

    for (const item of items) {
      // A feature commit describes the final shipped capability. Defects found while building it
      // are implementation history and must not be presented as fixes to an earlier release.
      if (type === "feat" && FEATURE_DEVELOPMENT_FIX_PATTERN.test(item)) {
        continue;
      }

      const rewritten = rewriteUserFacing(item, type);
      if (!rewritten) {
        continue;
      }
      uniquePush(sections[rewritten.section], rewritten.text);
      addedItem = true;
    }

    if (!addedItem && bullets.length > 0) {
      const rewrittenSubject = rewriteUserFacing(normalizeSubject(commit.subject), type);
      if (rewrittenSubject) {
        uniquePush(sections[rewrittenSubject.section], rewrittenSubject.text);
      }
    }
  }

  for (const key of SECTION_ORDER) {
    sections[key].sort((left, right) => (
      (COMMIT_HIGHLIGHT_PRIORITY.get(left) ?? COMMIT_HIGHLIGHT_RULES.length)
        - (COMMIT_HIGHLIGHT_PRIORITY.get(right) ?? COMMIT_HIGHLIGHT_RULES.length)
    ));
  }

  return sections;
}

function limitSections(sections, maxItems = MAX_RELEASE_NOTE_ITEMS) {
  const limitedSections = Object.fromEntries(SECTION_ORDER.map((key) => [key, []]));
  let itemIndex = 0;
  let itemCount = 0;

  while (itemCount < maxItems) {
    let addedItem = false;
    for (const key of SECTION_ORDER) {
      const item = sections[key][itemIndex];
      if (!item) {
        continue;
      }

      limitedSections[key].push(item);
      itemCount += 1;
      addedItem = true;
      if (itemCount === maxItems) {
        break;
      }
    }

    if (!addedItem) {
      break;
    }
    itemIndex += 1;
  }

  return limitedSections;
}

function countReleaseNoteItems(notes) {
  return notes.split(/\r?\n/).filter((line) => /^[-*]\s+/.test(line.trim())).length;
}

function detectChangedAreas(paths) {
  return RELEASE_NOTE_COVERAGE_RULES.filter((rule) => (
    paths.some((path) => rule.pathPatterns.some((pattern) => pattern.test(path)))
  ));
}

function findUnclassifiedProductionPaths(paths, addedPaths = []) {
  const addedPathSet = new Set(addedPaths);
  return paths.filter((path) => {
    const isProductionCode = PRODUCTION_CODE_PATH_PATTERNS.some((pattern) => pattern.test(path));
    const isExcluded = NON_PRODUCTION_CODE_PATH_PATTERNS.some((pattern) => pattern.test(path));
    const isClassified = RELEASE_NOTE_COVERAGE_RULES.some((rule) => (
      (addedPathSet.has(path) ? rule.addedPathPatterns ?? rule.pathPatterns : rule.pathPatterns)
        .some((pattern) => pattern.test(path))
    ));
    return isProductionCode && !isExcluded && !isClassified;
  });
}

function parseCuratedReleaseNotes(notes) {
  const sections = Object.fromEntries(SECTION_ORDER.map((key) => [key, []]));
  const items = [];
  const unclassifiedItems = [];
  let currentSection = "";

  for (const rawLine of notes.split(/\r?\n/)) {
    const line = rawLine.trim();
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      currentSection = resolveSectionName(headingMatch[1]);
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (!bulletMatch) {
      continue;
    }

    const item = cleanBullet(bulletMatch[1]);
    if (currentSection) {
      uniquePush(sections[currentSection], item);
      items.push(item);
    } else {
      unclassifiedItems.push(item);
    }
  }

  return { sections, items, unclassifiedItems };
}

function validateCuratedReleaseNotes(notes, changedAreas, unclassifiedPaths = []) {
  const parsed = parseCuratedReleaseNotes(notes);
  const itemCount = parsed.items.length + parsed.unclassifiedItems.length;
  if (itemCount === 0) {
    throw new Error("手写发布日志必须至少包含一条分点说明");
  }
  if (itemCount > MAX_RELEASE_NOTE_ITEMS) {
    throw new Error(`手写发布日志最多包含 ${MAX_RELEASE_NOTE_ITEMS} 条，当前为 ${itemCount} 条`);
  }
  if (parsed.unclassifiedItems.length > 0) {
    throw new Error("手写发布日志包含未归入新增、修复或优化章节的条目");
  }
  if (unclassifiedPaths.length > 0) {
    throw new Error(
      `版本差异包含未归类的生产代码，请更新发布日志领域规则：${unclassifiedPaths.join("、")}`,
    );
  }
  const releaseNoteText = parsed.items.join("\n");
  const missingAreas = changedAreas.filter((area) => !area.notePattern.test(releaseNoteText));
  if (missingAreas.length > 0) {
    throw new Error(
      `手写发布日志未覆盖完整版本差异：${missingAreas.map((area) => area.label).join("、")}`,
    );
  }

  return parsed.sections;
}

function readChangedFiles(range) {
  const paths = [];
  const addedPaths = [];
  const output = runGit(["diff", "--name-status", range]);

  for (const line of output.split("\n").filter(Boolean)) {
    const [status, ...statusPaths] = line.split("\t");
    const path = statusPaths.at(-1)?.trim();
    if (!path) {
      continue;
    }
    paths.push(path);
    if (/^[AC]/.test(status)) {
      addedPaths.push(path);
    }
  }

  return { paths, addedPaths };
}

function renderNotes(sections) {
  const chunks = [];

  for (const key of SECTION_ORDER) {
    const items = sections[key];
    if (items.length === 0) {
      continue;
    }

    chunks.push(`## ${SECTION_TITLES[key]}`);
    chunks.push("");
    for (const item of items) {
      chunks.push(`- ${item}。`);
    }
    chunks.push("");
  }

  if (chunks.length === 0) {
    return "## 优化\n\n- 常规维护与稳定性改进。\n";
  }

  return `${chunks.join("\n").trim()}\n`;
}

function compactSummaryItem(text, section) {
  let compact = text.trim();

  if (section === "features") {
    compact = compact.replace(/^新增了?/, "");
  } else if (section === "fixes") {
    compact = compact.replace(/^修复了/, "");
    compact = compact.replace(/的问题$/, "");
  } else {
    compact = compact.replace(/^优化了/, "");
  }

  return compact.trim();
}

function renderSummary(sections) {
  const summaryItems = [];

  if (sections.features.length > 0) {
    summaryItems.push(
      `新增 ${sections.features.slice(0, 2).map((item) => compactSummaryItem(item, "features")).join("、")}`,
    );
  }

  if (sections.fixes.length > 0) {
    summaryItems.push(
      `修复 ${sections.fixes.slice(0, 2).map((item) => compactSummaryItem(item, "fixes")).join("、")}`,
    );
  }

  if (sections.improvements.length > 0) {
    summaryItems.push(
      `优化 ${sections.improvements
        .slice(0, 2)
        .map((item) => compactSummaryItem(item, "improvements"))
        .join("、")}`,
    );
  }

  if (summaryItems.length === 0) {
    return "常规维护与稳定性改进。";
  }

  return `${summaryItems.join("；")}。`;
}

function buildReleaseArtifact(version, currentRef, previousTag, curatedNotes = "") {
  const range = previousTag ? `${previousTag}..${currentRef}` : currentRef;
  const commits = parseCommits(range);
  if (curatedNotes) {
    const changedFiles = readChangedFiles(range);
    const changedAreas = detectChangedAreas(changedFiles.paths);
    const unclassifiedPaths = findUnclassifiedProductionPaths(
      changedFiles.paths,
      changedFiles.addedPaths,
    );
    const sections = validateCuratedReleaseNotes(
      curatedNotes,
      changedAreas,
      unclassifiedPaths,
    );

    return {
      version,
      range,
      pub_date: resolveRefDate(currentRef) || undefined,
      body: `${curatedNotes.trim()}\n`,
      summary: renderSummary(sections),
      changedAreas,
    };
  }

  const sections = limitSections(buildSections(commits));

  return {
    version,
    range,
    pub_date: resolveRefDate(currentRef) || undefined,
    body: renderNotes(sections),
    summary: renderSummary(sections),
    changedAreas: [],
  };
}

function applyArchivedReleaseNotes(artifact, tag) {
  const archivedNotesPath = `docs/release/notes/${tag}.md`;
  if (!fs.existsSync(archivedNotesPath)) {
    return artifact;
  }

  const archivedNotes = fs.readFileSync(archivedNotesPath, "utf8");
  const sections = parseCuratedReleaseNotes(archivedNotes).sections;
  return {
    ...artifact,
    body: `${archivedNotes.trim()}\n`,
    summary: renderSummary(sections),
  };
}

function buildReleaseHistory(currentVersion, currentTag, currentArtifact) {
  const tags = readVersionTags();
  if (!tags.includes(currentTag)) {
    tags.push(currentTag);
  }

  return tags
    .map((tag, index) => {
      if (tag === currentTag && currentArtifact) {
        return currentArtifact;
      }

      const currentRef = tag === currentTag ? resolveCurrentRef(currentTag) : tag;
      const previousTag = index > 0 ? tags[index - 1] : "";
      const version = tag === currentTag ? currentVersion : versionFromTag(tag);
      return applyArchivedReleaseNotes(
        buildReleaseArtifact(version, currentRef, previousTag),
        tag,
      );
    })
    .reverse()
    .map(({ range, changedAreas, ...artifact }) => artifact);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version || readPackageVersion();
  const tag = args.tag || `v${version}`;
  const output = args.output || DEFAULT_OUTPUT;
  const summaryOutput = args["summary-output"] || DEFAULT_SUMMARY_OUTPUT;
  const historyOutput = args["history-output"] || "";
  const curatedNotesPath = args["curated-notes"] || "";
  const currentRef = args["current-ref"] || resolveCurrentRef(tag);
  const previousTag = args["previous-tag"] || resolvePreviousTag(tag, currentRef);
  const curatedNotes = curatedNotesPath ? fs.readFileSync(curatedNotesPath, "utf8") : "";
  const artifact = buildReleaseArtifact(version, currentRef, previousTag, curatedNotes);

  fs.writeFileSync(output, artifact.body);
  fs.writeFileSync(summaryOutput, `${artifact.summary}\n`);

  if (historyOutput) {
    const history = buildReleaseHistory(version, tag, artifact);
    fs.writeFileSync(historyOutput, `${JSON.stringify(history, null, 2)}\n`);
  }

  console.log(`Generated release notes for ${tag}`);
  console.log(`Range: ${artifact.range}`);
  console.log(`Output: ${output}`);
  console.log(`Summary: ${summaryOutput}`);
  if (curatedNotesPath) {
    console.log(`Curated notes: ${curatedNotesPath}`);
    console.log(`Diff coverage: ${artifact.changedAreas.map((area) => area.id).join(", ") || "none"}`);
  }
  if (historyOutput) {
    console.log(`History: ${historyOutput}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  MAX_RELEASE_NOTE_ITEMS,
  buildSections,
  countReleaseNoteItems,
  detectChangedAreas,
  findUnclassifiedProductionPaths,
  isPublicVersionTag,
  limitSections,
  validateCuratedReleaseNotes,
};
