import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedTeamDirectory } from './team-directory.ts';

export type GraphNodeType = 'team' | 'person' | 'topic' | 'project' | 'conversation';

export interface GraphNode {
  id: string;
  label: string;
  type: GraphNodeType;
  count?: number;
  root?: boolean;
  conversationId?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  label: string;
  weight: number;
}

export interface Graph {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface GraphNodeDetail extends Graph {
  root: { id: string; label: string; type: GraphNodeType; count: number; description: string };
  items: { id: number; title: string; owner: string; project: string; source: string; updated_at: string | null; topics: string[] }[];
  truncated: boolean;
}

export interface TeamProfile {
  id: number;
  name: string;
  role: string;
  team: string;
  interests: string[];
  source_url: string;
}

interface TopicRow { id: number; org_id: number; name: string; description: string; keywords: string }
interface CountRow { n: number }
interface ConversationWithOwner {
  id: number; owner_id: number; title: string; project: string; source: string;
  updated_at: string | null; message_count: number; owner: string; team: string;
}
interface GraphRoot {
  label: string; count: number; member_count?: number;
  team?: string; role?: string; description?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(process.env.ORG_MEMORY_DB || path.join(here, '../../data/org-memory.sqlite'));
export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), name TEXT NOT NULL,
    email TEXT NOT NULL, password_hash TEXT NOT NULL, team TEXT NOT NULL DEFAULT 'General', role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id, email)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS invitations (
    id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', token_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL, accepted_at TEXT, invited_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS connector_tokens (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT 'My computer', last_used_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS team_profiles (
    id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL, role TEXT NOT NULL, interests TEXT NOT NULL DEFAULT '[]', source_url TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,name)
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), owner_id INTEGER NOT NULL REFERENCES users(id),
    source TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL, project TEXT NOT NULL DEFAULT 'Unknown project',
    source_path TEXT, started_at TEXT, updated_at TEXT, message_count INTEGER DEFAULT 0, imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(org_id, owner_id, source, external_id)
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    org_id INTEGER NOT NULL REFERENCES organizations(id), owner_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL, content TEXT NOT NULL, occurred_at TEXT, ordinal INTEGER NOT NULL,
    embedding TEXT NOT NULL, UNIQUE(conversation_id, ordinal)
  );
  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), name TEXT NOT NULL,
    description TEXT DEFAULT '', keywords TEXT NOT NULL DEFAULT '[]', UNIQUE(org_id, name)
  );
  CREATE TABLE IF NOT EXISTS conversation_topics (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE, score REAL NOT NULL DEFAULT 1,
    PRIMARY KEY(conversation_id, topic_id)
  );
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query TEXT NOT NULL, answer TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'extractive',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS privacy_events (
    id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), user_id INTEGER NOT NULL REFERENCES users(id),
    source TEXT NOT NULL, external_id_hash TEXT NOT NULL, decision TEXT NOT NULL, categories TEXT NOT NULL DEFAULT '[]',
    policy_version TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS chunks_org_idx ON chunks(org_id);
  CREATE INDEX IF NOT EXISTS conversations_org_idx ON conversations(org_id);
  CREATE INDEX IF NOT EXISTS chat_history_user_idx ON chat_history(user_id, created_at DESC);
