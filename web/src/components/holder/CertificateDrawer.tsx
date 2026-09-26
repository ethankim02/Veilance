import { t, useI18n } from '@/lib/i18n';
import { useState } from 'react';
import { getApi } from '@/api/client';
import type { GraphEdge, PartyName } from '@/api/types';
import { Drawer } from '@/components/Drawer';
import { JobRing } from '@/components/JobRing';
import { Button, ErrorLine, Explore, Field, Hash, Heading, Input, Lock, Row, Select } from '@/components/ui';
import { useGraph, useOpenRequests } from '@/hooks/queries';
import { useAction } from '@/hooks/useAction';
import { certState } from '@/lib/certs';
import { fmtMs } from '@/lib/format';
import { consumedBy } from '@/lib/lots';
import { isActive } from '@/lib/progress';
import { CHAIN, PARTIES, nextInChain, orgName } from '@/lib/registry';
import { CertCard } from './CertCard';
import { ReceiveButton } from './HolderHome';

function TransferForm({ lot }: { lot: GraphEdge }) {
  useI18n();
  const [to, setTo] = useState<PartyName>(nextInChain(lot.to));
  const min = lot.carbonClass ?? 0;
  const [carbon, setCarbon] = useState(String(min));
  const carbonN = Number(carbon);
  const valid = Number.isInteger(carbonN) && carbonN >= min && carbonN <= 255;
  const action = useAction((recipient: PartyName, carbonClass: number) => getApi().transfer(lot.to, lot.credentialId, { recipient, carbonClass }), () => to);
  return (
    <form
      className="mt-3 space-y-3 rounded-xl border border-ink-600 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !action.pending) action.run(to, carbonN);
      }}
      onChange={() => action.job && !isActive(action.job) && action.reset()}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("받는 회사")}>
          <Select value={to} onChange={(e) => setTo(e.target.value as PartyName)}>
            {CHAIN.filter((p) => p !== lot.to).map((p) => (
              <option key={p} value={p}>{PARTIES[p].org}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("전달할 탄소 등급")}>
          <Input type="number" min={min} max={255} value={carbon} onChange={(e) => setCarbon(e.target.value)} />
        </Field>
      </div>
      <p className="text-xs leading-relaxed text-ink-400">{t("받는 회사에 새 증명서가 발행되고, 이 증명서는 ‘전달 완료’로 바뀌어 더 이상 사용할 수 없습니다. 탄소 등급은 현재 값({min}) 이상으로만 넘길 수 있습니다.", { min })}</p>
      {action.job ? (
        <JobRing jobId={action.job.id} initial={action.job} />
      ) : (
        <div>
          <Button type="submit" disabled={!valid || action.pending}>{t("{company}에 전달", { company: PARTIES[to].org })}</Button>
          <ErrorLine error={action.error} />
        </div>
      )}
    </form>
  );
}

