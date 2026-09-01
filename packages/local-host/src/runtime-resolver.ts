import {
  createStaticRuntimeResolver,
  type RuntimeAdapter,
  type RuntimeResolver,
} from "@pragma/core";

/**
 * Runtime selection is host-neutral. Concrete adapters are supplied by the
 * Desktop or CLI composition root and never imported by Local Host.
 */
export function createLocalHostRuntimeResolver(options: {
  readonly runtimes: readonly RuntimeAdapter[];
  readonly defaultRuntimeId: string;
  /** Logical IDs retained by published project revisions. */
  readonly runtimeAliases?: Readonly<Record<string, string>> | undefined;
}): RuntimeResolver {
  const delegate = createStaticRuntimeResolver(options);
  const aliases = options.runtimeAliases ?? {};
  const resolveRuntimeId = (runtimeId: string): string => aliases[runtimeId] ?? runtimeId;
  const restoreBindingId = <T extends { readonly runtimeId: string }>(
    binding: T,
    runtimeId: string,
  ): T => ({ ...binding, runtimeId });
  return {
    getDefaultRuntimeId: async () => await delegate.getDefaultRuntimeId(),
    bind: async (request = {}) => {
      const runtimeId = request.runtimeId;
      const resolved = await delegate.bind({
        ...(runtimeId === undefined ? {} : { runtimeId: resolveRuntimeId(runtimeId) }),
        ...(request.modelSelection === undefined ? {} : { modelSelection: request.modelSelection }),
      });
      return runtimeId === undefined
        ? resolved
        : { ...resolved, binding: restoreBindingId(resolved.binding, runtimeId) };
    },
    resolve: async ({ binding, modelSelection }) => {
      const resolved = await delegate.resolve({
        binding: { ...binding, runtimeId: resolveRuntimeId(binding.runtimeId) },
        ...(modelSelection === undefined ? {} : { modelSelection }),
      });
      return {
        ...resolved,
        binding: restoreBindingId(resolved.binding, binding.runtimeId),
      };
    },
  };
}
