import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const publicDir = path.join(repoRoot, "public", "tool-logos");
const manifestPath = path.join(repoRoot, "src", "features", "skills", "utils", "tool-logo-manifest.json");

const TOOL_SOURCES = [
  {
    id: "claude-code",
    homepage: "https://claude.com/product/claude-code",
    keepExistingFileName: "claude-code.png",
  },
  { id: "codex", homepage: "https://openai.com/codex/" },
  {
    id: "zcode",
    homepage: "https://zcode.z.ai/cn",
    preferredAssetUrl: "https://zcode.z.ai/favicon-192x192.png?v=20260707-transparent",
  },
  {
    id: "workbuddy",
    homepage: "https://www.workbuddy.ai/",
    keepExistingFileName: "workbuddy.svg",
  },
  { id: "opencode", homepage: "https://opencode.ai/" },
  { id: "cursor", homepage: "https://cursor.com/" },
  { id: "gemini", homepage: "https://gemini.google.com/" },
  { id: "antigravity", homepage: "https://antigravity.google/" },
  {
    id: "windsurf",
    homepage: "https://devin.ai/desktop/",
    preferredAssetUrl: "https://windsurf.com/favicon.ico",
    keepExistingFileName: "devin.png",
  },
  {
    id: "intellij",
    homepage: "https://www.jetbrains.com/idea/",
    keepExistingFileName: "intellij.svg",
  },
  { id: "openclaw", homepage: "https://openclaw.ai/" },
  { id: "continue", homepage: "https://www.continue.dev/" },
  { id: "iflow", homepage: "https://iflowai.com/" },
  { id: "codebuddy", homepage: "https://www.codebuddy.ai/" },
  {
    id: "trae",
    homepage: "https://www.trae.ai/",
    preferredAssetUrl: "https://lf16-web-neutral.traecdn.ai/obj/trae-ai-static/trae_website/favicon.png",
  },
  { id: "droid", homepage: "https://docs.factory.ai/cli/getting-started/overview" },
  { id: "augment", homepage: "https://www.augmentcode.com/" },
  { id: "cline", homepage: "https://cline.bot/" },
  { id: "commandcode", homepage: "https://commandcode.ai/" },
  { id: "crush", homepage: "https://charm.land/" },
  { id: "goose", homepage: "https://goose-docs.ai/" },
  { id: "junie", homepage: "https://junie.jetbrains.com/" },
  { id: "kilo-code", homepage: "https://kilocode.ai/" },
  { id: "kiro", homepage: "https://kiro.dev/" },
  { id: "qoder", homepage: "https://qoder.com/" },
  { id: "qwen-code", homepage: "https://qwen.ai/qwencode" },
  {
    id: "roo-code",
    homepage: "https://docs.roocode.com/",
    preferredAssetUrl: "https://roocodeinc.github.io/Roo-Code/img/favicon.ico",
  },
  { id: "zencoder", homepage: "https://zencoder.ai/" },
  {
    id: "trae-cn",
    homepage: "https://www.trae.cn/",
    preferredAssetUrl: "https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae_website_prod_cn/favicon.png",
  },
  {
    id: "hermes",
    homepage: "https://hermes-agent.nousresearch.com/",
    preferredAssetUrl: "https://hermes-agent.nousresearch.com/icon.png?icon.17972d59.png",
  },
  {
    id: "github-copilot",
    homepage: "https://github.com/features/copilot",
    keepExistingFileName: "github-copilot.svg",
  },
];

const OUTPUT_EXTENSIONS = [".svg", ".png", ".ico", ".jpg", ".jpeg", ".webp"];
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function parseAttributes(tag) {
  const attributes = {};
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = attributePattern.exec(tag))) {
    const [, rawName, doubleQuoted, singleQuoted, bareValue] = match;
    const name = rawName.toLowerCase();
    if (name === "link" || name === "meta") {
      continue;
    }
    const value = doubleQuoted ?? singleQuoted ?? bareValue ?? "";
    attributes[name] = decodeHtmlEntities(value.trim());
  }
  return attributes;
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function looksLikeHtml(buffer) {
  const sample = buffer.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  return sample.startsWith("<!doctype html") || sample.startsWith("<html") || sample.startsWith("<head");
}

function normalizeUrl(candidate, baseUrl) {
  if (!candidate || candidate.startsWith("data:")) {
    return null;
  }
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return null;
  }
}

