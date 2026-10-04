import { describe, expect, it, vi } from "vitest";
import { MissionExecutionOwner } from "../src/missions/execution-owner.ts";

describe("Mission execution owner", () => {
  it("coalesces lifecycle work and releases it after settlement", async () => {
    const service = new MissionExecutionOwner<unknown, string, string, { readonly id: string }>();
    let resolveRun!: (value: string) => void;
    const first = service.startRun(
      "mission-1",
      () => new Promise<string>((resolve) => (resolveRun = resolve)),
    );
    const duplicate = service.startRun("mission-1", async () => "duplicate");

    expect(duplicate).toBe(first);
    resolveRun("done");
    await expect(first).resolves.toBe("done");
    await Promise.resolve();
    expect(service.run("mission-1")).toBeUndefined();

    const active = { id: "execution-1" };
    service.setActive("mission-1", active);
    expect(service.active("mission-1")).toBe(active);
    service.deleteActiveIfCurrent("mission-1", { id: "stale" });
    expect(service.hasActive("mission-1")).toBe(true);
    service.deleteActiveIfCurrent("mission-1", active);
    expect(service.hasActive("mission-1")).toBe(false);
  });

  it("does not let a forgotten run generation replace the current active execution", async () => {
    const service = new MissionExecutionOwner<unknown, string, string, { readonly id: string }>();
    let finishOld!: () => void;
    const oldRun = service.startRun(
      "mission-1",
      (generation) =>
        new Promise<string>((resolve) => {
          finishOld = () => {
            service.setActiveForRun("mission-1", generation, { id: "old" });
            resolve("old");
          };
        }),
    );
    service.forgetRun("mission-1");
    await service.startRun("mission-1", async (generation) => {
      expect(service.setActiveForRun("mission-1", generation, { id: "new" })).toBe(true);
      return "new";
    });

    finishOld();
    await expect(oldRun).resolves.toBe("old");
    expect(service.active("mission-1")).toEqual({ id: "new" });
  });

  it("coalesces repeated deletion retries while the first cleanup is still running", async () => {
    const service = new MissionExecutionOwner<unknown, string, string, never>();
    let finish!: () => void;
    const cleanup = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    const first = service.startDeletion("mission-1", cleanup);
    const retry = service.startDeletion("mission-1", cleanup);
    expect(retry).toBe(first);
    expect(cleanup).toHaveBeenCalledOnce();
    finish();
    await expect(first).resolves.toBeUndefined();
  });

  it("keeps Session identity and invalidation state behind one registry", async () => {
    const service = new MissionExecutionOwner<{ readonly id: string }>();
    const context = Promise.resolve({ id: "context-1" });
    service.setExecutionContext("mission-1", context);
    service.setCompilationIdentity("mission-1", "compile-1");
    service.setCompilationSecrets("mission-1", [{ ref: "secret.fixture", fingerprint: "opaque" }]);
    service.setCompilationPlugins("mission-1", []);
    service.setDefinitionFingerprint("mission-1", "definition-1");

    expect(await service.executionContext("mission-1")).toEqual({ id: "context-1" });
    service.invalidateContextBindings("mission-1");
    expect(service.executionContext("mission-1")).toBeUndefined();
    expect(service.compilationIdentity("mission-1")).toBeUndefined();
    expect(service.definitionFingerprint("mission-1")).toBeUndefined();
    expect(service.compilationSecrets("mission-1")).toBeUndefined();
    expect(service.compilationPlugins("mission-1")).toBeUndefined();
    expect(service.successorRequired("mission-1")).toBe(true);
    service.clearSuccessorRequirement("mission-1");
    expect(service.successorRequired("mission-1")).toBe(false);
  });

  it("does not let stale cleanup remove a replacement Session", () => {
    const service = new MissionExecutionOwner<never>();
    type Session = Parameters<typeof service.setSession>[1];
    const oldSession = { sessionId: "old" } as Session;
    const replacement = { sessionId: "new" } as Session;
    service.setSession("mission-1", oldSession);
    service.setSession("mission-1", replacement);

    expect(service.deleteSessionIfCurrent("mission-1", oldSession)).toBe(false);
    expect(service.session("mission-1")).toBe(replacement);
    expect(service.deleteSessionIfCurrent("mission-1", replacement)).toBe(true);
  });
});

it("keeps the message gate closed until all concurrent teammate mounts finish", () => {
  const sessions = new MissionExecutionOwner();
  sessions.beginContextBindingChange("mission");
  sessions.beginContextBindingChange("mission");
  sessions.finishContextBindingChange("mission");
  expect(sessions.contextBindingChangeInProgress("mission")).toBe(true);
  expect(sessions.contextBindingChangeInProgress("other")).toBe(false);
  sessions.finishContextBindingChange("mission");
  expect(sessions.contextBindingChangeInProgress("mission")).toBe(false);
});

