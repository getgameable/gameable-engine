-- The player store. Applied once by migrate() and recorded in schema_migrations.
-- A document is the game's JSON; version starts at 1 and goes up by one on every write.
create table if not exists player_data (
  game text not null,
  player text not null,
  version integer not null,
  doc jsonb not null,
  saved_at timestamptz not null default now(),
  primary key (game, player)
);

create table if not exists game_data (
  game text primary key,
  version integer not null,
  doc jsonb not null,
  saved_at timestamptz not null default now()
);

-- A ledger of exchanges, written in the exchange's own transaction. give and take are what the
-- room said the exchange was for (JSON); 'null' when it said nothing.
create table if not exists exchanges (
  id bigserial primary key,
  game text not null,
  a text not null,
  b text not null,
  give jsonb not null,
  take jsonb not null,
  at timestamptz not null default now()
);
