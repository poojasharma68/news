-- The version of a card that is live on the website, saved when an editor presses
-- "Save final changes". The public API serves only this snapshot, so later edits stay off the
-- website until they are approved and saved again. null = not on the website. Safe to run again.
alter table public.news_cards
  add column if not exists live_card jsonb;

create index if not exists news_cards_live_idx
  on public.news_cards (published_at desc nulls last, site_published_at desc)
  where live_card is not null;
