import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { type FetchLike, progressiveMessages, slackUserEmail, slackUserMap, streamSlackResponse, verifySlackSignature } from '../src/server/slack.ts';

test('Slack signatures are verified and stale requests are rejected', () => {
  const signingSecret = 'test-secret';
  const timestamp = '1770186600';
  const rawBody = 'command=%2Fcontext&text=what+shipped';
  const signature = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const now = Number(timestamp) * 1000;
  assert.equal(verifySlackSignature({ signingSecret, timestamp, signature, rawBody, now }), true);
  assert.equal(verifySlackSignature({ signingSecret, timestamp, signature: `${signature}0`, rawBody, now }), false);
  assert.equal(verifySlackSignature({ signingSecret, timestamp, signature, rawBody, now: now + 301_000 }), false);
});

test('Slack users can resolve through an explicit private mapping', async () => {
  const mapping = slackUserMap('{"U123":"Rohan@Example.com"}');
  assert.equal(await slackUserEmail('U123', { userMap: mapping }), 'rohan@example.com');
  assert.deepEqual(slackUserMap('not-json'), {});
});

test('Slack answers are sent once by default', async () => {
  const requests: { text: string }[] = [];
  const fetchImpl: FetchLike = async (url, options) => {
    requests.push(JSON.parse(String(options.body)));
    return { ok: true, status: 200 };
  };
  await streamSlackResponse('https://hooks.slack.com/commands/T/B/secret', 'q', 'One two three four five six.', { fetchImpl, pause: async () => {} });
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.text, /One two three four five six\./);
});

test('progressive Slack responses replace the private command response', async () => {
  const requests: { url: string; payload: { text: string; replace_original: boolean; response_type: string } }[] = [];
  const fetchImpl: FetchLike = async (url, options) => {
    requests.push({ url: String(url), payload: JSON.parse(String(options.body)) });
    return { ok: true, status: 200 };
  };
  await streamSlackResponse('https://hooks.slack.com/commands/T/B/secret', '<latest work>', 'One two three four five six.', { fetchImpl, pause: async () => {}, steps: 3 });
  assert.equal(requests.length, 3);
  assert.equal(requests[0]!.payload.replace_original, true);
  assert.equal(requests[0]!.payload.response_type, 'ephemeral');
  assert.match(requests[0]!.payload.text, /&lt;latest work&gt;/);
  assert.match(requests.at(-1)!.payload.text, /One two three four five six\./);
  assert.deepEqual(progressiveMessages('one two three', 3), ['one', 'one two', 'one two three']);
});
