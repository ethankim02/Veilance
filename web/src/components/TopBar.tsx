import { t, useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { Link, useLocation } from 'react-router-dom';
import { useHealth, usePolicy, useTip } from '@/hooks/queries';
import { cx, shortHex } from '@/lib/format';
import { WalletConnect } from './WalletConnect';

export function TopBar() {
  const { locale, setLocale } = useI18n();
  const viewer = useWorkspace();
  const health = useHealth();
  const tip = useTip();
  const policy = usePolicy();
  const loc = useLocation();
  const h = health.data;
  const ok = !!h && h.ok && h.devnet.node && h.devnet.indexer && h.devnet.proofServer.ok && h.ready !== false;
  const dot = health.isError ? 'bg-red' : ok ? 'bg-accent' : 'bg-amber';
  return (
    <header className="flex min-h-12 flex-wrap shrink-0 py-2 items-center gap-3 sm:gap-6 border-b border-ink-700 bg-ink-850 px-4">
      <Link to="/" className="text-2xl font-bold tracking-tight text-ink-100">
        Veilance
      </Link>
      <span className="flex items-center gap-2 text-xs text-ink-300">
        <span className={cx('inline-block h-2 w-2 rounded-full', dot)} />
        {t("Block")}<span className="font-mono text-ink-100">{tip.data ? `#${tip.data.blockHeight}` : '—'}</span>
      </span>
      {viewer === 'admin' && <span className="hidden text-xs text-ink-300 sm:block">
        {t("Contract")}{' '}
        <Link to={{ pathname: '/explorer/contract', search: loc.search }} className="font-mono text-ink-100 hover:text-accent">
          {shortHex(h?.contractAddress)}
        </Link>
      </span>}
      {viewer === 'admin' ? <Link
        to={{ pathname: '/', search: '?policy=1' }}
        className={cx(
          'ml-auto rounded-full border px-3 py-1 text-xs',
          loc.search.includes('policy=1') ? 'border-accent text-accent' : 'border-ink-600 text-ink-200 hover:border-ink-400',
        )}
      >
        {t("Sourcing policy v")}{policy.data?.policyVersion ?? '—'}
      </Link> : <span className="ml-auto text-xs text-ink-300">{t("검사 기준 v")}{policy.data?.policyVersion ?? '—'}</span>}
      <WalletConnect />
      <div role="group" aria-label="Language / 언어" className="flex shrink-0 rounded-lg border border-ink-600 p-0.5 text-xs">
        <button type="button" lang="ko" aria-label="한국어" aria-pressed={locale === 'ko'} onClick={() => setLocale('ko')} className={`rounded-md px-2 py-1 ${locale === 'ko' ? 'bg-ink-700 text-ink-100' : 'text-ink-400'}`}>한글</button>
        <button type="button" lang="en" aria-label="English" aria-pressed={locale === 'en'} onClick={() => setLocale('en')} className={`rounded-md px-2 py-1 ${locale === 'en' ? 'bg-ink-700 text-ink-100' : 'text-ink-400'}`}>EN</button>
      </div>
    </header>
  );
}
