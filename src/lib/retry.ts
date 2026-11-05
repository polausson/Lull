export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries with exponential backoff (0.5s, 1s, 2s, …). */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4, baseMs = 500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < attempts - 1) await sleep(baseMs * 2 ** i); }
  }
  throw last;
}

/** Turns a Supabase `{ data, error }` result into a value or a thrown error. */
export function unwrap<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}
