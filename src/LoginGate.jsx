import React, { useState, useEffect } from "react";

/* Wraps the app in a password check. The server is the actual
 * gatekeeper — every /api route validates the cookie independently,
 * so this component is only deciding what to render, not whether
 * access is permitted. Bypassing it in devtools gets you a form
 * whose buttons all return 401. */

export default function LoginGate({ children }) {
  const [state, setState] = useState("checking"); // checking | out | in
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/session", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d) => setState(d.authed ? "in" : "out"))
      .catch(() => setState("out"));
  }, []);

  async function submit() {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setPassword("");
        setState("in");
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Sign-in failed.");
      }
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (state === "checking") return null;
  if (state === "in") return children;

  return (
    <div className="graph-paper" style={S.wrap}>
      <div style={S.card}>
        <img src="/logo/mark.png" alt="" style={S.mark} />
        <h1 style={S.title}>gridients</h1>
        <p style={S.sub}>This one's private. Password, please.</p>
        <input
          type="password"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={S.input}
        />
        <button onClick={submit} disabled={busy || !password} style={S.button}>
          {busy ? "Checking…" : "Sign in"}
        </button>
        {error && <p style={S.error}>{error}</p>}
      </div>
    </div>
  );
}

const S = {
  wrap: { minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "var(--font-serif)" },
  card: { width: 320, padding: 28, background: "var(--paper)", border: "var(--border-width) solid var(--rule)", borderRadius: "var(--radius)" },
  mark: { width: 36, height: "auto", marginBottom: 10 },
  title: { margin: "0 0 4px", fontSize: 26, fontWeight: "normal", fontFamily: "var(--font-hand)", color: "var(--ink)" },
  sub: { margin: "0 0 18px", fontSize: 13, color: "var(--ink-dim)" },
  input: { width: "100%", boxSizing: "border-box", padding: "9px 10px", fontSize: 14, fontFamily: "var(--font-mono)", border: "var(--border-width) solid var(--rule)", borderRadius: "var(--radius)", background: "var(--paper)", color: "var(--ink)" },
  button: { width: "100%", marginTop: 10, padding: "9px 10px", fontSize: 11, fontFamily: "var(--font-mono)", letterSpacing: ".1em", textTransform: "uppercase", border: 0, borderRadius: "var(--radius)", background: "var(--ink)", color: "var(--paper)", cursor: "pointer" },
  error: { margin: "12px 0 0", fontSize: 12.5, color: "var(--correction)" },
};
