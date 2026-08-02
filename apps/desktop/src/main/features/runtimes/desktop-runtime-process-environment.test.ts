import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createDesktopRuntimeProcessEnvironment } from "./desktop-runtime-process-environment.ts";

describe("DesktopRuntimeProcessEnvironment", () => {
  it("recovers PATH from the login shell once and reuses one immutable snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-path-"));
    const shellDirectory = join(root, "shell");
    const loginBin = join(root, "login-bin");
    const loginBinLink = join(root, "login-bin-link");
    const originalBin = join(root, "original-bin");
    const invocationFile = join(root, "invocations");
    await Promise.all([
      mkdir(shellDirectory),
      mkdir(loginBin),
      mkdir(originalBin),
      mkdir(join(root, ".local", "bin"), { recursive: true }),
    ]);
    await symlink(loginBin, loginBinLink);
    const shell = join(shellDirectory, "zsh");
    await writeFile(
      shell,
      `#!/bin/sh\nprintf x >> '${invocationFile}'\nexport PATH='${loginBinLink}:${loginBin}:${loginBinLink}:${originalBin}'\nprintf 'shell startup noise\\n'\nexec /bin/sh -c "$2"\n`,
    );
    await chmod(shell, 0o755);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const service = createDesktopRuntimeProcessEnvironment({
      logger,
      env: { HOME: root, PATH: originalBin, SHELL: shell },
      homeDirectory: root,
      platform: "linux",
    });

    await expect(readFile(invocationFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    service.warmUp();
    const [first, second] = await Promise.all([service.get(), service.get()]);

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    const loginBinRealPath = await realpath(loginBin);
    expect(first["PATH"]?.split(delimiter)[0]).toBe(loginBinRealPath);
    expect(
      first["PATH"]?.split(delimiter).filter((entry) => entry === loginBinRealPath),
    ).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      "desktop.runtime_process_environment_ready",
      expect.any(String),
      expect.objectContaining({ source: "login-shell" }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
    await expect(readFile(invocationFile, "utf8")).resolves.toBe("x");
  });

  it("falls back to common and original directories for an unsupported shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-path-fallback-"));
    const localBin = join(root, ".local", "bin");
    const originalBin = join(root, "original-bin");
    await Promise.all([mkdir(localBin, { recursive: true }), mkdir(originalBin)]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const service = createDesktopRuntimeProcessEnvironment({
      logger,
      env: { HOME: root, PATH: `relative${delimiter}${originalBin}`, SHELL: "/bin/fish" },
      homeDirectory: root,
      platform: "linux",
    });

    const environment = await service.get();
    const pathDirectories = environment["PATH"]?.split(delimiter) ?? [];

    expect(pathDirectories).toContain(await realpath(localBin));
    expect(pathDirectories).toContain(await realpath(originalBin));
    expect(pathDirectories).not.toContain("relative");
    expect(logger.warn).toHaveBeenCalledWith(
      "desktop.runtime_process_environment_fallback",
      expect.any(String),
      expect.objectContaining({ failureKind: "unsupported-shell", source: "fallback" }),
    );
  });

  it("keeps the original Windows environment without launching a shell", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const service = createDesktopRuntimeProcessEnvironment({
      logger,
      env: { PATH: "C:\\Windows\\System32", SHELL: "/definitely/not/a/shell" },
      platform: "win32",
    });

    await expect(service.get()).resolves.toMatchObject({ PATH: "C:\\Windows\\System32" });
    expect(logger.info).toHaveBeenCalledWith(
      "desktop.runtime_process_environment_ready",
      expect.any(String),
      expect.objectContaining({ source: "original" }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not let a diagnostic logger failure reject or poison the cached environment", async () => {
    const info = vi.fn(() => {
      throw new Error("logger unavailable");
    });
    const service = createDesktopRuntimeProcessEnvironment({
      logger: { info, warn: vi.fn() },
      env: { PATH: "/usr/bin:/bin" },
      platform: "win32",
    });

    const first = await service.get();
    const second = await service.get();

    expect(first).toBe(second);
    expect(first).toMatchObject({ PATH: "/usr/bin:/bin" });
    expect(info).toHaveBeenCalledOnce();
  });

  it("bounds a stuck login shell and returns the fallback environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-path-timeout-"));
    const shellDirectory = join(root, "shell");
    const originalBin = join(root, "original-bin");
    await Promise.all([mkdir(shellDirectory), mkdir(originalBin)]);
    const shell = join(shellDirectory, "zsh");
    await writeFile(shell, "#!/bin/sh\ntrap '' TERM\nwhile :; do /bin/sleep 1; done\n");
    await chmod(shell, 0o755);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const service = createDesktopRuntimeProcessEnvironment({
      logger,
      env: { HOME: root, PATH: originalBin, SHELL: shell },
      homeDirectory: root,
      platform: "linux",
      shellTimeoutMs: 20,
      forceKillDelayMs: 20,
    });

    await expect(service.get()).resolves.toMatchObject({ PATH: expect.any(String) });
    expect(logger.warn).toHaveBeenCalledWith(
      "desktop.runtime_process_environment_fallback",
      expect.any(String),
      expect.objectContaining({ failureKind: "timeout" }),
    );
  });

  it("rejects excessive shell output without retaining it in diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-path-output-"));
    const shell = join(root, "zsh");
    await writeFile(shell, "#!/bin/sh\nprintf 'startup-output-that-is-too-large'\n");
    await chmod(shell, 0o755);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const service = createDesktopRuntimeProcessEnvironment({
      logger,
      env: { HOME: root, PATH: "/usr/bin:/bin", SHELL: shell },
      homeDirectory: root,
      platform: "linux",
      maxOutputBytes: 8,
      forceKillDelayMs: 20,
    });

    await service.get();

    expect(logger.warn).toHaveBeenCalledWith(
      "desktop.runtime_process_environment_fallback",
      expect.any(String),
      expect.objectContaining({ failureKind: "output-limit" }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("startup-output");
  });
});
