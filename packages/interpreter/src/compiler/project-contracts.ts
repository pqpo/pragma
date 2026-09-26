import {
  type PragmaDiagnostic,
  type PragmaEnvironmentFingerprint,
  type PragmaLock,
  type PragmaResource,
  type PragmaResourceRef,
  type PragmaResourceHealth,
  type PragmaSemanticResourceRef,
} from "../ast/pragma-dsl.schema.ts";
import {
  DefinitionSerializerRegistry,
  type InvocableResource,
  type PragmaCompileHost,
} from "../runtime/registries.ts";
import { type PragmaResourceAdapterRegistry } from "../runtime/resource-adapters.ts";
import {
  type PragmaBundleManifest,
  type PragmaBundleRequirement,
} from "../ast/pragma-bundle.schema.ts";
import {
  type DecodedPragmaBundle,
  type PragmaBundleBinarySource,
  type PragmaBundleLimits,
} from "../bundle/pragma-bundle-codec.ts";
import {
  type PragmaBundleBindingHost,
  type PragmaBundleRequirementInspection,
  type PragmaEnvironmentBindingOverlay,
} from "../bundle/pragma-bundle-environment.ts";

export interface LoadPragmaProjectOptions {
  readonly rootDir?: string | undefined;
  readonly requireLock?: boolean | undefined;
  readonly serializers?: DefinitionSerializerRegistry | undefined;
  readonly resourceAdapters?: PragmaResourceAdapterRegistry | undefined;
  readonly externalResourceRefs?: ReadonlySet<PragmaResourceRef> | undefined;
  readonly revisionCompilerVersion?: string | undefined;
  readonly sourceIdentity?: string | undefined;
  readonly blueprintCache?: PragmaBlueprintCacheStore | undefined;
  readonly onBlueprintCacheLookup?:
    ((observation: PragmaBlueprintCacheObservation) => void) | undefined;
  /** Host extension id@version values understood by this process. */
  readonly supportedBundleExtensions?: ReadonlySet<string> | undefined;
}

export type LoadPragmaProjectSource =
  | string
  | {
      readonly kind: "yaml";
      readonly entryFile: string;
      readonly rootDir?: string | undefined;
    }
  | {
      readonly kind: "bundle";
      readonly source: PragmaBundleBinarySource;
      readonly limits?: PragmaBundleLimits | undefined;
    }
  | {
      readonly kind: "decoded-bundle";
      readonly bundle: DecodedPragmaBundle;
    };

export interface PragmaBlueprintCacheStore {
  readonly read: (key: string) => Promise<Uint8Array | undefined>;
  readonly write: (key: string, value: Uint8Array) => Promise<void>;
  readonly remove?: ((key: string) => Promise<void>) | undefined;
}

export interface PragmaBlueprintCacheObservation {
  readonly key: string;
  readonly tier: "memory" | "host" | "miss";
  readonly hit: boolean;
  readonly durationMs: number;
}

export type PragmaCompileOptions = PragmaCompileHost;

export interface CompiledResource<T> {
  readonly ref: PragmaSemanticResourceRef;
  readonly value: T;
  readonly fingerprint: string;
  readonly projectFingerprint: string;
  readonly environmentFingerprint: PragmaEnvironmentFingerprint;
  readonly rootRuntimeId?: string | undefined;
  readonly dependencies: readonly LockedResourceRef[];
}

export interface LockedResourceRef {
  readonly ref: PragmaSemanticResourceRef;
  readonly contentHash: string;
  readonly source: string;
}

export interface DumpOptions {
  readonly split?: "single" | "preserve" | "by-resource" | undefined;
}

export interface DumpedFiles {
  readonly files: ReadonlyMap<string, string>;
}

