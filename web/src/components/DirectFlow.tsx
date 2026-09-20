import { t, useI18n } from '@/lib/i18n';
import { useNavigate } from 'react-router-dom';
import { useGraph } from '@/hooks/queries';
import { useWorkspace } from '@/lib/workspace';
import { orgName } from '@/lib/registry';
import { STATUS_WORD, lotTitle, newestFirst } from '@/lib/lots';

/**
 * A company's own transfers, as a plain scrolling list. This is a list, not a
 * graph: the pan/zoom viewport belongs to the supply-chain map only, so the
 * mouse wheel here scrolls the list like any other page.
 */
export function DirectFlow() {
  useI18n();
  const graph = useGraph();
  const viewer = useWorkspace();
  const navigate = useNavigate();
  const edges = graph.data?.edges ?? [];
  if (graph.isPending) return <p className="m-auto text-sm text-ink-400">{t("거래 기록을 불러오는 중…")}</p>;
  if (graph.isError) return <p className="m-auto text-sm text-red">{t("거래 기록을 불러오지 못했습니다.")}</p>;
  if (!edges.length && !graph.data?.attestations.length) return <p className="m-auto p-8 text-sm text-ink-400">{t("아직 표시할 거래가 없습니다. 재료를 받거나 보내면 여기에 나타납니다.")}</p>;
  const tone = (s: string) => (s === 'DELIVERED' ? 'text-accent' : s === 'ISSUED' ? 'text-amber' : 'text-ink-400');
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-3 p-5 sm:p-8">
        {newestFirst(edges).map(e => (
          <button key={e.id} onClick={() => navigate(`/?lot=${encodeURIComponent(e.id)}`)}
            className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 p-4 text-left hover:border-ink-500">
            <div className={e.from === viewer ? 'text-ink-100' : 'text-ink-300'}><p className="text-sm font-semibold">{orgName(e.from)}</p><p className="mt-0.5 text-xs text-ink-400">{e.from === viewer ? t("우리 회사 · 보냄") : t("직접 거래처 · 보냄")}</p></div>
            <div className="text-center"><p className="text-xs text-ink-200">{lotTitle(edges, e)} →</p><p className={`mt-0.5 text-[11px] ${tone(e.status)}`}>{t(STATUS_WORD[e.status])}</p></div>
            <div className={`text-right ${e.to === viewer ? 'text-ink-100' : 'text-ink-300'}`}><p className="text-sm font-semibold">{orgName(e.to)}</p><p className="mt-0.5 text-xs text-ink-400">{e.to === viewer ? t("우리 회사 · 받음") : t("직접 거래처 · 받음")}</p></div>
          </button>
        ))}
        {!!graph.data?.attestations.length && <div className="flex items-center justify-between rounded-xl border border-ink-700 bg-ink-850 p-4 text-sm"><span>{orgName(viewer)} → OEM</span><span className="text-ink-300">{t("증명 기록")}{graph.data.attestations.length}{t("건 · 재료 전달이 아닌 검사 결과")}</span></div>}
      </div>
    </div>
  );
}
