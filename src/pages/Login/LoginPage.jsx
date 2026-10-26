import { useState } from "react";
import { supabase } from "../../lib/auth";

export function LoginPage({ notice }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (signInError) setError(signInError.message);
    setBusy(false);
  };

  return (
    <main className="loginShell">
      <form className="panel loginCard" onSubmit={submit}>
        <div className="brand large">
          <span className="brandMark" aria-hidden="true">
            MU
          </span>
          <span>News Card Studio</span>
        </div>
        <p className="muted">Sign in with your Masters' Union admin account.</p>
        {notice && (
          <p className="callout calloutWarning" role="alert">
            {notice}
          </p>
        )}
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <p className="inlineError" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btnPrimary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
