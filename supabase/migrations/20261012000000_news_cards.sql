-- News Card Automation Platform — initial schema
-- Apply with the Supabase CLI (`supabase db push`) or paste into the SQL editor.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ─────────────────────────────────────────────────────────────────────────────
-- Admin allow-list (used by RLS policies for direct authenticated access)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.admin_users (
  email       text primary key check (email = lower(email)),
  created_at  timestamptz not null default now()
);

create or replace function public.is_news_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.is_news_admin() from public;
grant execute on function public.is_news_admin() to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Batches: one row per "Fetch All News" submission
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.news_batches (
  id               uuid primary key default gen_random_uuid(),
  submitted_count  integer not null default 0 check (submitted_count >= 0),
  skipped          jsonb not null default '[]'::jsonb,
  created_by       text,
  created_at       timestamptz not null default now()
);

create index if not exists news_batches_created_at_idx on public.news_batches (created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- News cards
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.news_cards (
  id                   uuid primary key default gen_random_uuid(),
  batch_id             uuid references public.news_batches (id) on delete set null,

  source_url           text not null,                 -- original URL exactly as submitted
  source_url_key       text not null,                 -- normalised key for de-duplication
  canonical_url        text,                          -- canonical article URL (Read More link)
  canonical_url_key    text,

  publisher            text,
  title                text,                          -- complete title, never truncated
  description          text,                          -- complete description, never truncated
  published_at         timestamptz,

  original_image_url   text,                          -- publisher image used for the card
  image_candidates     text[] not null default '{}',  -- other images found on the page
  cdn_image_url        text,                          -- processed image on the existing CDN
  cdn_image_source     text,                          -- source URL or "upload:<sha256>"
  image_hash           text,
  image_width          integer,
  image_height         integer,

  status               text not null default 'queued',
  processing_stage     text,
  extraction_method    text,
  missing_fields       text[] not null default '{}',
  warnings             text[] not null default '{}',
  verification_reason  text,
  error_code           text,
  error_message        text,
  attempts             integer not null default 0 check (attempts >= 0),
  duplicate_of         uuid references public.news_cards (id) on delete set null,

  approved_at          timestamptz,
  approved_by          text,
  site_published_at    timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint news_cards_status_check check (status in (
    'queued', 'processing', 'completed', 'partial_data', 'verification_required',
    'needs_review', 'approved', 'published', 'failed', 'cancelled', 'duplicate'
  )),
  constraint news_cards_stage_check check (processing_stage is null or processing_stage in (
    'queued', 'validating_url', 'extracting', 'validating_image', 'processing_image', 'uploading', 'saving', 'done'
  )),
  constraint news_cards_method_check check (extraction_method is null or extraction_method in (
    'metadata', 'browser', 'api', 'rss', 'manual'
  )),
  constraint news_cards_source_url_scheme check (source_url ~* '^https?://'),
  constraint news_cards_canonical_url_scheme check (canonical_url is null or canonical_url ~* '^https?://'),
  constraint news_cards_cdn_url_scheme check (cdn_image_url is null or cdn_image_url ~* '^https?://')
);

-- De-duplication: one card per submitted URL, and one per canonical article URL.
create unique index if not exists news_cards_source_url_key_uidx on public.news_cards (source_url_key);
create unique index if not exists news_cards_canonical_url_key_uidx
  on public.news_cards (canonical_url_key)
  where canonical_url_key is not null and status <> 'duplicate';

create index if not exists news_cards_status_idx        on public.news_cards (status);
create index if not exists news_cards_batch_idx         on public.news_cards (batch_id);
create index if not exists news_cards_created_at_idx    on public.news_cards (created_at desc);
create index if not exists news_cards_published_at_idx  on public.news_cards (published_at desc nulls last);
create index if not exists news_cards_title_trgm_idx     on public.news_cards using gin (title gin_trgm_ops);
create index if not exists news_cards_publisher_trgm_idx on public.news_cards using gin (publisher gin_trgm_ops);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists news_cards_set_updated_at on public.news_cards;
create trigger news_cards_set_updated_at
  before update on public.news_cards
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Processed image cache: identical source bytes + output spec are uploaded once
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.processed_images (
  cache_key   text primary key,
  cdn_url     text not null check (cdn_url ~* '^https?://'),
  width       integer,
  height      integer,
  format      text,
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Dashboard statistics
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.news_card_stats()
returns table (status text, count bigint)
language sql
stable
set search_path = public
as $$
  select c.status, count(*)::bigint
  from public.news_cards c
  where (auth.jwt() ->> 'role') = 'service_role' or public.is_news_admin()
  group by c.status;
$$;

revoke all on function public.news_card_stats() from public, anon;
grant execute on function public.news_card_stats() to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- The API uses the service-role key (bypasses RLS) and enforces admin auth itself.
-- These policies protect the tables from the public anon key and allow only
-- allow-listed admins to read/write directly with their own Supabase session.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.admin_users      enable row level security;
alter table public.news_batches     enable row level security;
alter table public.news_cards       enable row level security;
alter table public.processed_images enable row level security;

revoke all on public.admin_users, public.news_batches, public.news_cards, public.processed_images from anon;

drop policy if exists "admins read admin list" on public.admin_users;
create policy "admins read admin list" on public.admin_users
  for select to authenticated using (public.is_news_admin());

drop policy if exists "admins manage batches" on public.news_batches;
create policy "admins manage batches" on public.news_batches
  for all to authenticated using (public.is_news_admin()) with check (public.is_news_admin());

drop policy if exists "admins manage cards" on public.news_cards;
create policy "admins manage cards" on public.news_cards
  for all to authenticated using (public.is_news_admin()) with check (public.is_news_admin());

drop policy if exists "admins read image cache" on public.processed_images;
create policy "admins read image cache" on public.processed_images
  for select to authenticated using (public.is_news_admin());

-- Add dashboard administrators (lower-case), e.g.:
-- insert into public.admin_users (email) values ('editor@mastersunion.org') on conflict do nothing;
