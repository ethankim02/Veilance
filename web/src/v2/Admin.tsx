import { t, useI18n } from '@/lib/i18n';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, ErrorLine, Field, Heading, Input, Select } from '@/components/ui';
import { v2, type Profile, type TenantCreated } from './api';
import { JobLine, q2, useRun } from './hooks';

type Tenant = { id: string; name: string; role: string; partyId: string; certId: string; supplier: boolean; recycler: 'eu' | 'other' | null; receivingKey: boolean };

function Deploy() {
  useI18n();
  const r = useRun<Record<string, never>>('POST', '/v2/admin/deploy');
  return (
    <section className="rounded-xl border border-amber/40 bg-amber-faint p-5">
      <h3 className="text-base font-semibold">{t('v2 컨트랙트가 아직 배포되지 않았습니다')}</h3>
      <p className="mt-1 text-xs text-ink-300">{t('배포는 7개 회로로 먼저 올린 뒤 나머지 7개 검증 키를 유지보수 거래로 추가합니다. 로컬 데브넷에서 약 3분 걸립니다.')}</p>
      <Button className="mt-3" onClick={() => r.run({})} disabled={r.pending}>
        {t('배포')}
      </Button>
      <JobLine job={r.job} className="mt-2" />
      <ErrorLine error={r.error} />
    </section>
  );
}

function CreateTenant() {
  useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const m = useMutation({
    mutationFn: () => v2<TenantCreated>('POST', '/v2/admin/tenants', { name: name.trim() }),
    onSuccess: () => {
      setName('');
      qc.invalidateQueries({ queryKey: q2.tenants });
    },
  });
  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !m.isPending) m.mutate();
        }}
      >
        <Field label={t('회사 이름')} className="w-64">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button type="submit" disabled={!name.trim() || m.isPending}>
          {t('회사 계정 만들기')}
        </Button>
      </form>
      <ErrorLine error={m.error} />
      {m.data && (
        <div className="rounded-lg border border-accent/40 bg-ink-900 p-4 text-xs">
          <p className="text-sm text-accent">{t('API 키는 지금 한 번만 표시됩니다. 회사에 안전하게 전달하세요.')}</p>
          <pre className="mt-2 overflow-x-auto text-ink-200">{JSON.stringify({ apiKey: m.data.apiKey, partyId: m.data.partyId, certId: m.data.certId }, null, 2)}</pre>
          <p className="mt-2 text-ink-400">{t('수신 키 등록 거래가 자동으로 진행됩니다.')}</p>
        </div>
      )}
    </div>
  );
}

function Chip({ on, label }: { on: boolean; label: string }) {
  return <span className={on ? 'rounded-full bg-accent/15 px-2 py-0.5 text-accent' : 'rounded-full bg-ink-800 px-2 py-0.5 text-ink-500'}>{on ? '✓ ' : ''}{label}</span>;
}

function TenantRow({ tn }: { tn: Tenant }) {
  useI18n();
  const supplier = useRun<{ partyId: string; certId: string }>('POST', '/v2/admin/suppliers');
  const recycler = useRun<{ partyId: string; certId: string; isEu: boolean }>('POST', '/v2/admin/recyclers');
  const [eu, setEu] = useState('true');
  return (
    <div className="border-t border-ink-700 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{tn.name}</p>
          <p className="truncate font-mono text-[11px] text-ink-400">{tn.partyId}</p>
          <p className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
            <Chip on={tn.receivingKey} label={t('수신 키')} />
            <Chip on={tn.supplier} label={t('공급업체')} />
            <Chip on={!!tn.recycler} label={tn.recycler === 'other' ? t('재활용 · EU 외') : t('재활용 · EU')} />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!tn.supplier && (
            <Button size="sm" variant="secondary" disabled={supplier.pending} onClick={() => supplier.run({ partyId: tn.partyId, certId: tn.certId })}>
              {t('공급업체 인증')}
            </Button>
          )}
          {!tn.recycler && (
            <>
              <Select aria-label={t('재활용 구분')} className="h-7 w-24 text-xs" value={eu} onChange={(e) => setEu(e.target.value)}>
                <option value="true">EU</option>
                <option value="false">{t('EU 외')}</option>
              </Select>
              <Button size="sm" variant="secondary" disabled={recycler.pending} onClick={() => recycler.run({ partyId: tn.partyId, certId: tn.certId, isEu: eu === 'true' })}>
                {t('재활용 업체 인증')}
              </Button>
            </>
          )}
        </div>
      </div>
      <JobLine job={supplier.job ?? recycler.job} className="mt-1" />
      <ErrorLine error={supplier.error ?? recycler.error} />
    </div>
  );
}

