import { t, useI18n } from '@/lib/i18n';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getApi } from '@/api/client';
import type { Challenge, PartyName, Profile } from '@/api/types';
import { Button, ErrorLine, Field, Select } from '@/components/ui';
import { RequestDetail, useStatus } from '@/components/drawers/VerifierDrawer';
import { qk, useChallenges, useVerify } from '@/hooks/queries';
import { CHECK_LABEL, NOT_DISCLOSED, PROFILE_CHECKS } from '@/lib/certs';
import { cx } from '@/lib/format';
import { useQueryNav } from '@/lib/nav';
import { CHAIN, PARTIES, PROFILES, profileLabel } from '@/lib/registry';

export type BuyerTab = 'request' | 'results';

function useCreateRequest(onCreated: (c: Challenge) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { profile: Profile; holder: PartyName }) => getApi().createChallenge(input),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: qk.challenges });
      qc.invalidateQueries({ queryKey: ['open'] });
      onCreated(c);
    },
  });
}

function RequestTab() {
  useI18n();
  const nav = useQueryNav();
  const [holder, setHolder] = useState<PartyName>('batteryMfr');
  const [level, setLevel] = useState<Profile>('procurement');
  const create = useCreateRequest((c) => nav.patch({ tab: 'results', req: c.challenge }));
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!create.isPending) create.mutate({ profile: level, holder });
      }}
    >
      <section className="rounded-xl border border-ink-600 bg-ink-850 p-5">
        <h3 className="text-sm font-semibold">{t("1. 검증할 공급업체")}</h3>
        <Field label={t("공급업체")} className="mt-3 max-w-xs">
          <Select value={holder} onChange={(e) => setHolder(e.target.value as PartyName)}>
            {CHAIN.map((p) => <option key={p} value={p}>{PARTIES[p].org}</option>)}
          </Select>
        </Field>
      </section>
      <section className="rounded-xl border border-ink-600 bg-ink-850 p-5">
        <h3 className="text-sm font-semibold">{t("2. 요구할 조건")}</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label={t("요구할 조건")}>
          {PROFILES.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={level === p.id} onClick={() => setLevel(p.id)}
              className={cx('rounded-xl border p-4 text-left transition', level === p.id ? 'border-accent bg-accent-faint' : 'border-ink-600 hover:border-ink-400')}>
              <p className="text-sm font-medium">{t(p.label)}</p>
              <ul className="mt-2 space-y-1 text-xs text-ink-300">{PROFILE_CHECKS[p.id].map((k) => <li key={k}>✓ {t(CHECK_LABEL[k])}</li>)}</ul>
            </button>
          ))}
        </div>
      </section>
      <section className="rounded-xl border border-ink-600 bg-ink-850 p-5 text-[13px]">
        <h3 className="text-sm font-semibold">{t("3. 받게 되는 결과")}</h3>
        <p className="mt-2 text-ink-300">{t("공급업체가 증명을 제출하면 검사 항목별 통과 여부와 적용된 정책 버전을 받습니다.")}</p>
        <p className="mt-2 text-xs text-ink-400">{t("받지 않는 정보: {items}", { items: NOT_DISCLOSED.map((r) => t(r)).join(' · ') })}</p>
        <p className="mt-2 text-xs text-ink-400">{t("결과는 특정 납품 배치를 가리키지 않습니다. 공급업체가 보유한 증명서 중 하나가 조건을 충족한다는 뜻입니다.")}</p>
      </section>
      <div>
        <Button type="submit" disabled={create.isPending}>{t("{company}에 증명 요청 보내기", { company: PARTIES[holder].org })}</Button>
        <ErrorLine error={create.error} />
      </div>
    </form>
  );
}

function ResultRow({ c, onOpen }: { c: Challenge; onOpen: () => void }) {
  useI18n();
  const s = useStatus(c);
  return (
    <button onClick={onOpen} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-ink-800">
      <span className="min-w-0">
        <span className="block truncate text-sm">{PARTIES[c.holder].org} · {profileLabel(c.profile)}</span>
        <span className="text-xs text-ink-400">{new Date(c.createdAt).toLocaleString()}</span>
      </span>
      <span className={cx('shrink-0 text-xs', s.tone)}>{s.text}</span>
    </button>
  );
}

function ReRequest({ c }: { c: Challenge }) {
  useI18n();
  const nav = useQueryNav();
  const v = useVerify(c.challenge, c.holder, c.profile);
  const create = useCreateRequest((n) => nav.patch({ req: n.challenge }));
  if (v.data?.status !== 'STALE') return null;
  return (
    <div className="mt-3">
      <Button size="sm" onClick={() => create.mutate({ profile: c.profile, holder: c.holder })} disabled={create.isPending}>{t("현재 정책으로 다시 요청")}</Button>
      <ErrorLine error={create.error} />
    </div>
  );
}

function ResultsTab({ req }: { req: string | null }) {
  useI18n();
  const nav = useQueryNav();
  const challenges = useChallenges();
  const list = [...(challenges.data ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const selected = req ? list.find((c) => c.challenge === req) : undefined;
  if (selected)
    return (
      <div className="rounded-xl border border-ink-600 bg-ink-850 p-5">
        <RequestDetail key={selected.challenge} c={selected} backTo="?tab=results" footer={<ReRequest c={selected} />} />
      </div>
    );
  if (challenges.isPending) return <p className="py-10 text-center text-sm text-ink-300">{t("결과를 불러오는 중…")}</p>;
  if (!list.length) return <p className="rounded-xl border border-dashed border-ink-600 py-10 text-center text-sm text-ink-400">{t("보낸 요청이 없습니다. ‘검증 요청하기’에서 시작하세요.")}</p>;
  return (
    <div className="divide-y divide-ink-700 rounded-xl border border-ink-600 bg-ink-850">
      {list.map((c) => <ResultRow key={c.challenge} c={c} onOpen={() => nav.patch({ req: c.challenge })} />)}
    </div>
  );
}

export function BuyerHome({ tab }: { tab: BuyerTab }) {
  useI18n();
  const nav = useQueryNav();
  return <div className="mx-auto w-full max-w-4xl p-5 sm:p-8">{tab === 'request' ? <RequestTab /> : <ResultsTab req={nav.get('req')} />}</div>;
}
