import { useEffect, useState } from 'react';
import AuthDialog from '../components/AuthDialog';
import Brand from '../components/Brand';
import RouteMap from '../components/map/RouteMap';
import { getCoveredDistance, getProgress } from '../domain/route';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { formatDateTime, formatDistance, formatPercent } from '../lib/format';
import { getUser, listUsers, revokeSessions, saveRoutes, updateUser } from '../services/admin/adminService';
import { useAuth, useConfirm } from '../state/contexts';
import './AdminPage.css';

const PAGE_SIZE = 50;

const providerLabel = (id) => (id ? id.charAt(0).toUpperCase() + id.slice(1) : id);

const adminLocation = () => {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const match = path.match(/^\/admin(?:\/([^/]+))?$/);
  return match ? { userId: match[1] ? decodeURIComponent(match[1]) : null } : null;
};

const errorMessage = (error, fallback) => error?.message || fallback;

const Shell = ({ children }) => (
  <main className="admin-page">
    <header className="admin-header">
      <a className="admin-home" href="/" aria-label="Treklin">
        <Brand />
      </a>
      <h1>Admin</h1>
    </header>
    {children}
  </main>
);

const GuestSignIn = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p>Sign in with an admin account to browse and edit accounts.</p>
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        Sign in
      </button>
      {open && <AuthDialog onClose={() => setOpen(false)} />}
    </>
  );
};

