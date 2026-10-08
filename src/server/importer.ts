import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, classifyConversation } from './db.ts';
import { embed } from './embeddings.ts';
import crypto from 'node:crypto';
import { sanitizeConversationForSync } from '../shared/privacy.ts';
import type { ChatMessage } from '../shared/types.ts';

export interface StoreConversationInput {
  orgId: number;
  userId: number;
  source: string;
  externalId: string;
  title: string;
  project: string;
  sourcePath: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  messages: ChatMessage[];
}

export interface ImportResult {
  conversations: number;
  chunks: number;
}

interface ImportOptions {
  orgId: number;
  userId: number;
  root?: string;
}

type MessageContent = string | (string | { type?: string; text?: string })[] | undefined;

const MAX_CHARS = 3000;
const HOME = process.env.HOME || '';

function safePath(candidate: string, allowedRoot: string): string {
  const resolved = path.resolve(candidate);
  const root = path.resolve(allowedRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Source path is outside the allowed root');
  return resolved;
}

function textFromContent(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((item) => typeof item === 'string' || item?.type === 'text').map((item) => typeof item === 'string' ? item : item?.text || '').join('\n');
}

function chunksOf(text: string): string[] {
  const clean = text.replace(/\u0000/g, '').trim();
  if (!clean) return [];
  // Claude transcripts can contain encrypted or encoded attachment payloads.
  // They carry no searchable meaning and should never be embedded or displayed.
  const compact = clean.replace(/\s/g, '');
  if (compact.length > 500 && /^[A-Za-z0-9+/=_-]+$/.test(compact) && compact.length / clean.length > 0.96) return [];
  const parts = [];
  for (let start = 0; start < clean.length; start += MAX_CHARS) parts.push(clean.slice(start, start + MAX_CHARS));
  return parts;
}

export async function storeConversation({ orgId, userId, source, externalId, title, project, sourcePath, startedAt, updatedAt, messages }: StoreConversationInput): Promise<{ conversationId: number; chunks: number; redacted: boolean }> {
  const prepared = sanitizeConversationForSync({ source, externalId, title, project, sourcePath, startedAt, updatedAt, messages });
  if (prepared.redacted) {
    db.prepare(`INSERT INTO privacy_events (org_id,user_id,source,external_id_hash,decision,categories,policy_version) VALUES (?,?,?,?,?,?,?)`)
      .run(orgId, userId, source, crypto.createHash('sha256').update(String(externalId)).digest('hex'), 'redacted', JSON.stringify(prepared.assessment.categories), prepared.assessment.policyVersion);
    ({ title, project, messages } = prepared.conversation);
  }
  const result = db.prepare(`INSERT INTO conversations (org_id,owner_id,source,external_id,title,project,source_path,started_at,updated_at,message_count)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,owner_id,source,external_id) DO UPDATE SET title=excluded.title,project=excluded.project,updated_at=excluded.updated_at,message_count=excluded.message_count,imported_at=CURRENT_TIMESTAMP RETURNING id`)
    .get(orgId, userId, source, externalId, title || 'Untitled work', project || 'Unknown project', sourcePath, startedAt || null, updatedAt || null, messages.length) as { id: number };
  const conversationId = result.id;
  db.prepare('DELETE FROM chunks WHERE conversation_id=?').run(conversationId);
  db.prepare('DELETE FROM conversation_topics WHERE conversation_id=?').run(conversationId);
  const insert = db.prepare('INSERT INTO chunks (conversation_id,org_id,owner_id,role,content,occurred_at,ordinal,embedding) VALUES (?,?,?,?,?,?,?,?)');
  let ordinal = 0;
  const allText = [];
  for (const message of messages) {
    for (const content of chunksOf(message.content)) {
      const vector = await embed(content);
      insert.run(conversationId, orgId, userId, message.role, content, message.timestamp || null, ordinal++, JSON.stringify(vector));
      allText.push(content);
    }
  }
  classifyConversation(orgId, conversationId, `${title}\n${project}\n${allText.join('\n')}`);
  return { conversationId, chunks: ordinal, redacted: prepared.redacted };
}

export async function redactStoredSensitiveConversations() {
  const conversations = db.prepare(`SELECT id,org_id,owner_id,source,external_id,title,project,source_path,started_at,updated_at FROM conversations ORDER BY id`).all() as unknown as {
    id: number; org_id: number; owner_id: number; source: string; external_id: string; title: string; project: string;
    source_path: string | null; started_at: string | null; updated_at: string | null;
  }[];
  let redacted = 0;
  for (const conversation of conversations) {
    if (conversation.title === 'Private session — content redacted locally') continue;
    const messages = db.prepare(`SELECT role,content,occurred_at timestamp FROM chunks WHERE conversation_id=? ORDER BY ordinal`).all(conversation.id) as unknown as ChatMessage[];
    if (!messages.length) continue;
    const prepared = sanitizeConversationForSync({ title: conversation.title, project: conversation.project, messages });
    if (!prepared.redacted) continue;
    await storeConversation({
      orgId: conversation.org_id,
      userId: conversation.owner_id,
      source: conversation.source,
      externalId: conversation.external_id,
      title: conversation.title,
      project: conversation.project,
      sourcePath: conversation.source_path,
      startedAt: conversation.started_at,
      updatedAt: conversation.updated_at,
      messages,
    });
    redacted += 1;
  }
  return redacted;
}

export async function importClaude({ orgId, userId, root = path.join(HOME, '.claude') }: ImportOptions): Promise<ImportResult> {
  const claudeRoot = safePath(root, path.join(HOME, '.claude'));
  const projectsRoot = path.join(claudeRoot, 'projects');
  if (!fs.existsSync(projectsRoot)) return { conversations: 0, chunks: 0 };
  const files = fs.readdirSync(projectsRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(entry.parentPath, entry.name));
  let conversations = 0; let chunks = 0;
  for (const file of files) {
    const messages: ChatMessage[] = []; let sessionId: string | undefined; let project: string | undefined; let firstAt: string | undefined; let lastAt: string | undefined;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { type?: string; sessionId?: string; cwd?: string; timestamp?: string; message?: { role?: string; content?: MessageContent } };
        if (!row.type || !['user', 'assistant'].includes(row.type) || !row.message) continue;
        const content = textFromContent(row.message.content);
        if (!content.trim()) continue;
        sessionId ||= row.sessionId;
        project ||= row.cwd ? path.basename(row.cwd) : path.basename(path.dirname(file));
        firstAt ||= row.timestamp; lastAt = row.timestamp || lastAt;
        messages.push({ role: row.message.role || row.type, content, timestamp: row.timestamp });
      } catch { /* ignore partially written JSONL lines */ }
    }
    if (!messages.length) continue;
    const firstUser = messages.find((m) => m.role === 'user')?.content || 'Untitled work';
    const saved = await storeConversation({ orgId, userId, source: 'claude', externalId: sessionId || path.basename(file, '.jsonl'), title: firstUser.slice(0, 120), project: project || 'Unknown project', sourcePath: file, startedAt: firstAt || null, updatedAt: lastAt || null, messages });
    conversations += 1; chunks += saved.chunks;
  }
  return { conversations, chunks };
}

