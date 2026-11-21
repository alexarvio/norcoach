// A client's meal-card order with FOOD_STORE=pg (19 Nov, quest 8 part 1, the food item's question 3 of
// docs/database-plan.md; Alex: "if we have to do it at some point, might as well do it now"). In memory mode the order
// is the client row's `meal_order`, as it always was, and nothing here runs. With FOOD_STORE=pg it lives in
// food_meal_orders, written in the same transaction as the food it orders (rows.ts writeFood) and read with the rows
// (rows.ts fetchScope); the client row's meal_order is its mirror, put there after each commit and saved by the store,
// so a rollback (this build in memory mode, the build before it, d100513) still reads every card's place.
//
// Beside the mirror, the store keeps a stamp of each mirror as this build last put it (kv `food_pg_orders`, client id to
// a hash of the order), saved by the same save as the client rows, so the two are always one save's. At a boot that
// tells the two ways a mirror can differ from the table apart, however many saves were lost:
//   the mirror is the one stamped: this build put it, and a crash came before the save of a later one: the table wins;
//   it isn't: another build changed it since (d100513 or the build before this one, run straight after pg mode, which
//     carry kv's keys without reading them): the mirror wins, and the table takes it;
//   the table has no row for a client whose mirror holds an order: the mirror wins (no write ever deletes a row; the
//     table lacking one is a fresh database, never a client's order taken away). The stamps never leave their database:
//     a JSON leaves them out and an import drops them (rows.ts withFoodKeys, boot.ts dropImportedStamps).
// A limit, accepted: after a crash, an order another build changes and then puts back exactly as stamped reads as this
// build's, and the table's later one wins (a 32-bit stamp's collision the same, at 2^-32).
// After any boot that wasn't this build's pg mode (kv's `food_pg` mark without `orders`: memory mode, the first flip,
// an import), the mirrors are the truth and the table is made from them again, whole. Nothing here reads FOOD_STORE.

import { sql, type SQL } from "drizzle-orm";

type Row = Record<string, unknown>;
type Run = (query: SQL) => Promise<Row[]>;

/** The store's key (kv) for the stamps of the mirrors this build put on the clients. */
export const FOOD_ORDER_STAMPS = "food_pg_orders";

/** An order as compared: its JSON, null for none (absent and null are the same order: none). */
export const orderKey = (o: unknown) => JSON.stringify(o ?? null);

/** A short stamp of an order (FNV-1a, 32 bits): only ever compared with another stamp of the same client's order. */
export function orderStamp(o: unknown): string {
  const s = orderKey(o);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export type OrderRow = { meal_order: string[] | null };
export type OrderClient = { id: number; meal_order?: string[] | null };
type Stamps = Record<string, string>;

const ints = (ids: readonly number[]) => `{${ids.filter((n) => Number.isInteger(n)).join(",")}}`;
const asList = (v: unknown): string[] | null => (Array.isArray(v) ? (v as string[]) : null);

/** These clients' rows of food_meal_orders (null: every row), by client. */
export async function readOrders(q: Run, clientIds: readonly number[] | null): Promise<Map<number, OrderRow>> {
  const out = new Map<number, OrderRow>();
  if (clientIds && !clientIds.length) return out;
  const rows = await q(clientIds ? sql`SELECT client_id, meal_order FROM food_meal_orders WHERE client_id = ANY(${ints(clientIds)}::int[])` : sql`SELECT client_id, meal_order FROM food_meal_orders`);
  for (const r of rows) out.set(Number(r.client_id), { meal_order: asList(r.meal_order) });
  return out;
}

/** The stamps in the store (an object of client id to stamp), or an empty one. */
export function stampsOf(data: unknown): Stamps {
  const s = (data as Record<string, unknown>)[FOOD_ORDER_STAMPS];
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Stamps) : {};
}

/**
 * After this build's pg mode, for each client which side is right (above): `toStore`, the table's order onto the
 * client; `toTable`, the client's into the table; `orphans`, rows of clients no longer in the store.
 */
export function reconcileOrders(rows: ReadonlyMap<number, OrderRow>, clients: readonly OrderClient[], stamps: Stamps) {
  const toStore: { client: OrderClient; order: string[] | null }[] = [];
  const toTable: { clientId: number; order: string[] | null }[] = [];
  const here = new Set<number>();
  for (const c of clients) {
    here.add(c.id);
    const mirror = Array.isArray(c.meal_order) ? c.meal_order : null;
    const row = rows.get(c.id);
    const table = row?.meal_order ?? null;
    if (orderKey(mirror) === orderKey(table)) continue;
    // A client with an order and no row: the table never lost one by a write (no code path sets an order to none, so
    // writeOrder never deletes a row; the erase and the reset take the client too), so the table is the one missing it
    // (a database made fresh from a JSON whose stamps came along, the review's fix of 20 Nov): the mirror, never none.
    if (!row && mirror) toTable.push({ clientId: c.id, order: mirror });
    // No stamp is the stamp of no order: this build never put one there (a client with none when the table was made).
    else if ((stamps[String(c.id)] ?? orderStamp(null)) === orderStamp(mirror)) toStore.push({ client: c, order: table });
    else toTable.push({ clientId: c.id, order: mirror });
  }
  const orphans = [...rows.keys()].filter((id) => !here.has(id));
  return { toStore, toTable, orphans };
}

/** An order put on a client row in memory (or taken off it), as a write's mirror puts it (rows.ts writeFood). */
export function putOnClient(c: OrderClient, order: string[] | null): boolean {
  if (orderKey(c.meal_order) === orderKey(order)) return false;
  if (order) c.meal_order = order;
  else delete c.meal_order;
  return true;
}

/** One client's stamp made its mirror's (none: no entry). True when it changed. */
export function stampClient(data: unknown, c: OrderClient): boolean {
  const d = data as Record<string, unknown>;
  const stamps = { ...stampsOf(d) };
  const want = Array.isArray(c.meal_order) ? orderStamp(c.meal_order) : undefined;
  if (stamps[String(c.id)] === want) return false;
  if (want === undefined) delete stamps[String(c.id)];
  else stamps[String(c.id)] = want;
  d[FOOD_ORDER_STAMPS] = stamps;
  return true;
}

/** Every client's stamp made its mirror's, the stamps of clients gone dropped. True when the stamps changed. */
export function restampAll(data: unknown, clients: readonly OrderClient[]): boolean {
  const d = data as Record<string, unknown>;
  const next: Stamps = {};
  for (const c of clients) if (Array.isArray(c.meal_order)) next[String(c.id)] = orderStamp(c.meal_order);
  if (FOOD_ORDER_STAMPS in d && JSON.stringify(stampsOf(d)) === JSON.stringify(next)) return false;
  d[FOOD_ORDER_STAMPS] = next;
  return true;
}
