export interface ExpertDisplayCopy {
  readonly name: string;
  readonly description: string;
  readonly scope?: string | undefined;
}

interface LocalizedExpertDisplayCopy {
  readonly name: string;
  readonly description: string;
  readonly scope: string;
}

interface SystemExpertDisplaySource extends ExpertDisplayCopy {
  readonly ref?: string | undefined;
  readonly origin: "project" | "built-in";
  readonly customized: boolean;
}

export const BUILT_IN_PRAGMA_EXPERT_REF = "expert:0000000000pragma";

export function localizeSystemExpertCopy(
  source: SystemExpertDisplaySource,
  pragma: LocalizedExpertDisplayCopy,
): ExpertDisplayCopy {
  if (
    source.ref !== BUILT_IN_PRAGMA_EXPERT_REF ||
    source.origin !== "built-in" ||
    source.customized
  ) {
    return {
      name: source.name,
      description: source.description,
      ...(source.scope === undefined ? {} : { scope: source.scope }),
    };
  }
  return {
    name: pragma.name,
    description: pragma.description,
    ...(source.scope === undefined ? {} : { scope: pragma.scope }),
  };
}
