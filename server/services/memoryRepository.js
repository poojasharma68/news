import { randomUUID } from "node:crypto";
import { CARD_STATUSES } from "../../shared/types.js";
import { PipelineError } from "../lib/errors.js";

/**
 * In-memory Repository for tests and local "sample mode" (no Supabase configured).
 * Enforces the same uniqueness rules as the SQL migration. Data is lost on restart.
 * Never used in production (config.ts refuses it).
 */
export class MemoryRepository {
  cards = new Map();
  batches = new Map();
  images = new Map();
  events = [];

  async createBatch(input) {
    const batch = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      ...input,
      skipped: [...input.skipped],
    };
    this.batches.set(batch.id, batch);
    return batch;
  }
  async getBatch(id) {
    return this.batches.get(id) ?? null;
  }
  async listBatches(limit) {
    return [...this.batches.values()].slice(-limit).reverse();
  }

  async insertCards(rows) {
    const inserted = [];
    for (const row of rows) {
      if (
        [...this.cards.values()].some(
          (c) => c.source_url_key === row.source_url_key,
        )
      )
        continue;
      const now = new Date().toISOString();
      const card = {
        id: randomUUID(),
        canonical_url: null,
        canonical_url_key: null,
        publisher: null,
        publisher_logo_url: null,
        cdn_publisher_logo_url: null,
        title: null,
        description: null,
        published_at: null,
        original_image_url: null,
        image_candidates: [],
        cdn_image_url: null,
        image_variants: {},
        image_focus: null,
        cdn_image_source: null,
        image_hash: null,
        image_width: null,
        image_height: null,
        extraction_method: null,
        missing_fields: [],
        warnings: [],
        verification_reason: null,
        error_code: null,
        error_message: null,
        attempts: 0,
        duplicate_of: null,
        approved_at: null,
        approved_by: null,
        site_published_at: null,
        live_card: null,
        created_at: now,
        updated_at: now,
        ...row,
      };
      this.cards.set(card.id, card);
      inserted.push(card);
    }
    return inserted;
  }

  async getCard(id) {
    const card = this.cards.get(id);
    return card ? { ...card } : null;
  }
  async getCardsByIds(ids) {
    return ids.map((id) => this.cards.get(id)).filter((c) => !!c);
  }
  async findCardsByUrlKeys(keys) {
    return [...this.cards.values()].filter(
      (c) =>
        keys.includes(c.source_url_key) ||
        (c.canonical_url_key && keys.includes(c.canonical_url_key)),
    );
  }
  async findDuplicate(key, excludeId) {
    return (
      [...this.cards.values()].find(
        (c) =>
          c.id !== excludeId &&
          c.status !== "duplicate" &&
          (c.canonical_url_key === key || c.source_url_key === key),
      ) ?? null
    );
  }
  async listCards(filters) {
    let items = [...this.cards.values()];
    if (filters.statuses?.length)
      items = items.filter((c) => filters.statuses.includes(c.status));
    if (filters.batchId)
      items = items.filter((c) => c.batch_id === filters.batchId);
    if (filters.publishedFrom)
      items = items.filter(
        (c) => !!c.published_at && c.published_at >= filters.publishedFrom,
      );
    if (filters.publishedTo)
      items = items.filter(
        (c) => !!c.published_at && c.published_at <= filters.publishedTo,
      );
    if (filters.search) {
      const q = filters.search.toLowerCase();
      items = items.filter(
        (c) =>
          c.title?.toLowerCase().includes(q) ||
          c.publisher?.toLowerCase().includes(q),
      );
    }
    const sortKey = filters.sort ?? "created_at";
    const direction = filters.ascending ? 1 : -1;
    items.sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      if (!av !== !bv) return av ? -1 : 1; // nulls last
      return av === bv ? 0 : av > bv ? direction : -direction;
    });
    const start = (filters.page - 1) * filters.pageSize;
    return {
      items: items.slice(start, start + filters.pageSize),
      total: items.length,
    };
  }
  async listLiveCards({ limit, offset }) {
    const live = [...this.cards.values()]
      .filter((c) => c.live_card)
      .sort(
        (a, b) =>
          (b.published_at ?? "").localeCompare(a.published_at ?? "") ||
          (b.site_published_at ?? "").localeCompare(a.site_published_at ?? ""),
      )
      .map(({ id, live_card, site_published_at }) => ({ id, live_card, site_published_at }));
    return { items: live.slice(offset, offset + limit), total: live.length };
  }
  async getLiveCard(id) {
    const card = this.cards.get(id);
    return card?.live_card
      ? { id, live_card: card.live_card, site_published_at: card.site_published_at }
      : null;
  }
  async listCardsByBatch(batchId) {
    return [...this.cards.values()].filter((c) => c.batch_id === batchId);
  }
  async listCardsByStatus(statuses) {
    return [...this.cards.values()].filter((c) => statuses.includes(c.status));
  }
  async updateCard(id, patch) {
    const card = this.cards.get(id);
    if (!card) return null;
    if (patch.canonical_url_key) {
      const clash = [...this.cards.values()].find(
        (c) =>
          c.id !== id &&
          c.status !== "duplicate" &&
          c.canonical_url_key === patch.canonical_url_key,
      );
      if (clash) throw new PipelineError("DUPLICATE", "duplicate canonical");
    }
    const next = { ...card, ...patch, updated_at: new Date().toISOString() };
    this.cards.set(id, next);
    return { ...next };
  }
  async deleteCard(id) {
    this.events = this.events.filter((e) => e.card_id !== id);
    return this.cards.delete(id);
  }
  async getStats() {
    const by = Object.fromEntries(CARD_STATUSES.map((s) => [s, 0]));
    for (const c of this.cards.values()) by[c.status]++;
    return { total: this.cards.size, by_status: by };
  }
  async getProcessedImage(key) {
    return this.images.get(key) ?? null;
  }
  async saveProcessedImage(record) {
    this.images.set(record.cache_key, record);
  }
  async addEvent(event) {
    this.events.push({
      id: this.events.length + 1,
      created_at: new Date().toISOString(),
      ...event,
    });
  }
  async listEvents(cardId, limit) {
    return this.events
      .filter((e) => e.card_id === cardId)
      .reverse()
      .slice(0, limit);
  }
}
