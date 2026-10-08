// Stand-in for the reader's own database layer in doc snippets. Every
// snippet that writes `import { db } from "./db"` type-checks against this.
type Table = Record<string, (...args: never[]) => Promise<unknown>>;

const table = <T extends Table>(methods: T): T => methods;

export const db = {
  messages: table({
    /** Saves the result of a send so status webhooks can find it by providerId. */
    async create(_row: { id: string; provider: string; providerId: string; to: string; status: string }): Promise<void> {},
    async updateStatus(_providerId: string, _status: string, _errorCode?: string): Promise<void> {},
    async markNeedsReview(_idempotencyKey: string, _reason: string): Promise<void> {},
  }),
  suppressions: table({
    async add(_phoneNumber: string): Promise<void> {},
    async remove(_phoneNumber: string): Promise<void> {},
    async has(_phoneNumber: string): Promise<boolean> {
      return false;
    },
  }),
  inbox: table({
    async save(_message: { from: string; to: string; body: string; providerId: string }): Promise<void> {},
  }),
  webhookEvents: table({
    /** Inserts the key and returns false when it was already there. */
    async insertIfNew(_dedupeKey: string): Promise<boolean> {
      return true;
    },
  }),
};

/** A `pg.Pool`-style client, for snippets that write SQL. */
export const pool = {
  async query<T>(_text: string, _params: unknown[]): Promise<{ rows: T[] }> {
    return { rows: [] };
  },
};
