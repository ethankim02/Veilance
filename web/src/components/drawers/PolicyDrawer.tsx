import { t, useI18n } from '@/lib/i18n';
import { useState } from 'react';
import { getApi } from '@/api/client';
import type { PartyName } from '@/api/types';
import { Drawer } from '@/components/Drawer';
import { JobRing } from '@/components/JobRing';
import { Button, ErrorLine, Explore, Heading, Input, Row } from '@/components/ui';
import { useGraph, useJobs, usePolicy } from '@/hooks/queries';
import { useAction } from '@/hooks/useAction';
import { CHAIN, PARTIES } from '@/lib/registry';

function CertifyOrg({ party }: { party: PartyName }) {
  useI18n();
  const action = useAction(() => getApi().addSupplier({ partyName: party }));
  if (action.job) return <JobRing jobId={action.job.id} initial={action.job} />;
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => action.run()} disabled={action.pending}>
        {t("Certify")}</Button>
      <ErrorLine error={action.error} />
    </>
  );
}

export function PolicyDrawer({ onClose, inline = false }: { onClose: () => void; inline?: boolean }) {
  useI18n();
  const policy = usePolicy();
  const graph = useGraph();
  const jobs = useJobs();
  const [threshold, setThreshold] = useState<string | null>(null);
  const [addingOrigin, setAddingOrigin] = useState(false);
  const [originLabel, setOriginLabel] = useState('');
  const setT = useAction((n: number) => getApi().setCarbonThreshold(n));
  const addOrigin = useAction((label: string) => getApi().addOrigin({ label }));
  const value = threshold ?? String(policy.data?.carbonThreshold ?? '');
  const n = Number(value);
  const validT = value !== '' && Number.isInteger(n) && n >= 0 && n <= 255 && n !== policy.data?.carbonThreshold;
  const originTx = (originId: string) => jobs.data?.find((j) => j.circuit === 'certifyOrigin' && j.stage === 'confirmed' && j.result?.originId === originId)?.txHash;
  const certTx = (p: PartyName) => jobs.data?.find((j) => j.circuit === 'certifySupplier' && j.stage === 'confirmed' && j.result?.partyName === p)?.txHash;
  const certified = (p: PartyName) =>
    graph.data?.nodes.find((x) => x.id === p)?.certified ?? policy.data?.suppliers.some((s) => s.partyName === p || s.org === PARTIES[p].org) ?? false;

  return (
    <Drawer inline={inline} title={t("Policy v{version}", { version: policy.data?.policyVersion ?? "—" })} onClose={onClose}>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-300">{t("These are the sourcing checks configured for this contract. No specific law, external certification scheme or laboratory test is linked here.")}</p>
      <p className="mb-4 text-xs text-ink-400">{t("Carbon class is a numeric category, not a CO₂ measurement. Changing the policy makes older proof results require re-verification.")}</p>
      <form
        className="flex items-center justify-between gap-3 py-1.5 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (validT && !setT.pending) setT.run(n);
        }}
      >
        <span className="text-ink-300">{t("Carbon threshold")}</span>
        <span className="flex items-center gap-2">
          {setT.job ? (
            <JobRing jobId={setT.job.id} initial={setT.job} onTerminal={() => setThreshold(null)} />
          ) : (
            <>
              <Input
                type="number"
                min={0}
                max={255}
                className="w-16 text-center"
                value={value}
                onChange={(e) => {
                  setThreshold(e.target.value);
                  setT.reset();
                }}
              />
              <Button size="sm" type="submit" disabled={!validT || setT.pending}>
                {t("Set")}</Button>
            </>
          )}
        </span>
      </form>
      <ErrorLine error={setT.error} />

      <Heading>{t("Certified origins")}</Heading>
      {policy.data?.origins.length ? (
        policy.data.origins.map((o) => (
          <Row key={o.originId} k={o.label ?? o.originId.slice(0, 12)} v={<Explore tx={originTx(o.originId)} />} />
        ))
      ) : (
        <p className="py-1.5 text-[13px] text-ink-500">—</p>
      )}
      {addingOrigin && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (originLabel.trim() && !addOrigin.pending) addOrigin.run(originLabel.trim());
          }}
        >
          {addOrigin.job ? (
            <JobRing
              jobId={addOrigin.job.id}
              initial={addOrigin.job}
              onTerminal={(j) => {
                if (j.stage === 'confirmed') {
                  setAddingOrigin(false);
                  setOriginLabel('');
                  addOrigin.reset();
                }
              }}
            />
          ) : (
            <>
              <Input autoFocus placeholder={t("Origin name")} value={originLabel} onChange={(e) => setOriginLabel(e.target.value)} />
              <Button size="sm" type="submit" className="h-8" disabled={!originLabel.trim() || addOrigin.pending}>
                {t("Certify")}</Button>
            </>
          )}
        </form>
      )}
      <ErrorLine error={addOrigin.error} />

      <Heading>{t("Certified organisations")}</Heading>
      {CHAIN.map((p) => (
        <Row
          key={p}
          k={PARTIES[p].org}
          v={
            certified(p) ? (
              <>
                <span className="text-accent">✓</span>
                <Explore tx={certTx(p)} />
              </>
            ) : (
              <CertifyOrg party={p} />
            )
          }
        />
      ))}

      {!addingOrigin && (
        <div className="mt-6">
          <Button variant="secondary" onClick={() => setAddingOrigin(true)}>
            {t("+ Origin")}</Button>
        </div>
      )}
    </Drawer>
  );
}