`);

const chatHistoryColumns = new Set((db.prepare('PRAGMA table_info(chat_history)').all() as { name: string }[]).map((column) => column.name));
if (!chatHistoryColumns.has('thread_id')) db.exec("ALTER TABLE chat_history ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''");
db.exec('CREATE INDEX IF NOT EXISTS chat_history_thread_idx ON chat_history(user_id, thread_id, id)');

export function seedOrg(orgId: number): void {
  const topics: [name: string, description: string, keywords: string[]][] = [
    ['Lead scraping', 'Finding and enriching prospective customer leads', ['scrape', 'scraping', 'crawler', 'leads', 'prospect', 'enrichment']],
    ['Supply operations', 'Work that grows and operates supply', ['supply', 'vendor', 'inventory', 'onboarding', 'operations']],
    ['Product', 'Product discovery and feature delivery', ['feature', 'product', 'roadmap', 'user story', 'feedback']],
    ['Engineering', 'Software architecture, implementation and reliability', ['api', 'database', 'frontend', 'backend', 'bug', 'deploy', 'code']],
    ['Growth', 'Acquisition, experiments and retention', ['growth', 'campaign', 'seo', 'retention', 'conversion']]
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO topics (org_id,name,description,keywords) VALUES (?,?,?,?)');
  for (const topic of topics) insert.run(orgId, topic[0], topic[1], JSON.stringify(topic[2]));
  seedTeamDirectory(db, orgId);
}

for (const org of db.prepare('SELECT id FROM organizations').all() as { id: number }[]) seedTeamDirectory(db, org.id);

export function classifyConversation(orgId: number, conversationId: number, text: string): void {
  const lower = text.toLowerCase();
  const topics = db.prepare('SELECT * FROM topics WHERE org_id = ?').all(orgId) as unknown as TopicRow[];
  const put = db.prepare('INSERT OR REPLACE INTO conversation_topics (conversation_id,topic_id,score) VALUES (?,?,?)');
  for (const topic of topics) {
    const hits = (JSON.parse(topic.keywords) as string[]).reduce((count, keyword) => count + (lower.includes(keyword) ? 1 : 0), 0);
    if (hits) put.run(conversationId, topic.id, hits);
  }
}

export function getStats(orgId: number): Record<'people' | 'conversations' | 'memories' | 'topics', number> {
  const count = (sql: string) => (db.prepare(sql).get(orgId) as unknown as CountRow).n;
  return {
    people: count('SELECT count(*) n FROM users WHERE org_id=?'),
    conversations: count('SELECT count(*) n FROM conversations WHERE org_id=?'),
    memories: count('SELECT count(*) n FROM chunks WHERE org_id=?'),
    topics: count('SELECT count(*) n FROM topics WHERE org_id=?'),
  };
}

export function getTeamContext(orgId: number): TeamProfile[] {
  const rows = db.prepare('SELECT id,name,role,interests,source_url FROM team_profiles WHERE org_id=? ORDER BY name').all(orgId) as unknown as (Omit<TeamProfile, 'team' | 'interests'> & { interests: string })[];
  return rows.map((person) => ({
    ...person,
    team: teamFromRole(person.role),
    interests: JSON.parse(person.interests || '[]'),
  }));
}

export function getGraph(orgId: number, viewerId: number): Graph {
  const topics = db.prepare(`SELECT t.id,t.name,count(DISTINCT ct.conversation_id) work_count FROM topics t JOIN conversation_topics ct ON ct.topic_id=t.id JOIN conversations c ON c.id=ct.conversation_id WHERE t.org_id=? AND c.owner_id=? GROUP BY t.id`).all(orgId, viewerId) as unknown as { id: number; name: string; work_count: number }[];
  const projects = db.prepare(`SELECT project,count(*) work_count FROM conversations WHERE org_id=? AND owner_id=? GROUP BY project ORDER BY work_count DESC LIMIT 18`).all(orgId, viewerId) as unknown as { project: string; work_count: number }[];
  const nodes: GraphNode[] = [
    ...topics.map((t) => ({ id: `topic:${t.id}`, label: t.name, type: 'topic' as const, count: t.work_count })),
    ...projects.map((p) => ({ id: `project:${p.project}`, label: p.project, type: 'project' as const, count: p.work_count })),
  ];
  const projectLinks = db.prepare(`SELECT c.project,ct.topic_id,count(*) weight FROM conversation_topics ct JOIN conversations c ON c.id=ct.conversation_id WHERE c.org_id=? AND c.owner_id=? GROUP BY c.project,ct.topic_id`).all(orgId, viewerId) as unknown as { project: string; topic_id: number; weight: number }[];
  const links = projectLinks.map((x) => ({ source: `topic:${x.topic_id}`, target: `project:${x.project}`, label: 'appears in', weight: x.weight }));
  return { nodes, links };
}

function teamFromRole(role: string): string {
  const value = role.toLowerCase();
  if (value.includes('supply')) return 'Supply';
  if (value.includes('demand')) return 'Demand';
  if (value.includes('product')) return 'Product';
  if (value.includes('designer') || value.includes('visual')) return 'Design';
  if (value.includes('customer experience')) return 'Customer Experience';
  if (value.includes('brand') || value.includes('marketing') || value.includes('comms')) return 'Brand & Marketing';
  if (value.includes('finance')) return 'Finance';
  if (value.includes('people')) return 'People';
  if (value.includes('founder') || value.includes('co-founder')) return 'Leadership';
  if (value.includes('engineer')) return 'Engineering';
  if (value.includes('operation')) return 'Operations';
  return 'General';
}

export function getGraphNode(orgId: number, nodeId: string | null, viewerId: number): GraphNodeDetail | null {
  if (!nodeId) return null;
  const [type = '', rawKey] = nodeId.split(/:(.*)/s);
  const key = rawKey?.trim();
  if (!['team', 'person', 'profile', 'topic', 'project'].includes(type) || !key) return null;

  let root: GraphRoot | undefined;
  let conversations: ConversationWithOwner[];
  let userMembers: { id: number; name: string }[] = [];
  if (type === 'team') {
    root = db.prepare(`SELECT team label,count(DISTINCT u.id) member_count,count(DISTINCT c.id) count FROM users u LEFT JOIN conversations c ON c.owner_id=u.id WHERE u.org_id=? AND u.team=? GROUP BY u.team`).get(orgId, key) as GraphRoot | undefined;
    userMembers = db.prepare(`SELECT id,name FROM users WHERE org_id=? AND team=? ORDER BY name`).all(orgId, key) as unknown as { id: number; name: string }[];
    if (root) root.member_count = userMembers.length;
    conversations = db.prepare(`SELECT c.*,u.name owner,u.team FROM conversations c JOIN users u ON u.id=c.owner_id WHERE c.org_id=? AND c.owner_id=? AND u.team=? ORDER BY coalesce(c.updated_at,c.imported_at) DESC LIMIT 24`).all(orgId, viewerId, key) as unknown as ConversationWithOwner[];
  } else if (type === 'person') {
    root = db.prepare(`SELECT u.name label,u.team,count(DISTINCT c.id) count FROM users u LEFT JOIN conversations c ON c.owner_id=u.id WHERE u.org_id=? AND u.id=? GROUP BY u.id`).get(orgId, Number(key)) as GraphRoot | undefined;
    conversations = Number(key) === Number(viewerId) ? db.prepare(`SELECT c.*,u.name owner,u.team FROM conversations c JOIN users u ON u.id=c.owner_id WHERE c.org_id=? AND u.id=? ORDER BY coalesce(c.updated_at,c.imported_at) DESC LIMIT 24`).all(orgId, Number(key)) as unknown as ConversationWithOwner[] : [];
  } else if (type === 'profile') {
    const profile = db.prepare(`SELECT name label,role,interests FROM team_profiles WHERE org_id=? AND id=?`).get(orgId, Number(key)) as { label: string; role: string } | undefined;
    root = profile ? { ...profile, team: teamFromRole(profile.role), count: 0 } : undefined;
    conversations = [];
  } else if (type === 'topic') {
    root = db.prepare(`SELECT t.name label,t.description,count(DISTINCT ct.conversation_id) count FROM topics t LEFT JOIN conversation_topics ct ON ct.topic_id=t.id WHERE t.org_id=? AND t.id=? GROUP BY t.id`).get(orgId, Number(key)) as GraphRoot | undefined;
    conversations = db.prepare(`SELECT c.*,u.name owner,u.team FROM conversations c JOIN conversation_topics ct ON ct.conversation_id=c.id JOIN users u ON u.id=c.owner_id WHERE c.org_id=? AND c.owner_id=? AND ct.topic_id=? ORDER BY coalesce(c.updated_at,c.imported_at) DESC LIMIT 24`).all(orgId, viewerId, Number(key)) as unknown as ConversationWithOwner[];
  } else {
    root = db.prepare(`SELECT project label,count(*) count FROM conversations WHERE org_id=? AND owner_id=? AND project=? GROUP BY project`).get(orgId, viewerId, key) as GraphRoot | undefined;
    conversations = db.prepare(`SELECT c.*,u.name owner,u.team FROM conversations c JOIN users u ON u.id=c.owner_id WHERE c.org_id=? AND c.owner_id=? AND c.project=? ORDER BY coalesce(c.updated_at,c.imported_at) DESC LIMIT 24`).all(orgId, viewerId, key) as unknown as ConversationWithOwner[];
  }
  if (!root) return null;

  const conversationIds = conversations.map((conversation) => conversation.id);
  const topicRows = conversationIds.length
    ? db.prepare(`SELECT ct.conversation_id,t.id,t.name FROM conversation_topics ct JOIN topics t ON t.id=ct.topic_id WHERE t.org_id=? AND ct.conversation_id IN (${conversationIds.map(() => '?').join(',')})`).all(orgId, ...conversationIds) as unknown as { conversation_id: number; id: number; name: string }[]
    : [];
  const topicsByConversation = new Map<number, typeof topicRows>();
  for (const topic of topicRows) {
    const list = topicsByConversation.get(topic.conversation_id) || [];
    list.push(topic);
    topicsByConversation.set(topic.conversation_id, list);
  }

  const visualType = (type === 'profile' ? 'person' : type) as GraphNodeType;
  const nodes: GraphNode[] = [{ id: nodeId, label: root.label, type: visualType, count: root.count, root: true }];
  const links: GraphLink[] = [];
  const seen = new Set([nodeId]);
  const addNode = (node: GraphNode) => { if (!seen.has(node.id)) { seen.add(node.id); nodes.push(node); } };
  const addLink = (source: string, target: string, label: string) => { if (source !== target) links.push({ source, target, label, weight: label === 'contains' ? 2 : 1 }); };

  if (type === 'team') {
    for (const member of userMembers) { addNode({ id: `person:${member.id}`, label: member.name, type: 'person' }); addLink(nodeId, `person:${member.id}`, 'has member'); }
  } else if (type === 'profile') {
    const teamId = `team:${root.team}`;
    addNode({ id: teamId, label: root.team!, type: 'team' }); addLink(teamId, nodeId, root.role!);
  }

  for (const conversation of conversations) {
    const conversationId = `conversation:${conversation.id}`;
    addNode({ id: conversationId, label: conversation.title, type: 'conversation', count: conversation.message_count, conversationId: conversation.id });
    if (type === 'person') addLink(nodeId, conversationId, 'contains');
    else {
      const personId = `person:${conversation.owner_id}`;
      addNode({ id: personId, label: conversation.owner, type: 'person' });
      if (type === 'team') addLink(nodeId, personId, 'has member');
      addLink(personId, conversationId, 'created');
      if (type === 'project') addLink(nodeId, conversationId, 'contains');
    }
    if (type !== 'project') {
      const projectId = `project:${conversation.project}`;
      addNode({ id: projectId, label: conversation.project, type: 'project' });
      addLink(conversationId, projectId, 'happened in');
    }
    for (const topic of topicsByConversation.get(conversation.id) || []) {
      const topicId = `topic:${topic.id}`;
      if (topicId === nodeId) { addLink(nodeId, conversationId, 'contains'); continue; }
      addNode({ id: topicId, label: topic.name, type: 'topic' });
      addLink(conversationId, topicId, 'covers');
    }
  }

  const descriptions: Record<string, string> = {
    team: `${root.member_count || 0} member${root.member_count === 1 ? '' : 's'} · ${root.count || 0} work session${root.count === 1 ? '' : 's'}`,
    person: `${root.team} · ${root.count || 0} work session${root.count === 1 ? '' : 's'}`,
    profile: `${root.role} · ${root.team}`,
    topic: root.description || `${root.count || 0} related work sessions`,
    project: `${root.count || 0} work session${root.count === 1 ? '' : 's'}`,
  };
  return {
    root: { id: nodeId, label: root.label, type: visualType, count: root.count || 0, description: descriptions[type]! },
    nodes,
    links,
    items: conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      owner: conversation.owner,
      project: conversation.project,
      source: conversation.source,
      updated_at: conversation.updated_at,
      topics: (topicsByConversation.get(conversation.id) || []).map((topic) => topic.name),
    })),
    truncated: conversations.length === 24,
  };
}
