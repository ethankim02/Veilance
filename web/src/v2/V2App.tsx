import { t, useI18n } from '@/lib/i18n';
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button, ErrorLine, Field, Input } from '@/components/ui';
import { cx } from '@/lib/format';
import { getKey, setKey, short, V2Error } from './api';
import { useHealth, useMe } from './hooks';
import { CompanyHome } from './Company';
import { AdminHome } from './Admin';
import { VerifyHome } from './Verify';

function SignIn({ onKey, error }: { onKey: (k: string) => void; error?: unknown }) {
  useI18n();
  const [k, setK] = useState('');
  return (
    <form
      className="mx-auto max-w-md space-y-4 rounded-xl border border-ink-600 bg-ink-850 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (k.trim()) onKey(k.trim());
      }}
    >
      <h2 className="text-lg font-semibold">{t('회사 계정으로 들어가기')}</h2>
      <p className="text-xs text-ink-400">{t('관리자에게 받은 API 키를 입력하세요. 키는 이 탭에만 보관되고, 탭을 닫으면 지워집니다.')}</p>
      <Field label={t('API 키')}>
        <Input mono type="password" autoComplete="off" value={k} onChange={(e) => setK(e.target.value)} placeholder="vk_…" />
      </Field>
      <Button type="submit" disabled={!k.trim()}>
        {t('들어가기')}
      </Button>
      <ErrorLine error={error} />
      <p className="border-t border-ink-700 pt-3 text-xs text-ink-400">
        {t('인증기관이나 구매사라면 계정 없이')} <Link className="text-accent underline" to="/v2/verify">{t('검증 화면')}</Link>{t('을 쓰면 됩니다.')}
      </p>
    </form>
  );
}

/** Veilance v2 — the platform layer UI (docs/PLATFORM_LAYER.md). v1 stays at `/`. */
export function V2App() {
  const { locale, setLocale } = useI18n();
  const loc = useLocation();
  const qc = useQueryClient();
  const health = useHealth();
  const [key, setKeyState] = useState<string | null>(getKey());
  const me = useMe(key);
  const verify = loc.pathname.startsWith('/v2/verify');
  const signIn = (k: string | null) => {
    setKey(k);
    setKeyState(k);
    qc.removeQueries({ queryKey: ['v2'] });
  };
  const badKey = me.error instanceof V2Error && me.error.status === 401;
  const ready = health.data?.ready;
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex min-h-12 flex-wrap items-center gap-3 border-b border-ink-700 bg-ink-850 px-4 py-2">
        <Link to="/v2" className="text-2xl font-bold tracking-tight text-ink-100">
          Veilance <span className="align-top text-xs font-medium text-accent">v2</span>
        </Link>
        <span className="flex items-center gap-2 text-xs text-ink-300">
          <span className={cx('inline-block h-2 w-2 rounded-full', health.isError ? 'bg-red' : ready ? 'bg-accent' : 'bg-amber')} />
          {health.isError ? t('노드에 연결할 수 없음') : ready ? t('노드 준비됨') : health.data?.step ?? '…'}
        </span>
        <nav className="ml-auto flex items-center gap-1 text-sm">
          <Link to="/v2" className={cx('rounded-md px-3 py-1.5', !verify ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200')}>
            {t('회사')}
          </Link>
          <Link to="/v2/verify" className={cx('rounded-md px-3 py-1.5', verify ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200')}>
            {t('검증')}
          </Link>
        </nav>
        {me.data && !verify && (
          <span className="flex items-center gap-2 text-xs text-ink-300">
            <span className="font-medium text-ink-100">{me.data.name}</span>
            <span className="font-mono text-ink-400">{short(me.data.partyId)}</span>
            <button className="text-ink-400 hover:text-red" onClick={() => signIn(null)}>
              {t('나가기')}
            </button>
          </span>
        )}
        <div role="group" aria-label="Language / 언어" className="flex shrink-0 rounded-lg border border-ink-600 p-0.5 text-xs">
          <button type="button" aria-pressed={locale === 'ko'} onClick={() => setLocale('ko')} className={`rounded-md px-2 py-1 ${locale === 'ko' ? 'bg-ink-700 text-ink-100' : 'text-ink-400'}`}>한글</button>
          <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')} className={`rounded-md px-2 py-1 ${locale === 'en' ? 'bg-ink-700 text-ink-100' : 'text-ink-400'}`}>EN</button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 p-5 sm:p-8">
        {verify ? (
          <VerifyHome />
        ) : !key || badKey ? (
          <SignIn onKey={signIn} error={badKey ? new Error(t('알 수 없는 API 키입니다.')) : undefined} />
        ) : me.isPending ? (
          <p className="py-10 text-center text-sm text-ink-400">{t('불러오는 중…')}</p>
        ) : me.error ? (
          <ErrorLine error={me.error} />
        ) : me.data?.role === 'admin' ? (
          <AdminHome me={me.data} />
        ) : me.data ? (
          <CompanyHome me={me.data} />
        ) : null}
      </main>
    </div>
  );
}
