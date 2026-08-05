export interface MemorySubjectReference {
  readonly type: string;
  readonly id: string;
}

export type MemorySubjectNameIndex = Readonly<Record<string, string>>;

interface MemorySubjectNameProject {
  readonly resources: readonly {
    readonly kind: string;
    readonly metadata: { readonly id: string; readonly name: string };
  }[];
}

interface NamedSystemExpert {
  readonly id: string;
  readonly name: string;
}

export function memorySubjectReferenceKey(ref: MemorySubjectReference): string {
  return `${ref.type}:${ref.id}`;
}

export function createMemorySubjectNameIndex(input: {
  readonly project: MemorySubjectNameProject;
  readonly systemExperts: readonly NamedSystemExpert[];
}): MemorySubjectNameIndex {
  const names: Record<string, string> = {};
  for (const resource of input.project.resources) {
    const type = memorySubjectType(resource.kind);
    if (type === undefined) continue;
    names[memorySubjectReferenceKey({ type, id: resource.metadata.id })] = resource.metadata.name;
  }
  for (const expert of input.systemExperts) {
    names[memorySubjectReferenceKey({ type: "pragma.expert", id: expert.id })] = expert.name;
  }
  return names;
}

export async function loadMemorySubjectNameIndex(input: {
  readonly getProject: () => Promise<MemorySubjectNameProject>;
  readonly listSystemExperts: () => readonly NamedSystemExpert[];
}): Promise<MemorySubjectNameIndex> {
  try {
    return createMemorySubjectNameIndex({
      project: await input.getProject(),
      systemExperts: input.listSystemExperts(),
    });
  } catch {
    return {};
  }
}

export function selectMemorySubjectNames(
  index: MemorySubjectNameIndex,
  refs: readonly MemorySubjectReference[],
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const ref of refs) {
    const key = memorySubjectReferenceKey(ref);
    const name = index[key];
    if (name !== undefined) names[key] = name;
  }
  return names;
}

function memorySubjectType(
  kind: string,
): "pragma.expert" | "pragma.expert-team" | "pragma.flow" | undefined {
  if (kind === "Expert") return "pragma.expert";
  if (kind === "ExpertTeam") return "pragma.expert-team";
  if (kind === "Flow") return "pragma.flow";
  return undefined;
}
