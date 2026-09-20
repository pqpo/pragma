import { SkillPackageSchema, type SkillPackage } from "@pragma/shared";

import {
  SkillRevisionChangeSetSchema,
  type SkillRevisionChangeSet,
} from "./revision-contracts.ts";

export function applySkillChangeSet(
  base: SkillPackage,
  rawChangeSet: SkillRevisionChangeSet,
): SkillPackage {
  const changeSet = SkillRevisionChangeSetSchema.parse(rawChangeSet);
  const files = new Map(base.files.map((file) => [file.path, file.content]));
  for (const operation of changeSet.operations) {
    if (operation.operation === "delete") files.delete(operation.path);
    else if (operation.operation === "rename") {
      const content = files.get(operation.path);
      if (content === undefined || files.has(operation.nextPath)) {
        throw new Error("skill_revision_rename_invalid");
      }
      files.delete(operation.path);
      files.set(operation.nextPath, content);
    } else files.set(operation.path, operation.content);
  }
  return SkillPackageSchema.parse({
    name: changeSet.name,
    description: changeSet.description,
    files: [...files]
      .map(([path, content]) => ({ path, content }))
      .toSorted((left, right) => left.path.localeCompare(right.path)),
  });
}
