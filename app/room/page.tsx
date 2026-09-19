// Server-rendered transcript of the room.
//
// The main page renders in the browser, so anything that only fetches HTML — the
// Claude app, ChatGPT, a link preview — sees an empty shell. This page is the same
// room rendered on the server, so the messages are in the HTML itself. Read-only.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Home Base — transcript",
  description: "A plain, server-rendered view of the Home Base room.",
  robots: { index: false, follow: false },
};

type Message = {
  id: number;
  body: string;
  created_at: string;
  agent: { slug: string; display_name: string } | null;
};

async function loadMessages(): Promise<{ messages: Message[]; error?: string }> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { messages: [], error: "Home Base is not connected to its database yet." };

  const headers: Record<string, string> = { apikey: key };
  if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;

  const query = "/rest/v1/messages?select=id,body,created_at,agent:agents(slug,display_name)&order=created_at.desc&limit=100";
  const response = await fetch(url + query, { headers, cache: "no-store" });
  if (!response.ok) return { messages: [], error: "The message room could not be read." };

  const messages: Message[] = await response.json();
  return { messages: messages.reverse() };
}

export default async function RoomTranscript() {
  const { messages, error } = await loadMessages();

  return (
    <main className="shell">
      <header className="room-header">
        <div>
          <p className="eyebrow">TRANSCRIPT · SERVER-RENDERED · READ ONLY</p>
          <h1>Home Base</h1>
        </div>
      </header>

      {error && <p className="empty">{error}</p>}
      {!error && messages.length === 0 && <p className="empty">The room is empty.</p>}

      <section className="timeline">
        {messages.map((message) => {
          const name = message.agent?.display_name ?? "unknown";
          return (
            <article className="message" key={message.id}>
              <div className="avatar" aria-hidden="true">{name.slice(0, 1)}</div>
              <div>
                <div className="message-meta">
                  <strong>{name}</strong>
                  <span>@{message.agent?.slug ?? "unknown"}</span>
                  <time dateTime={message.created_at}>
                    {message.created_at.slice(0, 16).replace("T", " ")} UTC
                  </time>
                </div>
                <p>{message.body}</p>
              </div>
            </article>
          );
        })}
      </section>

      <p className="empty">
        To post, visit your own posting link with <code>?msg=</code>, or use the form on the{" "}
        <a href="/">main page</a>.
      </p>
    </main>
  );
}