export async function importCodex({ orgId, userId, root = path.join(HOME, '.codex') }: ImportOptions): Promise<ImportResult> {
  const codexRoot = safePath(root, path.join(HOME, '.codex'));
  const statePath = path.join(codexRoot, 'state_5.sqlite');
  const historyPath = path.join(codexRoot, 'thread_history_1.sqlite');
  if (!fs.existsSync(statePath) || !fs.existsSync(historyPath)) return { conversations: 0, chunks: 0 };
  const state = new DatabaseSync(statePath, { readOnly: true });
  const history = new DatabaseSync(historyPath, { readOnly: true });
  // `has_user_event` is not backfilled by every Codex version. The history
  // database itself is the reliable authority; empty threads are skipped below.
  const threads = state.prepare(`SELECT id,title,cwd,created_at_ms,updated_at_ms FROM threads ORDER BY created_at_ms`).all() as unknown as { id: string; title: string; cwd: string | null; created_at_ms: number; updated_at_ms: number }[];
  let conversations = 0; let chunks = 0;
  for (const thread of threads) {
    const rows = history.prepare(`SELECT item_type,item_json,created_at_ms FROM thread_items WHERE thread_id=? AND item_type IN ('userMessage','agentMessage') ORDER BY rollout_ordinal`).all(thread.id) as unknown as { item_type: string; item_json: string; created_at_ms: number }[];
    const messages: ChatMessage[] = [];
    for (const row of rows) {
      try {
        const item = JSON.parse(row.item_json) as { text?: string; content?: MessageContent };
        const content = row.item_type === 'agentMessage' ? item.text : textFromContent(item.content);
        if (content?.trim()) messages.push({ role: row.item_type === 'agentMessage' ? 'assistant' : 'user', content, timestamp: new Date(row.created_at_ms).toISOString() });
      } catch { /* ignore malformed projected items */ }
    }
    if (!messages.length) continue;
    const saved = await storeConversation({ orgId, userId, source: 'codex', externalId: thread.id, title: thread.title, project: path.basename(thread.cwd || '') || 'Unknown project', sourcePath: thread.cwd, startedAt: new Date(thread.created_at_ms).toISOString(), updatedAt: new Date(thread.updated_at_ms).toISOString(), messages });
    conversations += 1; chunks += saved.chunks;
  }
  state.close(); history.close();
  return { conversations, chunks };
}
