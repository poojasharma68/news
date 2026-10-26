-- Publisher (press) logo shown next to the publisher name on news cards.
alter table public.news_cards
  add column if not exists publisher_logo_url      text,  -- logo found on the publisher's page
  add column if not exists cdn_publisher_logo_url  text;  -- processed logo on the existing CDN
