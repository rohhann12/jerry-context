import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, getGraph, getGraphNode, getStats, getTeamContext, seedOrg } from './db.ts';
import { cosine, embed } from './embeddings.ts';
import { type ImportResult, importClaude, importCodex, redactStoredSensitiveConversations, storeConversation } from './importer.ts';
import { PRIVACY_POLICY_VERSION } from '../shared/privacy.ts';
import { type WorkSession, extractWhoName, findNamedPerson, guardedPersonAnswer, isPersonWorkQuestion, summarizeRecentSelfWork } from './answer-guardrails.ts';
import { slackUserEmail, slackUserMap, streamSlackResponse, verifySlackSignature } from './slack.ts';
import { type ChatTurn, contextualizeQuery, suggestedFollowUps } from './conversation.ts';

interface SessionUser {
  id: number;
  org_id: number;
  name: string;
  email: string;
  team: string;
  role: string;
  org_name: string;
}

interface ChunkRow {
  id: number;
  content: string;
  role: string;
  embedding: string;
  conversation_id: number;
  title: string;
  project: string;
  source: string;
  updated_at: string | null;
  owner: string;
}

type Memory = Omit<ChunkRow, 'embedding'> & { score: number; lexical: number };

interface SourceLink {
  id: number;
  title: string;
  project: string;
  source: string;
  updated_at: string | null;
}

interface AnswerPayload {
  answer: string;
  mode?: string;
  source?: string;
  evidenceCount?: number;
  sources?: SourceLink[] | WorkSession[];
  followUps?: string[];
}

interface StoredTurn extends ChatTurn {
  mode: string;
  created_at: string;
}

/** Request bodies are untrusted JSON, so every field is optional. */
interface RequestBody {
  orgName?: string;
  org?: string;
  name?: string;
  email?: string;
  password?: string;
  team?: string;
  invite?: string;
  role?: string;
  source?: string;
  label?: string;
  externalId?: string | number;
  title?: string;
  project?: string;
  startedAt?: string;
  updatedAt?: string;
  messages?: { role?: string; content?: unknown; timestamp?: string }[];
  query?: string;
  q?: string;
  threadId?: string;
  history?: { query?: unknown; answer?: unknown }[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(here, '../../public');
// Bundled by `npm run build`: the browser app and the standalone laptop connector.
const builtPublicRoot = path.resolve(here, '../../dist/public');
const connectorDownload = path.resolve(here, '../../dist/connector.js');
const port = Number(process.env.PORT || 4310);

function redact(text: string | null | undefined): string {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk|om)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\b(password|pwd)\s+(?:is|was)\s*[-:=]?\s*\S+/gi, '$1 is [REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*["']?)[^\s,"'}]{8,}/gi, '$1[REDACTED]');
}

function looksEncoded(text: string): boolean {
  const value = String(text || '').trim();
  const compact = value.replace(/\s/g, '');
  return compact.length > 500 && /^[A-Za-z0-9+/=_-]+$/.test(compact) && compact.length / value.length > 0.96;
}

