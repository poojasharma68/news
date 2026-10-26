/**
 * Supabase (PostgreSQL) persistence. Runs on the server with the service-role key, which must
 * never be exposed to the browser. Row Level Security is enabled on every table (see migration).
 */
import { createClient } from "@supabase/supabase-js";
import { CARD_STATUSES } from "../../shared/types.js";
import { PipelineError } from "../lib/errors.js";

export function createSupabaseAdminClient(url, serviceRoleKey) {
  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/** Removes characters that carry meaning in PostgREST filter syntax. */
export function sanitizeSearch(term) {
  return term
    .replace(/[%_,()\\*"']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function dbError(error, action) {
  if (error.code === "23505") {
    return new PipelineError(
      "DUPLICATE",
      "Another card already exists for this article URL.",
    );
  }
  return new PipelineError(
    "DB_ERROR",
    `Database error while ${action}: ${error.message}`,
    { retryable: true },
  );
}

function normaliseCard(row) {
  const card = row;
  return {
    ...card,
    image_candidates: card.image_candidates ?? [],
    image_variants: card.image_variants ?? {},
    missing_fields: card.missing_fields ?? [],
    warnings: card.warnings ?? [],
  };
}

export class SupabaseRepository {
  constructor(db) {
    this.db = db;
  }

  async createBatch(input) {
    const { data, error } = await this.db
      .from("news_batches")
      .insert(input)
      .select()
      .single();
    if (error) throw dbError(error, "creating the batch");
    return data;
  }

  async getBatch(id) {
    const { data, error } = await this.db
      .from("news_batches")
      .select()
      .eq("id", id)
      .maybeSingle();
    if (error) throw dbError(error, "loading the batch");
    return data ?? null;
  }

  async listBatches(limit) {
    const { data, error } = await this.db
      .from("news_batches")
      .select()
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw dbError(error, "listing batches");
    return data ?? [];
  }

  async insertCards(rows) {
    if (!rows.length) return [];
    // ignoreDuplicates makes concurrent submissions of the same URL safe: only one row is created.
    const { data, error } = await this.db
      .from("news_cards")
      .upsert(rows, { onConflict: "source_url_key", ignoreDuplicates: true })
      .select();
    if (error) throw dbError(error, "creating cards");
    return (data ?? []).map(normaliseCard);
  }

  async getCard(id) {
    const { data, error } = await this.db
      .from("news_cards")
      .select()
      .eq("id", id)
      .maybeSingle();
    if (error) throw dbError(error, "loading the card");
    return data ? normaliseCard(data) : null;
  }

  async getCardsByIds(ids) {
    if (!ids.length) return [];
    const { data, error } = await this.db
      .from("news_cards")
      .select()
      .in("id", ids);
    if (error) throw dbError(error, "loading cards");
    return (data ?? []).map(normaliseCard);
  }

  async findCardsByUrlKeys(keys) {
    if (!keys.length) return [];
    const [bySource, byCanonical] = await Promise.all([
      this.db.from("news_cards").select().in("source_url_key", keys),
      this.db.from("news_cards").select().in("canonical_url_key", keys),
    ]);
    if (bySource.error)
      throw dbError(bySource.error, "checking for duplicates");
    if (byCanonical.error)
      throw dbError(byCanonical.error, "checking for duplicates");
    const seen = new Map();
    for (const row of [...(bySource.data ?? []), ...(byCanonical.data ?? [])])
      seen.set(row.id, normaliseCard(row));
    return [...seen.values()];
  }

  async findDuplicate(key, excludeId) {
    const { data, error } = await this.db
      .from("news_cards")
      .select()
      .neq("id", excludeId)
      .neq("status", "duplicate")
      .or(
        `canonical_url_key.eq."${key.replace(/"/g, "")}",source_url_key.eq."${key.replace(/"/g, "")}"`,
      )
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) throw dbError(error, "checking for duplicates");
    return data?.[0] ? normaliseCard(data[0]) : null;
  }

  async listCards(filters) {
    let query = this.db.from("news_cards").select("*", { count: "exact" });
    if (filters.statuses?.length) query = query.in("status", filters.statuses);
    if (filters.batchId) query = query.eq("batch_id", filters.batchId);
    if (filters.publishedFrom)
      query = query.gte("published_at", filters.publishedFrom);
    if (filters.publishedTo)
      query = query.lte("published_at", filters.publishedTo);
    const term = filters.search ? sanitizeSearch(filters.search) : "";
    if (term)
      query = query.or(`title.ilike."%${term}%",publisher.ilike."%${term}%"`);

    const from = (filters.page - 1) * filters.pageSize;
    const { data, error, count } = await query
      .order(filters.sort ?? "created_at", {
        ascending: filters.ascending ?? false,
        nullsFirst: false,
      })
      .order("id", { ascending: true })
      .range(from, from + filters.pageSize - 1);
    if (error) throw dbError(error, "listing cards");
    return { items: (data ?? []).map(normaliseCard), total: count ?? 0 };
  }

  /** Cards on the website (with a saved live version), newest article first. */
  async listLiveCards({ limit, offset }) {
    const { data, error, count } = await this.db
      .from("news_cards")
      .select("id, live_card, site_published_at", { count: "exact" })
      .not("live_card", "is", null)
      .order("published_at", { ascending: false, nullsFirst: false })
      .order("site_published_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw dbError(error, "listing live cards");
    return { items: data ?? [], total: count ?? 0 };
  }

  async getLiveCard(id) {
    const { data, error } = await this.db
      .from("news_cards")
      .select("id, live_card, site_published_at")
      .eq("id", id)
      .not("live_card", "is", null)
      .maybeSingle();
    if (error) throw dbError(error, "loading the live card");
    return data ?? null;
  }

  async listCardsByBatch(batchId) {
    const { data, error } = await this.db
      .from("news_cards")
      .select()
      .eq("batch_id", batchId)
      .order("created_at", { ascending: true });
    if (error) throw dbError(error, "loading batch cards");
    return (data ?? []).map(normaliseCard);
  }

  async listCardsByStatus(statuses) {
    const { data, error } = await this.db
      .from("news_cards")
      .select()
      .in("status", statuses)
      .order("created_at", { ascending: true });
    if (error) throw dbError(error, "loading cards by status");
    return (data ?? []).map(normaliseCard);
  }

  async updateCard(id, patch) {
    const { data, error } = await this.db
      .from("news_cards")
      .update(patch)
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) throw dbError(error, "updating the card");
    return data ? normaliseCard(data) : null;
  }

  async deleteCard(id) {
    const { data, error } = await this.db
      .from("news_cards")
      .delete()
      .eq("id", id)
      .select("id");
    if (error) throw dbError(error, "deleting the card");
    return (data ?? []).length > 0;
  }

  async getStats() {
    const { data, error } = await this.db.rpc("news_card_stats");
    if (error) throw dbError(error, "loading statistics");
    const byStatus = Object.fromEntries(CARD_STATUSES.map((s) => [s, 0]));
    let total = 0;
    for (const row of data ?? []) {
      const count = Number(row.count);
      if (row.status in byStatus) byStatus[row.status] = count;
      total += count;
    }
    return { total, by_status: byStatus };
  }

  async getProcessedImage(cacheKey) {
    const { data, error } = await this.db
      .from("processed_images")
      .select()
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (error) throw dbError(error, "checking the image cache");
    return data ?? null;
  }

  async saveProcessedImage(record) {
    const { error } = await this.db
      .from("processed_images")
      .upsert(record, { onConflict: "cache_key" });
    if (error) throw dbError(error, "saving the image cache");
  }

  async addEvent(event) {
    const { error } = await this.db.from("news_card_events").insert(event);
    if (error) throw dbError(error, "recording the card event");
  }

  async listEvents(cardId, limit) {
    const { data, error } = await this.db
      .from("news_card_events")
      .select()
      .eq("card_id", cardId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (error) throw dbError(error, "loading the card history");
    return data ?? [];
  }
}
