import { t, useI18n } from '@/lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { useHealth } from '@/hooks/queries';
import { CHAIN, orgName } from '@/lib/registry';
import { connect, disconnect, refreshDiscoveredWallets, useWalletState } from '@/lib/wallet';
import type { PartyName } from '@/api/types';
import { cx, shortHex } from '@/lib/format';
import { Button, Select } from './ui';

/** TopBar's "Connect wallet" control (agent/API.md "Delegated wallet" v1.4 addendum). UX_V3: no prose, short address + network when connected, a disconnect action. */
export function WalletConnect() {
  useI18n();
  const health = useHealth();
  const wallet = useWalletState();
  const [open, setOpen] = useState(false);
  const [party, setParty] = useState<PartyName>('mine');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    refreshDiscoveredWallets();
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [open]);

  const networkId = health.data?.networkId;

  if (wallet.status === 'connected') {
    return (
      <span className="flex items-center gap-2 text-xs text-ink-200">
        <span className="inline-block h-2 w-2 rounded-full bg-accent" aria-hidden />
        <span className="font-mono">{shortHex(wallet.unshieldedAddress ?? undefined, 4, 4)}</span>
        <span className="text-ink-400">{wallet.networkId}</span>
        <span className="text-ink-400">· {orgName(wallet.party ?? undefined)}</span>
        <button type="button" onClick={() => void disconnect()} className="text-ink-300 hover:text-red">
          {t('Disconnect')}
        </button>
      </span>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={!networkId}
      >
        {t('Connect wallet')}
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-64 rounded-lg border border-ink-600 bg-ink-850 p-3 shadow-lg">
          <label className="mb-2 block">
            <span className="mb-1 block text-[11px] text-ink-400">{t('Pay fees for')}</span>
            <Select value={party} onChange={(e) => setParty(e.target.value as PartyName)}>
              {[...CHAIN, 'admin' as const].map((p) => (
                <option key={p} value={p}>
                  {orgName(p)}
                </option>
              ))}
            </Select>
          </label>
          <div className="flex flex-col gap-1">
            {wallet.discovered.length === 0 ? (
              <p className="py-2 text-center text-[12px] text-ink-400">{t('No wallets found')}</p>
            ) : (
              wallet.discovered.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  disabled={wallet.status === 'connecting' || !networkId}
                  onClick={() => networkId && void connect(w.id, party, networkId).then(() => setOpen(false))}
                  className={cx(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink-100 hover:bg-ink-700 disabled:opacity-50',
                  )}
                >
                  <img src={w.icon} alt="" className="h-4 w-4 rounded" />
                  {w.name}
                </button>
              ))
            )}
          </div>
          <button type="button" onClick={refreshDiscoveredWallets} className="mt-2 text-[11px] text-ink-400 hover:text-ink-200">
            {t('Refresh')}
          </button>
          {wallet.error && <p className="mt-2 text-[12px] text-red">{wallet.error}</p>}
        </div>
      )}
    </div>
  );
}