async function retrieveMemories(orgId: number, ownerId: number, query: string, limit = 20): Promise<Memory[]> {
  const queryVector = await embed(query);
  const entityQuery = query.trim().match(/^who\s+(?:is|was)\s+([a-z][a-z .'-]{1,60})[? ]*$/i)?.[1]?.trim().toLowerCase();
  const stopwords = new Set(['who', 'what', 'where', 'when', 'why', 'how', 'the', 'and', 'for', 'from', 'with', 'that', 'this', 'are', 'was', 'were', 'is', 'working', 'work']);
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9][a-z0-9_.@-]{1,}/g) || []).filter((term) => !stopwords.has(term)))];
  const rows = db.prepare(`SELECT ch.id,ch.content,ch.role,ch.embedding,c.id conversation_id,c.title,c.project,c.source,c.updated_at,u.name owner FROM chunks ch JOIN conversations c ON c.id=ch.conversation_id JOIN users u ON u.id=ch.owner_id WHERE ch.org_id=? AND ch.owner_id=?`).all(orgId, ownerId) as unknown as ChunkRow[];
  return rows
    .filter((row) => !looksEncoded(row.content))
    .map(({ embedding, ...row }): Memory => {
      // For identity questions, only the transcript itself is evidence. A title
      // containing the name must not make every chunk in that session a match.
      const haystack = entityQuery ? row.content.toLowerCase() : `${row.title} ${row.project} ${row.content}`.toLowerCase();
      const lexical = terms.length ? terms.filter((term) => haystack.includes(term)).length / terms.length : 0;
      const semantic = cosine(queryVector, JSON.parse(embedding));
      return { ...row, content: redact(row.content), title: redact(row.title), score: semantic * 0.35 + lexical * 0.65, lexical };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function extractiveAnswer(query: string, sources: Memory[]): string {
  if (!sources.length) return `I couldn't find evidence in the shared memory for “${query}”.`;
  const entityMatch = query.trim().match(/^who\s+(?:is|was)\s+([a-z][a-z .'-]{1,60})[? ]*$/i);
  if (entityMatch) {
    const entity = entityMatch[1]!.trim();
    const exact = sources.filter((source) => source.content.toLowerCase().includes(entity.toLowerCase()));
    if (!exact.length) return `I couldn't find ${entity} in your imported work history.`;
    const combined = exact.slice(0, 5).map((source) => source.content).join('\n');
    const escapedEntity = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const email = combined.match(new RegExp(`\\b${escapedEntity}[a-z0-9._-]*@[a-z0-9.-]+\\.[a-z]{2,}\\b`, 'i'))?.[0];
    const namedRole = combined.match(new RegExp(`\\b(${escapedEntity}(?:\\s+[A-Z][a-z'-]+){0,2})\\s*\\(([^)]{3,100})\\)`, 'i'));
    const team = combined.match(/(?:access to|member of|part of|works? (?:with|in|on))\s+([^.!?\n]{3,80}?(?:team|department|function))/i)?.[1];
    const service = /figma/i.test(combined) ? 'Figma' : null;
    const projects = [...new Set(exact.map((source) => source.project).filter(Boolean))].slice(0, 3);
    const identity = [namedRole ? `${namedRole[1]} is identified as ${namedRole[2]}` : null, email ? `the account ${email}` : null, team ? `associated with ${team}` : null, service ? `through ${service}` : null].filter(Boolean).join(', ');
    if (namedRole) return `${identity}. The relevant records are in ${projects.join(', ') || 'your imported projects'}.`;
    if (identity) return `${entity.replace(/\b\w/g, (letter) => letter.toUpperCase())} appears in your work history as ${identity}. The relevant records are in ${projects.join(', ') || 'your imported projects'}.`;
    const sentence = combined.split(/(?<=[.!?])\s+|\n+/).find((part) => part.toLowerCase().includes(entity.toLowerCase()))?.trim();
    return `${entity.replace(/\b\w/g, (letter) => letter.toUpperCase())} appears in ${projects.join(', ') || 'your imported projects'}. The clearest matching record says: “${String(sentence || exact[0]!.content).slice(0, 280)}${String(sentence || exact[0]!.content).length > 280 ? '…' : ''}”`;
  }
  if ((sources[0]!.lexical || 0) < 0.5 && sources[0]!.score < 0.55) return `I found no strong evidence for “${query}” in your imported work history.`;
  const grouped = new Map<string, { projects: Set<string>; count: number; best: Memory }>();
  for (const source of sources.slice(0, 8)) {
    const key = source.owner || 'Unknown teammate';
    const entry = grouped.get(key) || { projects: new Set(), count: 0, best: source };
    entry.projects.add(source.project); entry.count += 1;
    if (source.score > entry.best.score) entry.best = source;
    grouped.set(key, entry);
  }
  const people = [...grouped.entries()].sort((a, b) => b[1].count - a[1].count);
  const lead = people[0]!;
  const projectNames = [...lead[1].projects].filter(Boolean).slice(0, 3).join(', ');
  const excerpt = lead[1].best.content.replace(/\s+/g, ' ').slice(0, 240);
  const others = people.slice(1, 3).map(([name]) => name);
  return `${lead[0]} has the strongest matching work history for this question, mainly in ${projectNames || 'their imported projects'}. The closest recorded work says: “${excerpt}${lead[1].best.content.length > 240 ? '…' : ''}”${others.length ? ` Related evidence also appears in work by ${others.join(' and ')}.` : ''}`;
}

async function answerWithLocalModel(query: string, sources: Memory[], history: ChatTurn[] = []): Promise<AnswerPayload> {
  const model = process.env.OLLAMA_GENERATION_MODEL;
  const baseUrl = process.env.OLLAMA_URL;
  if (!model || !baseUrl) return { answer: history.length ? conversationalExtractiveAnswer(query, sources) : extractiveAnswer(query, sources), mode: 'extractive' };
  const context = sources.slice(0, 10).map((source, index) => `[${index + 1}] Owner: ${source.owner}; project: ${source.project}; source: ${source.source}\n${source.content.slice(0, 1200)}`).join('\n\n');
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({ model, stream: false, messages: [
        { role: 'system', content: 'You are a conversational organizational-memory assistant. Answer only from the supplied memory. Follow up naturally on prior turns and go into implementation detail when asked. Name people and projects only when supported. If evidence is weak, say so. Never repeat credentials or secrets. Cite sources as [1], [2].' },
        ...history.slice(-4).flatMap((turn) => [{ role: 'user', content: turn.query }, { role: 'assistant', content: turn.answer }]),
        { role: 'user', content: `Question: ${query}\n\nOrganizational memory:\n${context}` }
      ] })
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const payload = await response.json() as { message?: { content?: string } };
    return { answer: redact(payload.message?.content || extractiveAnswer(query, sources)), mode: 'local-llm' };
  } catch {
    return { answer: history.length ? conversationalExtractiveAnswer(query, sources) : extractiveAnswer(query, sources), mode: 'extractive' };
  }
}

function conversationalExtractiveAnswer(query: string, sources: Memory[]): string {
  const distinct = [...new Map(sources.map((source) => [source.conversation_id, source])).values()].slice(0, 4);
  if (!distinct.length) return `I couldn't find enough underlying chat evidence to go deeper on “${query}”.`;
  const bullets = distinct.map((source, index) => {
    const cleaned = source.content.replace(/\s+/g, ' ').trim();
    const excerpt = cleaned.slice(0, 320);
    return `• ${source.title || source.project}: ${excerpt}${cleaned.length > 320 ? '…' : ''} [${index + 1}]`;
  }).join('\n');
  return `Going deeper, the imported conversations show:\n${bullets}\n\nThese details come from the recorded chats, so you can open the supporting sessions below to inspect the full context.`;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function answerJson(res: ServerResponse, user: SessionUser, query: string, payload: AnswerPayload, threadId = ''): void {
  storeAnswer(user, query, payload, threadId);
  return json(res, 200, { ...payload, threadId });
}

function storeAnswer(user: SessionUser, query: string, payload: AnswerPayload, threadId = ''): void {
  db.prepare('INSERT INTO chat_history (org_id,user_id,query,answer,mode,thread_id) VALUES (?,?,?,?,?,?)').run(user.org_id, user.id, query, payload.answer, payload.mode || 'extractive', threadId);
  db.prepare(`DELETE FROM chat_history WHERE user_id=? AND id NOT IN (SELECT id FROM chat_history WHERE user_id=? ORDER BY id DESC LIMIT 50)`).run(user.id, user.id);
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((pair) => pair.trim().split('=').map(decodeURIComponent)));
}

async function rawBody(req: IncomingMessage, limit = 12_000_000): Promise<string> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error('Request is too large');
  }
  return raw;
}

async function body(req: IncomingMessage): Promise<RequestBody> {
  const raw = await rawBody(req);
  return raw ? JSON.parse(raw) as RequestBody : {};
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt = '', expected = ''] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

function currentUser(req: IncomingMessage): SessionUser | null {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer) {
    const tokenHash = crypto.createHash('sha256').update(bearer).digest('hex');
    const user = db.prepare(`SELECT u.id,u.org_id,u.name,u.email,u.team,u.role,o.name org_name FROM connector_tokens t JOIN users u ON u.id=t.user_id JOIN organizations o ON o.id=u.org_id WHERE t.token_hash=?`).get(tokenHash) as SessionUser | undefined;
    if (user) { db.prepare('UPDATE connector_tokens SET last_used_at=CURRENT_TIMESTAMP WHERE token_hash=?').run(tokenHash); return user; }
  }
  const token = parseCookies(req)['org_memory_session'];
  if (!token) return null;
  return db.prepare(`SELECT u.id,u.org_id,u.name,u.email,u.team,u.role,o.name org_name FROM sessions s JOIN users u ON u.id=s.user_id JOIN organizations o ON o.id=u.org_id WHERE s.token_hash=? AND s.expires_at > CURRENT_TIMESTAMP`).get(crypto.createHash('sha256').update(token).digest('hex')) as SessionUser | undefined ?? null;
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url || '/', `http://${req.headers.host}`);
}

