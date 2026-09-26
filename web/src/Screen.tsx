import { t, useI18n } from '@/lib/i18n';
import { useContext, useEffect } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { PartyName } from './api/types';
import { ExplorerModal } from './components/ExplorerModal';
import { Map } from './components/Map';
import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import { LotDrawer } from './components/drawers/LotDrawer';
import { OrgDrawer } from './components/drawers/OrgDrawer';
import { PolicyDrawer } from './components/drawers/PolicyDrawer';
import { VerifierDrawer } from './components/drawers/VerifierDrawer';
import { HolderHome, type HolderTab } from './components/holder/HolderHome';
import { CertificateDrawer } from './components/holder/CertificateDrawer';
import { BuyerHome, type BuyerTab } from './components/buyer/BuyerHome';
import { Select } from './components/ui';
import { CHAIN, PARTIES, orgName } from './lib/registry';
import { useQueryNav } from './lib/nav';
import { useWorkspace, WorkspaceSwitchContext, type Workspace } from './lib/workspace';
import { useGraph, useOpenRequests } from './hooks/queries';

type Tab = { id: string; label: string; badge?: number };

const TABS: Record<'holder' | 'verifier' | 'admin', Tab[]> = {
  holder: [{ id: 'wallet', label: '내 증명서' }, { id: 'requests', label: '증명 요청' }, { id: 'activity', label: '활동 내역' }],
  verifier: [{ id: 'request', label: '검증 요청하기' }, { id: 'results', label: '결과 확인하기' }],
  admin: [{ id: 'admin', label: '정책 · 출처 관리' }, { id: 'map', label: '공급망 지도 (시연)' }],
};

function Tabs({ tabs, active, onPick }: { tabs: Tab[]; active: string; onPick: (id: string) => void }) {
  useI18n();
  return (
    <nav className="mt-5 flex justify-center gap-1" aria-label={t("업무 화면")}>
      {tabs.map((tab) => (
        <button key={tab.id} aria-current={active === tab.id ? 'page' : undefined} onClick={() => onPick(tab.id)}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm ${active === tab.id ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}>
          {t(tab.label)}
          {!!tab.badge && <span className="min-w-5 rounded-full bg-red px-1.5 text-center text-[11px] font-semibold leading-5 text-white">{tab.badge}</span>}
        </button>
      ))}
    </nav>
  );
}

/** Not authentication: the multi-party demo runs every company from one browser, so the viewpoint switch lives in the footer, apart from the product surface. */
function DemoSwitch() {
  useI18n();
  const viewer = useWorkspace();
  const switchViewer = useContext(WorkspaceSwitchContext);
  const navigate = useNavigate();
  return (
    <label className="ml-4 flex items-center gap-2 text-[11px] text-ink-400">
      <span className="whitespace-nowrap rounded border border-dashed border-ink-500 px-1.5 py-0.5 uppercase tracking-wider">{t("시연")}</span>
      <Select aria-label={t("시연용 보기 전환")} className="h-7 w-44 text-xs" value={viewer} onChange={(e) => { switchViewer(e.target.value as Workspace); navigate({ pathname: '/', search: '' }); }}>
        {([...CHAIN, 'verifier', 'admin'] as Workspace[]).map((id) => <option key={id} value={id}>{id === 'admin' ? t("관리자 · 운영") : id === 'verifier' ? t("OEM · 구매사") : orgName(id)}</option>)}
      </Select>
    </label>
  );
}

