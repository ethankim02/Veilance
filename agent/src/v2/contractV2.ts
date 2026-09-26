// Veilance B-2 — compiled v2 contract, per-tenant providers, deploy / find.

import path from "node:path";
import { Level } from "level";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { sampleSigningKey } from "@midnight-ntwrk/compact-runtime";
import {
  createUnprovenDeployTx,
  deployContract,
  findDeployedContract,
  submitInsertVerifierKeyTx,
  submitTx,
} from "@midnight-ntwrk/midnight-js-contracts";
import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { SucceedEntirely } from "@midnight-ntwrk/midnight-js-types";
import { ttlOneHour } from "@midnight-ntwrk/midnight-js-utils";
import type { DeployedContract, FoundContract } from "@midnight-ntwrk/midnight-js-contracts";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import type { MidnightProvider, MidnightProviders, WalletProvider } from "@midnight-ntwrk/midnight-js-types";

import { Contract, ledger as ledgerOf, type Ledger } from "../../../contract/src/managed/veilance_v2/contract/index.js";
import { witnessesV2, type V2PrivateState } from "../../../contract/src/witnesses_v2.js";
import { INDEXER_HTTP_URL, INDEXER_WS_URL, PRIVATE_STATE_PASSWORD, PROOF_SERVER_URL } from "../../../contract/e2e/lib/config.js";
import { V2_STATE_DIR, ZK_V2_DIR } from "./config.js";

export const V2_PRIVATE_STATE_ID = "veilanceV2PrivateState" as const;
export type V2PrivateStateId = typeof V2_PRIVATE_STATE_ID;

export type V2CircuitId =
  | "registerEncKey"
  | "certifyOrigin"
  | "certifySupplier"
  | "certifyRecycler"
  | "setCarbonThreshold"
  | "addProcessingRule"
  | "issueLot"
  | "issueRecycledLot"
  | "transferLot"
  | "processLots"
  | "attestOrder"
  | "openPeriod"
  | "consumeIntoPeriod"
  | "declareShare";

export type V2Providers = MidnightProviders<V2CircuitId, V2PrivateStateId, V2PrivateState>;

export const compiledContractV2 = CompiledContract.make("veilance_v2", Contract).pipe(
  CompiledContract.withWitnesses(witnessesV2),
  CompiledContract.withCompiledFileAssets(ZK_V2_DIR),
);

export type V2Contract = FoundContract<Contract<V2PrivateState>>;

/** Providers for one tenant. Private state lives under that tenant's own directory. */
export const buildV2Providers = (tenantId: string, wallet: WalletProvider & MidnightProvider): V2Providers => {
  const zkConfigProvider = new NodeZkConfigProvider<V2CircuitId>(ZK_V2_DIR);
  return {
    privateStateProvider: levelPrivateStateProvider<V2PrivateStateId, V2PrivateState>({
      accountId: `v2-${tenantId}`,
      privateStoragePasswordProvider: () => PRIVATE_STATE_PASSWORD,
      levelFactory: (dbName: string) => new Level(path.join(V2_STATE_DIR, "tenants", tenantId, dbName)) as never,
    }),
    publicDataProvider: indexerPublicDataProvider(INDEXER_HTTP_URL, INDEXER_WS_URL),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(PROOF_SERVER_URL, zkConfigProvider),
    walletProvider: wallet,
    midnightProvider: wallet,
  };
};

export const deployV2 = (providers: V2Providers, initialPrivateState: V2PrivateState): Promise<DeployedContract<Contract<V2PrivateState>>> =>
  deployContract(providers, { compiledContract: compiledContractV2, privateStateId: V2_PRIVATE_STATE_ID, initialPrivateState });

/**
 * Circuits whose verifier keys go into the deploy transaction itself. The
 * rest are inserted afterwards with maintenance transactions. All 14 keys in
 * one deploy is ~31.5 KB and the node rejects it ("1010: Transaction would
 * exhaust the block limits"); v1's 9-circuit deploy (~20.5 KB) is accepted.
 */
export const DEPLOY_FIRST: V2CircuitId[] = [
  "registerEncKey",
  "certifyOrigin",
  "certifySupplier",
  "certifyRecycler",
  "setCarbonThreshold",
  "addProcessingRule",
  "issueLot",
];
export const INSERT_AFTER: V2CircuitId[] = [
  "issueRecycledLot",
  "transferLot",
  "processLots",
  "attestOrder",
  "openPeriod",
  "consumeIntoPeriod",
  "declareShare",
];

/**
 * Deploys in stages: a deploy carrying only DEPLOY_FIRST's operations, then
 * one maintenance transaction per remaining circuit, signed with the
 * contract's maintenance key (kept in the deployer's private state store).
 * The deployed contract ends up with exactly the state a one-shot deploy
 * would have, so findDeployedContract's verifier-key check passes.
 */
export const deployV2Staged = async (
  providers: V2Providers,
  initialPrivateState: V2PrivateState,
  onStep: (step: string) => void = () => {},
): Promise<{ contractAddress: string; txHash: string; blockHeight: number; inserted: number }> => {
  const d = await createUnprovenDeployTx(providers, { compiledContract: compiledContractV2, initialPrivateState, signingKey: sampleSigningKey() });
  const full = ledger.ContractState.deserialize(d.public.initialContractState.serialize());
  const trimmed = new ledger.ContractState();
  trimmed.data = full.data;
  trimmed.maintenanceAuthority = full.maintenanceAuthority;
  for (const id of DEPLOY_FIRST) {
    const op = full.operation(id);
    if (!op) throw new Error(`deployV2Staged: no operation for ${id}`);
    trimmed.setOperation(id, op);
  }
  const deploy = new ledger.ContractDeploy(trimmed);
  const unprovenTx = ledger.Transaction.fromParts(getNetworkId(), undefined, undefined, ledger.Intent.new(ttlOneHour()).addDeploy(deploy));

  onStep(`deploying with ${DEPLOY_FIRST.length} of ${DEPLOY_FIRST.length + INSERT_AFTER.length} circuits`);
  const res = await submitTx(providers, { unprovenTx });
  if (res.status !== SucceedEntirely) throw new Error(`deploy transaction did not succeed: ${res.status}`);
  const contractAddress = deploy.address;

  providers.privateStateProvider.setContractAddress(contractAddress);
  await providers.privateStateProvider.set(V2_PRIVATE_STATE_ID, d.private.initialPrivateState as V2PrivateState);
  await providers.privateStateProvider.setSigningKey(contractAddress, d.private.signingKey);

  const keys = await providers.zkConfigProvider.getVerifierKeys(INSERT_AFTER);
  for (const [id, vk] of keys) {
    onStep(`inserting verifier key · ${id}`);
    await submitInsertVerifierKeyTx(providers, compiledContractV2, contractAddress, id, vk);
  }
  return { contractAddress, txHash: res.txHash, blockHeight: res.blockHeight, inserted: keys.length };
};

export const findV2 = (providers: V2Providers, contractAddress: string, initialPrivateState: V2PrivateState): Promise<V2Contract> =>
  findDeployedContract(providers, {
    contractAddress,
    compiledContract: compiledContractV2,
    privateStateId: V2_PRIVATE_STATE_ID,
    initialPrivateState,
  });

export const readLedgerV2 = async (providers: V2Providers, address: string): Promise<Ledger> => {
  const state = await providers.publicDataProvider.queryContractState(address);
  if (state === null) throw new Error(`v2 contract ${address} not found`);
  return ledgerOf(state.data);
};
