/**
 * collections.ts
 *
 * Small data structures the gateway needs and the standard library does not
 * give it: a map that cannot grow without bound, and a queue whose dequeue does
 * not cost a pass over everything behind it.
 */

/**
 * A Map that holds at most `capacity` entries, dropping the least recently
 * written one to make room.
 *
 * For state keyed by something the gateway sees an endless stream of — task
 * ids, session ids — in a process meant to run for weeks. Each entry is only
 * useful for a while after it was last written, so the oldest write is the one
 * to lose.
 *
 * Writing a key that is already present moves it to the newest end, which is
 * what keeps eviction oldest-first: a Map iterates in insertion order, and a
 * plain `set` on an existing key would leave it where it was. Reads do not
 * count as use. Every operation stays O(1).
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(
    readonly capacity: number,
    entries?: readonly (readonly [K, V])[] | null | Iterable<readonly [K, V]>,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`BoundedMap capacity must be a positive integer, got ${capacity}`);
    }
    super();
    if (entries) {
      for (const [key, value] of entries) {
        this.set(key, value);
      }
    }
  }

  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.capacity) {
      // Non-empty: size has just been checked to exceed a positive capacity.
      super.delete(this.keys().next().value as K);
    }
    return this;
  }
}

/**
 * A first-in, first-out queue with O(1) `push` and `shift`.
 *
 * `Array.prototype.shift` moves every remaining element down one slot, so
 * draining n items from an array costs O(n²). This reads from a moving head
 * instead, and compacts only once the spent prefix outweighs what is still
 * waiting — so each element is copied at most once more over its lifetime.
 */
export class FifoQueue<T> {
  private items: (T | undefined)[] = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  get isEmpty(): boolean {
    return this.length === 0;
  }

  push(item: T): void {
    this.items.push(item);
  }

  /** Returns the oldest item without removing it, or `undefined` when empty. */
  peek(): T | undefined {
    if (this.head === this.items.length) return undefined;
    return this.items[this.head];
  }

  /** Removes all items from the queue. */
  clear(): void {
    this.items = [];
    this.head = 0;
  }

  /** Removes and returns the oldest item, or `undefined` when empty. */
  shift(): T | undefined {
    if (this.head === this.items.length) return undefined;
    const item = this.items[this.head];
    // Cleared so the queue does not keep a finished task's closure alive.
    this.items[this.head++] = undefined;
    if (this.head === this.items.length) {
      this.items = [];
      this.head = 0;
    } else if (this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  *[Symbol.iterator](): Iterator<T> {
    for (let i = this.head; i < this.items.length; i++) {
      const item = this.items[i];
      if (item !== undefined) yield item;
    }
  }

  toArray(): T[] {
    return [...this];
  }
}
