import { useEffect, useState } from 'react';
import { connectUrl, enabledIntegrations, listConnections } from '../services/integrations';
import { useAuth } from '../state/contexts';
import AuthDialog from './AuthDialog';
import './AccountMenu.css';

const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

/** Header area: "Sign in" for guests, a hover menu for signed-in users. */
const AccountMenu = ({ onManageIntegration, connectionVersion = 0 }) => {
  const { user, status, accountsAvailable, logOut } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState([]);

  useEffect(() => {
    if (!accountsAvailable || status !== 'ready' || user.isGuest) return undefined;
    let cancelled = false;
    listConnections()
      .then((ids) => !cancelled && setConnected(ids))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [accountsAvailable, status, user, connectionVersion]);

  if (!accountsAvailable || status !== 'ready') return null;

  if (user.isGuest) {
    return (
      <>
        <button type="button" className="btn btn-primary account-sign-in" onClick={() => setDialogOpen(true)}>
          Sign in
        </button>
        {dialogOpen && <AuthDialog onClose={() => setDialogOpen(false)} />}
      </>
    );
  }

  const offered = enabledIntegrations();
  const connectedApps = offered.filter((app) => connected.includes(app.id));
  const availableApps = offered.filter((app) => !connected.includes(app.id));

  const handleLogOut = async () => {
    setError('');
    try {
      await logOut();
    } catch {
      setError('Could not sign out. Check your connection.');
    }
  };

  return (
    <div className="account-menu">
      <div className="account-user">
        {user.avatarUrl ? (
          <img className="account-avatar" src={user.avatarUrl} alt="" referrerPolicy="no-referrer" width={32} height={32} />
        ) : (
          <span className="account-avatar account-initials" aria-hidden="true">
            {initials(user.name) || '?'}
          </span>
        )}
        <span className="account-name" title={user.email}>
          {user.name}
        </span>
        <div className="account-dropdown">
          <div className="account-dropdown-panel" role="menu">
            <div className="menu-row">
              <button type="button" className="menu-item" role="menuitem" aria-haspopup="true">
                Connected Apps
                <span aria-hidden="true">›</span>
              </button>
              <div className="menu-flyout">
                <div className="account-dropdown-panel" role="menu">
                  {connectedApps.length === 0 && <p className="menu-empty">No apps connected</p>}
                  {connectedApps.map((app) => (
                    <button key={app.id} type="button" className="menu-item" role="menuitem" onClick={() => onManageIntegration(app.id)}>
                      {app.label}
                    </button>
                  ))}
                  <div className="menu-row">
                    <button type="button" className="menu-item" role="menuitem" aria-haspopup="true">
                      Connect a new app
                      <span aria-hidden="true">›</span>
                    </button>
                    <div className="menu-flyout">
                      <div className="account-dropdown-panel" role="menu">
                        {availableApps.length === 0 ? (
                          <p className="menu-empty">Everything available is connected</p>
                        ) : (
                          availableApps.map((app) => (
                            <button
                              key={app.id}
                              type="button"
                              className="menu-item"
                              role="menuitem"
                              onClick={() => {
                                window.location.assign(connectUrl(app.id));
                              }}
                            >
                              {app.label}
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            {user.isAdmin && (
              <a className="menu-item" role="menuitem" href="/admin">
                Admin
              </a>
            )}
            <button type="button" className="menu-item" role="menuitem" onClick={handleLogOut}>
              Log out
            </button>
          </div>
        </div>
      </div>
      {error && (
        <span className="account-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
};

export default AccountMenu;
