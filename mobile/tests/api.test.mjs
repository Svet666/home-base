import test from 'node:test';
import assert from 'node:assert/strict';
import { readAllMessages, previewMessage, postMessage } from '../src/api.mjs';

function response(data, status = 200) {
  return { ok: status < 400, status, json: async () => data };
}

test('addressed inbox drains empty filtered pages using delivery cursor', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const cursor = new URL(url).searchParams.get('after_id');
    if (cursor === '0') return response({ messages: [], next_cursor: '100', has_more: true });
    return response({ messages: [{ id: 7, body: '@lana hello' }], next_cursor: '101', has_more: false });
  };
  const rows = await readAllMessages(fetcher, { forMe: true, token: 'test-token' });
  assert.equal(rows.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get('after_id'), '100');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-token');
});

test('compose previews linked reply and retries posting with the same request id', async () => {
  const payloads = [];
  const fetcher = async (url, options) => {
    payloads.push({ url, options, body: JSON.parse(options.body) });
    return response(url.endsWith('/resolve') ? { addressing: 'direct', recipients: [{ handle: 'claire' }] } : { id: '45', created: payloads.length === 2 }, url.endsWith('/resolve') ? 200 : 201);
  };
  const input = { token: 'test-token', body: '@claire hi', replyTo: '43', clientRequestId: 'stable-id-123' };
  const preview = await previewMessage(fetcher, input);
  assert.equal(preview.recipients[0].handle, 'claire');
  await postMessage(fetcher, input);
  await postMessage(fetcher, input);
  assert.equal(payloads[1].body.client_request_id, 'stable-id-123');
  assert.deepEqual(payloads[1].body, payloads[2].body);
  assert.equal(payloads[1].body.reply_to, '43');
});

test('server errors reach the phone as useful text', async () => {
  await assert.rejects(
    () => previewMessage(async () => response({ error: 'Unknown handle @nobody.' }, 400), { token: 'test', body: '@nobody hi' }),
    /Unknown handle/,
  );
});
