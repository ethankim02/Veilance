import { t, useI18n } from '@/lib/i18n';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PartyName } from '@/api/types';
import { useGraph, useOpenRequests } from '@/hooks/queries';
import { useWorkspace } from '@/lib/workspace';
import { lotTitle, newestFirst } from '@/lib/lots';
import { orgName, profileLabel } from '@/lib/registry';
import { Button, ErrorLine } from './ui';
import { CheckInbox } from './drawers/OrgDrawer';
import { VerifierDrawer } from './drawers/VerifierDrawer';

export function WorkspaceHome({ req }: { req: string | null }) {
  useI18n();
  const viewer = useWorkspace();
  return viewer === 'verifier' ? <div className="mx-auto w-full max-w-4xl p-5 sm:p-8"><VerifierDrawer inline req={req} onClose={() => {}} /></div> : <CompanyHome party={viewer} />;
}
function CompanyHome({ party }: { party: PartyName }) {
  useI18n();
  const graph = useGraph();
  const requests = useOpenRequests(party);
  const navigate = useNavigate();
  const [selectedRequest, setSelectedRequest] = useState<string | null>(null);
  const [filter, setFilter] = useState<'held' | 'incoming' | 'sent' | 'history'>('held');
  const edges = newestFirst(graph.data?.edges ?? []);
  const own = edges.filter(e => e.to === party);
  const groups = {
    held: own.filter(e => e.status === 'DELIVERED'),
    incoming: own.filter(e => e.status === 'ISSUED'),
    sent: edges.filter(e => e.from === party),
    history: own.filter(e => e.status === 'CONSUMED'),
  };
  const node = graph.data?.nodes.find(n => n.id === party);
  const labels = { held: t("현재 보유 중"), incoming: t("등록할 새 기록"), sent: t("보낸 재료 기록"), history: t("전달 완료 기록") };
  const open = (id: string) => navigate(`/?lot=${encodeURIComponent(id)}${selectedRequest ? `&req=${selectedRequest}` : ''}`);
  if (graph.isPending) return <p className="p-8 text-ink-300">{t("내 재고를 불러오는 중…")}</p>;
  if (graph.isError) return <div className="p-8"><ErrorLine error={graph.error} /><Button onClick={() => graph.refetch()}>{t("다시 불러오기")}</Button></div>;
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-5 sm:p-8">
      <div className="grid grid-cols-3 gap-3">
        {([[t("현재 보유 중"), groups.held.length, t("건")], [t("등록할 새 기록"), groups.incoming.length, t("건")], [t("증명 요청"), requests.data?.length ?? '—', t("건")]] as const).map(([label, count, unit]) => (
          <div key={label} className="rounded-xl border border-ink-700 bg-ink-850 p-4 sm:p-5"><p className="text-xs text-ink-300">{label}</p><p className="mt-3 text-2xl font-semibold">{count}<span className="ml-1 text-xs font-normal text-ink-400">{unit}</span></p></div>
        ))}
      </div>
      <section className="rounded-xl border border-ink-600 bg-ink-850 p-5">
        <h2 className="text-base font-semibold">{t("먼저 할 일")}</h2>
        <div className="mt-4 space-y-4">
          {!node?.encKeyRegistered ? <div><p className="mb-3 text-sm text-ink-300">{t("재료 기록을 확인하려면 먼저 수신 설정을 완료하세요.")}</p><Button onClick={() => navigate(`/?org=${party}`)}>{t("수신 설정하기")}</Button></div> : <CheckInbox party={party} />}
          {party === 'mine' && <Button onClick={() => navigate('/?org=mine')}>{t("새 재료 기록 만들기")}</Button>}
          <ErrorLine error={requests.error} />
          {requests.isPending && <p className="text-sm text-ink-400">{t("증명 요청 확인 중…")}</p>}
          {requests.data?.map(c => <div key={c.challenge} className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-700 pt-4">
            <div><p className="text-sm">{t("Supplier request: {profile}", { profile: profileLabel(c.profile) })}</p><p className="mt-1 text-xs text-ink-400">{t("현재 보유 중인 재료 기록을 하나 선택해, 요청한 기준을 충족하는지 증명하세요.")}</p></div>
            <Button variant="secondary" disabled={!groups.held.length} onClick={() => { setSelectedRequest(c.challenge); setFilter('held'); document.getElementById('inventory')?.scrollIntoView({ block: 'nearest' }); }}>{t("재료 기록 선택")}</Button>
            {!groups.held.length && <p className="w-full text-xs text-ink-400">{t("증명할 재료 기록이 없습니다. 먼저 받은 기록을 등록하세요.")}</p>}
          </div>)}
          {requests.data?.length === 0 && <p className="text-xs text-ink-400">{t("응답할 새 증명 요청이 없습니다.")}</p>}
        </div>
      </section>
      <section id="inventory" className="rounded-xl border border-ink-600 bg-ink-850 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">{t("재료 기록 관리")}</h2><span className="text-xs text-ink-400">{t("재료 기록은 실제 수량이 아닌 공급망 추적 단위입니다.")}</span></div>
        <div className="my-4 flex flex-wrap gap-2" role="group" aria-label={t("재료 기록 상태")}>{(Object.keys(labels) as (keyof typeof labels)[]).map(key => <button key={key} aria-pressed={filter === key} onClick={() => { setFilter(key); if (key !== 'held') setSelectedRequest(null); }} className={`rounded-lg px-3 py-2 text-xs ${filter === key ? 'bg-accent text-ink-950' : 'bg-ink-800 text-ink-300'}`}>{labels[key]} {groups[key].length}</button>)}</div>
        {selectedRequest && <p role="status" className="mb-3 text-xs text-accent">{t("증명할 재료 기록을 선택하세요. 선택한 구매사 요청에 증명이 연결됩니다.")}</p>}
        {groups[filter].length ? <div className="divide-y divide-ink-700">{groups[filter].map(lot => <button key={lot.id} onClick={() => open(lot.id)} className="flex w-full items-center justify-between gap-3 rounded-lg py-4 text-left hover:bg-ink-800">
          <div><p className="text-sm font-medium">{lotTitle(edges, lot)}</p><p className="mt-1 text-xs text-ink-400">{filter === 'sent' ? t("Sent to {company}", { company: orgName(lot.to) }) : t("Received from {company}", { company: orgName(lot.from) })}</p></div>
          <span className="shrink-0 text-xs text-ink-300">{filter === 'held' ? t("내용 확인 · 증명 제출") : t("내용 보기")} ›</span>
        </button>)}</div> : <p className="py-8 text-center text-sm text-ink-400">{t("No {category}.", { category: labels[filter] })}</p>}
      </section>
    </div>
  );
}
