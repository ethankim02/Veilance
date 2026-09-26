import { getLocale, t, useI18n } from '@/lib/i18n';
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getApi } from '@/api/client';
import type { Challenge, GraphEdge, PartyName } from '@/api/types';
import { JobRing } from '@/components/JobRing';
import { Button, ErrorLine, Reason } from '@/components/ui';
import { IssueForm } from '@/components/drawers/OrgDrawer';
import { qk, useGraph, useOpenRequests, useParties, usePolicy } from '@/hooks/queries';
import { useAction } from '@/hooks/useAction';
import { CERT_STATE_LABEL, CHECK_LABEL, NOT_DISCLOSED, PROFILE_CHECKS, certState, certTitle, disclosedTo, isStale, type CertState } from '@/lib/certs';
import { cx } from '@/lib/format';
import { newestFirst } from '@/lib/lots';
import { useQueryNav } from '@/lib/nav';
import { CHECK_HELP, VERIFIER, orgName, profileLabel } from '@/lib/registry';
import { CertCard } from './CertCard';

export type HolderTab = 'wallet' | 'requests' | 'activity';

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(getLocale() === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

/** Imports certificates sent to this company into its wallet (agent `scan`). */
export function ReceiveButton({ party, label }: { party: PartyName; label?: string }) {
  useI18n();
  const qc = useQueryClient();
  const scan = useMutation({
    mutationFn: () => getApi().scan(party),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.graph });
      qc.invalidateQueries({ queryKey: qk.parties });
    },
  });
  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <Button size="sm" onClick={() => scan.mutate()} disabled={scan.isPending}>
        {scan.isPending ? t("받는 중…") : label ?? t("증명서 받기")}
      </Button>
      {scan.data && <span role="status" className="text-xs text-ink-300">{scan.data.found ? t("{count}건을 지갑에 보관했습니다", { count: scan.data.found }) : t("새로 받을 증명서가 없습니다")}</span>}
      {scan.error && <span className="text-xs text-red">{scan.error.message}</span>}
    </span>
  );
}

function useHolderData(party: PartyName) {
  const graph = useGraph();
  const edges = newestFirst(graph.data?.edges ?? []);
  const own = edges.filter((e) => e.to === party);
  const byState = (s: CertState) => own.filter((e) => certState(e) === s);
  return { graph, edges, own, held: byState('held'), incoming: byState('incoming'), transferred: byState('transferred') };
}

/* ---------------- 내 증명서 ---------------- */

function SetupNotice({ party }: { party: PartyName }) {
  useI18n();
  const register = useAction(() => getApi().registerEncKey(party));
  return (
    <div className="rounded-xl border border-amber/40 bg-amber-faint p-4 text-sm">
      <p className="font-medium text-ink-100">{t("증명서를 받으려면 수신 설정이 필요합니다")}</p>
      <p className="mt-1 text-xs text-ink-300">{t("다른 회사가 이 회사에 증명서를 보낼 수 있도록 수신용 공개키를 한 번 등록합니다.")}</p>
      <div className="mt-3">{register.job ? <JobRing jobId={register.job.id} initial={register.job} /> : <Button size="sm" onClick={() => register.run()} disabled={register.pending}>{t("수신 설정하기")}</Button>}</div>
      <ErrorLine error={register.error} />
    </div>
  );
}

