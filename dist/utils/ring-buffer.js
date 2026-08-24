/**
 * Fixed-capacity circular buffer with O(1) push.
 * Used by OperatorService for server log storage.
 */
export class RingBuffer {
    capacity;
    buf;
    head = 0;
    count = 0;
    constructor(capacity) {
        this.capacity = capacity;
        this.buf = new Array(capacity);
    }
    push(item) {
        this.buf[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        if (this.count < this.capacity)
            this.count++;
    }
    /** Return all entries oldest-to-newest. */
    toArray() {
        if (this.count === 0)
            return [];
        const start = this.count < this.capacity ? 0 : this.head;
        const result = new Array(this.count);
        for (let i = 0; i < this.count; i++) {
            result[i] = this.buf[(start + i) % this.capacity];
        }
        return result;
    }
    /** Return the last `n` entries (or all if n >= count). */
    last(n) {
        const take = Math.min(n, this.count);
        if (take === 0)
            return [];
        const start = this.count < this.capacity
            ? this.count - take
            : (this.head - take + this.capacity) % this.capacity;
        const result = new Array(take);
        for (let i = 0; i < take; i++) {
            result[i] = this.buf[(start + i) % this.capacity];
        }
        return result;
    }
    clear() {
        this.buf = new Array(this.capacity);
        this.head = 0;
        this.count = 0;
    }
    resize(newCapacity) {
        const entries = this.toArray();
        this.capacity = newCapacity;
        this.buf = new Array(newCapacity);
        this.head = 0;
        this.count = 0;
        // Re-insert, keeping only the newest entries that fit
        const start = Math.max(0, entries.length - newCapacity);
        for (let i = start; i < entries.length; i++) {
            this.push(entries[i]);
        }
    }
    get size() {
        return this.count;
    }
    get maxCapacity() {
        return this.capacity;
    }
}
