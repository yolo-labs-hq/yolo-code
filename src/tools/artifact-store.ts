/** In-memory store for raw tool outputs.
 *  Artifacts are never persisted to disk. Eviction is LRU by insertion order. */
export class ToolArtifactStore {
  private artifacts = new Map<string, string>();
  private nextId = 0;
  private maxArtifacts: number;
  private maxTotalChars: number;

  constructor(opts?: { maxArtifacts?: number; maxTotalChars?: number }) {
    this.maxArtifacts = opts?.maxArtifacts ?? 500;
    this.maxTotalChars = opts?.maxTotalChars ?? 2_000_000;
  }

  /** Store raw content and return a stable artifact ID. */
  store(raw: string): string {
    const id = `art_${++this.nextId}`;

    // Evict oldest artifacts until we have room
    while (this.totalChars() + raw.length > this.maxTotalChars && this.artifacts.size > 0) {
      this.evictOldest();
    }
    while (this.artifacts.size >= this.maxArtifacts && this.artifacts.size > 0) {
      this.evictOldest();
    }

    this.artifacts.set(id, raw);
    return id;
  }

  retrieve(id: string): string | undefined {
    return this.artifacts.get(id);
  }

  has(id: string): boolean {
    return this.artifacts.has(id);
  }

  /** Returns the most recently stored artifact ID (the highest-numbered
   *  that hasn't been evicted), or undefined when the store is empty.
   *  Used by the `/expand` slash command's default (no-arg) path so the
   *  operator can expand the last tool result without typing the id. */
  latestId(): string | undefined {
    if (this.artifacts.size === 0) return undefined;
    // Insertion order in a Map yields oldest → newest; take the last key.
    let last: string | undefined;
    for (const k of this.artifacts.keys()) last = k;
    return last;
  }

  /** Returns the list of stored artifact IDs in insertion (oldest →
   *  newest) order. Used by the `/expand list` sub-form. */
  listIds(): string[] {
    return [...this.artifacts.keys()];
  }

  clear(): void {
    this.artifacts.clear();
    this.nextId = 0;
  }

  size(): number {
    return this.artifacts.size;
  }

  private totalChars(): number {
    let sum = 0;
    for (const raw of this.artifacts.values()) {
      sum += raw.length;
    }
    return sum;
  }

  private evictOldest(): void {
    // Map preserves insertion order; first key is oldest
    const first = this.artifacts.keys().next().value;
    if (first !== undefined) {
      this.artifacts.delete(first);
    }
  }
}
