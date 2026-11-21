// A once key a FOOD_STORE=pg write found taken already (quest 8 part 1; food/rows.ts writeFood claims the key in its own
// transaction): the write that took it committed, perhaps before a crash took the store's copy of the key with it. Thrown
// before anything is written; lib/once.ts answers it as it answers a key it knows. Never thrown in memory mode. No
// imports, so once.ts can know it without loading the door.

export type AnsweredRow = { key: string; at: number; result?: unknown; redirect?: string };

export class OnceAnswered extends Error {
  readonly row: AnsweredRow;
  constructor(row: AnsweredRow) {
    super("[food] this save was taken once already");
    this.name = "OnceAnswered";
    this.row = row;
  }
}
