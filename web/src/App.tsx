import { useCallback, useEffect, useState } from 'react';
import { api, usePoll } from './api';
import { Approvals } from './pages/Approvals';
import { Dashboard } from './pages/Dashboard';
import { RequestDetailView, Requests } from './pages/Requests';
import { Simulator } from './pages/Simulator';

/** Tiny hash router: "#/requests/abc" -> "/requests/abc". No dependency needed for four pages. */
function useHashRoute(): [string, (path: string) => void] {
  const read = () => window.location.hash.replace(/^#/, '') || '/';
  const [path, setPath] = useState(read);

  useEffect(() => {
    const onChange = () => setPath(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const go = useCallback((next: string) => {
    window.location.hash = next;
    window.scrollTo({ top: 0 });
  }, []);

  return [path, go];
}

const NAV = [
  { path: '/', label: 'Dashboard' },
  { path: '/approvals', label: 'Approvals' },
  { path: '/requests', label: 'Requests' },
  { path: '/simulator', label: 'Simulator' },
] as const;

export function App() {
  const [path, go] = useHashRoute();
  const summary = usePoll(api.summary, 'summary-nav', 8000);
  const pending = summary.data?.totals.pendingApprovals ?? 0;

  const detailId = path.startsWith('/requests/') ? path.slice('/requests/'.length) : null;
  const section = detailId ? '/requests' : path;

  let page;
  if (detailId) page = <RequestDetailView key={detailId} id={detailId} go={go} />;
  else if (path === '/approvals') page = <Approvals go={go} />;
  else if (path === '/requests') page = <Requests go={go} />;
  else if (path === '/simulator') page = <Simulator go={go} />;
  else page = <Dashboard go={go} />;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/" onClick={() => go('/')}>
            <span className="brand-mark" aria-hidden>M</span>
            Mandate
          </a>
          <nav aria-label="Main">
            {NAV.map((n) => (
              <a
                key={n.path}
                href={`#${n.path}`}
                className={`nav-link${section === n.path ? ' active' : ''}`}
                aria-current={section === n.path ? 'page' : undefined}
              >
                {n.label}
                {n.path === '/approvals' && pending > 0 && <span className="count">{pending}</span>}
              </a>
            ))}
          </nav>
          <span className="net-pill" title="Test network: no real money">
            <span className="dot dot-approved" /> Base Sepolia
          </span>
        </div>
      </header>

      <main className="page">{page}</main>

      <footer className="footer">
        Testnet learning project: agent spend approvals with onchain USDC receipts. Not a production system; no real funds.
      </footer>
    </>
  );
}