function WalletTab({ party, onOpen, onRequests }: { party: PartyName; onOpen: (id: string) => void; onRequests: () => void }) {
  useI18n();
  const { graph, edges, held, incoming, transferred } = useHolderData(party);
  const requests = useOpenRequests(party);
  const parties = useParties();
  const policy = usePolicy();
  const me = parties.data?.find((p) => p.name === party);
  const [filter, setFilter] = useState<CertState>('held');
  const [issuing, setIssuing] = useState(false);
  if (graph.isPending) return <p className="py-10 text-center text-sm text-ink-300">{t("증명서를 불러오는 중…")}</p>;
  if (graph.isError) return <div className="py-10 text-center"><ErrorLine error={graph.error} /><Button className="mt-3" variant="secondary" onClick={() => graph.refetch()}>{t("다시 불러오기")}</Button></div>;
  const groups = { held, incoming, transferred };
  const list = groups[filter];
  const issueWhy = !me?.certified ? t("관리자에게 공급업체 인증을 요청하세요") : !me?.encKeyRegistered ? t("먼저 수신 설정을 완료하세요") : !policy.data?.origins.length ? t("관리자가 승인한 원산지가 아직 없습니다") : null;
  return (
    <div className="space-y-5">
      {me && !me.encKeyRegistered && <SetupNotice party={party} />}
      {(incoming.length > 0 || (requests.data?.length ?? 0) > 0) && (
        <div className="space-y-2" aria-label={t("확인할 알림")}>
          {incoming.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-600 bg-ink-850 px-4 py-3 text-sm">
              <span><span className="mr-2 inline-block h-2 w-2 rounded-full bg-amber" />{t("새 증명서 {count}건이 도착했습니다", { count: incoming.length })}</span>
              <ReceiveButton party={party} label={t("모두 받기")} />
            </div>
          )}
          {!!requests.data?.length && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-600 bg-ink-850 px-4 py-3 text-sm">
              <span><span className="mr-2 inline-block h-2 w-2 rounded-full bg-red" />{t("구매사 증명 요청 {count}건", { count: requests.data.length })}</span>
              <Button size="sm" variant="secondary" onClick={onRequests}>{t("요청 확인")}</Button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg bg-ink-850 p-1" role="group" aria-label={t("증명서 상태")}>
          {(Object.keys(groups) as CertState[]).map((k) => (
            <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)} className={cx('rounded-md px-3 py-1.5 text-xs', filter === k ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200')}>
              {t(CERT_STATE_LABEL[k])} <span className="tabular-nums text-ink-400">{groups[k].length}</span>
            </button>
          ))}
        </div>
        {party === 'mine' && <Button size="sm" variant={issuing ? 'secondary' : 'primary'} onClick={() => setIssuing((v) => !v)} disabled={!!issueWhy}>{issuing ? t("발행 닫기") : t("+ 새 증명서 발행")}</Button>}
      </div>
      {party === 'mine' && <Reason>{issueWhy}</Reason>}
      {issuing && !issueWhy && <div className="rounded-xl border border-ink-600 bg-ink-850 p-4"><p className="text-sm font-medium">{t("새 원자재 증명서 발행")}</p><p className="mt-1 text-xs text-ink-400">{t("채굴한 원자재 배치에 대한 출처 증명서를 다음 회사에 발행합니다.")}</p><IssueForm /></div>}

      {list.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((lot) => <CertCard key={lot.id} lot={lot} edges={edges} onClick={() => onOpen(lot.id)} />)}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-ink-600 py-10 text-center text-sm text-ink-400">
          {filter === 'held' ? (party === 'mine' ? t("보유한 증명서가 없습니다. 원자재 배치를 발행하면 받는 회사의 지갑에 들어갑니다.") : t("보유한 증명서가 없습니다. 이전 단계 회사가 증명서를 보내면 여기에 나타납니다.")) : filter === 'incoming' ? t("도착한 증명서가 없습니다.") : t("전달한 증명서가 없습니다.")}
        </p>
      )}
      <p className="text-xs text-ink-400">{t("증명서 한 장은 추적 중인 원자재 배치 하나를 뜻하며, 실제 재고 수량을 나타내지 않습니다.")}</p>
    </div>
  );
}

