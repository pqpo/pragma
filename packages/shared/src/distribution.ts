import { z } from "zod";

const isPortableFilename = (value: string): boolean =>
  !/[. ]$/u.test(value) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value);

const segment = z
  .string()
  .regex(/^[a-zA-Z0-9.][a-zA-Z0-9._-]*$/u)
  .refine((value) => value !== "." && value !== "..")
  .refine(isPortableFilename);
const label = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/u)
  .refine(isPortableFilename);
const version = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  );

/** Public, non-secret build input. Protocol and workspace package names are independent. */
export const DistributionConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    productName: label,
    applicationId: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/u),
    applicationName: label,
    executableName: label,
    homeDirectory: segment,
    developmentHomeDirectory: segment,
    userDataDirectory: label,
    userDataDevelopmentDirectory: label,
    homeEnvironmentVariable: z.string().regex(/^[A-Z][A-Z0-9_]*_HOME$/u),
    credentialNamespace: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9._-]+$/u),
    cliPackageName: z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
    cliCommand: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/u)
      .refine(isPortableFilename),
    desktopCliCommand: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/u)
      .refine(isPortableFilename),
    desktopVersion: version.optional(),
    cliVersion: version.optional(),
  })
  .strict()
  .superRefine((config, context) => {
    for (const [left, right] of [
      ["homeDirectory", "developmentHomeDirectory"],
      ["userDataDirectory", "userDataDevelopmentDirectory"],
      ["cliCommand", "desktopCliCommand"],
    ] as const) {
      if (config[left].toLowerCase() === config[right].toLowerCase())
        context.addIssue({
          code: "custom",
          path: [right],
          message: `${right} must differ from ${left}.`,
        });
    }
  });
export type DistributionConfig = z.infer<typeof DistributionConfigSchema>;

export const DEFAULT_DISTRIBUTION: Readonly<DistributionConfig> = Object.freeze(
  DistributionConfigSchema.parse({
    id: "pragma",
    productName: "Pragma",
    applicationId: "com.pqpo.pragma",
    applicationName: "Pragma Desktop",
    executableName: "Pragma",
    homeDirectory: ".pragma",
    developmentHomeDirectory: ".pragma-development",
    userDataDirectory: "Pragma Desktop",
    userDataDevelopmentDirectory: "Pragma Desktop Development",
    homeEnvironmentVariable: "PRAGMA_HOME",
    credentialNamespace: "default",
    cliPackageName: "@pqpo/pragma",
    cliCommand: "pragma",
    desktopCliCommand: "pragma-desktop",
  }),
);

declare const __PRAGMA_BUILD_DISTRIBUTION__: Readonly<DistributionConfig> | undefined;

/** Build identity; the immutable banner supports external workspace modules in Desktop dev. */
export function getDistribution(): Readonly<DistributionConfig> {
  if (typeof __PRAGMA_BUILD_DISTRIBUTION__ !== "undefined") return __PRAGMA_BUILD_DISTRIBUTION__;
  return (
    (globalThis as { readonly __PRAGMA_DISTRIBUTION__?: Readonly<DistributionConfig> })
      .__PRAGMA_DISTRIBUTION__ ?? DEFAULT_DISTRIBUTION
  );
}

export function getTerminalRegistrationIdentity() {
  const distribution = getDistribution();
  const label =
    distribution.id === "pragma" ? "Pragma Desktop CLI" : `${distribution.id} Desktop CLI`;
  return {
    begin: `# >>> ${label} >>>`,
    end: `# <<< ${label} <<<`,
    launcherMarker: `# ${label} launcher`,
    windowsLauncherMarker: `rem ${label} launcher`,
    fishFile: `${distribution.id}-desktop.fish`,
  };
}