it("publishes the same Session to first-run and control access and invalidates a successor", () => {
  const owners = new MissionExecutionOwner();
  type Owner = Parameters<typeof owners.setControlOwner>[1];
  type Session = Parameters<typeof owners.setSession>[1];
  const session = { sessionId: "first" } as Session;
  const owner = { kind: "session", session, executor: {} } as Owner;
  owners.setControlOwner("mission", owner, "live");
  expect(owners.session("mission")).toBe(session);
  expect(owners.controlOwner("mission")).toBe(owner);
  expect(owners.controlOwnerOrigin("mission")).toBe("live");

  const successor = { sessionId: "successor" } as Session;
  owners.setSession("mission", successor);
  expect(owners.controlOwner("mission")).toBeUndefined();
  expect(owners.deleteControlOwnerIfCurrent("mission", owner)).toBe(false);
  expect(owners.session("mission")).toBe(successor);
});

it("coalesces recovery and returns the current owner without opening or compiling again", async () => {
  const owners = new MissionExecutionOwner();
  type Owner = Parameters<typeof owners.setControlOwner>[1];
  let finish!: (owner: Owner) => void;
  const owner = { kind: "session", session: { sessionId: "recovered" }, executor: {} } as Owner;
  const recover = vi.fn(
    () =>
      new Promise<Owner>((resolve) => {
        finish = resolve;
      }),
  );
  const first = owners.recoverControlOwner("mission", recover);
  expect(owners.recoverControlOwner("mission", recover)).toBe(first);
  await Promise.resolve();
  finish(owner);
  await expect(first).resolves.toBe(owner);
  await expect(owners.recoverControlOwner("mission", recover)).resolves.toBe(owner);
  expect(recover).toHaveBeenCalledOnce();
  expect(owners.session("mission")).toBe(owner.kind === "session" ? owner.session : undefined);
  expect(owners.controlOwnerOrigin("mission")).toBe("recovered");
});

it("clears failed recovery so a retry can acquire an owner", async () => {
  const owners = new MissionExecutionOwner();
  type Owner = Parameters<typeof owners.setControlOwner>[1];
  await expect(
    owners.recoverControlOwner("mission", async () => {
      throw new Error("unavailable");
    }),
  ).rejects.toThrow("unavailable");
  const owner = { kind: "session", session: { sessionId: "retry" }, executor: {} } as Owner;
  await expect(owners.recoverControlOwner("mission", async () => owner)).resolves.toBe(owner);
});

it("rejects a recovery callback belonging to a revoked run generation", async () => {
  const owners = new MissionExecutionOwner();
  type Owner = Parameters<typeof owners.setControlOwner>[1];
  let finish!: (owner: Owner) => void;
  const discard = vi.fn(async () => undefined);
  const recovering = owners.recoverControlOwner(
    "mission",
    () =>
      new Promise<Owner>((resolve) => {
        finish = resolve;
      }),
    { discard },
  );
  await Promise.resolve();
  const rejected = expect(recovering).rejects.toThrow("Mission owner changed during recovery");
  owners.forgetRun("mission");
  finish({ kind: "session", session: { sessionId: "stale" }, executor: {} } as Owner);
  await rejected;
  expect(owners.controlOwner("mission")).toBeUndefined();
  expect(owners.session("mission")).toBeUndefined();
  expect(discard).toHaveBeenCalledOnce();
});

it.each(["session", "control-owner"] as const)(
  "revokes a stale recovery's published %s before releasing its Session",
  async (publication) => {
    const owners = new MissionExecutionOwner();
    type Owner = Parameters<typeof owners.setControlOwner>[1];
    let finish!: () => void;
    const session = {
      sessionId: "stale",
      getState: async () => ({ lastStatus: "succeeded" }),
      getPromptQueue: async () => [],
      releaseAfterTerminal: vi.fn(async () => {
        expect(owners.session("mission")).toBeUndefined();
        expect(owners.controlOwner("mission")).toBeUndefined();
        expect(owners.compilationIdentity("mission")).toBeUndefined();
      }),
    };
    const owner = { kind: "session", session } as unknown as Owner;
    const recovery = owners.recoverControlOwner("mission", async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      if (publication === "session")
        owners.setSession("mission", session as unknown as Parameters<typeof owners.setSession>[1]);
      else owners.setControlOwner("mission", owner, "live");
      owners.setCompilationIdentity("mission", "stale-compilation");
      return owner;
    });
    const rejected = expect(recovery).rejects.toThrow("Mission owner changed during recovery");
    await Promise.resolve();
    owners.markLeaseLost("mission");
    finish();
    await rejected;
    expect(session.releaseAfterTerminal).toHaveBeenCalledOnce();
    expect(owners.session("mission")).toBeUndefined();
  },
);

