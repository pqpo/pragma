import {
  addBundleSourceVersion,
  initializeBundleSource,
  inspectBundleSourceBundle,
  readBundleSourceManifest,
} from "@pragma/local-host";
import { BundleSourceSlugSchema, type JsonValue } from "@pragma/shared";

import type { ParsedCommand } from "../parser/argv.ts";
import type { CliCommandContext } from "./types.ts";
import { asJsonValue } from "./utils.ts";

export type SourceCommand = Extract<ParsedCommand, { readonly kind: `source-${string}` }>;

export async function executeSourceCommand(
  command: SourceCommand,
  context: CliCommandContext,
): Promise<JsonValue> {
  if (command.kind === "source-init") {
    return asJsonValue(await initializeBundleSource(command));
  }
  if (context.interactive === "never" || !context.terminal.isControllingTerminal()) {
    throw new Error("source add requires an interactive controlling terminal.");
  }
  const inspected = await inspectBundleSourceBundle(command.bundlePath);
  const root = await selectRoot(inspected.roots, context);
  const manifest = await readBundleSourceManifest(command.directory);
  const categories = manifest.sections[root.kind].categories.toSorted(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
  const categoryId = await selectValue(
    "Category",
    categories.map((category) => ({ value: category.id, label: category.name.default })),
    context,
  );
  const suggestedId = slugify(root.name) || root.ref.slice(root.ref.indexOf(":") + 1);
  const itemId = BundleSourceSlugSchema.parse(
    await askWithDefault(context, "Item ID", suggestedId),
  );
  const name = await askWithDefault(context, "Name", root.name);
  const summary = await askWithDefault(context, "Summary", root.description);
  const description = await askWithDefault(context, "Description", root.description);
  const authorName = await requiredAnswer(context, "Author name");
  const authorUrl = await optionalAnswer(context, "Author URL (optional)");
  const license = await askWithDefault(context, "License", "NOASSERTION");
  const homepage = await optionalAnswer(context, "Homepage (optional)");
  const suggestedTags = root.tags
    .map(slugify)
    .filter((tag) => BundleSourceSlugSchema.safeParse(tag).success)
    .join(",");
  const tags = (await askWithDefault(context, "Tags (comma-separated)", suggestedTags))
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => BundleSourceSlugSchema.parse(tag));
  const version = await askWithDefault(context, "Version", "1.0.0");
  return asJsonValue(
    await addBundleSourceVersion({
      directory: command.directory,
      bundlePath: command.bundlePath,
      kind: root.kind,
      categoryId,
      itemId,
      rootRef: root.ref,
      version,
      name,
      summary,
      description,
      authorName,
      ...(authorUrl === undefined ? {} : { authorUrl }),
      license,
      ...(homepage === undefined ? {} : { homepage }),
      tags,
      ...(root.avatarId === undefined ? {} : { avatarId: root.avatarId }),
    }),
  );
}

async function selectRoot(
  roots: Awaited<ReturnType<typeof inspectBundleSourceBundle>>["roots"],
  context: CliCommandContext,
) {
  if (roots.length === 1) return roots[0]!;
  const ref = await selectValue(
    "Bundle root",
    roots.map((root) => ({ value: root.ref, label: `${root.name} (${root.kind})` })),
    context,
  );
  return roots.find((root) => root.ref === ref)!;
}

async function selectValue(
  label: string,
  options: readonly { readonly value: string; readonly label: string }[],
  context: CliCommandContext,
): Promise<string> {
  if (options.length === 0) throw new Error(`${label} has no available options.`);
  const choices = options.map((option, index) => `${index + 1}:${option.label}`).join(", ");
  const answer = (await context.terminal.readLine(`${label} [${choices}]: `)).trim();
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1]!.value;
  }
  const match = options.find((option) => option.value === answer || option.label === answer);
  if (match === undefined) throw new Error(`Unknown ${label.toLocaleLowerCase()}: ${answer}`);
  return match.value;
}

async function askWithDefault(
  context: CliCommandContext,
  label: string,
  defaultValue: string,
): Promise<string> {
  const answer = (await context.terminal.readLine(`${label} [${defaultValue}]: `)).trim();
  return answer === "" ? defaultValue : answer;
}

async function requiredAnswer(context: CliCommandContext, label: string): Promise<string> {
  const answer = (await context.terminal.readLine(`${label}: `)).trim();
  if (answer === "") throw new Error(`${label} is required.`);
  return answer;
}

async function optionalAnswer(
  context: CliCommandContext,
  label: string,
): Promise<string | undefined> {
  const answer = (await context.terminal.readLine(`${label}: `)).trim();
  return answer === "" ? undefined : answer;
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}
