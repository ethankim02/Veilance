import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { loadApi } from './api/client';
import { App } from './App';
import { installDevWallet } from './lib/devWallet';
import './index.css';

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 500 } },
});

// Delegated wallet (agent/API.md v1.4 addendum): VITE_DEV_WALLET=1 installs
// a fake window.midnight.veilanceDev before anything looks for wallets, so
// the round trip is testable without a real Lace install — see docs/WALLET.md.
if (import.meta.env.VITE_DEV_WALLET === '1') installDevWallet();

loadApi().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
});