function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 30 * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'), userId, expires);
  return token;
}

function requireSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
}

function cleanThreadId(value: unknown): string {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id) ? id : '';
}

function threadHistory(user: SessionUser, threadId: string): StoredTurn[] {
  if (!threadId) return [];
  return db.prepare('SELECT query,answer,mode,created_at FROM chat_history WHERE org_id=? AND user_id=? AND thread_id=? ORDER BY id ASC LIMIT 20').all(user.org_id, user.id, threadId) as unknown as StoredTurn[];
}

async function generateAnswer(user: SessionUser, query: string, history: ChatTurn[] = []): Promise<AnswerPayload> {
  const profiles = db.prepare(`SELECT name,role,interests,source_url FROM team_profiles WHERE org_id=? ORDER BY name`).all(user.org_id) as unknown as { name: string; role: string; interests: string; source_url: string }[];
  const people = profiles.map((person) => ({ ...person, interests: JSON.parse(person.interests || '[]') }));
  const person = findNamedPerson(query, people);
  if (person) {
    if (!isPersonWorkQuestion(query)) return { answer: guardedPersonAnswer(query, person, []), mode: 'team-directory', source: person.source_url, evidenceCount: 0 };
    const asksAboutSelf = person.name.toLowerCase().split(/\s+/)[0] === user.name.toLowerCase().split(/\s+/)[0];
    if (!asksAboutSelf) return { answer: guardedPersonAnswer(query, person, []), mode: 'guardrail', source: person.source_url, evidenceCount: 0 };
    const sessions = db.prepare(`SELECT id,source,title,project,updated_at,message_count FROM conversations WHERE org_id=? AND owner_id=? AND source IN ('claude','codex') ORDER BY datetime(updated_at) DESC LIMIT 80`).all(user.org_id, user.id) as unknown as WorkSession[];
    const summary = summarizeRecentSelfWork(person.name, sessions);
    const sources: WorkSession[] = summary.sources || sessions.slice(0, 8).map(({ id, source, title, project, updated_at }) => ({ id, source, title, project, updated_at }));
    return { ...summary, mode: summary.evidenceCount ? 'session-summary' : 'guardrail', sources, followUps: suggestedFollowUps(summary.answer, sources) };
  }
  const unresolvedName = extractWhoName(query);
  if (unresolvedName) return { answer: `I couldn't resolve “${unresolvedName}” to a unique person in the team directory, so I won't infer their identity or current work from unrelated semantic matches.`, mode: 'guardrail', evidenceCount: 0 };
  const retrievalQuery = contextualizeQuery(query, history);
  let sources = await retrieveMemories(user.org_id, user.id, retrievalQuery, 18);
  if (/^who\s+(?:is|was)\s+/i.test(query) && sources.some((source) => source.lexical > 0)) sources = sources.filter((source) => source.lexical > 0);
  const generated = await answerWithLocalModel(query, sources, history);
  const sourceLinks = [...new Map(sources.map((source): [number, SourceLink] => [source.conversation_id, {
    id: source.conversation_id, title: source.title, project: source.project, source: source.source, updated_at: source.updated_at,
  }])).values()].slice(0, 6);
  return { ...generated, sources: sourceLinks, followUps: suggestedFollowUps(generated.answer, sourceLinks) };
}

