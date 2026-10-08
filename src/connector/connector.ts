#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PRIVACY_POLICY_VERSION, sanitizeConversationForSync, type PrivacyAssessment } from '../shared/privacy.ts';
import type { ChatMessage, ConversationInput, SyncSource } from '../shared/types.ts';

type MessageContent = string | (string | { type?: string; text?: string })[] | undefined;
type SyncPayload = ConversationInput & { source: SyncSource; externalId: string };
interface SyncStateEntry { updatedAt: string; decision: 'redacted' | 'synced'; policyVersion: string }
interface SyncResult { synced: number; redacted: number }

const server = (process.env.ORG_MEMORY_URL || 'http://localhost:4310').replace(/\/$/, '');
const token = process.env.ORG_MEMORY_TOKEN;
const home = process.env.HOME || '';
const statePath = process.env.ORG_MEMORY_STATE || path.join(home, 'Library', 'Application Support', 'OrgMemory', 'state.json');
const privacyAuditPath = process.env.ORG_MEMORY_PRIVACY_AUDIT || path.join(home, 'Library', 'Application Support', 'OrgMemory', 'privacy-audit.jsonl');
let syncState: Record<string, SyncStateEntry | string> = {};
try { syncState = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first sync */ }
if (!token) {
  console.error('Missing ORG_MEMORY_TOKEN. Generate one in the dashboard import window, then run:\nORG_MEMORY_TOKEN=om_... npm run connector');
  process.exit(1);
}

function contentText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((item) => typeof item === 'string' || item?.type === 'text').map((item) => typeof item === 'string' ? item : item?.text || '').join('\n');
}

async function send(payload: ConversationInput): Promise<void> {
  const response = await fetch(`${server}/api/connector/conversations`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-org-memory-privacy-policy': PRIVACY_POLICY_VERSION }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`${response.status}: ${(await response.json() as { error?: string }).error}`);
}

function alreadyProcessed(key: string, updatedAt: string | undefined): boolean {
  const state = syncState[key];
  if (!updatedAt || !state) return false;
  if (typeof state === 'string') return false;
  return state.updatedAt === updatedAt && state.policyVersion === PRIVACY_POLICY_VERSION;
}
function markProcessed(key: string, updatedAt: string | undefined, decision: SyncStateEntry['decision']): void { if (updatedAt) syncState[key] = { updatedAt, decision, policyVersion: PRIVACY_POLICY_VERSION }; }
function saveState(): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(syncState, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, statePath);
}

function auditPrivacy(source: SyncSource, externalId: string, assessment: PrivacyAssessment): void {
  fs.mkdirSync(path.dirname(privacyAuditPath), { recursive: true, mode: 0o700 });
  const event = {
    at: new Date().toISOString(), source,
    externalIdHash: crypto.createHash('sha256').update(String(externalId)).digest('hex'),
    decision: assessment.decision, categories: assessment.categories,
    policyVersion: assessment.policyVersion,
  };
  fs.appendFileSync(privacyAuditPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function prepareForSync(payload: SyncPayload) {
  const result = sanitizeConversationForSync(payload);
  if (result.redacted) auditPrivacy(payload.source, payload.externalId, result.assessment);
  return result;
}

async function claude(): Promise<SyncResult> {
  const root = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(root)) return { synced: 0, redacted: 0 };
  const files = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith('.jsonl')).map((item) => path.join(item.parentPath, item.name));
  let count = 0; let redacted = 0;
  for (const file of files) {
    const messages: ChatMessage[] = []; let id: string | undefined; let project: string | undefined; let startedAt: string | undefined; let updatedAt: string | undefined;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) try {
      const row = JSON.parse(line) as { type?: string; sessionId?: string; cwd?: string; timestamp?: string; message?: { role?: string; content?: MessageContent } };
      if (!row.type || !['user', 'assistant'].includes(row.type) || !row.message) continue;
      const content = contentText(row.message.content); if (!content.trim()) continue;
      id ||= row.sessionId; project ||= path.basename(row.cwd || path.dirname(file)); startedAt ||= row.timestamp; updatedAt = row.timestamp || updatedAt;
      messages.push({ role: row.message.role || row.type, content, timestamp: row.timestamp });
    } catch { /* tolerate live/truncated records */ }
    if (!messages.length) continue;
    const externalId = id || path.basename(file);
    const stateKey = `claude:${externalId}`;
    if (alreadyProcessed(stateKey, updatedAt)) continue;
    const payload: SyncPayload = { source: 'claude', externalId, title: messages.find((m) => m.role === 'user')?.content.slice(0, 120), project, startedAt, updatedAt, messages };
    const prepared = prepareForSync(payload);
    await send(prepared.conversation);
    markProcessed(stateKey, updatedAt, prepared.redacted ? 'redacted' : 'synced');
    if (prepared.redacted) redacted += 1;
    count += 1; process.stdout.write(`\rClaude: ${count}/${files.length}`);
  }
  process.stdout.write('\n'); return { synced: count, redacted };
}

