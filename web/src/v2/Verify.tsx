import { t, useI18n } from '@/lib/i18n';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, ErrorLine, Field, Input } from '@/components/ui';
import { v2, pct, type AttestationCheck, type AuditorPackage, type DeclarationCheck } from './api';

/** Notified body: checks a declared recycled share, and the hidden total once the manufacturer hands over its package. */
function DeclarationCheckForm() {
  useI18n();
  const [raw, setRaw] = useState('');
  const m = useMutation({
    mutationFn: (pkg: Partial<AuditorPackage>) => v2<DeclarationCheck>('POST', '/v2/public/declaration', pkg, null),
  });
  let parsed: Partial<AuditorPackage> | null = null;
  try {
    parsed = raw.trim() ? (JSON.parse(raw) as Partial<AuditorPackage>) : null;
  } catch {
    parsed = null;
  }
  const valid = !!parsed?.owner && !!parsed.plant && Number.isInteger(parsed.period) && !!parsed.material;
  const r = m.data;
  return (
    <section className="rounded-xl border border-ink-600 bg-ink-850 p-5">
      <h3 className="text-base font-semibold">{t('인증기관 · 재활용 함량 신고 확인')}</h3>
      <p className="mt-1 text-xs text-ink-400">{t('제조사에게 받은 제출 패키지(JSON)를 붙여 넣으세요. 체인에 기록된 신고 비율을 읽고, 숨겨진 투입 총량이 패키지의 값과 일치하는지 확인합니다. 그 총량을 공장 생산 기록과 대조하는 것이 인증기관의 몫입니다.')}</p>
      <textarea
        aria-label={t('제출 패키지 JSON')}
        className="mt-3 h-36 w-full rounded-md border border-ink-600 bg-ink-900 p-2.5 font-mono text-xs text-ink-100 focus:border-accent/60 focus:outline-none"
        placeholder='{"owner":"…","plant":"…","period":2028,"material":"nickel","totalKg":30000,"salt":"…"}'
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      {raw.trim() && !valid && <p className="mt-1 text-xs text-amber">{t('owner, plant, period, material 이 필요합니다.')}</p>}
      <Button className="mt-3" disabled={!valid || m.isPending} onClick={() => parsed && m.mutate(parsed)}>
        {t('확인')}
      </Button>
      <ErrorLine error={m.error} />
      {r && (
        <div className="mt-4 rounded-lg bg-ink-900 p-4 text-sm" role="status">
          {!r.declared ? (
            <p className="text-amber">{t('이 공장 · 기간 · 재료로 신고된 기록이 없습니다.')}</p>
          ) : (
            <ul className="space-y-1.5">
              <li>
                {t('신고된 재활용 비율')}: <span className="font-semibold text-accent">{pct(r.shareBps ?? 0)}</span>
              </li>
              <li>
                {t('투입 총량 일치')}:{' '}
                {r.totalMatches === undefined ? (
                  <span className="text-ink-400">{t('총량과 비밀값이 없어 확인하지 않음')}</span>
                ) : r.totalMatches ? (
                  <span className="text-accent">✓ {t('일치 — 이제 공장 생산 기록과 대조하세요')}</span>
                ) : (
                  <span className="text-red">✗ {t('불일치 — 패키지의 총량이 신고 당시 값과 다릅니다')}</span>
                )}
              </li>
              <li className="text-xs text-ink-400">{t('신고 비율은 컨트랙트가 증명으로 검증한 값입니다. 투입된 로트 · 재활용 업체 · 공급사는 체인에 드러나지 않습니다.')}</li>
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** Buyer: checks an order-bound attestation from the challenge it issued. */
function AttestationCheckForm() {
  useI18n();
  const [challenge, setChallenge] = useState('');
  const [owner, setOwner] = useState('');
  const [min, setMin] = useState('');
  const m = useMutation({
    mutationFn: () => v2<AttestationCheck>('POST', '/v2/public/attestation', { challenge: challenge.trim(), owner: owner.trim(), minQuantityKg: Number(min) }, null),
  });
  const valid = /^[0-9a-f]{64}$/i.test(challenge.trim()) && /^[0-9a-f]{64}$/i.test(owner.trim()) && Number.isInteger(Number(min)) && Number(min) > 0;
  const r = m.data;
  return (
    <section className="rounded-xl border border-ink-600 bg-ink-850 p-5">
      <h3 className="text-base font-semibold">{t('구매사 · 주문 증명 확인')}</h3>
      <p className="mt-1 text-xs text-ink-400">{t('공급사에 보낸 요청 코드와 주문 수량으로 증명 기록을 찾습니다. 코드와 수량을 모르는 사람에게는 이 기록이 무엇인지 보이지 않습니다.')}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label={t('요청 코드 (64자리)')} className="sm:col-span-2">
          <Input mono value={challenge} onChange={(e) => setChallenge(e.target.value)} />
        </Field>
        <Field label={t('공급사 식별자 (64자리)')}>
          <Input mono value={owner} onChange={(e) => setOwner(e.target.value)} />
        </Field>
        <Field label={t('주문 수량 (kg)')}>
          <Input inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button disabled={!valid || m.isPending} onClick={() => m.mutate()}>
          {t('확인')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setChallenge(Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join(''))}>
          {t('새 요청 코드 만들기')}
        </Button>
      </div>
      <ErrorLine error={m.error} />
      {r && (
        <p className="mt-3 text-sm" role="status">
          {!r.attested ? (
            <span className="text-amber">{t('아직 증명이 없습니다.')}</span>
          ) : r.fresh ? (
            <span className="text-accent">✓ {t('주문 수량 이상 · 정책 충족 (정책 v{v})', { v: r.policyVersion ?? '—' })}</span>
          ) : (
            <span className="text-amber">⚠ {t('이전 정책(v{old})으로 만든 증명입니다. 현재 v{cur} 기준으로 다시 요청하세요.', { old: r.policyVersion ?? '—', cur: r.currentPolicyVersion ?? '—' })}</span>
          )}
        </p>
      )}
    </section>
  );
}

export function VerifyHome() {
  useI18n();
  const ledger = useQuery({ queryKey: ['v2', 'public-ledger'], queryFn: () => v2<Record<string, string>>('GET', '/v2/public/ledger', undefined, null), retry: 0, refetchInterval: 15_000 });
  return (
    <div className="space-y-5">
      <DeclarationCheckForm />
      <AttestationCheckForm />
      {ledger.data && (
        <p className="text-center text-xs text-ink-400">
          {t('공유 원장')} {ledger.data.contractAddress?.slice(0, 8)}… · {t('로트 {n} · 사용 식별자 {m} · 신고 {d}', { n: ledger.data.lotLeaves, m: ledger.data.nullifiers, d: ledger.data.declarations })}
        </p>
      )}
    </div>
  );
}
