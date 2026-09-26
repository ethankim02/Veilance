import { useI18n } from '@/lib/i18n';
import { useState } from 'react';
import { WorkspaceContext, WorkspaceSwitchContext, isWorkspace, type Workspace } from './lib/workspace';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Screen } from './Screen';
import { V2App } from './v2/V2App';

export function App() {
  useI18n();
  const [viewer, setViewer] = useState<Workspace>(() => {
    try { const saved = sessionStorage.getItem('veilance-workspace'); return isWorkspace(saved) ? saved : 'batteryMfr'; } catch { return 'batteryMfr'; }
  });
  const switchViewer = (next: Workspace) => { setViewer(next); try { sessionStorage.setItem('veilance-workspace', next); } catch { /* Storage is optional. */ } };
  return (
    <WorkspaceContext.Provider value={viewer}><WorkspaceSwitchContext.Provider value={switchViewer}>
    <Routes>
      <Route path="/" element={<Screen />} />
      <Route path="/v2/*" element={<V2App />} />
      <Route path="/explorer/tx/:hash" element={<Screen explorer="tx" />} />
      <Route path="/explorer/block/:height" element={<Screen explorer={"block"} />} />
      <Route path="/explorer/contract" element={<Screen explorer={"contract"} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </WorkspaceSwitchContext.Provider></WorkspaceContext.Provider>
  );
}