it("preserves a successor publication when stale recovery releases another Session", async () => {
  const owners = new MissionExecutionOwner();
  type Owner = Parameters<typeof owners.setControlOwner>[1];
  const successor = { kind: "session", session: { sessionId: "successor" } } as Owner;
  const discarded = { kind: "session", session: { sessionId: "discarded" } } as Owner;
  let finish!: () => void;
  const discard = vi.fn(async () => {
    expect(owners.controlOwner("mission")).toBe(successor);
    expect(owners.compilationIdentity("mission")).toBe("successor-compilation");
  });
  const recovery = owners.recoverControlOwner(
    "mission",
    async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      return discarded;
    },
    { discard },
  );
  const rejected = expect(recovery).rejects.toThrow("Mission owner changed during recovery");
  await Promise.resolve();
  owners.markLeaseLost("mission");
  owners.setControlOwner("mission", successor, "live");
  owners.setCompilationIdentity("mission", "successor-compilation");
  finish();
  await rejected;
  expect(owners.controlOwner("mission")).toBe(successor);
  expect(discard).toHaveBeenCalledOnce();
});

it("serializes one owner admission while unrelated owners and retry remain independent", async () => {
  const owners = new MissionExecutionOwner();
  let finish!: () => void;
  const events: string[] = [];
  const first = owners.admit("mission", async () => {
    events.push("first");
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    throw new Error("failed admission");
  });
  const rejected = expect(first).rejects.toThrow("failed admission");
  const second = owners.admit("mission", async () => {
    events.push("second");
  });
  await owners.admit("other", async () => {
    events.push("other");
  });
  expect(events).toEqual(["first", "other"]);
  finish();
  await rejected;
  await second;
  expect(events).toEqual(["first", "other", "second"]);
});

it("releases a discarded recovered Session when a Host publishes a live handle", async () => {
  const owners = new MissionExecutionOwner();
  type Owner = Parameters<typeof owners.setControlOwner>[1];
  const release = vi.fn(async () => undefined);
  const recovered = {
    kind: "session",
    session: {
      sessionId: "recovered",
      getState: async () => ({ lastStatus: "succeeded" }),
      getPromptQueue: async () => [],
      releaseAfterTerminal: release,
    },
  } as unknown as Owner;
  const live = { kind: "session", session: { sessionId: "live" } } as Owner;
  let finish!: (owner: Owner) => void;
  const recovering = owners.recoverControlOwner(
    "mission",
    () =>
      new Promise<Owner>((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  owners.setControlOwner("mission", live, "live");
  finish(recovered);
  await expect(recovering).resolves.toBe(live);
  expect(release).toHaveBeenCalledOnce();
  expect(owners.controlOwner("mission")).toBe(live);
  expect(owners.controlOwnerOrigin("mission")).toBe("live");
});

it("waits for first-run admission before acquiring a recovered owner", async () => {
  const owners = new MissionExecutionOwner();
  type Owner = Parameters<typeof owners.setControlOwner>[1];
  const live = { kind: "session", session: { sessionId: "live" } } as Owner;
  let finish!: () => void;
  const firstRun = owners.admit("mission", async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    owners.setControlOwner("mission", live, "live");
  });
  const recover = vi.fn(async () => live);
  const recovered = owners.recoverControlOwner("mission", recover);
  await Promise.resolve();
  expect(recover).not.toHaveBeenCalled();
  finish();
  await firstRun;
  await expect(recovered).resolves.toBe(live);
  expect(recover).not.toHaveBeenCalled();
});

it("prunes released owner records while stale generation callbacks remain fenced", () => {
  const owners = new MissionExecutionOwner<unknown, unknown, unknown, { id: string }>();
  const generation = owners.runGeneration("mission");
  const active = { id: "old" };
  owners.setActive("mission", active);
  owners.deleteActiveIfCurrent("mission", active);
  expect(owners.isRunGenerationCurrent("mission", generation)).toBe(false);
  const nextGeneration = owners.runGeneration("mission");
  expect(nextGeneration).toBeGreaterThan(generation);
  expect(owners.setActiveForRun("mission", generation, active)).toBe(false);
  expect(owners.setActiveForRun("mission", nextGeneration, { id: "new" })).toBe(true);
});
