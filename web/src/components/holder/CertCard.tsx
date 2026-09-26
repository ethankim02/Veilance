import { t, useI18n } from '@/lib/i18n';
import type { GraphEdge } from '@/api/types';
import { Lock } from '@/components/ui';
import { CERT_STATE_LABEL, cardTint, certState } from '@/lib/certs';
import { cx } from '@/lib/format';
import { consumedBy, lotNumber, materialName } from '@/lib/lots';
import { orgName } from '@/lib/registry';

const CHIP = {
  held: 'bg-accent/15 text-accent',
  incoming: 'bg-amber/15 text-amber',
  transferred: 'bg-ink-900/60 text-ink-300',
} as const;

/** One raw-material provenance certificate, drawn like a card in a mobile ID wallet. */
export function CertCard({ lot, edges, size = 'md', selected, onClick }: { lot: GraphEdge; edges: GraphEdge[]; size?: 'md' | 'lg'; selected?: boolean; onClick?: () => void }) {
  useI18n();
  const state = certState(lot);
  const next = state === 'transferred' ? consumedBy(edges, lot) : undefined;
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cx(
        'relative flex w-full flex-col overflow-hidden rounded-2xl border bg-gradient-to-br p-4 text-left shadow-lg transition',
        cardTint(lot),
        size === 'lg' ? 'aspect-[1.6/1] p-5' : 'aspect-[1.7/1]',
        selected ? 'border-accent ring-2 ring-accent/40' : 'border-white/10',
        onClick && 'hover:-translate-y-0.5 hover:border-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        state === 'transferred' && 'opacity-60 grayscale-[60%]',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/60">{t("원자재 출처 증명서")}</span>
        <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-medium', CHIP[state])}>{t(CERT_STATE_LABEL[state])}</span>
      </div>
      <div className="mt-auto">
        <p className={cx('font-semibold leading-tight text-white', size === 'lg' ? 'text-3xl' : 'text-2xl')}>{materialName(lot)}</p>
        <p className="mt-0.5 font-mono text-[11px] text-white/50">{t("배치 #{number}", { number: lotNumber(edges, lot.id) })}</p>
      </div>
      <div className="mt-3 flex items-end justify-between gap-2 text-[11px] text-white/70">
        <span className="min-w-0 truncate">
          {state === 'transferred' ? t("→ {company}에 전달", { company: orgName(next?.to) }) : t("{company}에서 받음", { company: orgName(lot.from) })}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-white/50">
          {t("원산지")} <Lock />
        </span>
      </div>
    </Tag>
  );
}
