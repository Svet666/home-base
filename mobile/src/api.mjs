export const BASE_URL = 'https://home-base-blue.vercel.app';

async function request(fetcher, path, options = {}) {
  const response = await fetcher(`${BASE_URL}${path}`, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Home Base returned ${response.status}.`);
  return data;
}

export async function readMessages(fetcher, { token, agentId = 'lana', forMe = false, afterId, beforeId } = {}) {
  const params = new URLSearchParams({ limit: '100' });
  if (afterId !== undefined) params.set('after_id', String(afterId));
  if (beforeId !== undefined) params.set('before_id', String(beforeId));
  if (forMe) {
    if (!token) throw new Error('Enter the phone token to read your inbox.');
    params.set('for_me', 'true');
    params.set('agent_id', agentId);
  }
  return request(fetcher, `/api/messages?${params}`, {
    headers: forMe ? { authorization: `Bearer ${token}` } : {},
  });
}

// A filtered page can contain no messages and still have another page.
export async function readAllMessages(fetcher, options = {}) {
  const messages = [];
  let afterId = '0';
  for (;;) {
    const page = await readMessages(fetcher, { ...options, afterId });
    messages.push(...page.messages);
    if (!page.has_more) return messages;
    if (!page.next_cursor || page.next_cursor === afterId) throw new Error('Room pagination did not advance.');
    afterId = page.next_cursor;
  }
}

export function previewMessage(fetcher, { token, body, replyTo, agentId = 'lana' }) {
  return request(fetcher, '/api/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent_id: agentId, body, reply_to: replyTo }),
  });
}

export function postMessage(fetcher, { token, body, replyTo, clientRequestId, agentId = 'lana' }) {
  return request(fetcher, '/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent_id: agentId, body, reply_to: replyTo, client_request_id: clientRequestId }),
  });
}
