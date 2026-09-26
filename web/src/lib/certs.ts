import type { GraphAttestation, GraphEdge, Profile } from '@/api/types';
import { t } from './i18n';
import { lotNumber, materialName } from './lots';

/**
 * Holder-side vocabulary for the certificate wallet. A "certificate" is one
 * provenance record (graph edge) addressed to the viewing company:
 *   ISSUED    → incoming    (sent to us, not yet received into the wallet)
 *   DELIVERED → held        (usable: submit a proof or pass it on)
 *   CONSUMED  → transferred (spent to create the next company's certificate)
 */
export type CertState = 'incoming' | 'held' | 'transferred';

export const certState = (e: GraphEdge): CertState => (e.status === 'ISSUED' ? 'incoming' : e.status === 'DELIVERED' ? 'held' : 'transferred');

export const CERT_STATE_LABEL: Record<CertState, string> = {
  incoming: '수신 대기',
  held: '보유 중',
  transferred: '전달 완료',
};

/** Which checks each request level runs. Mirrors the agent's verify() `applies` table. */
export const PROFILE_CHECKS: Record<Profile, string[]> = {
  consumer: ['responsibleSourcing', 'chainOfCustody', 'restrictedSource', 'duplicateClaim'],
  procurement: ['responsibleSourcing', 'chainOfCustody', 'restrictedSource', 'supplierCertification', 'carbonThreshold', 'duplicateClaim'],
  regulator: ['responsibleSourcing', 'chainOfCustody', 'restrictedSource', 'supplierCertification', 'carbonThreshold', 'duplicateClaim'],
};

export const CHECK_LABEL: Record<string, string> = {
  responsibleSourcing: 'Responsible sourcing',
  chainOfCustody: 'Chain of custody',
  supplierCertification: 'Supplier certification',
  carbonThreshold: 'Carbon class ≤ threshold',
  restrictedSource: 'No restricted source',
  duplicateClaim: 'No duplicate claim',
};

/** What the buyer learns from a submitted proof. The same for every level since rotate-on-attest. */
export function disclosedTo(_profile: Profile): string[] {
  return ['요청한 검사 항목을 모두 통과했다는 사실', '검증에 적용된 정책 버전', '요청받은 회사가 응답했다는 사실'];
}

/** What never leaves the holder, whatever the level. */
export const NOT_DISCLOSED = ['어떤 증명서를 사용했는지', '원산지', '상류 공급업체', '탄소 등급 실제 값', '수량 · 거래 조건'];

export const isStale = (a: GraphAttestation, currentPolicyVersion?: string) =>
  currentPolicyVersion != null && String(a.policyVersion) !== String(currentPolicyVersion);

/** Accent gradient per material, so cards are told apart at a glance. */
const TINT: Record<string, string> = {
  cobalt: 'from-[#1d3b6e] to-[#0f1b33]',
  lithium: 'from-[#4a2a5e] to-[#1d1228]',
  nickel: 'from-[#2f4a4a] to-[#132222]',
  graphite: 'from-[#3a3f47] to-[#15181c]',
  manganese: 'from-[#5a3326] to-[#231310]',
};
export const cardTint = (e: GraphEdge) => TINT[e.materialLabel?.trim().toLowerCase() ?? ''] ?? 'from-[#233040] to-[#10161d]';

/** "Cobalt · Batch #3" — the wallet's name for a certificate. */
export const certTitle = (edges: GraphEdge[], lot: GraphEdge) => `${materialName(lot)} · ${t('배치 #{number}', { number: lotNumber(edges, lot.id) })}`;
