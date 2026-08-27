import { builtinModules } from "node:module";

const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

export const allowedExternalSpecifiers = new Set([
  "@napi-rs/keyring",
  "bufferutil",
  "utf-8-validate",
]);

export function isAllowedExternalSpecifier(specifier) {
  return nodeBuiltins.has(specifier) || allowedExternalSpecifiers.has(specifier);
}

export function findExternalWorkspaceImports(source) {
  const specifiers = new Set();
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?:[^"'()\n;]*?\s+from\s+)?["'](@pragma\/[^"']+)["']/gu,
    /\bimport\s*\(\s*["'](@pragma\/[^"']+)["']/gu,
    /\brequire\s*\(\s*["'](@pragma\/[^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

export function findSecretPatterns(source) {
  const patterns = [
    ["PEM private key", /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/u],
    ["npm token", /\bnpm_[A-Za-z0-9]{20,}\b/u],
    ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/u],
    ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u],
    ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
    ["Bearer token", /\bBearer\s+[A-Za-z0-9._~-]{24,}\b/u],
  ];
  return patterns.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}

export function findForbiddenText(
  source,
  {
    repositoryDirectory = "",
    checkDependencyProtocols = true,
    checkAbsolutePaths = true,
    allowFileUrls = false,
  } = {},
) {
  const failures = [];
  const fileProtocolPattern = allowFileUrls
    ? /\bfile:(?:\/(?!\/)|\.\.?\/|~\/|[A-Za-z]:[\\/])/u
    : /\bfile:(?:\/{1,3}|\.\.?\/|~\/|[A-Za-z]:[\\/])/u;
  const checks = [
    ...(checkDependencyProtocols
      ? [
          ["workspace protocol", /\bworkspace:(?:\*|[./~])/u],
          ["link protocol", /\blink:(?:[./~@])/u],
          ["file protocol", fileProtocolPattern],
        ]
      : []),
    ...(checkAbsolutePaths
      ? [
          ["absolute Unix user path", /\/(?:Users|home)\/[^\s"']+/u],
          ["absolute Windows path", /\b[A-Za-z]:\\(?:[^\r\n"']*)/u],
        ]
      : []),
  ];
  if (repositoryDirectory.length > 0) {
    checks.push(["repository absolute path", new RegExp(escapeRegExp(repositoryDirectory), "u")]);
  }
  for (const [name, pattern] of checks) {
    if (pattern.test(source)) failures.push(name);
  }
  failures.push(...findSecretPatterns(source));
  return [...new Set(failures)];
}

export function findBuildPathLeaks(
  source,
  { repositoryDirectory = "", buildDirectories = [] } = {},
) {
  const failures = new Set();
  const normalizedSource = normalizePathText(source);
  const normalizedRepository = normalizePathValue(repositoryDirectory);

  if (
    normalizedRepository.length > 0 &&
    containsNormalizedPath(normalizedSource, normalizedRepository)
  ) {
    failures.add("repository absolute path");
  }

  for (const directory of buildDirectories) {
    const normalizedDirectory = normalizePathValue(directory);
    if (
      normalizedDirectory.length > 0 &&
      containsNormalizedPath(normalizedSource, normalizedDirectory)
    ) {
      failures.add("build machine path");
    }
  }

  const pathPatterns = [
    /\/(?:Users|home|tmp|private|var|opt|workspace|runner)\/[^\s"'`<>()[\],;]*/giu,
    /\b[A-Za-z]:[\\/][^\s"'`<>()[\],;]*/gu,
  ];
  for (const pattern of pathPatterns) {
    for (const match of source.matchAll(pattern)) {
      if (isLikelyBuildSourcePath(match[0])) failures.add("build machine source path");
    }
  }

  return [...failures];
}

export function assertNoBuildPathLeaks(source, label, options = {}) {
  const failures = findBuildPathLeaks(source, options);
  if (failures.length > 0) {
    throw new Error(`${label} contains build path leaks: ${failures.join(", ")}.`);
  }
}

export function assertSafeText(source, label, options = {}) {
  const failures = findForbiddenText(source, options);
  if (failures.length > 0) {
    throw new Error(`${label} contains forbidden content: ${failures.join(", ")}.`);
  }
}

export function assertNoExternalWorkspaceImports(source, label) {
  const imports = findExternalWorkspaceImports(source);
  if (imports.length > 0) {
    throw new Error(`${label} contains external @pragma imports: ${imports.join(", ")}.`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizePathValue(value) {
  if (typeof value !== "string") return "";
  return value
    .replaceAll("\\\\", "\\")
    .replaceAll("\\", "/")
    .replace(/\/{2,}/gu, "/")
    .replace(/\/$/u, "")
    .toLowerCase();
}

function normalizePathText(value) {
  return normalizePathValue(value);
}

function containsNormalizedPath(source, directory) {
  return new RegExp(`(?:^|[^a-z0-9._-])${escapeRegExp(directory)}(?=$|[^a-z0-9._-])`, "u").test(
    source,
  );
}

function isLikelyBuildSourcePath(value) {
  const normalized = normalizePathValue(value);
  const hasSourceDirectory =
    /(?:^|\/)\b(?:apps|packages|src|test|scripts|workspace|work|_work)\b(?:\/|$)/u.test(normalized);
  const hasSourceFile = /\.(?:[cm]?[jt]sx?|json|ya?ml|mjs|cjs)(?:$|[?#])/u.test(normalized);
  const hasWorkspaceMarker =
    /(?:^|\/)(?:workspace|workspaces|work|_work|repo|repository|build)(?:\/|$)/u.test(normalized) ||
    /(?:expert-mesh|pragma-cli)/u.test(normalized);
  return (hasSourceDirectory && hasSourceFile) || (hasWorkspaceMarker && hasSourceFile);
}