function Policy() {
  useI18n();
  const [origin, setOrigin] = useState('');
  const [rule, setRule] = useState({ inMaterial: 'nickel', outMaterial: 'nickel', yieldPct: '100' });
  const [threshold, setThreshold] = useState('9');
  const o = useRun<{ label: string }>('POST', '/v2/admin/origins');
  const r = useRun<{ inMaterial: string; outMaterial: string; yieldPct: number }>('POST', '/v2/admin/rules');
  const th = useRun<{ value: number }>('POST', '/v2/admin/threshold');
  return (
    <div className="space-y-5">
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (origin.trim()) o.run({ label: origin.trim() }); }}>
        <Field label={t('원산지 · 재활용 시설 이름')} className="w-64">
          <Input value={origin} maxLength={32} onChange={(e) => setOrigin(e.target.value)} />
        </Field>
        <Button type="submit" disabled={!origin.trim() || o.pending}>{t('원산지 승인')}</Button>
        <JobLine job={o.job} className="w-full" />
        <ErrorLine error={o.error} />
      </form>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); r.run({ inMaterial: rule.inMaterial, outMaterial: rule.outMaterial, yieldPct: Number(rule.yieldPct) }); }}>
        <Field label={t('입력 재료')} className="w-36"><Input value={rule.inMaterial} onChange={(e) => setRule({ ...rule, inMaterial: e.target.value })} /></Field>
        <Field label={t('산출 재료')} className="w-36"><Input value={rule.outMaterial} onChange={(e) => setRule({ ...rule, outMaterial: e.target.value })} /></Field>
        <Field label={t('최대 수율 (%)')} className="w-28"><Input inputMode="numeric" value={rule.yieldPct} onChange={(e) => setRule({ ...rule, yieldPct: e.target.value })} /></Field>
        <Button type="submit" disabled={r.pending}>{t('가공 규칙 등록')}</Button>
        <JobLine job={r.job} className="w-full" />
        <ErrorLine error={r.error} />
      </form>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); th.run({ value: Number(threshold) }); }}>
        <Field label={t('탄소 등급 상한')} className="w-28"><Input inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></Field>
        <Button type="submit" disabled={th.pending}>{t('설정')}</Button>
        <JobLine job={th.job} className="w-full" />
        <ErrorLine error={th.error} />
      </form>
    </div>
  );
}

export function AdminHome({ me }: { me: Profile }) {
  useI18n();
  const tenants = useQuery({ queryKey: q2.tenants, queryFn: () => v2<Tenant[]>('GET', '/v2/admin/tenants'), refetchInterval: 10_000 });
  return (
    <div className="space-y-6">
      {!me.deployed && <Deploy />}
      <section className="rounded-xl border border-ink-600 bg-ink-850 p-5">
        <h3 className="text-base font-semibold">{t('회사')}</h3>
        <div className="mt-3">
          <CreateTenant />
        </div>
        <Heading>{t('등록된 회사')}</Heading>
        {(tenants.data ?? []).filter((x) => x.role === 'company').map((tn) => <TenantRow key={tn.id} tn={tn} />)}
      </section>
      <section className="rounded-xl border border-ink-600 bg-ink-850 p-5">
        <h3 className="mb-3 text-base font-semibold">{t('정책')}</h3>
        <Policy />
      </section>
    </div>
  );
}
