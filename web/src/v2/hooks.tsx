import { t, useI18n } from '@/lib/i18n';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cx } from '@/lib/format';
import { v2, isDone, type AccountView, type DirectoryEntry, type Health, type Job, type LotView, type Profile } from './api';

export const q2 = {
  health: ['v2', 'health'] as const,
  me: ['v2', 'me'] as const,
  lots: ['v2', 'lots'] as const,
  periods: ['v2', 'periods'] as const,
  directory: ['v2', 'directory'] as const,
  jobs: ['v2', 'jobs'] as const,
  tenants: ['v2', 'tenants'] as const,
};

export const useHealth = () => useQuery({ queryKey: q2.health, queryFn: () => v2<Health>('GET', '/v2/health', undefined, null), refetchInterval: 5_000, retry: 0 });
export const useMe = (key: string | null) =>
  useQuery({ queryKey: [...q2.me, key], enabled: !!key, queryFn: () => v2<Profile>('GET', '/v2/me', undefined, key), retry: 0, refetchInterval: 15_000 });
export const useLots = () => useQuery({ queryKey: q2.lots, queryFn: () => v2<LotView[]>('GET', '/v2/lots'), refetchInterval: 8_000 });
export const usePeriods = () => useQuery({ queryKey: q2.periods, queryFn: () => v2<AccountView[]>('GET', '/v2/periods'), refetchInterval: 8_000 });
export const useDirectory = () => useQuery({ queryKey: q2.directory, queryFn: () => v2<DirectoryEntry[]>('GET', '/v2/directory') });
export const useJobs = () => useQuery({ queryKey: q2.jobs, queryFn: () => v2<Job[]>('GET', '/v2/jobs'), refetchInterval: 4_000 });

/** Polls one job every 2 s until it ends; then refreshes everything it may have changed. */
export function useJobPoll(job: Job | null) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['v2', 'job', job?.id],
    enabled: !!job,
    initialData: job ?? undefined,
    queryFn: () => v2<Job>('GET', `/v2/jobs/${job!.id}`),
    refetchInterval: (s) => (isDone(s.state.data) ? false : 2_000),
  });
  const done = isDone(q.data);
  useEffect(() => {
    if (done) for (const k of Object.values(q2)) qc.invalidateQueries({ queryKey: k });
  }, [done, qc]);
  return q.data;
}

/** Starts a job-returning request and tracks the job it returns. */
export function useRun<B>(method: string, path: string | ((b: B) => string)) {
  const [job, setJob] = useState<Job | null>(null);
  const m = useMutation({
    mutationFn: (body: B) => v2<Job>(method, typeof path === 'function' ? path(body) : path, body),
    onSuccess: (j) => setJob(j),
  });
  const live = useJobPoll(job);
  return {
    run: (b: B) => {
      setJob(null);
      m.mutate(b);
    },
    job: live ?? null,
    pending: m.isPending || (!!live && !isDone(live)),
    error: m.error as Error | null,
    reset: () => {
      setJob(null);
      m.reset();
    },
  };
}

const OP_LABEL: Record<string, string> = {
  deploy: '컨트랙트 배포',
  registerEncKey: '수신 키 등록',
  certifyOrigin: '원산지 승인',
  certifySupplier: '공급업체 인증',
  certifyRecycler: '재활용 업체 인증',
  addProcessingRule: '가공 규칙 등록',
  setCarbonThreshold: '탄소 등급 상한',
  issueLot: '로트 발행',
  issueRecycledLot: '재활용 로트 발행',
  transferLot: '전달',
  processLots: '합치기 · 가공',
  attestOrder: '주문 증명',
  openPeriod: '기간 계정 열기',
  consumeIntoPeriod: '기간 투입',
  declareShare: '재활용 비율 신고',
};
export const opLabel = (op: string) => t(OP_LABEL[op] ?? op);

/** One line of job progress: stage + seconds while running, the outcome after. */
export function JobLine({ job, className }: { job: Job | null; className?: string }) {
  useI18n();
  const [now, setNow] = useState(Date.now());
  const running = !!job && !isDone(job);
  useEffect(() => {
    if (!running) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [running]);
  if (!job) return null;
  const secs = Math.max(0, Math.round(((job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.createdAt)) / 1000));
  const tone = job.stage === 'confirmed' ? 'text-accent' : job.stage === 'rejected' || job.stage === 'failed' ? 'text-red' : 'text-amber';
  const word =
    job.stage === 'confirmed'
      ? t('완료 · 블록 {height}', { height: job.blockHeight ?? '—' })
      : job.stage === 'rejected'
        ? t('컨트랙트가 거부함 — {reason}', { reason: (job.error ?? '').replace(/^veilance:\s*/, '') })
        : job.stage === 'failed'
          ? t('실패 — {reason}', { reason: job.error ?? '' })
          : job.stage === 'queued'
            ? t('대기 중')
            : t('증명 생성 · 제출 중');
  return (
    <p role="status" className={cx('text-sm', tone, className)}>
      {word} <span className="tabular-nums text-ink-400">· {t('{n}초', { n: secs })}</span>
    </p>
  );
}
