import { describe, expect, it } from "vitest";

import { BoundedLruCache } from "../src/bounded-lru-cache.ts";

describe("BoundedLruCache", () => {
  it("rejects invalid capacities", () => {
    expect(() => new BoundedLruCache(0)).toThrow("positive safe integer");
    expect(() => new BoundedLruCache(1.5)).toThrow("positive safe integer");
  });

  it("evicts the least recently used entry", () => {
    const cache = new BoundedLruCache<string, number>(2);
    cache.set("first", 1).set("second", 2);

    expect(cache.get("first")).toBe(1);
    cache.set("third", 3);

    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe(1);
    expect(cache.get("third")).toBe(3);
    expect(cache.size).toBe(2);
  });
});