function sizeScore(sizes) {
  if (!sizes) {
    return 0;
  }
  const normalized = sizes.toLowerCase();
  if (normalized.includes("any")) {
    return 18;
  }
  const values = normalized
    .split(/\s+/)
    .map((value) => value.split("x").map(Number))
    .filter((pair) => pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
    .map(([width, height]) => Math.max(width, height));
  if (values.length === 0) {
    return 0;
  }
  const maxSize = Math.max(...values);
  if (maxSize >= 512) {
    return 32;
  }
  if (maxSize >= 256) {
    return 26;
  }
  if (maxSize >= 128) {
    return 20;
  }
  if (maxSize >= 64) {
    return 14;
  }
  if (maxSize >= 32) {
    return 8;
  }
  return 2;
}

function iconScore(candidate) {
  let score = candidate.kind === "fallback" ? 5 : 0;
  if (candidate.rel.includes("apple-touch-icon")) {
    score += 44;
  }
  if (candidate.rel.includes("mask-icon")) {
    score += 22;
  }
  if (candidate.rel.includes("icon")) {
    score += 38;
  }
  if (candidate.rel.includes("manifest")) {
    score += 26;
  }
  if (candidate.kind === "meta-image") {
    score += 8;
  }
  if (candidate.kind === "preload-image") {
    score += 14;
  }
  if (candidate.type.includes("svg") || candidate.url.endsWith(".svg")) {
    score += 28;
  }
  if (candidate.url.toLowerCase().includes("logo")) {
    score += 12;
  }
  if (candidate.url.includes("apple-touch-icon")) {
    score += 12;
  }
  if (candidate.url.includes("favicon")) {
    score += 6;
  }
  score += sizeScore(candidate.sizes);
  return score;
}

function extractIconCandidates(html, pageUrl) {
  const candidates = [];
  const seenUrls = new Set();

  const pushCandidate = (candidate) => {
    if (!candidate?.url || seenUrls.has(candidate.url)) {
      return;
    }
    seenUrls.add(candidate.url);
    candidates.push({
      ...candidate,
      score: iconScore(candidate),
    });
  };

  const linkPattern = /<link\b[^>]*>/gi;
  let linkMatch;
  while ((linkMatch = linkPattern.exec(html))) {
    const tag = linkMatch[0];
    const attributes = parseAttributes(tag);
    const rel = (attributes.rel ?? "").toLowerCase();
    const href = normalizeUrl(attributes.href, pageUrl);
    if (!href) {
      continue;
    }
    if (rel.includes("icon")) {
      pushCandidate({
        kind: "icon",
        rel,
        type: (attributes.type ?? "").toLowerCase(),
        sizes: attributes.sizes ?? "",
        url: href,
      });
      continue;
    }
    if (rel.includes("manifest")) {
      pushCandidate({
        kind: "manifest",
        rel,
        type: (attributes.type ?? "").toLowerCase(),
        sizes: attributes.sizes ?? "",
        url: href,
      });
    }
    if (
      rel.includes("preload")
      && (attributes.as ?? "").toLowerCase() === "image"
      && /logo|icon|brand|mark/i.test(href)
    ) {
      pushCandidate({
        kind: "preload-image",
        rel,
        type: (attributes.type ?? "").toLowerCase(),
        sizes: attributes.imagesizes ?? attributes.sizes ?? "",
        url: href,
      });
    }
  }

  const metaPattern = /<meta\b[^>]*>/gi;
  let metaMatch;
  while ((metaMatch = metaPattern.exec(html))) {
    const tag = metaMatch[0];
    const attributes = parseAttributes(tag);
    const key = `${attributes.property ?? attributes.name ?? ""}`.toLowerCase();
    const content = normalizeUrl(attributes.content, pageUrl);
    if (!content) {
      continue;
    }
    if (key === "og:image" || key === "twitter:image") {
      pushCandidate({
        kind: "meta-image",
        rel: key,
        type: "",
        sizes: "",
        url: content,
      });
    }
  }

  pushCandidate({
    kind: "fallback",
    rel: "fallback",
    type: "",
    sizes: "",
    url: new URL("/favicon.ico", pageUrl).toString(),
  });

  return candidates.sort((left, right) => right.score - left.score);
}

function extensionFromContentType(contentType) {
  const normalized = (contentType ?? "").toLowerCase().split(";")[0].trim();
  switch (normalized) {
    case "image/svg+xml":
      return ".svg";
    case "image/png":
      return ".png";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
    case "image/ico":
      return ".ico";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    default:
      return null;
  }
}

function extensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    for (const extension of OUTPUT_EXTENSIONS) {
      if (pathname.endsWith(extension)) {
        return extension;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.text();
}

async function fetchManifestIcons(manifestUrl) {
  const response = await fetch(manifestUrl, {
    redirect: "follow",
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/manifest+json,application/json,text/plain;q=0.8,*/*;q=0.6",
    },
  });
  if (!response.ok) {
    return [];
  }
  const rawManifest = await response.text();
  let manifest;
  try {
    manifest = JSON.parse(rawManifest);
  } catch {
    return [];
  }
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  return icons
    .map((icon) => {
      const href = normalizeUrl(icon.src, manifestUrl);
      if (!href) {
        return null;
      }
      return {
        kind: "manifest-icon",
        rel: "manifest icon",
        type: `${icon.type ?? ""}`.toLowerCase(),
        sizes: icon.sizes ?? "",
        url: href,
      };
    })
    .filter(Boolean)
    .sort((left, right) => iconScore(right) - iconScore(left));
}

async function fetchIconAsset(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": USER_AGENT,
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      referer: url,
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await response.arrayBuffer());
  if (looksLikeHtml(bytes)) {
    throw new Error(`Unexpected HTML response for ${url}`);
  }
  const extension = extensionFromContentType(contentType) ?? extensionFromUrl(url);
  if (!extension) {
    throw new Error(`Unsupported content type "${contentType}" for ${url}`);
  }
  return {
    bytes,
    extension,
    contentType,
  };
}

async function writeIcon(id, asset) {
  await fs.mkdir(publicDir, { recursive: true });
  for (const extension of OUTPUT_EXTENSIONS) {
    const existingPath = path.join(publicDir, `${id}${extension}`);
    if (extension !== asset.extension) {
      await fs.rm(existingPath, { force: true });
    }
  }
  const outputPath = path.join(publicDir, `${id}${asset.extension}`);
  await fs.writeFile(outputPath, asset.bytes);
  return path.basename(outputPath);
}

async function refreshToolLogo(tool) {
  if (tool.keepExistingFileName) {
    return {
      fileName: tool.keepExistingFileName,
      sourceUrl: tool.homepage,
      homepage: tool.homepage,
      contentType: "image/svg+xml",
    };
  }

  if (tool.preferredAssetUrl) {
    const asset = await fetchIconAsset(tool.preferredAssetUrl);
    const fileName = await writeIcon(tool.id, asset);
    return {
      fileName,
      sourceUrl: tool.preferredAssetUrl,
      homepage: tool.homepage,
      contentType: asset.contentType,
    };
  }

  const html = await fetchText(tool.homepage);
  const primaryCandidates = extractIconCandidates(html, tool.homepage);
  const candidateQueue = [];
  for (const candidate of primaryCandidates) {
    candidateQueue.push(candidate);
    if (candidate.kind === "manifest") {
      const manifestIcons = await fetchManifestIcons(candidate.url);
      candidateQueue.push(...manifestIcons);
    }
  }

  candidateQueue.sort((left, right) => right.score - left.score);

  let lastError = null;
  for (const candidate of candidateQueue) {
    try {
      const asset = await fetchIconAsset(candidate.url);
      const fileName = await writeIcon(tool.id, asset);
      return {
        fileName,
        sourceUrl: candidate.url,
        homepage: tool.homepage,
        contentType: asset.contentType,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`${tool.id}: failed to fetch icon from ${tool.homepage}${lastError ? ` (${lastError.message})` : ""}`);
}

async function main() {
  const manifest = {};
  const refreshed = [];

  for (const tool of TOOL_SOURCES) {
    const result = await refreshToolLogo(tool);
    manifest[tool.id] = `/${path.posix.join("tool-logos", result.fileName)}`;
    refreshed.push({
      id: tool.id,
      homepage: result.homepage,
      sourceUrl: result.sourceUrl,
      fileName: result.fileName,
      contentType: result.contentType,
    });
    console.log(`updated ${tool.id}: ${result.fileName} <- ${result.sourceUrl}`);
  }

  await fs.writeFile(`${manifestPath}`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote manifest: ${manifestPath}`);
  console.log(JSON.stringify(refreshed, null, 2));
}

await main();