/** Holder's certificate detail: the card, what can be done with it now, where it came from and went, and the evidence behind it. */
export function CertificateDrawer({ id, party, onClose, onProve }: { id: string; party: PartyName; onClose: () => void; onProve: (certId: string) => void }) {
  useI18n();
  const graph = useGraph();
  const requests = useOpenRequests(party);
  const [transferring, setTransferring] = useState(false);
  const edges = graph.data?.edges ?? [];
  const lot = edges.find((e) => e.id === id) ?? edges.find((e) => e.credentialId === id);
  if (!lot) return <Drawer title={t("증명서")} onClose={onClose}>{!graph.isPending && <p className="text-[13px] text-ink-500">{t("이 증명서를 찾을 수 없습니다.")}</p>}</Drawer>;

  const ours = lot.to === party;
  const state = certState(lot);
  const next = consumedBy(edges, lot);
  const openCount = requests.data?.length ?? 0;

  return (
    <Drawer title={ours ? t("증명서 상세") : t("보낸 증명서")} subtitle={ours ? t("{company}에서 받음", { company: orgName(lot.from) }) : t("{company}에 보냄", { company: orgName(lot.to) })} onClose={onClose}>
      <CertCard lot={lot} edges={edges} size="lg" />

      {!ours ? (
        <p className="mt-4 rounded-lg bg-ink-800 p-3 text-[13px] leading-relaxed text-ink-300">
          {lot.status === 'ISSUED'
            ? t("{company}이(가) 아직 이 증명서를 받지 않았습니다.", { company: orgName(lot.to) })
            : t("{company}이(가) 받은 증명서입니다. 이후 사용은 받은 회사가 관리합니다.", { company: orgName(lot.to) })}
        </p>
      ) : state === 'held' ? (
        <div className="mt-4 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => onProve(lot.id)}>{t("증명 제출")}</Button>
            <Button variant="secondary" aria-expanded={transferring} onClick={() => setTransferring((v) => !v)}>{t("다음 회사로 전달")}</Button>
          </div>
          <p className="text-xs text-ink-400">{openCount ? t("응답을 기다리는 구매사 요청이 {count}건 있습니다.", { count: openCount }) : t("지금은 응답할 구매사 요청이 없습니다.")}</p>
          {transferring && <TransferForm key={lot.id} lot={lot} />}
        </div>
      ) : state === 'incoming' ? (
        <div className="mt-4 rounded-lg bg-ink-800 p-3 text-[13px] leading-relaxed">
          <p className="text-ink-200">{t("{company}이(가) 보낸 증명서가 도착했습니다. 받으면 지갑에 보관되고 증명 제출·전달에 사용할 수 있습니다.", { company: orgName(lot.from) })}</p>
          <div className="mt-3"><ReceiveButton party={party} /></div>
        </div>
      ) : (
        <p className="mt-4 rounded-lg bg-ink-800 p-3 text-[13px] leading-relaxed text-ink-300">
          {t("{company}에 전달되어 더 이상 현재 보유 증명서가 아닙니다. 증명 제출이나 다시 전달에 사용할 수 없습니다.", { company: orgName(next?.to) })}
        </p>
      )}

      {ours && (
        <>
          <Heading>{t("우리 회사만 보는 정보")}</Heading>
          <Row k={t("원산지")} v={<>{lot.originLabel ?? '—'} <Lock /></>} />
          <Row k={t("탄소 등급")} v={<>{lot.carbonClass ?? '—'} <Lock /></>} />
          <p className="mt-1 text-xs text-ink-400">{t("증명을 제출해도 구매사에 전달되지 않습니다.")}</p>
        </>
      )}

      <Heading>{t("전달 이력")}</Heading>
      <ol className="relative ml-1 border-l border-ink-600 pl-4 text-[13px]">
        <li className="pb-3">
          <p>{lot.circuit === 'issueProvenance' ? t("{company} 발행", { company: orgName(lot.from) }) : t("{company}이(가) 전달", { company: orgName(lot.from) })}</p>
          <p className="flex items-center gap-2 text-xs text-ink-400">{t("블록 {height}", { height: lot.blockHeight ?? '—' })} <Explore tx={lot.txHash} /></p>
        </li>
        <li className="pb-3">
          <p className={lot.status === 'ISSUED' ? 'text-ink-400' : ''}>{lot.status === 'ISSUED' ? t("{company} 수신 대기", { company: orgName(lot.to) }) : t("{company} 수신", { company: orgName(lot.to) })}</p>
        </li>
        {lot.status === 'CONSUMED' && (
          <li>
            <p>{t("{company}에 전달", { company: orgName(next?.to) })}</p>
            <p className="flex items-center gap-2 text-xs text-ink-400">{t("블록 {height}", { height: next?.blockHeight ?? lot.consumedBlockHeight ?? '—' })} <Explore tx={next?.txHash ?? lot.consumedTxHash} /></p>
          </li>
        )}
      </ol>

      <details className="mt-6 text-[13px]">
        <summary className="cursor-pointer select-none text-[11px] font-medium uppercase tracking-wider text-ink-400">{t("검증 근거")}</summary>
        <p className="mt-2 text-xs text-ink-400">{t("체인에 기록된 값으로 이 증명서의 존재와 사용 여부를 누구나 확인할 수 있습니다.")}</p>
        <Row k={t("Commitment")} v={<Hash value={lot.commitment} />} />
        <Row k={t("Nullifier")} v={<Hash value={lot.nullifier} />} />
        <Row k={t("Inbox #")} v={<span className="font-mono text-xs">{lot.inboxIndex ?? '—'}</span>} />
        <Row k={t("Circuit")} v={<span className="font-mono text-xs">{lot.circuit}</span>} />
        <Row k={t("Verifier key")} v={<Hash value={lot.verifierKeyFingerprint} />} />
        <Row k={t("Proving time")} v={<span className="font-mono text-xs">{fmtMs(lot.provingMs)}</span>} />
      </details>
    </Drawer>
  );
}
