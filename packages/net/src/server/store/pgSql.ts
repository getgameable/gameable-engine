/**
 * Every statement the Postgres store runs. All take their values as
 * parameters ($1...); nothing is ever spliced into the text.
 * `doc::text` comes back as a string; `saved_at` as ms since the epoch.
 */

const DOC_COLUMNS =
  'version, doc::text as data, (extract(epoch from saved_at) * 1000)::float8 as saved_at';

/** One row as the store's selects return it. */
export interface DocRow {
  version: number;
  data: string;
  saved_at: number;
}

/** A player's statements: keyed on ($1 game, $2 player). */
export const PLAYER_SQL = {
  load: `select ${DOC_COLUMNS} from player_data where game = $1 and player = $2`,
  lock: `select ${DOC_COLUMNS} from player_data where game = $1 and player = $2 for update`,
  /** $3 doc. A row already there means another writer got version 1 first: no row back. */
  create: `insert into player_data (game, player, version, doc) values ($1, $2, 1, $3::jsonb)
    on conflict (game, player) do nothing returning version`,
  /** $3 expected version, $4 doc. No row back when the stored version is not $3. */
  update: `update player_data set version = version + 1, doc = $4::jsonb, saved_at = now()
    where game = $1 and player = $2 and version = $3 returning version`,
} as const;

/** The game's own document: keyed on ($1 game). */
export const GAME_SQL = {
  load: `select ${DOC_COLUMNS} from game_data where game = $1`,
  /** $2 doc. */
  create: `insert into game_data (game, version, doc) values ($1, 1, $2::jsonb)
    on conflict (game) do nothing returning version`,
  /** $2 expected version, $3 doc. */
  update: `update game_data set version = version + 1, doc = $3::jsonb, saved_at = now()
    where game = $1 and version = $2 returning version`,
} as const;

/** ($1 game, $2 a, $3 b, $4 give, $5 take): one ledger line, in the exchange's transaction. */
export const LEDGER_SQL =
  'insert into exchanges (game, a, b, give, take) values ($1, $2, $3, $4::jsonb, $5::jsonb)';
