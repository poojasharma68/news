-- Three card outputs per article and an activity log. Additive and safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────────
-- Featured-image variants: one CDN image per card placement, derived from one master record.
--   { "large":  { "url": "https://cdn…/…webp", "width": 800, "height": 450 },
--     "medium": { … }, "small": { … } }
-- cdn_image_url stays as a mirror of the large variant for existing consumers.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.news_cards
  add column if not exists image_variants jsonb not null default '{}'::jsonb;

alter table public.news_cards drop constraint if exists news_cards_image_variants_object;
alter table public.news_cards
  add constraint news_cards_image_variants_object check (jsonb_typeof(image_variants) = 'object');

-- Existing thumbnails are the large card size. Medium/small are generated on the next retry.
update public.news_cards
set image_variants = jsonb_build_object(
  'large', jsonb_build_object('url', cdn_image_url, 'width', image_width, 'height', image_height)
)
where cdn_image_url is not null and image_variants = '{}'::jsonb;

-- ─────────────────────────────────────────────────────────────────────────────
-- Card activity log: processing events, retries, edits, approvals, publish confirmations.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.news_card_events (
  id              bigint generated always as identity primary key,
  card_id         uuid not null references public.news_cards (id) on delete cascade,
  event           text not null check (event ~ '^[a-z_]{1,40}$'),
  status          text,
  message         text check (message is null or length(message) <= 2000),
  actor           text,
  correlation_id  text,                         -- job id shared by every attempt of one job
  created_at      timestamptz not null default now()
);

create index if not exists news_card_events_card_idx
  on public.news_card_events (card_id, created_at desc);
create index if not exists news_card_events_correlation_idx
  on public.news_card_events (correlation_id) where correlation_id is not null;

alter table public.news_card_events enable row level security;
revoke all on public.news_card_events from anon;

-- The log is append-only for editors: they may read it; only the API (service role) writes it.
drop policy if exists "admins read card events" on public.news_card_events;
create policy "admins read card events" on public.news_card_events
  for select to authenticated using (public.is_news_admin());
