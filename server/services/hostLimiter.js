const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialises requests per publisher host and enforces a minimum interval between them, so a batch
 * containing many links from one publisher never bursts against that site.
 */
export class HostRateLimiter {
  tails = new Map();
  lastRequest = new Map();

  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
  }

  async schedule(host, task) {
    const key = host.toLowerCase().replace(/^www\./, "");
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);

    await previous;
    const wait =
      (this.lastRequest.get(key) ?? 0) + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      this.lastRequest.set(key, Date.now());
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/**
 * Remembers publishers that recently served a CAPTCHA / access-denied page so the rest of the
 * batch does not keep hitting them. Entries expire after the configured TTL.
 */
export class BlockedHostRegistry {
  hosts = new Map();

  constructor(ttlMs) {
    this.ttlMs = ttlMs;
  }

  key(host) {
    return host.toLowerCase().replace(/^www\./, "");
  }

  mark(host, kind, reason) {
    if (this.ttlMs <= 0) return;
    this.hosts.set(this.key(host), {
      kind,
      reason,
      until: Date.now() + this.ttlMs,
    });
  }

  get(host) {
    const entry = this.hosts.get(this.key(host));
    if (!entry) return null;
    if (entry.until <= Date.now()) {
      this.hosts.delete(this.key(host));
      return null;
    }
    return entry;
  }

  clear(host) {
    this.hosts.delete(this.key(host));
  }
}
