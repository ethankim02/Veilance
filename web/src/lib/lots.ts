import { t } from './i18n';
import type { EdgeStatus, GraphEdge, PartyName } from '@/api/types';
import { CHAIN } from './registry';

const byCreated = (a: GraphEdge, b: GraphEdge) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);

/** Lot numbers follow creation order across the whole chain: lot 1, lot 2, … */
export function lotNumber(edges: GraphEdge[], id: string): number {
  const own = edges.find((e) => e.id === id)?.lotNumber;
  if (own != null) return own;
  return [...edges].sort(byCreated).findIndex((e) => e.id === id) + 1;
}
/** Material labels arrive as free text from the agent ('cobalt', 'Cobalt'); show them Title-cased. */
export const materialName = (lot: GraphEdge) => {
  const m = lot.materialLabel?.trim();
  return t(m ? m.charAt(0).toUpperCase() + m.slice(1) : 'Lot');
};
export const lotTitle = (edges: GraphEdge[], lot: GraphEdge) => `${materialName(lot)} · ${t('Material record #{number}', { number: lotNumber(edges, lot.id) })}`;

export const STATUS_WORD: Record<EdgeStatus, string> = { ISSUED: 'Awaiting receipt', DELIVERED: 'Held', CONSUMED: 'Used in transfer' };

/** Which gap between two consecutive cards a lot sits in (0 = mine→refiner, 1 = refiner→battery maker). */
export function slotOf(lot: GraphEdge): number {
  const order = (p: PartyName) => Math.max(0, CHAIN.indexOf(p));
  return Math.min(CHAIN.length - 2, Math.max(0, Math.max(order(lot.from), order(lot.to)) - 1));
}

export const newestFirst = (edges: GraphEdge[]) => [...edges].sort((a, b) => byCreated(b, a));

/** The transfer that consumed this lot, when it can be told apart. */
export function consumedBy(edges: GraphEdge[], lot: GraphEdge): GraphEdge | undefined {
  if (lot.status !== 'CONSUMED') return undefined;
  if (lot.consumedTxHash) return edges.find((e) => e.txHash === lot.consumedTxHash);
  return [...edges]
    .sort(byCreated)
    .find((e) => e.from === lot.to && e.circuit === 'transferProvenance' && Date.parse(e.createdAt) >= Date.parse(lot.createdAt) && e.materialLabel === lot.materialLabel);
}

/** A lot sent against the chain direction (e.g. battery maker back to refiner). */
export const isBackward = (lot: GraphEdge) => CHAIN.indexOf(lot.from as PartyName) > CHAIN.indexOf(lot.to as PartyName);
