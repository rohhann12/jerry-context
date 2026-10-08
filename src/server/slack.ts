import crypto from 'node:crypto';

/** The subset of `fetch` the Slack helpers use, so tests can stub it. */
export type FetchLike = (url: string | URL, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status'> & Partial<Pick<Response, 'json'>>>;

export interface SlackSignatureInput {
  signingSecret?: string;
  timestamp?: string | string[];
  signature?: string | string[];
  rawBody?: string;
  now?: number;
}

export function verifySlackSignature({ signingSecret, timestamp, signature, rawBody, now = Date.now() }: SlackSignatureInput): boolean {
  if (!signingSecret || typeof timestamp !== 'string' || typeof signature !== 'string' || !rawBody) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now - seconds * 1000) > 5 * 60 * 1000) return false;
  const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function slackUserMap(value = ''): Record<string, string> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function slackUserEmail(userId: string, { botToken, userMap = {}, fetchImpl = fetch }: { botToken?: string; userMap?: Record<string, string>; fetchImpl?: FetchLike } = {}): Promise<string | null> {
  const mapped = String(userMap[userId] || '').trim().toLowerCase();
  if (mapped) return mapped;
  if (!botToken) return null;
  const response = await fetchImpl(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
    headers: { authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.json) throw new Error('Slack user lookup returned no body');
  const payload = await response.json() as { ok?: boolean; error?: string; user?: { profile?: { email?: string } } };
  if (!response.ok || !payload.ok) throw new Error(`Slack user lookup failed: ${payload.error || response.status}`);
  return payload.user?.profile?.email?.trim().toLowerCase() || null;
}

export function progressiveMessages(answer: string, steps = 3): string[] {
  const words = String(answer || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return ['No answer was generated.'];
  const count = Math.max(1, Math.min(steps, words.length));
  return Array.from({ length: count }, (_, index) => words.slice(0, Math.ceil(words.length * (index + 1) / count)).join(' '));
}

export async function replaceSlackResponse(responseUrl: string, text: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const url = new URL(responseUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'hooks.slack.com') throw new Error('Slack response URL was rejected.');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', replace_original: true, text: String(text).slice(0, 12_000) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Slack response failed with ${response.status}`);
}

// Slack posts each response_url call to an ephemeral slash-command reply as a new message,
// so progressive updates show up as duplicates. Default to a single final message.
export async function streamSlackResponse(responseUrl: string, query: string, answer: string, { fetchImpl = fetch, pause = defaultPause, steps = 1 }: { fetchImpl?: FetchLike; pause?: (milliseconds: number) => Promise<void>; steps?: number } = {}): Promise<void> {
  const safeQuery = String(query).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').slice(0, 500);
  const messages = progressiveMessages(answer, steps);
  for (let index = 0; index < messages.length; index += 1) {
    await replaceSlackResponse(responseUrl, `*Context:* ${safeQuery}\n\n${messages[index]}${index < messages.length - 1 ? ' ▌' : ''}`, fetchImpl);
    if (index < messages.length - 1) await pause(220);
  }
}

function defaultPause(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
