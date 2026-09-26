// Veilance B-2 — the node's wallet provider: fees and submission both go
// through the sponsor over HTTP (submission there, so a rejected transaction
// releases the DUST it booked). A node never holds funds, and the sponsor
// never holds secrets.

import * as ledger from "@midnight-ntwrk/ledger-v8";
import type { MidnightProvider, WalletProvider } from "@midnight-ntwrk/midnight-js-types";

import { fromHex, toHex } from "../bytes.js";
import { SPONSOR_TOKEN, SPONSOR_URL } from "./config.js";

type Identity = { coinPublicKey: string; encryptionPublicKey: string; networkId: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until the sponsor answers with its identity (it may still be syncing its wallet). */
export const fetchSponsorIdentity = async (onWait?: (step: string) => void): Promise<Identity> => {
  for (;;) {
    try {
      const res = await fetch(`${SPONSOR_URL}/sponsor/identity`);
      if (res.ok) return (await res.json()) as Identity;
      const body = (await res.json().catch(() => ({}))) as { step?: string };
      onWait?.(`waiting for sponsor (${body.step ?? res.status})`);
    } catch {
      onWait?.(`waiting for sponsor at ${SPONSOR_URL}`);
    }
    await sleep(3_000);
  }
};

export const createSponsoredProvider = (identity: Identity): WalletProvider & MidnightProvider => {
  return {
    getCoinPublicKey: () => identity.coinPublicKey,
    getEncryptionPublicKey: () => identity.encryptionPublicKey,
    balanceTx: async (tx) => {
      const res = await fetch(`${SPONSOR_URL}/sponsor/balance`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SPONSOR_TOKEN}` },
        body: JSON.stringify({ txHex: toHex(tx.serialize()) }),
      });
      const body = (await res.json().catch(() => ({}))) as { txHex?: string; error?: string };
      if (!res.ok || !body.txHex) throw new Error(`sponsor refused to balance: ${body.error ?? res.status}`);
      return ledger.Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.Binding>(
        "signature",
        "proof",
        "binding",
        fromHex(body.txHex),
      );
    },
    submitTx: async (tx) => {
      const res = await fetch(`${SPONSOR_URL}/sponsor/submit`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SPONSOR_TOKEN}` },
        body: JSON.stringify({ txHex: toHex(tx.serialize()) }),
      });
      const body = (await res.json().catch(() => ({}))) as { txId?: string; error?: string };
      if (!res.ok || !body.txId) throw new Error(`sponsor could not submit: ${body.error ?? res.status}`);
      return body.txId as never;
    },
  };
};