const AdminList = () => {
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const debounced = useDebouncedValue(query, 300);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    listUsers({ q: debounced.trim(), offset, limit: PAGE_SIZE, signal: controller.signal })
      .then((body) => {
        setUsers(body.users);
        setTotal(body.total);
        setError('');
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(error, 'Could not load accounts.'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [debounced, offset]);

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + users.length, total);

  return (
    <>
      <p className="admin-note">Password hashes and connected-app tokens stay on the server and are not shown here.</p>
      <div className="form-group admin-search">
        <label htmlFor="admin-search">Search by name or email</label>
        <input
          id="admin-search"
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOffset(0);
          }}
          autoComplete="off"
        />
      </div>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Created</th>
              <th>Account</th>
            </tr>
          </thead>
          <tbody>
            {users.map((account) => (
              <tr key={account.id}>
                <td>
                  <a href={`/admin/${account.id}`}>{account.name}</a>
                </td>
                <td>{account.email}</td>
                <td>{formatDateTime(account.createdAt)}</td>
                <td className="admin-flags">
                  {account.emailVerified && <span>Verified</span>}
                  {account.hasPassword && <span>Password</span>}
                  {account.googleLinked && <span>Google</span>}
                  {account.isAdmin && <span>Admin</span>}
                </td>
              </tr>
            ))}
            {!loading && users.length === 0 && (
              <tr>
                <td colSpan={4} className="admin-empty">
                  No accounts match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="admin-pager">
        <span>{loading ? 'Loading…' : `${from}–${to} of ${total}`}</span>
        <button type="button" className="btn btn-secondary btn-small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
          Previous
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          Next
        </button>
      </div>
    </>
  );
};

const AdminUser = ({ userId, currentUserId, onLostAccess }) => {
  const confirm = useConfirm();
  const [record, setRecord] = useState(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [emailVerified, setEmailVerified] = useState(false);
  const [routeText, setRouteText] = useState('[]');
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingAccount, setSavingAccount] = useState(false);
  const [savingRoutes, setSavingRoutes] = useState(false);
  const [selectedRouteId, setSelectedRouteId] = useState(null);

  const apply = (body) => {
    setRecord(body);
    setName(body.user.name);
    setEmail(body.user.email);
    setEmailVerified(body.user.emailVerified);
    setRouteText(JSON.stringify(body.routes.routes, null, 2));
    setVersion(body.routes.version);
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    getUser(userId, { signal: controller.signal })
      .then((body) => {
        setRecord(body);
        setName(body.user.name);
        setEmail(body.user.email);
        setEmailVerified(body.user.emailVerified);
        setRouteText(JSON.stringify(body.routes.routes, null, 2));
        setVersion(body.routes.version);
        setError('');
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setRecord(null);
        setError(errorMessage(error, 'Could not load this account.'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [userId]);

  const saveAccount = async (event) => {
    event.preventDefault();
    setSavingAccount(true);
    setError('');
    setNotice('');
    try {
      const { user } = await updateUser(userId, { name, email, emailVerified });
      setRecord((current) => ({ ...current, user }));
      setName(user.name);
      setEmail(user.email);
      setEmailVerified(user.emailVerified);
      if (user.id === currentUserId && !user.isAdmin) {
        onLostAccess();
        return;
      }
      setNotice('Account saved.');
    } catch (error) {
      setError(errorMessage(error, 'Could not save this account.'));
    } finally {
      setSavingAccount(false);
    }
  };

  const saveRouteDocument = async (event) => {
    event.preventDefault();
    setError('');
    setNotice('');
    let routes;
    try {
      routes = JSON.parse(routeText);
    } catch {
      setError('Route document is not valid JSON.');
      return;
    }
    if (!Array.isArray(routes)) {
      setError('Route document must be a JSON array.');
      return;
    }
    setSavingRoutes(true);
    try {
      const saved = await saveRoutes(userId, { version, routes });
      setVersion(saved.version);
      setRouteText(JSON.stringify(saved.routes, null, 2));
      setRecord((current) => ({ ...current, routes: { version: saved.version, routes: saved.routes } }));
      setNotice(saved.dropped > 0 ? `Routes saved. ${saved.dropped} invalid route${saved.dropped === 1 ? '' : 's'} were dropped.` : 'Routes saved.');
    } catch (error) {
      if (error?.status === 409) {
        try {
          apply(await getUser(userId));
          setError('These routes were changed elsewhere. The latest version is shown.');
        } catch (reloadError) {
          setError(errorMessage(reloadError, 'These routes were changed elsewhere.'));
        }
      } else {
        setError(errorMessage(error, 'Could not save routes.'));
      }
    } finally {
      setSavingRoutes(false);
    }
  };

  const signOutEverywhere = async (event) => {
    const confirmed = await confirm({
      anchor: event.currentTarget,
      message: 'Sign this account out on every device?',
      confirmLabel: 'Sign out',
    });
    if (!confirmed) return;
    setError('');
    setNotice('');
    try {
      await revokeSessions(userId);
      setNotice('Signed out on every device.');
    } catch (error) {
      setError(errorMessage(error, 'Could not sign this account out.'));
    }
  };

  if (loading) return <p>Loading…</p>;
  if (!record) {
    return (
      <>
        <p>
          <a href="/admin">All accounts</a>
        </p>
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
      </>
    );
  }

  const { user, connections, routes } = record;
  const selectedRoute = routes.routes.find((item) => item.id === selectedRouteId) ?? routes.routes[0] ?? null;

  return (
    <>
      <p className="admin-back">
        <a href="/admin">All accounts</a>
      </p>
      <h2>{user.name}</h2>
      <p className="admin-meta">
        Created {formatDateTime(user.createdAt)}
        {connections.length > 0 ? ` · Connected: ${connections.map(providerLabel).join(', ')}` : ' · No connected apps'}
        {user.isAdmin ? ' · Admin' : ''}
      </p>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <form className="admin-card" onSubmit={saveAccount} autoComplete="off">
        <h3>Account</h3>
        <div className="form-group">
          <label htmlFor="admin-name">Name</label>
          <input id="admin-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required autoComplete="off" />
        </div>
        <div className="form-group">
          <label htmlFor="admin-email">Email</label>
          <input
            id="admin-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={254}
            required
            autoComplete="off"
          />
        </div>
        <label className="admin-check">
          <input type="checkbox" checked={emailVerified} onChange={(event) => setEmailVerified(event.target.checked)} />
          Email verified
        </label>
        <div className="admin-actions">
          <button type="submit" className="btn btn-primary" disabled={savingAccount}>
            {savingAccount ? 'Saving…' : 'Save account'}
          </button>
          <button type="button" className="btn btn-danger" onClick={signOutEverywhere}>
            Sign out everywhere
          </button>
        </div>
      </form>

      <section className="admin-card">
        <h3>Routes</h3>
        {routes.routes.length === 0 ? (
          <p className="admin-empty">No routes.</p>
        ) : (
          <>
            <div className="form-group admin-route-picker">
              <label htmlFor="admin-route">Route</label>
              <select
                id="admin-route"
                value={selectedRoute.id}
                onChange={(event) => setSelectedRouteId(event.target.value)}
              >
                {routes.routes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="admin-map-frame">
              <RouteMap route={selectedRoute} />
            </div>
            <p className="admin-meta">
              {selectedRoute.from} → {selectedRoute.to} · {formatDistance(getCoveredDistance(selectedRoute))} (
              {formatPercent(getProgress(selectedRoute))})
            </p>
            <ul className="admin-routes">
              {routes.routes.map((item) => (
                <li key={item.id}>
                  <strong>{item.name}</strong>
                  <span>
                    {item.from} → {item.to}
                  </span>
                  <span>{formatDistance(item.distance)}</span>
                  <span>
                    {item.workouts.length} workout{item.workouts.length === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <form onSubmit={saveRouteDocument}>
          <div className="form-group">
            <label htmlFor="admin-routes-json">Route document</label>
            <textarea id="admin-routes-json" className="admin-json" value={routeText} onChange={(event) => setRouteText(event.target.value)} spellCheck={false} />
            <p className="field-hint">Saving replaces this account&apos;s routes. Invalid routes are dropped.</p>
          </div>
          <button type="submit" className="btn btn-primary" disabled={savingRoutes}>
            {savingRoutes ? 'Saving…' : 'Save routes'}
          </button>
        </form>
      </section>
    </>
  );
};

/** Operator view at /admin. The server rejects anyone who is not on ADMIN_EMAILS. */
const AdminPage = () => {
  const { user, status, accountsAvailable } = useAuth();
  const [lostAccess, setLostAccess] = useState(false);
  const location = adminLocation();

  useEffect(() => {
    document.title = 'Admin — Treklin';
    return () => {
      document.title = 'Treklin';
    };
  }, []);

  let body = <p>This page does not exist.</p>;
  if (!accountsAvailable) body = <p>Accounts are not configured, so the admin panel is unavailable.</p>;
  else if (status !== 'ready') body = <p>Loading…</p>;
  else if (user.isGuest) body = <GuestSignIn />;
  else if (!user.isAdmin || lostAccess) body = <p>This account cannot open the admin panel.</p>;
  else if (location?.userId) body = <AdminUser userId={location.userId} currentUserId={user.id} onLostAccess={() => setLostAccess(true)} />;
  else if (location) body = <AdminList />;

  return <Shell>{body}</Shell>;
};

export default AdminPage;