export interface PragmaBundleExportPayload {
  readonly codec: string;
  /** Paths are relative to the requirement payload root. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface PragmaBundleExportHost {
  readonly exportPayload?: (input: {
    readonly requirement: PragmaBundleRequirement;
    readonly originalBindingRef?: string | undefined;
  }) => Promise<PragmaBundleExportPayload | undefined>;
}

export interface PragmaBundleExportExtensionInput {
  readonly id: string;
  readonly version: string;
  readonly required?: boolean | undefined;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface PragmaProjectBundleExportOptions {
  readonly roots: readonly (PragmaResourceRef | object)[];
  readonly additionalRoots?: readonly (PragmaResourceRef | object)[] | undefined;
  readonly host?: PragmaBundleExportHost | undefined;
  readonly extensions?: readonly PragmaBundleExportExtensionInput[] | undefined;
  readonly createdAt?: string | undefined;
}

export interface PragmaBundleExportResult {
  readonly bytes: Uint8Array;
  readonly manifest: PragmaBundleManifest;
}

export interface ExportPragmaBundleOptions extends PragmaProjectBundleExportOptions {
  readonly serializers?: DefinitionSerializerRegistry | undefined;
  readonly resourceAdapters?: PragmaResourceAdapterRegistry | undefined;
  readonly projectRoot?: string | undefined;
  readonly include?: readonly object[] | undefined;
}

export interface PragmaLoadedBundle {
  readonly manifest: PragmaBundleManifest;
  readonly archiveBytes: number;
}

export interface PragmaProject extends AsyncDisposable {
  readonly entryFile: string;
  readonly bundle?: PragmaLoadedBundle | undefined;
  listResources(): readonly PragmaResource[];
  listResourceClosure(ref: PragmaResourceRef): readonly PragmaResource[];
  validate(): Promise<readonly PragmaDiagnostic[]>;
  validateFor(ref: PragmaResourceRef): Promise<readonly PragmaDiagnostic[]>;
  validateEnvironment(host: PragmaCompileOptions): Promise<readonly PragmaDiagnostic[]>;
  inspectEnvironment(host: PragmaCompileOptions): Promise<PragmaEnvironmentInspection>;
  inspectEnvironmentFor(
    ref: PragmaResourceRef,
    host: PragmaCompileOptions,
  ): Promise<PragmaEnvironmentInspection>;
  inspectBundleBindings(
    ref: PragmaResourceRef,
    host: PragmaBundleBindingHost,
  ): Promise<readonly PragmaBundleRequirementInspection[]>;
  bindEnvironment(
    ref: PragmaResourceRef,
    host: PragmaBundleBindingHost,
    selections?: Readonly<Record<string, string>>,
  ): Promise<PragmaBundleBindingResult>;
  prepareCompile<T extends InvocableResource>(
    ref: PragmaResourceRef,
    host: PragmaCompileOptions,
    overlay?: PragmaEnvironmentBindingOverlay,
  ): Promise<PragmaPrepareCompileResult<T>>;
  compile<T extends InvocableResource>(
    ref: PragmaResourceRef,
    host: PragmaCompileOptions,
  ): Promise<CompiledResource<T>>;
  dump(resource: object, options?: DumpOptions): Promise<DumpedFiles>;
  exportBundle(options: PragmaProjectBundleExportOptions): Promise<PragmaBundleExportResult>;
  createLock(): PragmaLock;
  readLock(): Promise<PragmaLock>;
  dispose(): Promise<void>;
}

export interface PragmaEnvironmentInspection {
  readonly diagnostics: readonly PragmaDiagnostic[];
  readonly resources: readonly PragmaResourceHealth[];
}

export interface PragmaBundleBindingResult {
  readonly overlay: PragmaEnvironmentBindingOverlay;
  readonly requirements: readonly PragmaBundleRequirementInspection[];
}

export type PragmaPrepareCompileResult<T> =
  | { readonly status: "ready"; readonly compiled: CompiledResource<T> }
  | {
      readonly status: "needs_binding";
      readonly requirements: readonly PragmaBundleRequirement[];
      readonly diagnostics: readonly PragmaDiagnostic[];
      readonly resources: readonly PragmaResourceHealth[];
    }
  | { readonly status: "invalid"; readonly diagnostics: readonly PragmaDiagnostic[] };

export class PragmaDslError extends Error {
  constructor(
    message: string,
    readonly diagnostics: readonly PragmaDiagnostic[] = [],
  ) {
    super(message);
    this.name = "PragmaDslError";
  }
}

export interface IndexedResource {
  readonly resource: PragmaResource;
  readonly source: string;
  readonly normalized: string;
  readonly contentHash: string;
}
