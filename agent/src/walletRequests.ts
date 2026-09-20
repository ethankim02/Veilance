// Veilance Party Agent — delegated-wallet pending-request registry.
//
// Deliberately has NO knowledge of ledger types, jobs, or HTTP — it is a
// generic "park a promise under an id, resolve/reject it from elsewhere, or
// time it out" registry, so it can be unit-tested (delegatedWallet.test.ts)
// without needing a real Transaction to serialize/deserialize. delegatedWallet.ts
// is the thin ledger-aware layer on top of this.

export type WalletResultPayload = { readonly balancedTxHex: string } | { readonly error: string };
/** The only shape a parked request's promise ever actually resolves with — an `{ error }` payload rejects instead (see `resolveWalletRequest`), so callers never need to re-check `"balancedTxHex" in payload` after awaiting. */
export type WalletSuccessPayload = Extract<WalletResultPayload, { balancedTxHex: string }>;

/** Jobs time out of `awaiting_wallet` after this long (agent/API.md v1.4 addendum). */
export const WALLET_TIMEOUT_MS = 5 * 60 * 1000;

type Pending = {
  readonly resolve: (payload: WalletSuccessPayload) => void;
  readonly reject: (err: Error) => void;
};

const pending = new Map<string, Pending>();

/**
 * Registers `id` and returns a promise that settles when {@link resolveWalletRequest}
 * is called with it, or rejects with `Error("wallet did not respond")` after
 * `timeoutMs` (default {@link WALLET_TIMEOUT_MS}). Safe to call with the same
 * `id` only once — a second `park` for an id already pending overwrites the
 * first entry (the first promise is simply never settled by `resolveWalletRequest`
 * again; callers are expected to generate a fresh id per request, see
 * delegatedWallet.ts's `randomUUID()`).
 */
export const parkWalletRequest = (id: string, timeoutMs: number = WALLET_TIMEOUT_MS): Promise<WalletSuccessPayload> =>
  new Promise<WalletSuccessPayload>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("wallet did not respond"));
    }, timeoutMs);
    // Deliberately left ref'd (the default): the agent is a long-lived HTTP
    // server, so this never needs to artificially keep the process alive —
    // but unref'ing it is a trap for anything shorter-lived (a standalone
    // test or CLI script): if an unref'd timer becomes the only thing left
    // for the event loop to wait on, Node exits immediately instead of
    // waiting for it, and the timer simply never fires. Found by exactly
    // that happening to this file's own test (walletRequests.test.ts) —
    // process exited 0 with no output, silently skipping the timeout case.
    pending.set(id, {
      resolve: (payload) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(payload);
      },
      reject: (err) => {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      },
    });
  });

/**
 * Settles the promise `parkWalletRequest(id)` returned. Returns `true` if
 * `id` was still pending (the usual case), `false` if it had already
 * settled (timed out, or resolved/rejected twice — the HTTP handler treats
 * `false` as "404 / already handled", not an error) — see
 * `POST /jobs/:id/wallet-result`'s route handler.
 */
export const resolveWalletRequest = (id: string, payload: WalletResultPayload): boolean => {
  const entry = pending.get(id);
  if (!entry) return false;
  if ("error" in payload) entry.reject(new Error(payload.error));
  else entry.resolve(payload);
  return true;
};

/** For tests and `GET /wallet/session` diagnostics only. */
export const isWalletRequestPending = (id: string): boolean => pending.has(id);
