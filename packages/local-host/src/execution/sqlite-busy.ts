/** Retry only SQLite lock contention, yielding the Worker between attempts. */
export async function withSqliteBusyRetry<T>(operation: () => T | Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "errcode" in error
          ? error.errcode
          : undefined;
      if (typeof code !== "number" || ![5, 6].includes(code & 0xff) || attempt >= 20) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, 5 * 2 ** attempt)));
    }
  }
}
