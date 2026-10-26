/**
 * Persistence boundary. Implemented by SupabaseRepository (supabaseService.js);
 * tests use the in-memory version (memoryRepository.js). Both must provide these methods:
 *
 *   createBatch({ submitted_count, skipped, created_by })  -> Promise<NewsBatch>
 *   getBatch(id)                                          -> Promise<NewsBatch | null>
 *   listBatches(limit)                                    -> Promise<NewsBatch[]>
 *
 *   insertCards(rows: NewCardInput[])                     -> Promise<NewsCard[]>
 *   getCard(id)                                           -> Promise<NewsCard | null>
 *   getCardsByIds(ids)                                    -> Promise<NewsCard[]>
 *   findCardsByUrlKeys(keys)    cards whose source_url_key or canonical_url_key matches any key
 *   findDuplicate(key, excludeId)  another card (≠ excludeId) already representing this URL key
 *   listCards(filters: CardFilters)                       -> Promise<{ items, total }>
 *   listCardsByBatch(batchId)                             -> Promise<NewsCard[]>
 *   listCardsByStatus(statuses)                           -> Promise<NewsCard[]>
 *   updateCard(id, patch)       resolves null when the card no longer exists (e.g. deleted while processing)
 *   deleteCard(id)                                        -> Promise<boolean>
 *   getStats()                                            -> Promise<CardStats>
 *
 *   getProcessedImage(cacheKey)                           -> Promise<ProcessedImageRecord | null>
 *   saveProcessedImage(record)                            -> Promise<void>
 *
 *   addEvent(event: CardEvent)                            -> Promise<void>
 *   listEvents(cardId, limit)   newest first              -> Promise<CardEvent[]>
 *
 * Shapes:
 *   NewCardInput         { batch_id, source_url, source_url_key, status, processing_stage }
 *   CardFilters          { search?, statuses?, publishedFrom?, publishedTo?, batchId?, page, pageSize,
 *                          sort?: 'created_at' | 'published_at' | 'updated_at', ascending? }
 *   ProcessedImageRecord { cache_key, cdn_url, width, height, format }
 *   CardEvent            { card_id, event, status, message, actor, correlation_id }
 */
export {};
