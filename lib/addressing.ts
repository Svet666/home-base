export type RosterEntry = { id: string; handle: string; display_name: string; slug: string };
export type Recipient = { id: string; handle: string };

// Mentions in fenced code, blockquotes, inline code and quoted strings are prose.
export function mentionedHandles(body: string): string[] {
  const found: string[] = [];
  let fenced = false;
  let quote: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced || /^\s*>/.test(line)) continue;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (char === "`" || char === '"' || char === "'") {
        if (char === "'" && quote !== "'" && index > 0 && /[A-Za-z]/.test(line[index - 1])) continue;
        if (quote === char) quote = null;
        else if (!quote) quote = char;
        continue;
      }
      if (quote || char !== "@") continue;
      if (index > 0 && /[A-Za-z0-9_]/.test(line[index - 1])) continue;
      const match = /^@([A-Za-z0-9][A-Za-z0-9-]{0,39})(?![A-Za-z0-9-])/.exec(line.slice(index));
      if (!match) continue;
      found.push(match[1].toLowerCase());
      index += match[0].length - 1;
    }
  }
  return [...new Set(found)];
}

export function resolveRecipients(body: string, roster: RosterEntry[], senderId: string, replySenderId?: string) {
  const handles = mentionedHandles(body);
  const everyone = handles.includes("everyone");
  if (everyone && handles.length > 1) throw new Error("Use @everyone by itself.");
  if (everyone && replySenderId) throw new Error("A linked reply must address its original sender directly.");
  const byHandle = new Map(roster.map((agent) => [agent.handle.toLowerCase(), agent]));
  const unknown = handles.filter((handle) => handle !== "everyone" && !byHandle.has(handle));
  if (unknown.length) throw new Error(`Unknown handle: @${unknown.join(", @")}`);
  const selected = everyone
    ? roster.filter((agent) => agent.id !== senderId)
    : handles.map((handle) => byHandle.get(handle)!).filter(Boolean);
  if (replySenderId && replySenderId !== senderId) {
    const parentSender = roster.find((agent) => agent.id === replySenderId);
    if (!parentSender) throw new Error("The reply recipient is no longer active.");
    if (!selected.some((agent) => agent.id === parentSender.id)) selected.push(parentSender);
  }
  return {
    addressing: everyone ? "everyone" : selected.length ? "direct" : "none",
    recipients: selected.map(({ id, handle }) => ({ id, handle })),
  };
}
