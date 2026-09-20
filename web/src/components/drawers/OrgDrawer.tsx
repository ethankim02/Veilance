import { t, useI18n } from '@/lib/i18n';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getApi } from '@/api/client';
import type { GraphEdge, PartyName } from '@/api/types';
import { Drawer } from '@/components/Drawer';
import { JobRing } from '@/components/JobRing';
import { Button, ErrorLine, Explore, Field, Hash, Heading, Input, Reason, Row, Select } from '@/components/ui';
import { qk, useGraph, useJobs, useParties, usePolicy } from '@/hooks/queries';
import { useAction } from '@/hooks/useAction';
import { cx } from '@/lib/format';
import { STATUS_WORD, lotNumber, newestFirst } from '@/lib/lots';
import { CHAIN, MATERIALS, PARTIES, nextInChain } from '@/lib/registry';

export function LotRow({ lot, edges }: { lot: GraphEdge; edges: GraphEdge[] }) {
  useI18n();
  const consumed = lot.status === 'CONSUMED';
  return (
    <Link
      to={{ pathname: '/', search: `?lot=${encodeURIComponent(lot.id)}` }}
      className="flex items-center gap-2 rounded px-1 py-1.5 text-[13px] hover:bg-ink-800"
    >
      <span className={cx('inline-block h-2 w-2 rounded-full', lot.status === 'DELIVERED' ? 'bg-accent' : lot.status === 'ISSUED' ? 'bg-ink-400' : 'border border-ink-400')} />
      <span className={cx('flex-1', consumed && 'text-ink-400')}>
        {t(lot.materialLabel ?? "Lot")} {t("· lot")}{lotNumber(edges, lot.id)} · {t(STATUS_WORD[lot.status])}
        {!consumed && lot.carbonClass != null && t(" · class {value}", { value: lot.carbonClass })}
      </span>
      <span className="text-ink-500">›</span>
    </Link>
  );
}

/** Import newly received encrypted material records into local inventory. */
export function CheckInbox({ party }: { party: PartyName }) {
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
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="secondary" onClick={() => scan.mutate()} disabled={scan.isPending}>
        {scan.isPending ? t("새 재료 기록 확인 중…") : t("새 재료 기록 확인")}
      </Button>
      <p className="w-full text-xs leading-relaxed text-ink-400">{t("우리 회사로 온 재료 기록을 확인하고 새 기록을 등록합니다. 실제 물건의 입고를 확인하는 기능은 아닙니다.")}</p>
      {scan.data && (
        <span role="status" className={cx('text-[13px]', scan.data.found ? 'text-accent' : 'text-ink-400')}>
          {scan.data.found ? t("Imported {count} new material records", { count: scan.data.found }) : t("등록할 새 재료 기록이 없습니다")}
        </span>
      )}
      {scan.error && <span className="text-[13px] text-red">{scan.error.message}</span>}
    </div>
  );
}

