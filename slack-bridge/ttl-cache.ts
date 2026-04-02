/**
 * Lightweight TTL + max-size cache.
 *
 * Entries expire after `ttlMs` milliseconds and are lazily evicted on
 * access.  When the cache exceeds `maxSize`, the oldest entry (by
 * insertion / last-update order) is dropped — Map iteration order
 * guarantees FIFO.
 */
export class TtlCache<K, V> {
  private readonly map = new Map<K, { value: V; touchedAt: number }>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { maxSize: number; ttlMs: number; now?: () => number }) {
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.touchedAt > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): this {
    // Delete first so re-insertion moves the key to the end (Map ordering).
    this.map.delete(key);
    this.map.set(key, { value, touchedAt: this.now() });
    this.evictOverflow();
    return this;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  /** Iterate live (non-expired) entries. */
  *entries(): IterableIterator<[K, V]> {
    const now = this.now();
    for (const [key, entry] of this.map) {
      if (now - entry.touchedAt <= this.ttlMs) {
        yield [key, entry.value];
      }
    }
  }

  /** Sweep all expired entries in one pass. */
  sweep(): number {
    const now = this.now();
    let swept = 0;
    for (const [key, entry] of this.map) {
      if (now - entry.touchedAt > this.ttlMs) {
        this.map.delete(key);
        swept++;
      }
    }
    return swept;
  }

  clear(): void {
    this.map.clear();
  }

  private evictOverflow(): void {
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
}

/**
 * TTL + max-size Set — thin wrapper around TtlCache<V, true>.
 */
export class TtlSet<V> {
  private readonly cache: TtlCache<V, true>;

  constructor(options: { maxSize: number; ttlMs: number; now?: () => number }) {
    this.cache = new TtlCache(options);
  }

  add(value: V): this {
    this.cache.set(value, true);
    return this;
  }

  has(value: V): boolean {
    return this.cache.has(value);
  }

  delete(value: V): boolean {
    return this.cache.delete(value);
  }

  get size(): number {
    return this.cache.size;
  }

  sweep(): number {
    return this.cache.sweep();
  }

  clear(): void {
    this.cache.clear();
  }
}
