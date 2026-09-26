import { t, useI18n } from '@/lib/i18n';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getApi } from '@/api/client';
import type { Challenge, PartyName, Profile } from '@/api/types';
import { Drawer } from '@/components/Drawer';
import { Button, ErrorLine, Explore, Field, Heading, LockBlock, Mark, Select } from '@/components/ui';
import { qk, useChallenges, useGraph, useVerify } from '@/hooks/queries';
import { cx } from '@/lib/format';
import { CHAIN, CHECK_HELP, PARTIES, PRIVATE_ROWS, PROFILE_HELP, PROFILES, VERIFIER, profileLabel, shortName } from '@/lib/registry';

export function useStatus(c: Challenge) {
  useI18n();
  const v = useVerify(c.challenge, c.holder, c.profile);
  const r = v.data;
  if (v.isError) return { text: t("Unable to verify"), tone: 'text-red' };
  if (!r) return { text: t("Checking…"), tone: 'text-ink-400' };
  if (r.status === 'PASSED') return { text: t("✓ Passed · v{version}", { version: r.attestation?.policyVersion ?? "—" }), tone: 'text-accent' };
  if (r.status === 'STALE') return { text: t("⚠ Re-verify (v{old}→v{current})", { old: r.attestation?.policyVersion ?? "—", current: r.currentPolicyVersion }), tone: 'text-amber' };
  return { text: t("Awaiting supplier proof"), tone: 'text-ink-400' };
}

function RequestRow({ c }: { c: Challenge }) {
  useI18n();
  const s = useStatus(c);
  return (
    <Link
      to={{ pathname: '/', search: `?org=verifier&req=${c.challenge}` }}
      className="flex items-center gap-2 rounded px-1 py-1.5 text-[13px] hover:bg-ink-800"
    >
      <span className="flex-1">
        {profileLabel(c.profile)} · {shortName(c.holder)} · <span className={s.tone}>{s.text}</span>
      </span>
      <span className="text-ink-500">›</span>
    </Link>
  );
}

export function RequestDetail({ c, backTo = "?org=verifier", footer }: { c: Challenge; backTo?: string; footer?: React.ReactNode }) {
  useI18n();
  const v = useVerify(c.challenge, c.holder, c.profile);
  const graph = useGraph();
  const att = graph.data?.attestations.find((a) => a.challenge === c.challenge || (a.holder === c.holder && a.attestationKey === c.attestationKey));
  const s = useStatus(c);
  return (
    <>
      <Link to={{ pathname: '/', search: backTo }} className="text-[12px] text-ink-400 hover:text-ink-100">
        {t("‹ Requests")}</Link>
      <div className="mt-3 flex items-center justify-between text-[14px]">
        <span>
          {profileLabel(c.profile)} · {PARTIES[c.holder].org}
        </span>
        <span className={cx('flex items-center gap-2 text-[13px]', s.tone)}>
          {s.text} <Explore tx={att?.txHash} />
        </span>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-300">{t(PROFILE_HELP[c.profile])}</p>
      <p className="mt-2 text-xs text-ink-400">{t("A zero-knowledge proof checks private data against this contract’s policy. It is not a laboratory test or a named regulatory certificate.")}</p>
      {v.data?.status === 'PENDING' && <p className="mt-3 text-sm text-ink-200">{t("Waiting for {company} to select a lot and submit a proof.", { company: PARTIES[c.holder].org })}</p>}
      {v.data?.status === 'STALE' && <p className="mt-3 text-sm text-amber">{t("These results use an older policy. Return to Requests and request a new proof under the current policy.")}</p>}
      {footer}
      <ErrorLine error={v.error} />
      <Heading>{t("What this proof checks")}</Heading>
      <div className="mt-3 divide-y divide-ink-700/70 rounded-md border border-ink-700">
        {(v.data?.predicates ?? []).map((p) => (
          <div key={p.key} className="flex items-center justify-between px-3 py-1.5 text-[13px]">
            <details className="mr-3 flex-1">
              <summary className="cursor-pointer text-ink-200">{t(p.label)}</summary>
              <p className="mt-2 text-xs leading-relaxed text-ink-400">{t(CHECK_HELP[p.key] ?? p.label)}</p>
            </details>
            {p.passed === null ? <span className="text-[11px] text-ink-400">{v.data?.status === 'PENDING' ? t("Awaiting proof") : t("Not checked")}</span> : <Mark state={p.passed} />}
          </div>
        ))}
        {!v.data && <div className="px-3 py-2 text-[13px] text-ink-500">…</div>}
      </div>
      <Heading>{t("Not disclosed to OEM")}</Heading>
      <p className="mb-3 text-xs text-ink-400">{t("OEM receives the result and policy version. The proof does not identify which inventory lot was selected.")}</p>
      <div className="divide-y divide-ink-700/50">
        {(v.data?.private ?? PRIVATE_ROWS).map((r) => (
          <LockBlock key={r} label={t(r)} />
        ))}
      </div>
    </>
  );
}

export function VerifierDrawer({ req, onClose, inline = false }: { req: string | null; onClose: () => void; inline?: boolean }) {
  useI18n();
  const challenges = useChallenges();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [from, setFrom] = useState<PartyName>('batteryMfr');
  const [level, setLevel] = useState<Profile>('procurement');
  const create = useMutation({
    mutationFn: () => getApi().createChallenge({ profile: level, holder: from }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.challenges });
      qc.invalidateQueries({ queryKey: ['open'] });
      setCreating(false);
    },
  });
  const list = [...(challenges.data ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const selected = req ? list.find((c) => c.challenge === req) : undefined;

  return (
    <Drawer inline={inline} title={VERIFIER.org} subtitle={t("Buyer · Verify sourcing before purchase")} onClose={onClose}>
      {selected ? (
        <RequestDetail key={selected.challenge} c={selected} />
      ) : (
        <>
          <p className="mb-4 text-[13px] leading-relaxed text-ink-300">{t("Ask a supplier to prove that its material meets your sourcing criteria, without sharing its private source data.")}</p>
          {creating ? (
            <form
              className="grid grid-cols-2 items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!create.isPending) create.mutate();
              }}
            >
              <Field label={t("Supplier to verify")}>
                <Select value={from} onChange={(e) => setFrom(e.target.value as PartyName)}>
                  {CHAIN.map((p) => (
                    <option key={p} value={p}>
                      {PARTIES[p].org}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("Checks to request")}>
                <Select value={level} onChange={(e) => setLevel(e.target.value as Profile)}>
                  {PROFILES.map((p) => (
                    <option key={p.id} value={p.id}>
                      {t(p.label)}
                    </option>
                  ))}
                </Select>
              </Field>
              <p className="col-span-2 text-xs leading-relaxed text-ink-300">{t(PROFILE_HELP[level])}</p>
              <p className="col-span-2 text-xs text-ink-400">{t("Creates a request only. The supplier then selects a lot and submits its proof.")}</p>
              <Button type="submit" size="sm" className="h-8" disabled={create.isPending}>
                {t("Send request")}</Button>
            </form>
          ) : (
            <Button onClick={() => setCreating(true)}>{t("Request proof")}</Button>
          )}
          <ErrorLine error={create.error} />

          <Heading>{t("Requests")}</Heading>
          {list.length ? (
            <div className="-mx-1">
              {list.map((c) => (
                <RequestRow key={c.challenge} c={c} />
              ))}
            </div>
          ) : (
            <p className="py-1.5 text-[13px] text-ink-400">{t("No requests yet. Request a proof to start a sourcing check.")}</p>
          )}
        </>
      )}
    </Drawer>
  );
}
