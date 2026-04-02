import { describe, it, expect } from "vitest";
import { TtlCache, TtlSet } from "./ttl-cache.js";

// ─── TtlCache ────────────────────────────────────────────

describe("TtlCache", () => {
  it("stores and retrieves values", () => {
    const cache = new TtlCache<string, number>({ maxSize: 10, ttlMs: 1000 });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.has("a")).toBe(true);
    expect(cache.size).toBe(1);
  });

  it("returns undefined for missing keys", () => {
    const cache = new TtlCache<string, number>({ maxSize: 10, ttlMs: 1000 });
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.has("missing")).toBe(false);
  });

  it("expires entries after TTL", () => {
    let time = 0;
    const cache = new TtlCache<string, number>({ maxSize: 10, ttlMs: 100, now: () => time });

    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);

    time = 101;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.has("a")).toBe(false);
  });

  it("entries at exactly TTL boundary are still valid", () => {
    let time = 0;
    const cache = new TtlCache<string, number>({ maxSize: 10, ttlMs: 100, now: () => time });
    cache.set("a", 1);

    time = 100;
    expect(cache.get("a")).toBe(1);
  });

  it("evicts oldest when exceeding maxSize", () => {
    const cache = new TtlCache<string, number>({ maxSize: 3, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // "a" should be evicted

    expect(cache.has("a")).toBe(false);
    expect(cache.get("b")).toBe(2);
    expect(cache.get("d")).toBe(4);
    expect(cache.size).toBe(3);
  });

  it("re-setting a key refreshes its position (not evicted first)", () => {
    const cache = new TtlCache<string, number>({ maxSize: 3, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    // Touch "a" — moves it to the end
    cache.set("a", 10);
    cache.set("d", 4); // "b" should be evicted (oldest now)

    expect(cache.has("b")).toBe(false);
    expect(cache.get("a")).toBe(10);
    expect(cache.size).toBe(3);
  });

  it("delete removes entries", () => {
    const cache = new TtlCache<string, number>({ maxSize: 10, ttlMs: 1000 });
    cache.set("a", 1);
    expect(cache.delete("a")).toBe(true);
    expect(cache.has("a")).toBe(false);
    expect(cache.delete("a")).toBe(false);
  });

  it("entries() skips expired items", () => {
    let time = 0;
    const cache = new TtlCache<string, number>({ maxSize: 10, ttlMs: 100, now: () => time });
    cache.set("a", 1);
    time = 50;
    cache.set("b", 2);

    time = 101; // "a" expired, "b" still valid
    const entries = Array.from(cache.entries());
    expect(entries).toEqual([["b", 2]]);
  });

  it("sweep removes all expired entries", () => {
    let time = 0;
    const cache = new TtlCache<string, number>({ maxSize: 10, ttlMs: 100, now: () => time });
    cache.set("a", 1);
    cache.set("b", 2);
    time = 50;
    cache.set("c", 3);

    time = 101; // "a" and "b" expired, "c" still valid
    const swept = cache.sweep();
    expect(swept).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("clear removes everything", () => {
    const cache = new TtlCache<string, number>({ maxSize: 10, ttlMs: 1000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("set returns this for chaining", () => {
    const cache = new TtlCache<string, number>({ maxSize: 10, ttlMs: 1000 });
    const ret = cache.set("a", 1);
    expect(ret).toBe(cache);
  });
});

// ─── TtlSet ─────────────────────────────────────────────

describe("TtlSet", () => {
  it("add and has", () => {
    const set = new TtlSet<string>({ maxSize: 10, ttlMs: 1000 });
    set.add("x");
    expect(set.has("x")).toBe(true);
    expect(set.has("y")).toBe(false);
    expect(set.size).toBe(1);
  });

  it("expires entries after TTL", () => {
    let time = 0;
    const set = new TtlSet<string>({ maxSize: 10, ttlMs: 100, now: () => time });
    set.add("x");

    time = 101;
    expect(set.has("x")).toBe(false);
  });

  it("evicts oldest when exceeding maxSize", () => {
    const set = new TtlSet<string>({ maxSize: 2, ttlMs: 60_000 });
    set.add("a");
    set.add("b");
    set.add("c"); // "a" evicted

    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
  });

  it("delete removes entries", () => {
    const set = new TtlSet<string>({ maxSize: 10, ttlMs: 1000 });
    set.add("x");
    expect(set.delete("x")).toBe(true);
    expect(set.has("x")).toBe(false);
  });

  it("sweep removes expired entries", () => {
    let time = 0;
    const set = new TtlSet<string>({ maxSize: 10, ttlMs: 100, now: () => time });
    set.add("a");
    set.add("b");
    time = 101;
    expect(set.sweep()).toBe(2);
    expect(set.size).toBe(0);
  });

  it("add returns this for chaining", () => {
    const set = new TtlSet<string>({ maxSize: 10, ttlMs: 1000 });
    const ret = set.add("x");
    expect(ret).toBe(set);
  });
});
