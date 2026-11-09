import ErrorBoundary from './components/ErrorBoundary';
import AdminPage from './pages/AdminPage';
import HomePage from './pages/HomePage';
import PrivacyPage from './pages/PrivacyPage';
import { AuthProvider } from './state/AuthProvider';
import { ConfirmProvider } from './state/ConfirmProvider';
import { RoutesProvider } from './state/RoutesProvider';

const currentPath = () => window.location.pathname.replace(/\/+$/, '') || '/';

const App = () => {
  const path = currentPath();
  let page = (
    <ConfirmProvider>
      <AuthProvider>
        <RoutesProvider>
          <HomePage />
        </RoutesProvider>
      </AuthProvider>
    </ConfirmProvider>
  );
  if (path === '/privacy') page = <PrivacyPage />;
  else if (/^\/admin(?:\/[^/]+)?$/.test(path)) {
    page = (
      <ConfirmProvider>
        <AuthProvider>
          <AdminPage />
        </AuthProvider>
      </ConfirmProvider>
    );
  }

  return <ErrorBoundary>{page}</ErrorBoundary>;
};

export default App;
