import { t, useI18n } from '@/lib/i18n';
import { useMemo, useState } from 'react';
import { Button, ErrorLine, Field, Input, Select } from '@/components/ui';
import { cx } from '@/lib/format';
import { kg, pct, short, type AccountView, type AuditorPackage, type LotView, type Profile } from './api';
import { v2 } from './api';
import { JobLine, opLabel, useDirectory, useJobs, useLots, usePeriods, useRun } from './hooks';

type Tab = 'lots' | 'issue' | 'periods' | 'jobs';

const intOr = (s: string) => (s.trim() === '' ? NaN : Number(s));
const validKg = (n: number) => Number.isInteger(n) && n > 0 && n <= 0xffffffff;

/* ---------------- lot card ---------------- */

function RecycledBar({ lot }: { lot: Pick<LotView, 'quantityKg' | 'recycledEuKg' | 'recycledOtherKg'> }) {
  useI18n();
  const eu = lot.quantityKg ? (lot.recycledEuKg / lot.quantityKg) * 100 : 0;
  const other = lot.quantityKg ? (lot.recycledOtherKg / lot.quantityKg) * 100 : 0;
  return (
    <div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-ink-700" aria-hidden>
        <div className="bg-accent" style={{ width: `${eu}%` }} />
        <div className="bg-amber" style={{ width: `${other}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-ink-400">
        {lot.recycledEuKg || lot.recycledOtherKg
          ? t('재활용 {eu} EU · {other} 기타', { eu: kg(lot.recycledEuKg), other: kg(lot.recycledOtherKg) })
          : t('재활용분 없음')}
      </p>
    </div>
  );
}

function LotCard({ lot, selected, onSelect, onOpen, open }: { lot: LotView; selected: boolean; onSelect: () => void; onOpen: () => void; open: boolean }) {
  useI18n();
  const consumed = lot.status === 'CONSUMED';
  return (
    <div className={cx('rounded-2xl border bg-gradient-to-br from-[#1f3348] to-[#0f1820] p-4 transition', open ? 'border-accent' : 'border-white/10', consumed && 'opacity-50')}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/60">{t('원자재 로트')}</span>
        {!consumed && (
          <label className="flex items-center gap-1.5 text-[11px] text-white/70">
            <input type="checkbox" checked={selected} onChange={onSelect} className="accent-accent" aria-label={t('합치기에 선택')} />
            {t('합치기')}
          </label>
        )}
      </div>
      <button type="button" onClick={onOpen} className="mt-3 block w-full text-left">
        <p className="text-2xl font-semibold capitalize text-white">{lot.material}</p>
        <p className="text-lg tabular-nums text-white/90">{kg(lot.quantityKg)}</p>
      </button>
      <div className="mt-3">
        <RecycledBar lot={lot} />
      </div>
      <p className="mt-2 truncate text-[11px] text-white/60">
        {lot.origins.map((o) => o.origin).join(' + ')} · {t(lot.custody)}
        {lot.memo ? ` · ${lot.memo}` : ''}
      </p>
      {consumed && <p className="mt-1 text-[11px] text-white/60">{t('사용됨')}</p>}
    </div>
  );
}

/* ---------------- per-lot actions ---------------- */

function TransferForm({ lot, me }: { lot: LotView; me: Profile }) {
  useI18n();
  const dir = useDirectory();
  const [to, setTo] = useState('');
  const [qty, setQty] = useState(String(lot.quantityKg));
  const [eu, setEu] = useState('');
  const [other, setOther] = useState('');
  const [memo, setMemo] = useState('');
  const r = useRun<Record<string, unknown>>('POST', `/v2/lots/${lot.id}/transfer`);
  const q = intOr(qty);
  const recipients = (dir.data ?? []).filter((d) => d.partyId !== me.partyId);
  const recipient = to || recipients[0]?.partyId || '';
  const valid = !!recipient && validKg(q) && q <= lot.quantityKg;
  const propEu = validKg(q) ? Math.floor((lot.recycledEuKg * q) / lot.quantityKg) : 0;
  const propOther = validKg(q) ? Math.floor((lot.recycledOtherKg * q) / lot.quantityKg) : 0;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || r.pending) return;
        r.run({
          recipient,
          quantityKg: q,
          ...(eu !== '' || other !== '' ? { recycledEuKg: intOr(eu || '0'), recycledOtherKg: intOr(other || '0') } : {}),
          ...(memo ? { memo } : {}),
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('받는 회사')}>
          <Select value={recipient} onChange={(e) => setTo(e.target.value)}>
            {recipients.map((d) => (
              <option key={d.partyId} value={d.partyId}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('보낼 수량 (kg, 최대 {max})', { max: lot.quantityKg.toLocaleString() })}>
          <Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label={t('함께 보낼 EU 재활용분 (kg, 비우면 비례 {n})', { n: propEu.toLocaleString() })}>
          <Input inputMode="numeric" value={eu} placeholder={String(propEu)} onChange={(e) => setEu(e.target.value)} />
        </Field>
        <Field label={t('함께 보낼 기타 재활용분 (kg, 비우면 비례 {n})', { n: propOther.toLocaleString() })}>
          <Input inputMode="numeric" value={other} placeholder={String(propOther)} onChange={(e) => setOther(e.target.value)} />
        </Field>
        <Field label={t('메모 (주문 번호 등, 32자 이내)')} className="sm:col-span-2">
          <Input value={memo} maxLength={32} onChange={(e) => setMemo(e.target.value)} />
        </Field>
      </div>
      <p className="text-xs text-ink-400">{t('남는 수량은 잔량 로트로 돌아옵니다. 재활용분은 나눠 보낼 수 있지만 가진 것보다 많이 보낼 수는 없습니다.')}</p>
      <Button type="submit" disabled={!valid || r.pending}>
        {t('전달')}
      </Button>
      <JobLine job={r.job} />
      <ErrorLine error={r.error} />
    </form>
  );
}

function AttestForm({ lot }: { lot: LotView }) {
  useI18n();
  const [challenge, setChallenge] = useState('');
  const [min, setMin] = useState('');
  const r = useRun<{ challenge: string; minQuantityKg: number }>('POST', `/v2/lots/${lot.id}/attest-order`);
  const m = intOr(min);
  const valid = /^[0-9a-f]{64}$/i.test(challenge.trim()) && validKg(m);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !r.pending) r.run({ challenge: challenge.trim().toLowerCase(), minQuantityKg: m });
      }}
    >
      <Field label={t('구매사 요청 코드 (64자리)')}>
        <Input mono value={challenge} onChange={(e) => setChallenge(e.target.value)} />
      </Field>
      <Field label={t('주문 수량 (kg)')}>
        <Input inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} />
      </Field>
      <p className="text-xs text-ink-400">{t('이 로트가 주문 수량 이상이고 정책을 충족함을 증명합니다. 수량과 주문 크기는 공개되지 않고, 로트는 같은 내용으로 교체됩니다.')}</p>
      <Button type="submit" disabled={!valid || r.pending}>
        {t('주문 증명 제출')}
      </Button>
      <JobLine job={r.job} />
      <ErrorLine error={r.error} />
    </form>
  );
}

function ConsumeForm({ lot }: { lot: LotView }) {
  useI18n();
  const periods = usePeriods();
  const open = (periods.data ?? []).filter((a) => a.status === 'OPEN' && a.material === lot.material);
  const [id, setId] = useState('');
  const accountId = id || open[0]?.id || '';
  const r = useRun<{ lotId: string }>('POST', () => `/v2/periods/${accountId}/consume`);
  if (!open.length) return <p className="text-sm text-ink-400">{t('이 재료의 열린 기간 계정이 없습니다. ‘공장 · 기간 신고’에서 먼저 여세요.')}</p>;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (accountId && !r.pending) r.run({ lotId: lot.id });
      }}
    >
      <Field label={t('투입할 기간 계정')}>
        <Select value={accountId} onChange={(e) => setId(e.target.value)}>
          {open.map((a) => (
            <option key={a.id} value={a.id}>
              {a.plant} · {a.period} · {a.material}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-xs text-ink-400">{t('로트 전체가 이 공장 · 기간의 생산에 투입된 것으로 기록되고 로트는 소비됩니다.')}</p>
      <Button type="submit" disabled={r.pending}>
        {t('기간에 투입')}
      </Button>
      <JobLine job={r.job} />
      <ErrorLine error={r.error} />
    </form>
  );
}

function LotPanel({ lot, me, onClose }: { lot: LotView; me: Profile; onClose: () => void }) {
  useI18n();
  const [mode, setMode] = useState<'transfer' | 'attest' | 'consume'>('transfer');
  return (
    <section className="rounded-xl border border-ink-600 bg-ink-850 p-5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold capitalize">
            {lot.material} · {kg(lot.quantityKg)}
          </h3>
          <p className="mt-1 text-xs text-ink-400">
            {lot.origins.map((o) => `${o.origin} (${t('발행')} ${short(o.issuer)})`).join(' · ')}
          </p>
        </div>
        <button onClick={onClose} className="text-ink-400 hover:text-ink-100" aria-label={t('닫기')}>
          ✕
        </button>
      </div>
      <div className="mt-4 flex gap-1 rounded-lg bg-ink-800 p-1 text-xs" role="group">
        {(['transfer', 'attest', 'consume'] as const).map((m) => (
          <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)} className={cx('rounded-md px-3 py-1.5', mode === m ? 'bg-ink-700 text-ink-100' : 'text-ink-400')}>
            {t(m === 'transfer' ? '전달 · 나누기' : m === 'attest' ? '주문 증명' : '기간 투입')}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {mode === 'transfer' && <TransferForm key={lot.id} lot={lot} me={me} />}
        {mode === 'attest' && <AttestForm key={lot.id} lot={lot} />}
        {mode === 'consume' && <ConsumeForm key={lot.id} lot={lot} />}
      </div>
    </section>
  );
}

/* ---------------- merge ---------------- */

function MergePanel({ a, b, onDone }: { a: LotView; b: LotView; onDone: () => void }) {
  useI18n();
  const [outMaterial, setOut] = useState(a.material);
  const [yieldPct, setYield] = useState('100');
  const [qty, setQty] = useState(String(a.quantityKg + b.quantityKg));
  const r = useRun<Record<string, unknown>>('POST', '/v2/lots/process');
  const y = intOr(yieldPct);
  const q = intOr(qty);
  const cap = Number.isInteger(y) ? Math.floor(((a.quantityKg + b.quantityKg) * y) / 100) : 0;
  const same = a.material === b.material;
  const valid = same && Number.isInteger(y) && y >= 1 && y <= 100 && validKg(q) && q <= cap && !!outMaterial;
  return (
    <section className="rounded-xl border border-accent/50 bg-ink-850 p-5">
      <h3 className="text-base font-semibold">{t('두 로트 합치기 · 가공')}</h3>
      <p className="mt-1 text-xs text-ink-400">
        {a.material} {kg(a.quantityKg)} + {b.material} {kg(b.quantityKg)}
      </p>
      {!same ? (
        <p className="mt-3 text-sm text-amber">{t('같은 재료의 로트만 합칠 수 있습니다.')}</p>
      ) : (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !r.pending) r.run({ lotIds: [a.id, b.id], outMaterial, yieldPct: y, quantityKg: q });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('산출 재료')}>
              <Input value={outMaterial} maxLength={32} onChange={(e) => setOut(e.target.value)} />
            </Field>
            <Field label={t('등록된 수율 (%)')}>
              <Input inputMode="numeric" value={yieldPct} onChange={(e) => setYield(e.target.value)} />
            </Field>
            <Field label={t('산출량 (kg, 최대 {max})', { max: cap.toLocaleString() })}>
              <Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
          </div>
          <p className="text-xs text-ink-400">{t('관리자가 등록한 가공 규칙과 수율이 일치해야 합니다. 재활용 비율은 입력 로트들의 비율을 넘을 수 없습니다.')}</p>
          <Button type="submit" disabled={!valid || r.pending}>
            {t('합치기')}
          </Button>
          <JobLine job={r.job} />
          <ErrorLine error={r.error} />
          {r.job?.stage === 'confirmed' && (
            <Button type="button" variant="secondary" size="sm" onClick={onDone}>
              {t('닫기')}
            </Button>
          )}
        </form>
      )}
    </section>
  );
}

/* ---------------- lots tab ---------------- */

/**
 * The newest job, while it runs and for a minute after. A lot panel closes
 * when its lot is spent (full transfer, consumed into a period), which would
 * otherwise take the job's outcome off screen with it.
 */
function RecentJob() {
  useI18n();
  const jobs = useJobs();
  const j = jobs.data?.[0];
  if (!j) return null;
  const recent = !j.finishedAt || Date.now() - Date.parse(j.finishedAt) < 60_000;
  if (!recent) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-600 bg-ink-850 px-4 py-2 text-sm" aria-label={t('최근 작업')}>
      <span className="text-ink-300">{opLabel(j.op)}</span>
      <JobLine job={j} />
    </div>
  );
}

function LotsTab({ me }: { me: Profile }) {
  useI18n();
  const lots = useLots();
  const [show, setShow] = useState<'ACTIVE' | 'CONSUMED'>('ACTIVE');
  const [openId, setOpenId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const list = (lots.data ?? []).filter((l) => l.status === show);
  const openLot = lots.data?.find((l) => l.id === openId && l.status === 'ACTIVE');
  const pickedLots = picked.map((id) => lots.data?.find((l) => l.id === id && l.status === 'ACTIVE')).filter(Boolean) as LotView[];
  const total = (lots.data ?? []).filter((l) => l.status === 'ACTIVE').reduce((s, l) => s + l.quantityKg, 0);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg bg-ink-850 p-1 text-xs" role="group">
          {(['ACTIVE', 'CONSUMED'] as const).map((s) => (
            <button key={s} aria-pressed={show === s} onClick={() => setShow(s)} className={cx('rounded-md px-3 py-1.5', show === s ? 'bg-ink-700 text-ink-100' : 'text-ink-400')}>
              {t(s === 'ACTIVE' ? '보유 중' : '사용됨')} <span className="text-ink-400">{(lots.data ?? []).filter((l) => l.status === s).length}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-ink-400">{t('보유 합계 {total}', { total: kg(total) })}</p>
      </div>
      <RecentJob />
      {pickedLots.length === 2 && <MergePanel key={picked.join()} a={pickedLots[0]} b={pickedLots[1]} onDone={() => setPicked([])} />}
      {openLot && <LotPanel key={openLot.id} lot={openLot} me={me} onClose={() => setOpenId(null)} />}
      {lots.isPending ? (
        <p className="py-10 text-center text-sm text-ink-400">{t('불러오는 중…')}</p>
      ) : list.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((l) => (
            <LotCard key={l.id} lot={l} open={openId === l.id} selected={picked.includes(l.id)} onSelect={() => toggle(l.id)} onOpen={() => setOpenId(l.id === openId ? null : l.id)} />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-ink-600 py-10 text-center text-sm text-ink-400">
          {show === 'ACTIVE' ? t('보유한 로트가 없습니다. 받은 로트는 자동으로 여기에 나타납니다.') : t('사용된 로트가 없습니다.')}
        </p>
      )}
    </div>
  );
}

/* ---------------- issue tab (the minimal recycler screen) ---------------- */

function IssueTab({ me }: { me: Profile }) {
  useI18n();
  const dir = useDirectory();
  const recipients = (dir.data ?? []).filter((d) => d.partyId !== me.partyId);
  const [to, setTo] = useState('');
  const [origin, setOrigin] = useState('');
  const [material, setMaterial] = useState('nickel');
  const [qty, setQty] = useState('');
  const [carbon, setCarbon] = useState('1');
  const [memo, setMemo] = useState('');
  const recycled = !!me.recycler;
  const r = useRun<Record<string, unknown>>('POST', '/v2/lots/issue');
  const q = intOr(qty);
  const c = intOr(carbon);
  const recipient = to || recipients[0]?.partyId || '';
  const valid = !!recipient && !!origin.trim() && !!material.trim() && validKg(q) && Number.isInteger(c) && c >= 0 && c <= 255;
  if (!me.supplier) return <p className="rounded-xl border border-ink-600 bg-ink-850 p-5 text-sm text-ink-300">{t('발행하려면 관리자에게 공급업체 인증을 받아야 합니다. 이 회사의 식별자와 인증 번호를 관리자에게 전달하세요.')}</p>;
  return (
    <form
      className="mx-auto max-w-xl space-y-4 rounded-xl border border-ink-600 bg-ink-850 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !r.pending) r.run({ recipient, origin: origin.trim(), material: material.trim(), quantityKg: q, carbonClass: c, recycled, isEu: me.recycler === 'eu', ...(memo ? { memo } : {}) });
      }}
    >
      <div>
        <h3 className="text-base font-semibold">{recycled ? t('재활용 원료 발행') : t('원료 로트 발행')}</h3>
        <p className="mt-1 text-xs text-ink-400">
          {recycled
            ? t('이 로트 전량이 재활용분으로 기록됩니다. {kind} 재활용 여부는 관리자가 등록한 인증서로 정해집니다.', { kind: me.recycler === 'eu' ? t('EU 역내') : t('EU 외') })
            : t('채굴 · 1차 원료입니다. 재활용분은 0으로 기록됩니다.')}
        </p>
      </div>
      <Field label={t('받는 회사')}>
        <Select value={recipient} onChange={(e) => setTo(e.target.value)}>
          {recipients.map((d) => (
            <option key={d.partyId} value={d.partyId}>
              {d.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={recycled ? t('재활용 시설 (승인된 원산지 이름)') : t('원산지 (승인된 이름)')}>
          <Input value={origin} maxLength={32} onChange={(e) => setOrigin(e.target.value)} />
        </Field>
        <Field label={t('재료')}>
          <Input value={material} maxLength={32} onChange={(e) => setMaterial(e.target.value)} />
        </Field>
        <Field label={t('수량 (kg)')}>
          <Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label={t('탄소 등급')}>
          <Input inputMode="numeric" value={carbon} onChange={(e) => setCarbon(e.target.value)} />
        </Field>
      </div>
      <Field label={t('메모 (선택, 32자 이내)')}>
        <Input value={memo} maxLength={32} onChange={(e) => setMemo(e.target.value)} />
      </Field>
      <p className="text-xs text-ink-400">{t('체인에는 해시와 암호문만 남습니다. 수량 · 재료 · 원산지는 받는 회사만 볼 수 있습니다.')}</p>
      <Button type="submit" disabled={!valid || r.pending}>
        {t('발행')}
      </Button>
      <JobLine job={r.job} />
      <ErrorLine error={r.error} />
    </form>
  );
}

/* ---------------- periods tab ---------------- */

function AccountCard({ a }: { a: AccountView }) {
  useI18n();
  const [bps, setBps] = useState('');
  const [pkg, setPkg] = useState<AuditorPackage | null>(null);
  const [pkgErr, setPkgErr] = useState<Error | null>(null);
  const r = useRun<{ shareBps?: number }>('POST', `/v2/periods/${a.id}/declare`);
  const b = bps === '' ? a.maxDeclarableBps : intOr(bps);
  return (
    <div className="rounded-xl border border-ink-600 bg-ink-850 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">
          {a.plant} · {a.period} · <span className="capitalize">{a.material}</span>
        </h3>
        <span className={cx('rounded-full px-2 py-0.5 text-[11px]', a.status === 'DECLARED' ? 'bg-accent/15 text-accent' : 'bg-amber/15 text-amber')}>
          {t(a.status === 'DECLARED' ? '신고 완료' : '열림')}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-ink-400">{t('투입 합계')}</dt>
          <dd className="tabular-nums">{kg(a.totalKg)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-400">{t('재활용 EU · 기타')}</dt>
          <dd className="tabular-nums">
            {kg(a.recycledEuKg)} · {kg(a.recycledOtherKg)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-400">{a.status === 'DECLARED' ? t('신고한 비율') : t('신고 가능한 최대')}</dt>
          <dd className="tabular-nums">{pct(a.declaredBps ?? a.maxDeclarableBps)}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-ink-400">{t('EU 역내 재활용분은 1.3배로 계산합니다. 이 숫자들은 체인에 공개되지 않고, 신고 비율만 공개됩니다.')}</p>
      {/* Outside the form: a confirmed declaration flips the card to DECLARED and removes the form. */}
      <JobLine job={r.job} className="mt-3" />
      {a.status === 'OPEN' ? (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!r.pending && a.totalKg > 0) r.run({ shareBps: b });
          }}
        >
          <Field label={t('신고할 비율 (basis points, 비우면 최대)')} className="w-56">
            <Input inputMode="numeric" value={bps} placeholder={String(a.maxDeclarableBps)} onChange={(e) => setBps(e.target.value)} />
          </Field>
          <Button type="submit" disabled={r.pending || a.totalKg === 0}>
            {t('{p} 신고', { p: pct(Number.isFinite(b) ? b : 0) })}
          </Button>
          <ErrorLine error={r.error} />
        </form>
      ) : (
        <div className="mt-4 space-y-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              v2<AuditorPackage>('GET', `/v2/periods/${a.id}/auditor-package`)
                .then(setPkg)
                .catch(setPkgErr)
            }
          >
            {t('인증기관 제출 패키지 보기')}
          </Button>
          <ErrorLine error={pkgErr} />
          {pkg && (
            <div>
              <p className="text-xs text-amber">{t('투입 총량과 비밀값이 들어 있습니다. 인증기관에만 전달하세요.')}</p>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-ink-900 p-3 text-[11px] text-ink-200">{JSON.stringify(pkg, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PeriodsTab() {
  useI18n();
  const periods = usePeriods();
  const [plant, setPlant] = useState('');
  const [period, setPeriod] = useState(String(new Date().getFullYear()));
  const [material, setMaterial] = useState('nickel');
  const r = useRun<{ plant: string; period: number; material: string }>('POST', '/v2/periods');
  const p = intOr(period);
  const valid = !!plant.trim() && !!material.trim() && Number.isInteger(p);
  return (
    <div className="space-y-5">
      <form
        className="flex flex-wrap items-end gap-3 rounded-xl border border-ink-600 bg-ink-850 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !r.pending) r.run({ plant: plant.trim(), period: p, material: material.trim() });
        }}
      >
        <Field label={t('공장')} className="w-40">
          <Input value={plant} maxLength={32} onChange={(e) => setPlant(e.target.value)} />
        </Field>
        <Field label={t('기간 (연도)')} className="w-28">
          <Input inputMode="numeric" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </Field>
        <Field label={t('원소 · 재료')} className="w-32">
          <Input value={material} maxLength={32} onChange={(e) => setMaterial(e.target.value)} />
        </Field>
        <Button type="submit" disabled={!valid || r.pending}>
          {t('기간 계정 열기')}
        </Button>
        <p className="w-full text-xs text-ink-400">{t('공장 · 기간 · 재료마다 계정은 하나만 열 수 있습니다. 로트 화면의 ‘기간 투입’으로 생산에 쓴 로트를 넣은 뒤 신고합니다.')}</p>
        <JobLine job={r.job} className="w-full" />
        <ErrorLine error={r.error} />
      </form>
      {(periods.data ?? []).map((a) => (
        <AccountCard key={a.id} a={a} />
      ))}
      {periods.data?.length === 0 && <p className="py-6 text-center text-sm text-ink-400">{t('아직 연 기간 계정이 없습니다.')}</p>}
    </div>
  );
}

/* ---------------- jobs ---------------- */

function JobsTab() {
  useI18n();
  const jobs = useJobs();
  return (
    <div className="divide-y divide-ink-700 rounded-xl border border-ink-600 bg-ink-850">
      {(jobs.data ?? []).map((j) => (
        <div key={j.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
          <span>{opLabel(j.op)}</span>
          <JobLine job={j} />
        </div>
      ))}
      {jobs.data?.length === 0 && <p className="px-4 py-6 text-center text-sm text-ink-400">{t('작업 내역이 없습니다.')}</p>}
    </div>
  );
}

/* ---------------- shell ---------------- */

export function CompanyHome({ me }: { me: Profile }) {
  useI18n();
  const tabs = useMemo(() => {
    const all: [Tab, string][] = [
      ['lots', '내 로트'],
      ['issue', me.recycler ? '재활용 원료 발행' : '발행'],
      ['periods', '공장 · 기간 신고'],
      ['jobs', '작업 내역'],
    ];
    return all.filter(([id]) => id !== 'issue' || me.supplier);
  }, [me]);
  const [tab, setTab] = useState<Tab>(me.recycler ? 'issue' : 'lots');
  return (
    <div>
      <nav className="mb-6 flex flex-wrap justify-center gap-1" aria-label={t('업무 화면')}>
        {tabs.map(([id, label]) => (
          <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)} className={cx('rounded-lg px-4 py-2 text-sm', tab === id ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200')}>
            {t(label)}
          </button>
        ))}
      </nav>
      {!me.receivingKey && <p className="mb-4 rounded-lg bg-amber-faint p-3 text-sm text-amber">{t('수신 키가 아직 체인에 등록되지 않았습니다. 등록이 끝나야 로트를 받을 수 있습니다.')}</p>}
      {tab === 'lots' && <LotsTab me={me} />}
      {tab === 'issue' && <IssueTab me={me} />}
      {tab === 'periods' && <PeriodsTab />}
      {tab === 'jobs' && <JobsTab />}
    </div>
  );
}
