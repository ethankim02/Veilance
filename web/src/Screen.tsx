import { t, useI18n } from '@/lib/i18n';
import { useContext, useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { PartyName } from './api/types';
import { ExplorerModal } from './components/ExplorerModal';
import { Map } from './components/Map';
import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import { LotDrawer } from './components/drawers/LotDrawer';
import { OrgDrawer } from './components/drawers/OrgDrawer';
import { PolicyDrawer } from './components/drawers/PolicyDrawer';
import { VerifierDrawer } from './components/drawers/VerifierDrawer';
import { CHAIN, orgName } from './lib/registry';
import { WorkspaceHome } from './components/WorkspaceHome';
import { DirectFlow } from './components/DirectFlow';
import { Select } from './components/ui';
import { useWorkspace, WorkspaceSwitchContext, type Workspace } from './lib/workspace';
import { useGraph, useOpenRequests } from './hooks/queries';

type Badge = { n: number; tone: 'todo' | 'chain' | 'peer'; title: string };
const TONE: Record<Badge['tone'], string> = { todo: 'bg-red text-white', chain: 'bg-amber text-ink-950', peer: 'bg-ink-500 text-ink-100' };
function TabButton({ active, onClick, label, badges }: { active: boolean; onClick: () => void; label: string; badges: Badge[] }) {
  return (
    <button aria-pressed={active} onClick={onClick} className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm ${active ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}>
      {label}
      {badges.filter(b => b.n > 0).map(b => <span key={b.tone} title={b.title} aria-label={`${b.title} ${b.n}`} className={`min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold leading-5 ${TONE[b.tone]}`}>{b.n}</span>)}
    </button>
  );
}

/** The one screen. Drawer state lives in the query string; the explorer modal in the path. */
export function Screen({ explorer }: { explorer?: 'tx' | "block" | "contract" }) {
  useI18n();
  const viewer = useWorkspace();
  const switchViewer = useContext(WorkspaceSwitchContext);
  const [tab, setTab] = useState<'home' | 'flow'>('home');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const loc = useLocation();
  const route = useParams();
  const org = params.get('org');
  const lot = params.get('lot');
  const policy = params.get('policy');
  const req = params.get('req');
  const company = viewer !== 'admin' && viewer !== 'verifier';
  const graph = useGraph();
  const requests = useOpenRequests(company ? (viewer as PartyName) : 'mine');
  const edges = graph.data?.edges ?? [];
  const node = graph.data?.nodes.find(n => n.id === viewer);
  // Things this company must act on: records to pick up, proof requests to answer, receiving not set up.
  const todo = company ? edges.filter(e => e.to === viewer && e.status === 'ISSUED').length + (requests.data?.length ?? 0) + (node && !node.encKeyRegistered ? 1 : 0) : 0;
  // Not ours to act on: a transaction still being proven/confirmed, and lots the counterparty has not picked up yet.
  const jobs = [graph.data?.activeJob, ...(graph.data?.queue ?? [])].filter(j => j && j.party === viewer);
  const onChain = company ? jobs.length : 0;
  const waitingPeer = company ? edges.filter(e => e.from === viewer && e.status === 'ISSUED').length : 0;
  const go = (search: string) => navigate({ pathname: '/', search });
  const close = () => go('');
  const closeExplorer = () => navigate({ pathname: '/', search: loc.search });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (explorer) closeExplorer();
      else if (org || lot || policy) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const drawer = policy && viewer === 'admin' ? (
    <PolicyDrawer onClose={close} />
  ) : lot && viewer !== 'verifier' ? (
    <LotDrawer id={lot} onClose={close} requestCode={req} />
  ) : org === 'verifier' && viewer === 'admin' ? (
    <VerifierDrawer req={req} onClose={close} />
  ) : org && CHAIN.includes(org as PartyName) && (viewer === 'admin' || viewer === org) ? (
    <OrgDrawer id={org as PartyName} onClose={close} />
  ) : null;

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="map-bg relative min-h-0 flex-1 overflow-hidden">
        <div className={`flex h-full min-w-0 flex-col ${drawer ? 'md:mr-[452px]' : ''}`}>
          <div className="relative border-b border-ink-700 px-5 pb-4 pt-6 sm:px-8">
            <label className="absolute right-4 top-3 w-40 sm:right-8"><span className="sr-only">{t("데모 보기 전환")}</span><Select aria-label={t("데모 보기 전환")} value={viewer} onChange={e => { switchViewer(e.target.value as Workspace); setTab('home'); close(); }}>
              {([...CHAIN, 'verifier', 'admin'] as Workspace[]).map(id => <option key={id} value={id}>{id === 'admin' ? t("통합 운영 (데모)") : orgName(id)}</option>)}
            </Select></label>
            <div className="mx-auto max-w-3xl text-center">
              <h1 className="text-3xl font-semibold tracking-tight">{viewer === 'admin' ? t("공급망 운영") : viewer === 'verifier' ? 'OEM' : orgName(viewer)}</h1>
              {company && <div className="mt-4 flex justify-center gap-2" role="group" aria-label={t("업무 화면")}>
                <TabButton active={tab === 'home'} onClick={() => setTab('home')} label={t("내 재고 · 할 일")} badges={[{ n: todo, tone: 'todo', title: t("할 일") }]} />
                <TabButton active={tab === 'flow'} onClick={() => setTab('flow')} label={t("내 거래 흐름")} badges={[{ n: onChain, tone: 'chain', title: t("체인 처리 중") }, { n: waitingPeer, tone: 'peer', title: t("상대 확인 대기") }]} />
                <button onClick={() => go(`?org=${viewer}`)} className="rounded-lg px-3 py-2 text-xs text-ink-400 hover:text-ink-200">{t("회사 설정")}</button>
              </div>}
              <p className="mt-3 text-sm text-ink-300">{viewer === 'verifier' ? t("공급업체의 상세 재료 정보를 받지 않고 구매 기준 충족 여부를 확인하세요.") : viewer === 'admin' ? t("시연용 전체 보기입니다. 여러 회사의 운영 정보를 함께 표시합니다.") : tab === 'flow' ? t("우리 회사가 보내거나 받은 전달 기록입니다.") : t("받은 재료 기록을 등록하고, 구매사의 증명 요청에 응답하세요.")}</p>
            </div>
          </div>
        {viewer === 'admin' ? (
        <Map
          selectedOrg={policy ? null : org}
          selectedLot={lot}
          onOrg={(id) => go(`?org=${id}`)}
          onLot={(id) => go(`?lot=${encodeURIComponent(id)}`)}
          onProof={(challenge) => go(challenge ? `?org=verifier&req=${challenge}` : '?org=verifier')}
        />
        ) : viewer !== 'verifier' && tab === 'flow' ? <DirectFlow /> : <div className="min-h-0 flex-1 overflow-y-auto"><WorkspaceHome key={viewer} req={req} /></div>}
        </div>
        {drawer}
      </div>
      <StatusBar key={viewer} />
      {explorer && viewer === 'admin' && <ExplorerModal kind={explorer} value={route.hash ?? route.height} onClose={closeExplorer} />}
    </div>
  );
}
