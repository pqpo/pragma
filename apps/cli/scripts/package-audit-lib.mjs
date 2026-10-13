import { parse } from "acorn";
import { isBuiltin } from "node:module";
import { posix } from "node:path";

export const allowedExternalSpecifiers = new Set([
  "@napi-rs/keyring",
  "@silvia-odwyer/photon-node",
  "bufferutil",
  "utf-8-validate",
]);

export function isAllowedExternalSpecifier(specifier) {
  return isBuiltin(specifier) || allowedExternalSpecifiers.has(specifier);
}

/** Parse generated JS rather than relying on line boundaries or quote formatting. */
export function inspectJavaScript(source) {
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const requireNames = new Set(["require", "__require", "__pragmaRequire"]);
  const factoryNames = new Set(["createRequire", "__pragmaCreateRequire"]);
  const declarations = [];
  function collect(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) collect(child);
      return;
    }
    if (node.type === "ImportSpecifier" && node.imported.name === "createRequire")
      factoryNames.add(node.local.name);
    if (node.type === "VariableDeclarator") declarations.push(node);
    for (const [key, child] of Object.entries(node))
      if (key !== "start" && key !== "end") collect(child);
  }
  collect(tree);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { id, init } of declarations) {
      if (id.type !== "Identifier" || !init || requireNames.has(id.name)) continue;
      const factory =
        init.type === "CallExpression" &&
        ((init.callee.type === "Identifier" && factoryNames.has(init.callee.name)) ||
          (init.callee.type === "MemberExpression" &&
            init.callee.property.name === "createRequire"));
      // esbuild renames its ESM require shim during minification. Recognize
      // the conditional global-require branch structurally, not by helper name.
      const body =
        init.type === "CallExpression" && init.callee.type === "ArrowFunctionExpression"
          ? init.callee.body
          : undefined;
      const shim =
        body?.type === "ConditionalExpression" &&
        body.consequent.type === "Identifier" &&
        requireNames.has(body.consequent.name) &&
        body.test.type === "BinaryExpression" &&
        body.test.left.type === "UnaryExpression" &&
        body.test.left.operator === "typeof" &&
        body.test.left.argument.type === "Identifier" &&
        requireNames.has(body.test.left.argument.name);
      const alias = init.type === "Identifier" && requireNames.has(init.name);
      if (factory || alias || shim) {
        requireNames.add(id.name);
        changed = true;
      }
    }
  }
  const specifiers = new Set();
  const literals = new Set();
  let dynamicLoads = 0;
  function literal(node) {
    if (node?.type === "Literal" && typeof node.value === "string") return node.value;
    if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
      return node.quasis[0].value.cooked;
    return undefined;
  }
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const value = literal(node);
    if (value !== undefined) literals.add(value);
    let argument;
    let load = false;
    if (
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)
    ) {
      argument = node.source;
      load = argument !== null && argument !== undefined;
    } else if (node.type === "ImportExpression") {
      argument = node.source;
      load = true;
    } else if (node.type === "CallExpression") {
      const callee = node.callee;
      if (
        (callee.type === "Identifier" && requireNames.has(callee.name)) ||
        (callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          requireNames.has(callee.object.name) &&
          callee.property.name === "resolve")
      ) {
        argument = node.arguments[0];
        load = true;
      }
    }
    if (load) {
      const specifier = literal(argument);
      if (specifier === undefined) dynamicLoads++;
      else specifiers.add(specifier);
    }
    for (const [key, child] of Object.entries(node))
      if (key !== "start" && key !== "end") visit(child);
  }
  visit(tree);
  return { specifiers: [...specifiers], literals: [...literals], dynamicLoads };
}

/** Verify a resource load in the emitted entry graph, rather than in a separately built probe. */
export async function assertExternalResourceImport(entry, resource, readSource) {
  const pending = [entry];
  const visited = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const { specifiers } = inspectJavaScript(await readSource(path));
    if (specifiers.includes(resource)) return;
    for (const specifier of specifiers) {
      if (specifier.startsWith(".") && /\.[cm]?js$/.test(specifier))
        pending.push(posix.normalize(posix.join(posix.dirname(path), specifier)));
    }
  }
  throw new Error(
    `Production bundle ${entry} does not load external resource ${resource}; it may have been inlined.`,
  );
}

export function findExternalWorkspaceImports(source) {
  return inspectJavaScript(source).specifiers.filter((specifier) =>
    specifier.startsWith("@pragma/"),
  );
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
  let decoded = "";
  if (/\\(?:u|x)/u.test(source)) {
    try {
      decoded = "\n" + inspectJavaScript(source).literals.join("\n");
    } catch {
      /* Non-JavaScript diagnostic text is still checked verbatim. */
    }
  }
  const normalizedSource = normalizePathText(source + decoded);
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
    for (const match of (source + decoded).matchAll(pattern)) {
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