/** The one screen. Tab and drawer state live in the query string; the explorer modal in the path. */
export function Screen({ explorer }: { explorer?: 'tx' | 'block' | 'contract' }) {
  useI18n();
  const viewer = useWorkspace();
  const nav = useQueryNav();
  const navigate = useNavigate();
  const loc = useLocation();
  const route = useParams();
  const holder = viewer !== 'admin' && viewer !== 'verifier';
  const role = holder ? 'holder' : viewer;
  const graph = useGraph();
  const requests = useOpenRequests(holder ? (viewer as PartyName) : 'mine');
  const tabs = TABS[role].map((tab) =>
    holder && tab.id === 'wallet' ? { ...tab, badge: (graph.data?.edges ?? []).filter((e) => e.to === viewer && e.status === 'ISSUED').length }
      : holder && tab.id === 'requests' ? { ...tab, badge: requests.data?.length ?? 0 }
      : tab,
  );
  const cert = nav.get('cert');
  const org = nav.get('org');
  const lot = nav.get('lot');
  const policy = nav.get('policy');
  const req = nav.get('req');
  const requested = nav.get('tab');
  // Map drawers link to each other with bare `?lot=` / `?org=` queries; those always belong to the map.
  const tab = role === 'admin' && (org || lot || policy) ? 'map' : tabs.some((x) => x.id === requested) ? requested! : tabs[0].id;
  const closeDrawer = () => nav.patch({ cert: null, org: null, lot: null, policy: null, ...(role === 'admin' ? { req: null } : {}) });
  const closeExplorer = () => navigate({ pathname: '/', search: loc.search });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (explorer) closeExplorer();
      else if (cert || org || lot || policy) closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const onMap = role === 'admin' && tab === 'map';
  const drawer = holder && cert ? (
    <CertificateDrawer id={cert} party={viewer as PartyName} onClose={closeDrawer} onProve={(id) => nav.patch({ tab: 'requests', use: id, cert: null, respond: null })} />
  ) : !onMap ? null : policy ? (
    <PolicyDrawer onClose={closeDrawer} />
  ) : lot ? (
    <LotDrawer id={lot} onClose={closeDrawer} requestCode={req} />
  ) : org === 'verifier' ? (
    <VerifierDrawer req={req} onClose={closeDrawer} />
  ) : org && CHAIN.includes(org as PartyName) ? (
    <OrgDrawer id={org as PartyName} onClose={closeDrawer} />
  ) : null;

  const title = viewer === 'admin' ? t("관리자") : viewer === 'verifier' ? 'OEM' : orgName(viewer);
  const subtitle = viewer === 'admin'
    ? t("출처 등록, 공급업체 인증, 검사 기준을 관리합니다. 공급망 지도는 시연용 전체 보기입니다.")
    : viewer === 'verifier'
      ? t("공급업체의 원본 정보를 받지 않고 요구 조건 충족 여부를 검증합니다.")
      : t("{role} · 원자재 출처 증명서를 받아 보관하고, 다음 회사로 전달하거나 구매사 요청에 증명합니다.", { role: t(PARTIES[viewer].role) });

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="map-bg relative min-h-0 flex-1 overflow-hidden">
        <div className={`flex h-full min-w-0 flex-col ${drawer ? 'md:mr-[452px]' : ''}`}>
          <div className="border-b border-ink-700 px-5 pb-4 pt-6 sm:px-8">
            <div className="mx-auto max-w-3xl text-center">
              <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
              <p className="mt-2 text-sm text-ink-300">{subtitle}</p>
              <Tabs tabs={tabs} active={tab} onPick={(id) => nav.patch({ tab: id }, true)} />
            </div>
          </div>
          {onMap ? (
            <Map
              selectedOrg={policy ? null : org}
              selectedLot={lot}
              onOrg={(id) => nav.patch({ tab: 'map', org: id }, true)}
              onLot={(id) => nav.patch({ tab: 'map', lot: id }, true)}
              onProof={(challenge) => nav.patch({ tab: 'map', org: 'verifier', req: challenge ?? null }, true)}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {holder ? <HolderHome key={viewer} party={viewer as PartyName} tab={tab as HolderTab} />
                : viewer === 'verifier' ? <BuyerHome tab={tab as BuyerTab} />
                : <div className="mx-auto w-full max-w-3xl p-5 sm:p-8"><PolicyDrawer inline onClose={() => {}} /></div>}
            </div>
          )}
        </div>
        {drawer}
      </div>
      <StatusBar key={viewer} extra={<DemoSwitch />} />
      {explorer && <ExplorerModal kind={explorer} value={route.hash ?? route.height} onClose={closeExplorer} />}
    </div>
  );
}
