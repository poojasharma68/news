import { useEffect, useState } from "react";
import { ToastProvider } from "./components/Toast";
import { api, configureApiAuth } from "./lib/api";
import { getAccessToken, supabase } from "./lib/auth";
import { ConfigContext } from "./lib/config";
import { useHashRoute } from "./lib/hooks";
import { DashboardPage } from "./pages/Dashboard/DashboardPage";
import { LoginPage } from "./pages/Login/LoginPage";
import { CardDetailsPage } from "./pages/NewsCards/CardDetailsPage";
import { CardEditPage } from "./pages/NewsCards/CardEditPage";
import { NewsCardsPage } from "./pages/NewsCards/NewsCardsPage";

configureApiAuth(getAccessToken, () => {
  void supabase?.auth.signOut();
});

function Shell({ email, onSignOut }) {
  const route = useHashRoute();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.name]);

  return (
    <div className="appShell">
      <a className="skipLink" href="#main">
        Skip to content
      </a>
      <header className="topBar">
        <a className="brand" href="#/">
          <span className="brandMark" aria-hidden="true">
            MU
          </span>
          <span>News Card Studio</span>
        </a>
        <nav className="mainNav" aria-label="Main">
          <a
            href="#/"
            aria-current={route.name === "dashboard" ? "page" : undefined}
          >
            Dashboard
          </a>
          <a
            href="#/library"
            aria-current={route.name !== "dashboard" ? "page" : undefined}
          >
            Manage news
          </a>
        </nav>
        <div className="userBox">
          {email && <span className="muted small truncate">{email}</span>}
          {onSignOut && (
            <button
              type="button"
              className="btn btnSmall btnGhost"
              onClick={onSignOut}
            >
              Sign out
            </button>
          )}
        </div>
      </header>
      <main id="main" className="content">
        {route.name === "dashboard" && <DashboardPage />}
        {route.name === "library" && <NewsCardsPage />}
        {route.name === "card" && <CardEditPage id={route.id} />}
        {route.name === "cardDetails" && <CardDetailsPage id={route.id} />}
      </main>
    </div>
  );
}

export function App() {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(!supabase);

  useEffect(() => {
    api.config().then(setConfig, (err) => setConfigError(err.message));
  }, []);

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) =>
      setSession(next),
    );
    return () => data.subscription.unsubscribe();
  }, []);

  if (configError) {
    return (
      <main className="loginShell">
        <div className="panel loginCard">
          <h1>Cannot reach the API</h1>
          <p className="inlineError">{configError}</p>
          <button
            type="button"
            className="btn"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </div>
      </main>
    );
  }
  if (!config || !authReady)
    return <div className="loadingScreen">Loading…</div>;

  if (config.auth_mode === "supabase") {
    if (!supabase) {
      return (
        <main className="loginShell">
          <div className="panel loginCard">
            <h1>Sign-in is not configured</h1>
            <p>
              Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for the dashboard
              build.
            </p>
          </div>
        </main>
      );
    }
    if (!session) return <LoginPage />;
  }

  return (
    <ConfigContext.Provider value={config}>
      <ToastProvider>
        <Shell
          email={
            session?.user.email ??
            (config.auth_mode === "none" ? "Local development (no auth)" : null)
          }
          onSignOut={
            supabase && session ? () => void supabase.auth.signOut() : null
          }
        />
      </ToastProvider>
    </ConfigContext.Provider>
  );
}