function IssueForm() {
  useI18n();
  const policy = usePolicy();
  const parties = useParties();
  const [to, setTo] = useState<PartyName>(nextInChain('mine'));
  const [material, setMaterial] = useState(MATERIALS[0]);
  const [origin, setOrigin] = useState('');
  const [carbon, setCarbon] = useState('3');
  const originId = origin || policy.data?.origins[0]?.originId || '';
  const recipient = parties.data?.find((p) => p.name === to);
  const carbonN = Number(carbon);
  const action = useAction((input: Parameters<typeof api.issue>[1]) => api.issue('mine', input), () => to);
  const api = getApi();
  const why = !policy.data?.origins.length ? t("Certify an origin in Policy first") : recipient && !recipient.encKeyRegistered ? t("{company} has no receiving key", { company: PARTIES[to].org }) : null;
  const valid = !why && Number.isInteger(carbonN) && carbonN >= 0 && carbonN <= 255 && !!originId;
  return (
    <form
      className="mt-2 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !action.pending) action.run({ recipient: to, originId, materialType: material.toLowerCase(), carbonClass: carbonN });
      }}
      onChange={() => action.job && !["queued", 'preparing', 'proving', 'submitting'].includes(action.job.stage) && action.reset()}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("To")}>
          <Select value={to} onChange={(e) => setTo(e.target.value as PartyName)}>
            {CHAIN.filter((p) => p !== 'mine').map((p) => (
              <option key={p} value={p}>
                {PARTIES[p].org}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("Material")}>
          <Select value={material} onChange={(e) => setMaterial(e.target.value)}>
            {MATERIALS.map((m) => (
              <option key={m} value={m}>{t(m)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("Origin")}>
          <Select value={originId} onChange={(e) => setOrigin(e.target.value)}>
            {!policy.data?.origins.length && <option value="">—</option>}
            {policy.data?.origins.map((o) => (
              <option key={o.originId} value={o.originId}>
                {o.label ?? o.originId.slice(0, 12)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("Carbon class")}>
          <Input type="number" min={0} max={255} value={carbon} onChange={(e) => setCarbon(e.target.value)} />
        </Field>
      </div>
      {action.job ? (
        <JobRing jobId={action.job.id} initial={action.job} />
      ) : (
        <div>
          <Button type="submit" disabled={!valid || action.pending}>
            {t("Issue")}</Button>
          <Reason>{why}</Reason>
          <ErrorLine error={action.error} />
        </div>
      )}
      <details className="text-[12px] text-ink-400">
        <summary className="cursor-pointer select-none">{t("What goes on chain")}</summary>
        <ul className="mt-1 list-disc pl-5">
          <li>{t("one 32-byte commitment")}</li>
          <li>{t("one sealed 192-byte delivery")}</li>
        </ul>
      </details>
    </form>
  );
}

export function OrgDrawer({ id, onClose }: { id: PartyName; onClose: () => void }) {
  useI18n();
  const graph = useGraph();
  const parties = useParties();
  const jobs = useJobs();
  const node = graph.data?.nodes.find((n) => n.id === id);
  const party = parties.data?.find((p) => p.name === id);
  const certified = node?.certified ?? party?.certified ?? false;
  const keyed = node?.encKeyRegistered ?? party?.encKeyRegistered ?? false;
  const certJob = jobs.data?.find(
    (j) => j.circuit === 'certifySupplier' && j.stage === 'confirmed' && (j.result?.partyName === id || (party && j.result?.partyId === party.partyId)),
  );
  const keyJob = jobs.data?.find((j) => j.circuit === 'registerEncKey' && j.party === id && j.stage === 'confirmed');
  const edges = graph.data?.edges ?? [];
  const lots = newestFirst(edges.filter((e) => e.to === id && e.status !== 'ISSUED'));
  const [issuing, setIssuing] = useState(false);
  useEffect(() => setIssuing(false), [id]);
  const register = useAction(() => getApi().registerEncKey(id));
  const why = !certified ? t("Ask the policy admin to certify this organisation") : !keyed ? t("Register the receiving key first") : null;

  return (
    <Drawer
      title={node?.org ?? PARTIES[id].org}
      subtitle={
        <>
          {t(node?.role ?? PARTIES[id].role)} {t("· id")}<Hash value={party?.partyId} />
        </>
      }
      onClose={onClose}
    >
      <Row
        k={t("Certified")}
        v={
          certified ? (
            <>
              <span className="text-accent">✓</span>
              {certJob?.blockHeight != null && <span className="text-ink-300">{t("since block")}{certJob.blockHeight}</span>}
              <Explore tx={certJob?.txHash} />
            </>
          ) : (
            <span className="text-ink-500">—</span>
          )
        }
      />
      <Row
        k={t("Receiving key")}
        v={
          keyed ? (
            <>
              <span className="text-accent">✓</span>
              <span className="text-ink-300">{t("registered")}</span>
              <Explore tx={keyJob?.txHash} />
            </>
          ) : register.job ? (
            <JobRing jobId={register.job.id} initial={register.job} />
          ) : (
            <>
              <span className="text-ink-500">—</span>
              <Button size="sm" variant="secondary" onClick={() => register.run()} disabled={register.pending}>
                {t("Register")}</Button>
            </>
          )
        }
      />

      <Heading>{t("Lots")}</Heading>
      {lots.length ? (
        <div className="-mx-1">
          {lots.map((l) => (
            <LotRow key={l.id} lot={l} edges={edges} />
          ))}
        </div>
      ) : (
        <p className="py-1.5 text-[13px] text-ink-500">—</p>
      )}

      <div className="mt-6">
        {id === 'mine' ? (
          issuing ? (
            <IssueForm />
          ) : (
            <div>
              <Button onClick={() => setIssuing(true)} disabled={!!why}>
                {t("Issue lot")}</Button>
              <Reason>{why}</Reason>
            </div>
          )
        ) : (
          <>
            {keyed ? <CheckInbox party={id} /> : <Button variant="secondary" disabled>{t("새 재료 기록 확인")}</Button>}
            <Reason>{!keyed ? t("Register the receiving key first") : null}</Reason>
          </>
        )}
      </div>
    </Drawer>
  );
}