async function codex(): Promise<SyncResult> {
  const statePath = path.join(home, '.codex', 'state_5.sqlite'); const historyPath = path.join(home, '.codex', 'thread_history_1.sqlite');
  if (!fs.existsSync(statePath) || !fs.existsSync(historyPath)) return { synced: 0, redacted: 0 };
  const state = new DatabaseSync(statePath, { readOnly: true }); const history = new DatabaseSync(historyPath, { readOnly: true });
  const threads = state.prepare('SELECT id,title,cwd,created_at_ms,updated_at_ms FROM threads ORDER BY created_at_ms').all() as unknown as { id: string; title: string; cwd: string | null; created_at_ms: number; updated_at_ms: number }[]; let count = 0; let redacted = 0;
  for (const thread of threads) {
    const updatedAt = new Date(thread.updated_at_ms).toISOString();
    const stateKey = `codex:${thread.id}`;
    if (alreadyProcessed(stateKey, updatedAt)) continue;
    const rows = history.prepare("SELECT item_type,item_json,created_at_ms FROM thread_items WHERE thread_id=? AND item_type IN ('userMessage','agentMessage') ORDER BY rollout_ordinal").all(thread.id) as unknown as { item_type: string; item_json: string; created_at_ms: number }[];
    const messages = rows.flatMap((row): ChatMessage[] => { try { const item = JSON.parse(row.item_json) as { text?: string; content?: MessageContent }; const content = row.item_type === 'agentMessage' ? item.text : contentText(item.content); return content?.trim() ? [{ role: row.item_type === 'agentMessage' ? 'assistant' : 'user', content, timestamp: new Date(row.created_at_ms).toISOString() }] : []; } catch { return []; } });
    if (!messages.length) continue;
    const payload: SyncPayload = { source: 'codex', externalId: thread.id, title: thread.title, project: path.basename(thread.cwd || '') || 'Unknown project', startedAt: new Date(thread.created_at_ms).toISOString(), updatedAt, messages };
    const prepared = prepareForSync(payload);
    await send(prepared.conversation);
    markProcessed(stateKey, updatedAt, prepared.redacted ? 'redacted' : 'synced');
    if (prepared.redacted) redacted += 1;
    count += 1; process.stdout.write(`\rCodex: ${count}/${threads.length}`);
  }
  state.close(); history.close(); process.stdout.write('\n'); return { synced: count, redacted };
}

try {
  console.log(`Syncing allowlisted conversation history to ${server}`);
  const [claudeResult, codexResult] = await Promise.all([claude(), codex()]);
  saveState();
  console.log(`Done. Synced ${claudeResult.synced} Claude and ${codexResult.synced} Codex conversations.`);
  const redacted = claudeResult.redacted + codexResult.redacted;
  if (redacted) console.log(`Privacy guardrail redacted ${redacted} conversation${redacted === 1 ? '' : 's'} locally. Only generic placeholders were sent; no sensitive text, title, project, or category left the machine. Audit: ${privacyAuditPath}`);
} catch (error) { console.error(`Connector failed: ${(error as Error).message}`); process.exit(1); }
