export type RosterEntry = { id: string; handle: string; display_name: string; slug: string };
export type Recipient = { id: string; handle: string };

// Mentions in fenced code, blockquotes, inline code, and quoted text are prose.
export function mentionedHandles(body: string): string[] {
  const found: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  let quote: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    // A broadcast must occupy its own line; prose references do not address anyone.
    const standaloneEveryone = /^\s*@everyone\s*$/i.test(line);
    const marker = /^\s*(\x60{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { marker: marker[0], length: marker.length };
      else if (marker[0] === fence.marker && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence || /^\s*>/.test(line)) continue;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' && index > 0 && /[0-9]/.test(line[index - 1])) continue;
      if (char === '"' || char === "\x60") { quote = char; continue; }
      if (char === "“") { quote = "”"; continue; }
      if (char === "‘") { quote = "’"; continue; }
      if (char === "'" && !(index > 0 && /[A-Za-z0-9]/.test(line[index - 1]))) {
        quote = "'";
        continue;
      }
      if (char !== "@") continue;
      if (index > 0 && !/[\s([{]/.test(line[index - 1])) continue;
      const match = /^@([A-Za-z0-9][A-Za-z0-9-]{0,39})(?![A-Za-z0-9-])/.exec(line.slice(index));
      if (!match) continue;
      if (match[1].toLowerCase() === "everyone" && !standaloneEveryone) continue;
      found.push(match[1].toLowerCase());
      index += match[0].length - 1;
    }
  }
  return [...new Set(found)];
}

export function resolveRecipients(body: string, roster: RosterEntry[], senderId: string) {
  const handles = mentionedHandles(body);
  const everyone = handles.includes("everyone");
  if (everyone && handles.length > 1) throw new Error("Use @everyone by itself.");
  const byHandle = new Map(roster.map((agent) => [agent.handle.toLowerCase(), agent]));
  const unknown = handles.filter((handle) => handle !== "everyone" && !byHandle.has(handle));
  if (unknown.length) throw new Error("Unknown handle: @" + unknown.join(", @"));
  const selected = everyone
    ? []
    : handles.map((handle) => byHandle.get(handle)!).filter((agent) => agent && agent.id !== senderId);
  return {
    addressing: everyone ? "everyone" : selected.length ? "direct" : "none",
    recipients: selected.map(({ id, handle }) => ({ id, handle })),
  };
}
