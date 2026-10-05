/**
 * The Postgres exchange: one transaction that locks both players' rows,
 * checks both versions, runs `apply`, writes both documents and a ledger
 * line, or rolls everything back.
 */
import type { PoolClient } from 'pg';
import { docRefusal, runApply } from './docCheck.js';
import { LEDGER_SQL, PLAYER_SQL, type DocRow } from './pgSql.js';
import type { ExchangeApply, ExchangeNote, ExchangeResult } from './types.js';

/** One side of the exchange. */
interface Side {
  player: string;
  expected: number;
  row: DocRow | undefined;
  next: string;
}

/**
 * Runs the exchange on `client` (already checked out of the pool). Rows are
 * locked with `select ... for update` in one stable order, sorted by player
 * id, so two opposite exchanges wait for each other instead of deadlocking.
 * A player with no row yet cannot be locked; its write is an
 * `insert ... on conflict do nothing`, done in the same sorted order, and a
 * row that appeared meanwhile makes the exchange `stale`. Rejects only on a
 * database error, after rolling back; the caller maps that to `unavailable`.
 */
export async function exchangeTx(
  client: PoolClient,
  game: string,
  ids: { a: string; b: string },
  apply: ExchangeApply,
  expected: { a: number; b: number },
  note: ExchangeNote | undefined,
): Promise<ExchangeResult> {
  const sides: Side[] = [
    { player: ids.a, expected: expected.a, row: undefined, next: '' },
    { player: ids.b, expected: expected.b, row: undefined, next: '' },
  ];
  const lockOrder = [...sides].sort((x, y) => (x.player < y.player ? -1 : 1));
  await client.query('begin');
  try {
    for (const side of lockOrder) {
      [side.row] = (await client.query<DocRow>(PLAYER_SQL.lock, [game, side.player])).rows as (
        DocRow | undefined
      )[];
      if ((side.row?.version ?? 0) !== side.expected) return await rollback(client, 'stale');
    }
    const [a, b] = sides as [Side, Side];
    const next = runApply(apply, a.row?.data ?? null, b.row?.data ?? null);
    if (typeof next === 'string') return await rollback(client, next);
    a.next = next.a;
    b.next = next.b;
    for (const side of lockOrder) {
      const written =
        side.expected === 0
          ? await client.query(PLAYER_SQL.create, [game, side.player, side.next])
          : await client.query(PLAYER_SQL.update, [game, side.player, side.expected, side.next]);
      if (written.rowCount !== 1) return await rollback(client, 'stale');
    }
    await client.query(LEDGER_SQL, [
      game,
      ids.a,
      ids.b,
      ledgerJson(note?.give),
      ledgerJson(note?.take),
    ]);
    await client.query('commit');
    return { ok: true, versions: { a: expected.a + 1, b: expected.b + 1 } };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

/** A note as `jsonb` can take it: JSON as given, anything else as a JSON string of its first 1000 characters. */
function ledgerJson(text: string | undefined): string {
  if (text === undefined) return 'null';
  return docRefusal(text) === null
    ? text
    : JSON.stringify(text.slice(0, 1000).replaceAll(String.fromCharCode(0), ''));
}

async function rollback(
  client: PoolClient,
  reason: 'stale' | 'refused' | 'size' | 'invalid',
): Promise<ExchangeResult> {
  await client.query('rollback');
  return { ok: false, reason };
}
