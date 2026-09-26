import { t, useI18n } from '@/lib/i18n';
import { useEffect, useState } from 'react';
import { getApi } from '@/api/client';
import { useGraph, useJob } from '@/hooks/queries';
import { bus } from '@/lib/bus';
import { cx, reason } from '@/lib/format';
import { STAGE_WORD, elapsedMs, expectedMs, isActive } from '@/lib/progress';

export function StatusBar({ extra }: { extra?: React.ReactNode }) {
  useI18n();
  const graph = useGraph();
  const active = graph.data?.activeJob;
  const queue = graph.data?.queue ?? [];
  const current = active ?? queue[0];
  const [lastId, setLastId] = useState<string | null>(null);
  useEffect(() => {
    if (current) setLastId(current.id);
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const last = useJob(lastId);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const job = current ?? last.data;
  let text = t("Idle");
  let tone = 'text-ink-300';
  let pct: number | null = null;
  let over = false;
  if (graph.isError) {
    text = t("Agent unreachable");
    tone = 'text-red';
  } else if (job && isActive(job)) {
    const ms = elapsedMs(job, now);
    const exp = expectedMs(getApi().mode);
    text = `${t(STAGE_WORD[job.stage])} · ${bus.label(job)} · ${Math.floor(ms / 1000)} ${t("seconds")}`;
    tone = 'text-amber';
    pct = Math.min(1, ms / exp);
    over = ms > exp;
  } else if (job?.finishedAt && now - Date.parse(job.finishedAt) < (job.stage === 'confirmed' ? 5000 : 8000)) {
    text = job.stage === 'confirmed' ? t("Confirmed · block {height}", { height: job.blockHeight ?? "—" }) : `${t(STAGE_WORD[job.stage])} · ${reason(job.error)}`;
    tone = job.stage === 'confirmed' ? 'text-accent' : 'text-red';
  }
  const queued = active ? queue.length : Math.max(0, queue.length - 1);
  return (
    <footer className="relative flex h-10 shrink-0 items-center border-t border-ink-700 bg-ink-850 px-4 text-[13px]" aria-live="polite">
      {pct != null && (
        <div
          className={cx('absolute left-0 top-0 h-[2px] bg-amber', over && 'animate-blink')}
          style={{ width: `${pct * 100}%`, transition: 'width 1s linear' }}
        />
      )}
      <span className={cx('tabular-nums', tone)}>{text}</span>
      <span className="ml-auto flex items-center">
        {queued > 0 && <span className="text-ink-400">+{queued} {t("Queued")}</span>}
        {extra}
      </span>
    </footer>
  );
}
