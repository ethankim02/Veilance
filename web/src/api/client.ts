import type { Workspace } from '@/lib/workspace';
import type {
  AttestInput,
  Challenge,
  Credential,
  ExplorerBlock,
  ExplorerContract,
  ExplorerTip,
  ExplorerTx,
  Graph,
  Health,
  IssueInput,
  Job,
  Ledger,
  LedgerRaw,
  Party,
  PartyName,
  Policy,
  Profile,
  ScanResult,
  TransferInput,
  VerifyResult,
  WalletSession,
  WalletSessionInput,
} from './types';

/** Body for `POST /jobs/:id/wallet-result` — see agent/API.md's "Delegated wallet" addendum. */
export type WalletResultInput = { requestId: string } & ({ balancedTxHex: string } | { error: string });

/** Everything the UI calls. One implementation talks HTTP to the party agent, the other is an in-browser mock. */
export interface VeilanceApi {
  readonly mode: 'mock' | 'http';
  readonly baseUrl?: string;

  health(): Promise<Health>;
  parties(): Promise<Party[]>;
  ledger(): Promise<Ledger>;
  policy(): Promise<Policy>;

  job(id: string): Promise<Job>;
  jobs(party?: PartyName): Promise<Job[]>;

  addOrigin(input: { label: string; originId?: string }): Promise<Job>;
  addSupplier(input: { partyName: PartyName; certId?: string; certLabel?: string }): Promise<Job>;
  setCarbonThreshold(threshold: number): Promise<Job>;

  registerEncKey(party: PartyName): Promise<Job>;
  credentials(party: PartyName): Promise<Credential[]>;
  scan(party: PartyName): Promise<ScanResult>;
  issue(party: PartyName, input: IssueInput): Promise<Job>;
  transfer(party: PartyName, credentialId: string, input: TransferInput): Promise<Job>;
  attest(party: PartyName, credentialId: string, input: AttestInput): Promise<Job>;

  createChallenge(input: { profile: Profile; holder: PartyName }): Promise<Challenge>;
  challenges(): Promise<Challenge[]>;
  /** GET /verify/challenges?holder=&open=true — requests without an attestation yet, newest first. */
  openRequests(holder: PartyName): Promise<Challenge[]>;
  verify(challenge: string, holder: PartyName, profile: Profile): Promise<VerifyResult>;

  graph(viewer?: Workspace): Promise<Graph>;
  explorerTip(): Promise<ExplorerTip>;
  explorerBlock(height: number): Promise<ExplorerBlock>;
  explorerTx(hash: string): Promise<ExplorerTx>;
  explorerContract(): Promise<ExplorerContract>;
  explorerLedgerRaw(): Promise<LedgerRaw>;

  /* ---------- v1.4 addendum: delegated wallet ---------- */
  walletSessions(): Promise<WalletSession[]>;
  connectWallet(input: WalletSessionInput): Promise<WalletSession>;
  disconnectWallet(party: PartyName): Promise<void>;
  /** Reports the browser wallet's `balanceUnsealedTransaction` result (or an error) for a job parked in `awaiting_wallet`. */
  postWalletResult(jobId: string, input: WalletResultInput): Promise<void>;
}

let instance: VeilanceApi | null = null;

export function isMockMode(): boolean {
  const env = import.meta.env;
  if (env.VITE_MOCK === '1' || env.VITE_MOCK === 'true') return true;
  return !env.VITE_API_URL;
}

export async function loadApi(): Promise<VeilanceApi> {
  if (instance) return instance;
  if (isMockMode()) {
    const { createMockApi } = await import('./mock');
    instance = createMockApi();
  } else {
    const { createHttpApi } = await import('./http');
    instance = createHttpApi(import.meta.env.VITE_API_URL as string);
  }
  return instance;
}

export function getApi(): VeilanceApi {
  if (!instance) throw new Error('API not loaded');
  return instance;
}
