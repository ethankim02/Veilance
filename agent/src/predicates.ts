// Veilance Party Agent — verifier-profile predicate tables (spec.md §4.2.3).
//
// A recorded attestation means the contract's circuit already accepted the
// proof, so every predicate that profile's circuit checks is necessarily
// `true` — there is no partial-pass state on-chain. Predicates a profile's
// circuit does NOT check are reported `null` ("not evaluated by this
// profile"). Since rotate-on-attest (CONTRACT_DESIGN.md) every profile spends
// the credential it proves with, so every profile checks "Duplicate claim".

import type { VerifierProfileName } from "./types.js";

export type Predicate = { readonly key: string; readonly label: string; readonly passed: boolean | null };

const ALL_KEYS = [
  "responsibleSourcing",
  "chainOfCustody",
  "supplierCertification",
  "carbonThreshold",
  "restrictedSource",
  "duplicateClaim",
] as const;

const LABELS: Record<(typeof ALL_KEYS)[number], string> = {
  responsibleSourcing: "Responsible sourcing",
  chainOfCustody: "Valid chain of custody",
  supplierCertification: "Supplier certification",
  carbonThreshold: "Carbon class ≤ threshold",
  restrictedSource: "Restricted source",
  duplicateClaim: "Duplicate claim",
};

/** Which predicates each profile's circuit actually checks (spec.md §4.2.3 result table). */
const CHECKED_BY_PROFILE: Record<VerifierProfileName, ReadonlySet<(typeof ALL_KEYS)[number]>> = {
  consumer: new Set(["responsibleSourcing", "chainOfCustody", "restrictedSource", "duplicateClaim"]),
  procurement: new Set([
    "responsibleSourcing",
    "chainOfCustody",
    "supplierCertification",
    "carbonThreshold",
    "restrictedSource",
    "duplicateClaim",
  ]),
  regulator: new Set([
    "responsibleSourcing",
    "chainOfCustody",
    "supplierCertification",
    "carbonThreshold",
    "restrictedSource",
    "duplicateClaim",
  ]),
};

/** Predicate table for a PASSED attestation under `profile`. */
export const predicatesFor = (profile: VerifierProfileName): Predicate[] => {
  const checked = CHECKED_BY_PROFILE[profile];
  return ALL_KEYS.map((key) => ({
    key,
    label: LABELS[key],
    passed: checked.has(key) ? true : null,
  }));
};

/** All-null predicate table, for PENDING (no attestation recorded yet). */
export const emptyPredicates = (): Predicate[] =>
  ALL_KEYS.map((key) => ({ key, label: LABELS[key], passed: null }));