async function resolveSlackUser(slackUserId: string): Promise<SessionUser> {
  const email = await slackUserEmail(slackUserId, {
    botToken: process.env.SLACK_BOT_TOKEN,
    userMap: slackUserMap(process.env.SLACK_USER_MAP),
  });
  if (!email) throw new Error('Your Slack account is not linked to Org Memory.');
  const orgSlug = process.env.SLACK_ORG_SLUG?.trim();
  if (orgSlug) {
    const user = db.prepare(`SELECT u.id,u.org_id,u.name,u.email,u.team,u.role,o.name org_name FROM users u JOIN organizations o ON o.id=u.org_id WHERE lower(u.email)=lower(?) AND o.slug=?`).get(email, orgSlug) as SessionUser | undefined;
    if (!user) throw new Error('No Org Memory account matches your Slack email.');
    return user;
  }
  const matches = db.prepare(`SELECT u.id,u.org_id,u.name,u.email,u.team,u.role,o.name org_name FROM users u JOIN organizations o ON o.id=u.org_id WHERE lower(u.email)=lower(?)`).all(email) as unknown as SessionUser[];
  if (matches.length !== 1) throw new Error('Your Slack email does not map to one unique Org Memory account.');
  return matches[0]!;
}

async function slackContextCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await rawBody(req, 64_000);
  const valid = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    timestamp: req.headers['x-slack-request-timestamp'],
    signature: req.headers['x-slack-signature'],
    rawBody: raw,
  });
  if (!valid) return json(res, 401, { error: 'Invalid Slack signature' });
  const input = Object.fromEntries(new URLSearchParams(raw));
  if (process.env.SLACK_TEAM_ID && input.team_id !== process.env.SLACK_TEAM_ID) return json(res, 403, { error: 'Slack workspace rejected' });
  const query = input.text?.trim().slice(0, 2_000);
  if (!query || query === 'help') {
    return json(res, 200, { response_type: 'ephemeral', text: 'Use `/context <question>`, for example: `/context what did I work on this week?`' });
  }
  if (!input.response_url || !input.user_id) return json(res, 400, { error: 'Incomplete Slack command' });

  json(res, 200, { response_type: 'ephemeral', text: `Searching your private Org Memory for “${query.slice(0, 160)}”…` });
  void (async () => {
    try {
      const user = await resolveSlackUser(input.user_id);
      const threadId = cleanThreadId(`slack_${input.team_id}_${input.channel_id}_${input.user_id}`);
      const result = await generateAnswer(user, query, threadHistory(user, threadId));
      storeAnswer(user, query, result, threadId);
      await streamSlackResponse(input.response_url, query, result.answer);
    } catch (error) {
      console.error('Slack /context failed:', (error as Error).message);
      try { await streamSlackResponse(input.response_url, query, `I couldn't answer that request. ${(error as Error).message}`); }
      catch (responseError) { console.error('Slack response failed:', (responseError as Error).message); }
    }
  })();
}

