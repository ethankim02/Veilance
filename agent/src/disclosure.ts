// Veilance Party Agent — static "what goes on chain" text for the UI's
// disclosure-preview panel (GET /parties/:party/disclosure-preview).
//
// This mirrors the DISCLOSURE comments in contract/src/veilance.compact
// exactly (each circuit's disclose() call sites) — see CONTRACT_DESIGN.md §5
// and NOTES.md §4 for the full analysis this table summarizes.

import type { VerifierProfileName } from "./types.js";

export type DisclosurePreview = { readonly public: string[]; readonly private: string[] };

const ISSUE: DisclosurePreview = {
  public: [
    "new provenance commitment (one-way hash — reveals nothing about owner, origin, material, or carbon class)",
    "sealed inbox entry (192-byte AEAD ciphertext, unreadable without the recipient's private key)",
  ],
  private: ["recipient identity", "origin", "material type", "carbon class", "batch secret"],
};

const TRANSFER: DisclosurePreview = {
  public: [
    "nullifier of the consumed (upstream) credential",
    "new provenance commitment",
    "sealed inbox entry (192-byte AEAD ciphertext, unreadable without the recipient's private key)",
    "recomputed Merkle roots (already public ledger state; do not identify which leaf was proven)",
  ],
  private: [
    "upstream commitment",
    "origin",
    "material type",
    "recipient identity",
    "new carbon class",
    "new batch secret",
  ],
};

const attest = (_profile: VerifierProfileName): DisclosurePreview => ({
  public: [
    "attestation key = H(\"veilance:att\", challenge, holderPartyId, profile) — opaque unless the challenge is known",
    "recomputed Merkle roots (already public ledger state)",
    "nullifier of the attested credential, which is spent here (rotate-on-attest) — never published again, so it links to nothing later",
    "rotated commitment (same credential under a fresh secret — indistinguishable from any other commitment)",
  ],
  private: [
    "which credential was used",
    "origin",
    "material type",
    "carbon class (only the ≤ threshold comparison is proven, never the value itself)",
    "upstream supplier",
  ],
});

export const disclosurePreview = (
  op: "issue" | "transfer" | "attest",
  profile?: VerifierProfileName,
): DisclosurePreview => {
  if (op === "issue") return ISSUE;
  if (op === "transfer") return TRANSFER;
  return attest(profile ?? "consumer");
};
