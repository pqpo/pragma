import type { ContextStoreEntry } from "../../../../shared/contracts/index.ts";
import { parentId, rebaseEntryId } from "./asset-file-paths.ts";

type Snapshot = {
  entries: readonly ContextStoreEntry[];
  collapsed: ReadonlySet<string>;
  pending: ReadonlySet<string>;
};

/** A resource-local cache. Only explicitly opened directories are requested. */
export class AssetDirectoryLoader {
  private expanded = new Set<string>();
  private loaded = new Set<string>();
  private requests = new Map<string, Promise<void>>();
  private generation = 0;
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { entries: [], collapsed: new Set(), pending: new Set() };

  constructor(private read: (directory: string) => Promise<readonly ContextStoreEntry[]>) {}

  setReader(read: (directory: string) => Promise<readonly ContextStoreEntry[]>): void {
    this.read = read;
  }

  getSnapshot = (): Snapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(entries = this.snapshot.entries): void {
    this.snapshot = {
      entries,
      collapsed: new Set(
        entries
          .filter((entry) => entry.kind === "directory" && !this.expanded.has(entry.id))
          .map((entry) => entry.id),
      ),
      pending: new Set(this.requests.keys()),
    };
    for (const listener of this.listeners) listener();
  }

  setEntries(
    update: (entries: readonly ContextStoreEntry[]) => readonly ContextStoreEntry[],
  ): void {
    this.publish(update(this.snapshot.entries).toSorted((a, b) => a.id.localeCompare(b.id)));
  }

  isLoaded(directory: string): boolean {
    return this.loaded.has(directory);
  }

  contains(path: string): boolean | undefined {
    const segments = path.split("/");
    for (let depth = 1; depth <= segments.length; depth++) {
      const id = segments.slice(0, depth).join("/");
      if (!this.loaded.has(parentId(id))) return undefined;
      const entry = this.snapshot.entries.find((entry) => entry.id === id);
      if (entry === undefined || (depth < segments.length && entry.kind !== "directory"))
        return false;
    }
    return true;
  }

  async load(directory: string): Promise<void> {
    if (this.loaded.has(directory)) return;
    const existing = this.requests.get(directory);
    if (existing !== undefined) return await existing;
    const generation = this.generation;
    const request = Promise.resolve().then(async () => {
      try {
        if (generation !== this.generation) return;
        const children = await this.read(directory);
        if (generation !== this.generation) return;
        if (directory !== "" && this.contains(directory) === false) return;
        const childDirectories = new Set(
          children.filter((entry) => entry.kind === "directory").map((entry) => entry.id),
        );
        const prefix = directory === "" ? "" : `${directory}/`;
        const retained = (id: string) => {
          if (!id.startsWith(prefix)) return true;
          const suffix = id.slice(prefix.length);
          const separator = suffix.indexOf("/");
          return separator === -1 || childDirectories.has(`${prefix}${suffix.slice(0, separator)}`);
        };
        this.loaded = new Set(
          [...this.loaded].filter((id) => id === directory || retained(`${id}/`)),
        );
        this.expanded = new Set([...this.expanded].filter((id) => retained(`${id}/`)));
        this.loaded.add(directory);
        this.setEntries((entries) => [
          ...entries.filter((entry) => retained(entry.id) && parentId(entry.id) !== directory),
          ...children,
        ]);
      } catch (error) {
        if (generation === this.generation) throw error;
      } finally {
        if (generation === this.generation) {
          this.requests.delete(directory);
          this.publish();
        }
      }
    });
    this.requests.set(directory, request);
    this.publish();
    return await request;
  }

  async toggle(directory: string): Promise<boolean> {
    const generation = this.generation;
    if (this.expanded.has(directory)) {
      this.expanded.delete(directory);
      this.publish();
      return true;
    }
    this.expanded.add(directory);
    this.publish();
    try {
      await this.load(directory);
      return generation === this.generation;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.expanded.delete(directory);
      this.publish();
      throw error;
    }
  }

  async reveal(path: string): Promise<boolean> {
    const generation = this.generation;
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const directory = segments.slice(0, depth).join("/");
      if (
        !this.snapshot.entries.some((entry) => entry.id === directory && entry.kind === "directory")
      ) {
        this.publish();
        return false;
      }
      this.expanded.add(directory);
      await this.load(directory);
      if (generation !== this.generation) return false;
    }
    this.publish();
    return true;
  }

  remove(path: string): void {
    this.generation++;
    this.requests.clear();
    const retained = (id: string) => id !== path && !id.startsWith(`${path}/`);
    this.loaded = new Set([...this.loaded].filter(retained));
    this.expanded = new Set([...this.expanded].filter(retained));
    this.setEntries((entries) => entries.filter((entry) => retained(entry.id)));
  }

  rebase(source: string, target: string): void {
    this.generation++;
    this.requests.clear();
    const rebase = (id: string) => rebaseEntryId(id, source, target) ?? id;
    this.expanded = new Set([...this.expanded].map(rebase));
    this.loaded = new Set([...this.loaded].map(rebase));
    this.setEntries((entries) => entries.map((entry) => ({ ...entry, id: rebase(entry.id) })));
  }

  async refresh(): Promise<boolean> {
    const generation = ++this.generation;
    this.loaded.clear();
    this.requests.clear();
    // Keep the previous display on failure, but invalidate every cached directory.
    await this.load("");
    if (generation !== this.generation) return false;
    const reachable = new Set<string>();
    for (const directory of [...this.expanded].sort(
      (a, b) => a.split("/").length - b.split("/").length,
    )) {
      if (
        !this.snapshot.entries.some((entry) => entry.id === directory && entry.kind === "directory")
      )
        continue;
      if (parentId(directory) !== "" && !reachable.has(parentId(directory))) continue;
      reachable.add(directory);
      await this.load(directory);
      if (generation !== this.generation) return false;
    }
    this.expanded = reachable;
    this.setEntries((entries) =>
      entries.filter((entry) => parentId(entry.id) === "" || reachable.has(parentId(entry.id))),
    );
    return true;
  }
}