async function api(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (pathname === '/api/slack/context' && req.method === 'POST') return slackContextCommand(req, res);
  if (req.method !== 'GET' && !requireSameOrigin(req)) return json(res, 403, { error: 'Origin rejected' });
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const input = await body(req);
    if (!input.orgName?.trim() || !input.name?.trim() || !input.email || !/^\S+@\S+\.\S+$/.test(input.email) || !input.password || input.password.length < 8) return json(res, 400, { error: 'Organization, name, valid email, and an 8+ character password are required.' });
    const slug = input.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || crypto.randomUUID();
    try {
      db.exec('BEGIN');
      const org = db.prepare('INSERT INTO organizations (name,slug) VALUES (?,?) RETURNING id').get(input.orgName.trim(), slug) as { id: number };
      const user = db.prepare('INSERT INTO users (org_id,name,email,password_hash,team,role) VALUES (?,?,?,?,?,?) RETURNING id').get(org.id, input.name.trim(), input.email.toLowerCase(), hashPassword(input.password), input.team?.trim() || 'General', 'admin') as { id: number };
      seedOrg(org.id); db.exec('COMMIT');
      const token = createSession(user.id);
      return json(res, 201, { ok: true }, { 'set-cookie': `org_memory_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
    } catch (error) { db.exec('ROLLBACK'); return json(res, 409, { error: 'That organization or account already exists.' }); }
  }
  if (pathname === '/api/auth/join' && req.method === 'POST') {
    const input = await body(req);
    if (!input.name?.trim() || !input.email || !/^\S+@\S+\.\S+$/.test(input.email) || !input.password || input.password.length < 8 || !input.invite) return json(res, 400, { error: 'Name, invited email, invite code, and an 8+ character password are required.' });
    const tokenHash = crypto.createHash('sha256').update(input.invite).digest('hex');
    const invite = db.prepare(`SELECT * FROM invitations WHERE token_hash=? AND lower(email)=lower(?) AND accepted_at IS NULL AND expires_at > CURRENT_TIMESTAMP`).get(tokenHash, input.email) as { id: number; org_id: number; role: string } | undefined;
    if (!invite) return json(res, 400, { error: 'This invite is invalid, expired, or belongs to another email.' });
    try {
      db.exec('BEGIN');
      const joined = db.prepare('INSERT INTO users (org_id,name,email,password_hash,team,role) VALUES (?,?,?,?,?,?) RETURNING id').get(invite.org_id, input.name.trim(), input.email.toLowerCase(), hashPassword(input.password), input.team?.trim() || 'General', invite.role) as { id: number };
      db.prepare('UPDATE invitations SET accepted_at=CURRENT_TIMESTAMP WHERE id=?').run(invite.id);
      db.exec('COMMIT');
      const token = createSession(joined.id);
      return json(res, 201, { ok: true }, { 'set-cookie': `org_memory_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
    } catch { db.exec('ROLLBACK'); return json(res, 409, { error: 'An account with that email already exists in this workspace.' }); }
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const input = await body(req);
    const user = db.prepare(`SELECT u.* FROM users u JOIN organizations o ON o.id=u.org_id WHERE lower(u.email)=lower(?) AND o.slug=?`).get(input.email || '', input.org || '') as { id: number; password_hash: string } | undefined;
    if (!user || !verifyPassword(input.password || '', user.password_hash)) return json(res, 401, { error: 'Invalid organization, email, or password.' });
    const token = createSession(user.id);
    return json(res, 200, { ok: true }, { 'set-cookie': `org_memory_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
  }
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: 'Authentication required' });
  if (pathname === '/api/me') return json(res, 200, user);
  if (pathname === '/api/dashboard') {
    const recent = db.prepare(`SELECT c.id,c.title,c.project,c.source,c.updated_at,u.name owner,group_concat(t.name, ', ') topics FROM conversations c JOIN users u ON u.id=c.owner_id LEFT JOIN conversation_topics ct ON ct.conversation_id=c.id LEFT JOIN topics t ON t.id=ct.topic_id WHERE c.org_id=? AND c.owner_id=? GROUP BY c.id ORDER BY coalesce(c.updated_at,c.imported_at) DESC LIMIT 12`).all(user.org_id, user.id);
    const count = (sql: string, ...params: number[]) => (db.prepare(sql).get(...params) as { n: number }).n;
    const stats = {
      people: count('SELECT count(*) n FROM team_profiles WHERE org_id=?', user.org_id),
      conversations: count('SELECT count(*) n FROM conversations WHERE org_id=? AND owner_id=?', user.org_id, user.id),
      memories: count('SELECT count(*) n FROM chunks WHERE org_id=? AND owner_id=?', user.org_id, user.id),
      topics: count('SELECT count(DISTINCT ct.topic_id) n FROM conversation_topics ct JOIN conversations c ON c.id=ct.conversation_id WHERE c.org_id=? AND c.owner_id=?', user.org_id, user.id),
    };
    return json(res, 200, { stats, recent });
  }
  if (pathname === '/api/team-context') return json(res, 200, getTeamContext(user.org_id));
  if (pathname === '/api/chat-history' && req.method === 'GET') {
    const threadId = cleanThreadId(requestUrl(req).searchParams.get('thread'));
    if (threadId) return json(res, 200, db.prepare('SELECT id,query,answer,mode,created_at,thread_id FROM chat_history WHERE org_id=? AND user_id=? AND thread_id=? ORDER BY id ASC LIMIT 50').all(user.org_id, user.id, threadId));
    return json(res, 200, db.prepare('SELECT id,query,answer,mode,created_at,thread_id FROM chat_history WHERE org_id=? AND user_id=? ORDER BY id DESC LIMIT 50').all(user.org_id, user.id));
  }
  if (pathname === '/api/graph') {
    if (user.role !== 'admin') return json(res, 403, { error: 'The organization graph is restricted to admins.' });
    return json(res, 200, getGraph(user.org_id, user.id));
  }
  if (pathname === '/api/graph/node') {
    if (user.role !== 'admin') return json(res, 403, { error: 'The organization graph is restricted to admins.' });
    const detail = getGraphNode(user.org_id, requestUrl(req).searchParams.get('id'), user.id);
    return detail ? json(res, 200, detail) : json(res, 404, { error: 'That graph node was not found.' });
  }
  if (pathname === '/api/topics' && req.method === 'GET') return json(res, 200, db.prepare('SELECT * FROM topics WHERE org_id=? ORDER BY name').all(user.org_id).map((t) => ({ ...t, keywords: JSON.parse(String(t.keywords)) })));
  if (pathname === '/api/members' && req.method === 'GET') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Admin access required.' });
    return json(res, 200, db.prepare('SELECT id,name,email,team,role,created_at FROM users WHERE org_id=? ORDER BY name').all(user.org_id));
  }
  if (pathname === '/api/invitations' && req.method === 'POST') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Admin access required.' });
    const input = await body(req);
    if (!input.email || !/^\S+@\S+\.\S+$/.test(input.email) || !input.role || !['admin', 'member'].includes(input.role)) return json(res, 400, { error: 'A valid email and role are required.' });
    const token = crypto.randomBytes(18).toString('base64url');
    const expires = new Date(Date.now() + 7 * 864e5).toISOString();
    db.prepare('INSERT INTO invitations (org_id,email,role,token_hash,expires_at,invited_by) VALUES (?,?,?,?,?,?)').run(user.org_id, input.email.toLowerCase(), input.role, crypto.createHash('sha256').update(token).digest('hex'), expires, user.id);
    return json(res, 201, { invite: token, email: input.email.toLowerCase(), role: input.role, expiresAt: expires });
  }
  if (pathname === '/api/import' && req.method === 'POST') {
    const input = await body(req);
    const result: { codex?: ImportResult; claude?: ImportResult } = {};
    if (input.source === 'codex' || input.source === 'both') result.codex = await importCodex({ orgId: user.org_id, userId: user.id });
    if (input.source === 'claude' || input.source === 'both') result.claude = await importClaude({ orgId: user.org_id, userId: user.id });
    return json(res, 200, result);
  }
  if (pathname === '/api/connector-token' && req.method === 'POST') {
    const input = await body(req);
    const token = `om_${crypto.randomBytes(30).toString('base64url')}`;
    db.prepare('INSERT INTO connector_tokens (token_hash,user_id,label) VALUES (?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'), user.id, input.label?.trim() || 'My computer');
    return json(res, 201, { token });
  }
  if (pathname === '/api/connector/conversations' && req.method === 'POST') {
    if (!req.headers.authorization?.startsWith('Bearer ')) return json(res, 401, { error: 'A connector token is required.' });
    if (req.headers['x-org-memory-privacy-policy'] !== PRIVACY_POLICY_VERSION) return json(res, 428, { error: 'Update the local connector before syncing. This server requires local privacy scanning.' });
    const input = await body(req);
    if (!input.source || !['claude', 'codex'].includes(input.source) || !input.externalId || !Array.isArray(input.messages) || input.messages.length > 5000) return json(res, 400, { error: 'Invalid conversation payload.' });
    const normalized = input.messages.map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content || '').slice(0, 200_000), timestamp: message.timestamp || null })).filter((message) => message.content.trim());
    const saved = await storeConversation({ orgId: user.org_id, userId: user.id, source: input.source, externalId: String(input.externalId), title: String(input.title || 'Untitled work').slice(0, 300), project: String(input.project || 'Unknown project').slice(0, 200), sourcePath: null, startedAt: input.startedAt || null, updatedAt: input.updatedAt || null, messages: normalized });
    return json(res, 201, saved);
  }
  if (pathname === '/api/search') {
    const query = requestUrl(req).searchParams.get('q')?.trim();
    if (!query) return json(res, 200, []);
    return json(res, 200, await retrieveMemories(user.org_id, user.id, query, 20));
  }
  if (pathname === '/api/answer' && (req.method === 'GET' || req.method === 'POST')) {
    const input: RequestBody = req.method === 'POST' ? await body(req) : Object.fromEntries(requestUrl(req).searchParams);
    const query = String(input.query || input.q || '').trim().slice(0, 2_000);
    if (!query) return json(res, 400, { error: 'A question is required.' });
    const threadId = cleanThreadId(input.threadId) || crypto.randomUUID();
    const storedHistory = threadHistory(user, threadId);
    const clientHistory = Array.isArray(input.history) ? input.history.slice(-4).map((turn) => ({
      query: String(turn?.query || '').slice(0, 2_000),
      answer: String(turn?.answer || '').slice(0, 4_000),
    })).filter((turn) => turn.query && turn.answer) : [];
    const history: ChatTurn[] = storedHistory.length ? storedHistory : clientHistory;
    return answerJson(res, user, query, await generateAnswer(user, query, history), threadId);
  }
  const conversationMatch = pathname.match(/^\/api\/conversations\/(\d+)$/);
  if (conversationMatch) {
    const conversation = db.prepare(`SELECT c.*,u.name owner FROM conversations c JOIN users u ON u.id=c.owner_id WHERE c.id=? AND c.org_id=? AND c.owner_id=?`).get(Number(conversationMatch[1]), user.org_id, user.id);
    if (!conversation) return json(res, 404, { error: 'Not found' });
    const chunks = db.prepare('SELECT role,content,occurred_at,ordinal FROM chunks WHERE conversation_id=? ORDER BY ordinal').all(conversation['id']!);
    return json(res, 200, { ...conversation, chunks });
  }
  return json(res, 404, { error: 'Not found' });
}

const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.sh': 'text/x-shellscript; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(requestUrl(req).pathname);
    if (pathname.startsWith('/api/')) return await api(req, res, pathname);
    if (pathname === '/downloads/connector.js') {
      if (!fs.existsSync(connectorDownload)) return json(res, 503, { error: 'The connector has not been built. Run npm run build.' });
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-disposition': 'attachment; filename="connector.js"', 'cache-control': 'no-store' });
      return fs.createReadStream(connectorDownload).pipe(res);
    }
    const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = [builtPublicRoot, publicRoot]
      .map((root) => ({ root, file: path.resolve(root, requested) }))
      .find(({ root, file }) => file.startsWith(`${root}${path.sep}`) && fs.existsSync(file) && !fs.statSync(file).isDirectory())?.file;
    if (!file) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: (error as Error).message || 'Internal error' });
  }
});

const retroactivelyRedacted = await redactStoredSensitiveConversations();
if (retroactivelyRedacted) console.log(`Privacy guardrail retroactively redacted ${retroactivelyRedacted} stored sensitive session${retroactivelyRedacted === 1 ? '' : 's'}.`);
server.listen(port, () => console.log(`Org Memory is running at http://localhost:${port}`));