/* ---------------- 증명 요청 ---------------- */

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-ink-600 bg-ink-850 p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-ink-700 text-[11px] tabular-nums">{n}</span>{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function RespondFlow({ party, request, preselect, onBack, onDone }: { party: PartyName; request: Challenge; preselect: string | null; onBack: () => void; onDone: () => void }) {
  useI18n();
  const { edges, held } = useHolderData(party);
  const [certId, setCertId] = useState<string | null>(preselect && held.some((h) => h.id === preselect) ? preselect : held.length === 1 ? held[0].id : null);
  const cert = held.find((h) => h.id === certId);
  const action = useAction((lot: GraphEdge) => getApi().attest(party, lot.credentialId, { profile: request.profile, challenge: request.challenge }), () => 'verifier');
  const checks = PROFILE_CHECKS[request.profile];
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-xs text-ink-400 hover:text-ink-100">{t("‹ 요청 목록")}</button>
      <Step n={1} title={t("요청 확인")}>
        <p className="text-sm">{t("{buyer}이(가) {level}을 요청했습니다", { buyer: VERIFIER.org, level: profileLabel(request.profile) })}</p>
        <p className="mt-1 text-xs text-ink-400">{t("요청 시각 {time}", { time: when(request.createdAt) })}</p>
        <ul className="mt-3 divide-y divide-ink-700 rounded-lg border border-ink-700">
          {checks.map((k) => (
            <li key={k} className="px-3 py-2 text-[13px]"><p className="text-ink-100">{t(CHECK_LABEL[k])}</p><p className="mt-0.5 text-xs text-ink-400">{t(CHECK_HELP[k])}</p></li>
          ))}
        </ul>
      </Step>
      <Step n={2} title={t("사용할 증명서 선택")}>
        {held.length ? (
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label={t("사용할 증명서")}>
            {held.map((lot) => (
              <div key={lot.id} role="radio" aria-checked={certId === lot.id}>
                <CertCard lot={lot} edges={edges} selected={certId === lot.id} onClick={() => { if (!action.job) setCertId(lot.id); }} />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-400">{t("보유 중인 증명서가 없습니다. 증명서를 받은 뒤 응답할 수 있습니다.")}</p>
        )}
      </Step>
      <Step n={3} title={t("공개 범위 확인")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-medium text-accent">{t("{buyer}이(가) 받는 정보", { buyer: VERIFIER.org })}</p>
            <ul className="space-y-1.5 text-[13px]">{disclosedTo(request.profile).map((r) => <li key={r}>· {t(r)}</li>)}</ul>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-ink-300">{t("공개되지 않는 정보")}</p>
            <ul className="space-y-1.5 text-[13px] text-ink-300">{NOT_DISCLOSED.map((r) => <li key={r}>🔒 {t(r)}</li>)}</ul>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-400">{t("제출하면 이 증명서는 같은 내용의 새 증명서로 교체됩니다. 이미 전달한 증명서로는 증명할 수 없고, 이번 증명과 이후 전달 기록은 체인에서 서로 연결되지 않습니다.")}</p>
      </Step>
      <Step n={4} title={t("증명 제출")}>
        {action.job ? (
          <JobRing jobId={action.job.id} initial={action.job} onTerminal={(j) => j.stage === 'confirmed' && setTimeout(onDone, 1500)} />
        ) : (
          <>
            <Button disabled={!cert || action.pending} onClick={() => cert && action.run(cert)}>{cert ? t("{cert}로 증명 제출", { cert: certTitle(edges, cert) }) : t("증명서를 먼저 선택하세요")}</Button>
            <p className="mt-2 text-xs text-ink-400">{t("영지식 증명을 만들어 체인에 기록합니다. 보통 수십 초가 걸립니다.")}</p>
            <ErrorLine error={action.error} />
          </>
        )}
      </Step>
    </div>
  );
}

function RequestsTab({ party, respond, preselect }: { party: PartyName; respond: string | null; preselect: string | null }) {
  useI18n();
  const nav = useQueryNav();
  const requests = useOpenRequests(party);
  const { held } = useHolderData(party);
  // Keep the request after it is answered (it then drops out of the open list) so the flow can show the result.
  const [snapshot, setSnapshot] = useState<Challenge | null>(null);
  const found = requests.data?.find((c) => c.challenge === respond);
  useEffect(() => { if (found) setSnapshot(found); }, [found]);
  // Coming from a certificate's "증명 제출" with exactly one open request: go straight into it.
  useEffect(() => {
    if (!respond && preselect && requests.data?.length === 1) nav.patch({ respond: requests.data[0].challenge });
  }, [respond, preselect, requests.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = respond ? found ?? (snapshot?.challenge === respond ? snapshot : undefined) : undefined;
  if (active) return <RespondFlow key={active.challenge} party={party} request={active} preselect={preselect} onBack={() => nav.patch({ respond: null, use: null })} onDone={() => nav.patch({ tab: 'activity', respond: null, use: null })} />;
  return (
    <div className="space-y-3">
      {preselect && <p role="status" className="text-xs text-accent">{t("응답할 요청을 고르세요. 선택한 증명서가 미리 지정됩니다.")}</p>}
      <ErrorLine error={requests.error} />
      {requests.isPending ? <p className="py-10 text-center text-sm text-ink-300">{t("증명 요청을 불러오는 중…")}</p> : requests.data?.length ? requests.data.map((c) => (
        <div key={c.challenge} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-600 bg-ink-850 p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">{VERIFIER.org} · {profileLabel(c.profile)}</p>
            <p className="mt-1 text-xs text-ink-400">{t("확인 항목 {count}개 · {time}", { count: PROFILE_CHECKS[c.profile].length, time: when(c.createdAt) })}</p>
          </div>
          <Button size="sm" onClick={() => nav.patch({ respond: c.challenge })} disabled={!held.length}>{t("응답하기")}</Button>
          {!held.length && <p className="w-full text-xs text-ink-400">{t("보유 중인 증명서가 있어야 응답할 수 있습니다.")}</p>}
        </div>
      )) : <p className="rounded-xl border border-dashed border-ink-600 py-10 text-center text-sm text-ink-400">{t("응답할 증명 요청이 없습니다. 구매사가 요청을 보내면 여기에 나타납니다.")}</p>}
    </div>
  );
}

/* ---------------- 활동 내역 ---------------- */

type Activity = { key: string; at: string; title: string; detail: string; tone?: string; badge?: { text: string; tone: string }; open?: string };

function ActivityTab({ party, onOpen }: { party: PartyName; onOpen: (id: string) => void }) {
  useI18n();
  const graph = useGraph();
  const policy = usePolicy();
  const edges = graph.data?.edges ?? [];
  const items: Activity[] = [];
  for (const e of edges) {
    if (e.from === party) {
      items.push({
        key: `out-${e.id}`, at: e.createdAt, open: e.id,
        title: e.circuit === 'issueProvenance' ? t("발행 · {cert}", { cert: certTitle(edges, e) }) : t("전달 · {cert}", { cert: certTitle(edges, e) }),
        detail: t("→ {company}", { company: orgName(e.to) }),
        badge: e.status === 'ISSUED' ? { text: t("상대 수신 대기"), tone: 'text-amber' } : { text: t("상대 수신 완료"), tone: 'text-ink-300' },
      });
    }
    if (e.to === party) {
      items.push({
        key: `in-${e.id}`, at: e.deliveredAt ?? e.createdAt, open: e.id,
        title: t("수신 · {cert}", { cert: certTitle(edges, e) }),
        detail: t("← {company}", { company: orgName(e.from) }),
        badge: e.status === 'ISSUED' ? { text: t("받기 전"), tone: 'text-amber' } : undefined,
      });
    }
  }
  for (const a of graph.data?.attestations ?? []) {
    if (a.holder !== party) continue;
    const stale = isStale(a, policy.data?.policyVersion);
    items.push({
      key: `att-${a.attestationKey}-${a.createdAt}`, at: a.createdAt,
      title: t("증명 제출 · {level}", { level: profileLabel(a.profile) }),
      detail: t("→ {buyer} · 정책 v{version} 기준", { buyer: VERIFIER.org, version: a.policyVersion }),
      badge: stale ? { text: t("정책 변경 · 재검증 필요"), tone: 'text-amber' } : { text: t("현재 정책 기준 유효"), tone: 'text-accent' },
    });
  }
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (graph.isPending) return <p className="py-10 text-center text-sm text-ink-300">{t("활동 내역을 불러오는 중…")}</p>;
  if (!items.length) return <p className="rounded-xl border border-dashed border-ink-600 py-10 text-center text-sm text-ink-400">{t("아직 활동 내역이 없습니다.")}</p>;
  return (
    <div className="divide-y divide-ink-700 rounded-xl border border-ink-600 bg-ink-850">
      {items.map((it) => {
        const body = (
          <>
            <div className="min-w-0">
              <p className="truncate text-sm">{it.title}</p>
              <p className="mt-0.5 text-xs text-ink-400">{it.detail} · {when(it.at)}</p>
            </div>
            {it.badge && <span className={cx('shrink-0 text-xs', it.badge.tone)}>{it.badge.text}</span>}
          </>
        );
        return it.open ? (
          <button key={it.key} onClick={() => onOpen(it.open!)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-ink-800">{body}<span className="text-ink-500">›</span></button>
        ) : (
          <div key={it.key} className="flex items-center justify-between gap-3 px-4 py-3">{body}</div>
        );
      })}
    </div>
  );
}

/* ---------------- shell ---------------- */

export function holderBadges(party: PartyName, edges: GraphEdge[], openRequests: number) {
  return { wallet: edges.filter((e) => e.to === party && e.status === 'ISSUED').length, requests: openRequests };
}

export function HolderHome({ party, tab }: { party: PartyName; tab: HolderTab }) {
  useI18n();
  const nav = useQueryNav();
  const open = (id: string) => nav.patch({ cert: id });
  return (
    <div className="mx-auto w-full max-w-5xl p-5 sm:p-8">
      {tab === 'wallet' && <WalletTab party={party} onOpen={open} onRequests={() => nav.patch({ tab: 'requests', cert: null })} />}
      {tab === 'requests' && <RequestsTab party={party} respond={nav.get('respond')} preselect={nav.get('use')} />}
      {tab === 'activity' && <ActivityTab party={party} onOpen={open} />}
    </div>
  );
}
