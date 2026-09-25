/** Match repository metadata segments in portable asset paths. */
export function isGitMetadataPath(path: string): boolean {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment.toLowerCase() === ".git");
}
