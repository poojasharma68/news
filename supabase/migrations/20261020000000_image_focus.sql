-- Focus point of the featured image per card variant, set by an editor:
--   {"large": {"x": 0..1, "y": 0..1}, "medium": {...}, "small": {...}}
-- (as CSS object-position, from the left/top). A variant without a point uses the automatic
-- crop; null = automatic crop for every variant. Safe to run again.
alter table public.news_cards
  add column if not exists image_focus jsonb;

-- CHECK constraints cannot contain subqueries, so the shape is validated in a function.
create or replace function public.news_card_image_focus_ok(focus jsonb)
returns boolean
language sql
immutable
as $$
  select focus is null or (
    jsonb_typeof(focus) = 'object'
    and not exists (
      select 1
      from jsonb_each(focus) as e(key, point)
      -- CASE keeps the numeric casts from running on values that are not numbers.
      where case
        when e.key not in ('large', 'medium', 'small') then true
        when jsonb_typeof(e.point) is distinct from 'object' then true
        when jsonb_typeof(e.point -> 'x') is distinct from 'number'
          or jsonb_typeof(e.point -> 'y') is distinct from 'number' then true
        else (e.point ->> 'x')::numeric not between 0 and 1
          or (e.point ->> 'y')::numeric not between 0 and 1
      end
    )
  )
$$;

alter table public.news_cards drop constraint if exists news_cards_image_focus_point;
alter table public.news_cards
  add constraint news_cards_image_focus_point
  check (public.news_card_image_focus_ok(image_focus));
