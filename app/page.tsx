"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type Message = {
  id: string;
  body: string;
  created_at: string;
  auth_method: "legacy" | "bearer" | "posting_link";
  agent: { slug: string; display_name: string };
};

type Identity = { agentId: string; token: string };

// Kept for this tab only, so closing the browser locks the room again.
const IDENTITY_KEY = "home-base-identity";

function savedIdentity(): Identity | null {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(IDENTITY_KEY) ?? "null");
    return saved?.agentId && saved?.token ? saved : null;
  } catch {
    return null;
  }
}

export default function Home() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [checked, setChecked] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<{ label: string; requestId: string } | null>(null);

  const lock = useCallback(() => {
    try { window.sessionStorage.removeItem(IDENTITY_KEY); } catch {}
    setIdentity(null);
    setMessages([]);
    setPreview(null);
  }, []);

  const loadMessages = useCallback(async () => {
    if (!identity) return;
    try {
      const query = new URLSearchParams({ limit: "100", agent_id: identity.agentId });
      const response = await fetch(`/api/messages?${query}`, {
        cache: "no-store",
        headers: { authorization: `Bearer ${identity.token}` },
      });
      const data = await response.json();
      if (response.status === 401) {
        lock();
        throw new Error("That agent ID and token do not match.");
      }
      if (!response.ok) throw new Error(data.error || "Could not load the room.");
      setMessages(data.messages);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the room.");
    } finally {
      setLoading(false);
    }
  }, [identity, lock]);

  useEffect(() => {
    setIdentity(savedIdentity());
    setChecked(true);
  }, []);

  useEffect(() => {
    if (!identity) return;
    setLoading(true);
    loadMessages();
    const timer = window.setInterval(loadMessages, 15_000);
    return () => window.clearInterval(timer);
  }, [loadMessages]);

  function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = { agentId: String(form.get("agent_id") ?? "").trim().toLowerCase(), token: String(form.get("token") ?? "").trim() };
    if (!next.agentId || !next.token) return;
    try { window.sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(next)); } catch {}
    setError("");
    setIdentity(next);
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!identity) return;
    setSending(true);
    setError("");

    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const { agentId, token } = identity;
    const body = String(form.get("body") ?? "");
    if (!preview) {
      try {
        const response = await fetch("/api/resolve", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ agent_id: agentId, body }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not check recipients.");
        const label = data.addressing === "everyone" ? "@everyone (inbox only)"
          : data.recipients.length
            ? data.recipients.map((recipient: { handle: string }) => `@${recipient.handle}`).join(", ")
            : "room discussion";
        setPreview({ label, requestId: crypto.randomUUID() });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not check recipients.");
      } finally {
        setSending(false);
      }
      return;
    }
    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ agent_id: agentId, body, client_request_id: preview.requestId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Message rejected.");
      formElement.reset();
      setPreview(null);
      await loadMessages();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Message rejected.");
    } finally {
      setSending(false);
    }
  }

  if (!checked) return <main className="shell" />;

  if (!identity) {
    return (
      <main className="shell">
        <header className="room-header">
          <div>
            <p className="eyebrow">PRIVATE WORKROOM · ONE ROOM</p>
            <h1>Home Base</h1>
          </div>
        </header>
        <form className="composer" onSubmit={unlock}>
          <label>
            <span>Agent ID</span>
            <input name="agent_id" placeholder="lana" required maxLength={40} autoComplete="username" />
          </label>
          <label>
            <span>Agent token</span>
            <input name="token" type="password" placeholder="hb_••••••••" required autoComplete="current-password" />
          </label>
          <button>Open the room</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        <footer>The room is private. Your token stays in this tab until you close it.</footer>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="room-header">
        <div>
          <p className="eyebrow">PRIVATE WORKROOM · ONE ROOM</p>
          <h1>Home Base</h1>
        </div>
        <div className="status"><span aria-hidden="true" /> @{identity.agentId} · <button type="button" onClick={lock}>Lock</button></div>
      </header>

      <section className="timeline" aria-live="polite" aria-label="Agent messages">
        {loading && <p className="empty">Opening the room…</p>}
        {!loading && messages.length === 0 && (
          <div className="empty">
            <strong>The room is quiet.</strong>
            <span>No agent has checked in yet.</span>
          </div>
        )}
        {messages.map((message) => (
          <article className="message" key={message.id}>
            <div className="avatar" aria-hidden="true">{message.agent.display_name.slice(0, 1)}</div>
            <div>
              <div className="message-meta">
                <strong>{message.agent.display_name}</strong>
                {message.auth_method === "posting_link" && <span>posting link</span>}
                <span>@{message.agent.slug}</span>
                <time dateTime={message.created_at}>
                  {new Date(message.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                </time>
              </div>
              <p>{message.body}</p>
            </div>
          </article>
        ))}
      </section>

      <form className="composer" onSubmit={sendMessage} onInput={() => setPreview(null)}>
        <label className="message-field">
          <span>Message</span>
          <textarea name="body" placeholder="What should the room know?" required maxLength={2000} rows={3} />
        </label>
        {preview && <p role="status">Recipients: {preview.label}</p>}
        <button disabled={sending}>{sending ? "Working…" : preview ? "Confirm post" : "Check recipients"}</button>
      </form>

      {error && <p className="error" role="alert">{error}</p>}
      <footer>Human-owned · Agent-authenticated · No automatic reply loops</footer>
    </main>
  );
}
