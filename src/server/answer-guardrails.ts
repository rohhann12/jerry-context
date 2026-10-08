export interface DirectoryPerson {
  name: string;
  role: string;
  interests?: string[];
}

export interface EvidenceSource {
  content: string;
  project?: string;
  owner?: string;
  updated_at?: string | null;
  score?: number;
}

export interface WorkSession {
  id?: number;
  source: string;
  title: string;
  project: string;
  updated_at: string | null;
}

interface WorkArea {
  key: string;
  label: string;
  detail: string;
}

interface RankedWorkArea extends WorkArea {
  sessions: number;
  updated_at: string | null;
  sourceTypes: Set<string>;
  evidence: WorkSession[];
}

export interface SelfWorkSummary {
  answer: string;
  evidenceCount: number;
  sources?: WorkSession[];
}

function normalized(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9'-]+/g, ' ').trim();
}

function containsPhrase(text: unknown, phrase: string): boolean {
  return ` ${normalized(text)} `.includes(` ${normalized(phrase)} `);
}

export function extractWhoName(query: string): string | null {
  const rest = String(query || '').match(/\bwho\s+(?:is|was)\s+(.+)$/i)?.[1];
  if (!rest) return null;
  const stop = new Set(['is', 'was', 'are', 'and', 'or', 'what', 'where', 'when', 'why', 'how', 'does', 'do', 'has', 'have', 'working', 'work', 'right', 'currently']);
  const words = normalized(rest).split(' ').filter(Boolean);
  const name: string[] = [];
  for (const word of words) {
    if (name.length && stop.has(word)) break;
    name.push(word);
    if (name.length === 4) break;
  }
  return name.join(' ') || null;
}

export function findNamedPerson<T extends DirectoryPerson>(query: string, people: T[]): T | null {
  const fullMatches = people.filter((person) => containsPhrase(query, person.name));
  if (fullMatches.length) return fullMatches.sort((a, b) => b.name.length - a.name.length)[0]!;
  const requested = extractWhoName(query);
  const queryWords = new Set(normalized(query).split(' ').filter(Boolean));
  const matches = people.filter((person) => {
    const firstName = normalized(person.name).split(' ')[0];
    return requested ? firstName === requested : queryWords.has(firstName);
  });
  return matches.length === 1 ? matches[0]! : null;
}

function usefulSession(session: WorkSession): boolean {
  const title = String(session.title || '').replace(/\s+/g, ' ').trim();
  if (!['claude', 'codex'].includes(String(session.source || '').toLowerCase())) return false;
  if (title.length < 12 || /^(?:hi|hello|continue|fix this|didn'?t u fix this)[.!? ]*$/i.test(title)) return false;
  if (/^<(?:command-message|local-command-caveat|fork-boilerplate|ide_opened_file)/i.test(title)) return false;
  if (/^\[Image(?:\s+#?\d+)?\](?:\s+\[Image(?:\s+#?\d+)?\])*$/i.test(title)) return false;
  if (/^\s*<pasted_content\b/i.test(title)) return false;
  return true;
}

function workArea(session: WorkSession): WorkArea | null {
  const title = String(session.title || '').replace(/\s+/g, ' ').trim();
  const project = String(session.project || '').trim();
  const text = `${project} ${title}`.toLowerCase();
  if (/shared memory|org memory|\.codex.*\.claude|knowledge graph/.test(text)) {
    return { key: 'org-memory', label: 'Org Memory', detail: 'building the shared Claude/Codex memory product, including private semantic search and knowledge graphs' };
  }
  if (/\bstayin(?:_be)?\b/.test(text)) {
    return { key: 'stayin', label: 'Stayin', detail: 'setting up and running the Stayin backend locally' };
  }
  if (/zoho|hawkeye|reconcil/.test(text)) {
    return { key: 'hawkeye', label: 'Hawkeye reconciliation', detail: 'reconciling Zoho documents with the Hawkeye sheet' };
  }
  if (/flent-crm|agreement|contract-doc-automation/.test(text)) {
    return { key: 'flent-crm', label: 'Flent CRM / Agreements', detail: 'testing, fixing, deploying, and reviewing agreement automation work' };
  }
  if (/sibling-prod|sibling-(?:admin|student|backend)|private session note/.test(text)) {
    return { key: 'sibling', label: 'Sibling', detail: 'working on session-note privacy and related product/backend changes' };
  }
  if (/codex chrome|claude chrome/.test(text)) {
    return { key: 'ai-tooling', label: 'AI tooling', detail: 'investigating browser tooling for Codex and Claude' };
  }
  if (/codeforces|competitive programming/.test(text)) {
    return { key: 'codeforces', label: 'Developer tooling', detail: 'setting up a local Codeforces input/output workflow' };
  }
  if (/apply to|how much i have to pay|github account|text .* on slack/.test(text)) return null;
  if (!project || /^(?:rohan|code|src|unknown project)$/i.test(project)) return null;
  const concise = title.replace(/<[^>]+>/g, '').slice(0, 120).replace(/[,:;\s]+$/, '');
  return { key: normalized(project), label: project.replace(/[_-]+/g, ' '), detail: concise.charAt(0).toLowerCase() + concise.slice(1) };
}

export function summarizeRecentSelfWork(personName: string, sessions: WorkSession[]): SelfWorkSummary {
  const usable = sessions.filter(usefulSession).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  if (!usable.length) return { answer: `I couldn't find any meaningful Claude or Codex sessions for ${personName}, so I can't say what they are working on.`, evidenceCount: 0 };

  const newest = Date.parse(usable[0]!.updated_at || '') || Date.now();
  const recent = usable.filter((session) => {
    const at = Date.parse(session.updated_at || '');
    return !Number.isFinite(at) || newest - at <= 7 * 24 * 60 * 60 * 1000;
  });
  const areas = new Map<string, RankedWorkArea>();
  for (const session of recent) {
    const area = workArea(session);
    if (!area) continue;
    const existing = areas.get(area.key);
    if (!existing) areas.set(area.key, { ...area, sessions: 1, updated_at: session.updated_at, sourceTypes: new Set([session.source]), evidence: [session] });
    else { existing.sessions += 1; existing.sourceTypes.add(session.source); existing.evidence.push(session); }
  }
  const ranked = [...areas.values()].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, 5);
  if (!ranked.length) return { answer: `I found Claude/Codex sessions for ${personName}, but none contain enough meaningful project information to say what they are working on.`, evidenceCount: 0 };

  const latestDate = new Date(newest).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const bullets = ranked.map((area) => `• ${area.label}: ${area.detail}.`).join('\n');
  const evidenceCount = ranked.reduce((sum, area) => sum + area.sessions, 0);
  return {
    answer: `Based on ${personName}’s recent Claude and Codex sessions, they are working on:\n${bullets}\n\nLatest relevant session: ${latestDate}. This reflects recorded AI work sessions, not a confirmed task tracker.`,
    evidenceCount,
    sources: ranked.flatMap((area) => area.evidence.slice(0, 2)).map(({ id, source, title, project, updated_at }) => ({ id, source, title, project, updated_at })),
  };
}

export function directPersonMentions<T extends EvidenceSource>(person: DirectoryPerson, sources: T[]): T[] {
  const fullName = normalized(person.name);
  const firstName = fullName.split(' ')[0]!;
  return sources.filter((source) => containsPhrase(source.content, fullName) || containsPhrase(source.content, firstName));
}

const workEvidence = /\b(?:is|was|has been|had been)\s+(?:currently\s+)?(?:working|building|developing|designing|leading|shipping|implementing|launching|running|owning|researching|fixing|testing)\b|\b(?:works?|worked)\s+on\b|\b(?:building|developing|designing|leading|shipping|implementing|launching|running|owning|researching|fixing|testing)\b/i;

export function directPersonWorkMentions<T extends EvidenceSource>(person: DirectoryPerson, sources: T[]): T[] {
  return directPersonMentions(person, sources).filter((source) => {
    const sentence = mentionSentence(person, source.content);
    return sentence && !sentence.trim().endsWith('?') && workEvidence.test(sentence);
  });
}

export function isPersonWorkQuestion(query: string): boolean {
  return /\b(work(?:ing)?|project|building|doing|right now|currently|today|this week)\b/i.test(query);
}

function mentionSentence(person: DirectoryPerson, content: string): string | undefined {
  const firstName = normalized(person.name).split(' ')[0]!;
  return String(content || '').split(/(?<=[.!?])\s+|\n+/).find((sentence) => containsPhrase(sentence, firstName))?.replace(/\s+/g, ' ').trim();
}

export function guardedPersonAnswer(query: string, person: DirectoryPerson, sources: EvidenceSource[]): string {
  const interests = Array.isArray(person.interests) ? person.interests : [];
  const identity = `${person.name} is ${person.role}.`;
  const asksAboutWork = isPersonWorkQuestion(query);
  if (!asksAboutWork) return `${identity}${interests.length ? ` Their directory interests include ${interests.slice(0, 6).join(', ')}.` : ''}`;

  const direct = directPersonWorkMentions(person, sources).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  if (!direct.length) {
    return `${identity} I couldn't find enough evidence in the imported Claude Code sessions to determine what ${person.name} is working on right now.${interests.length ? ` The directory lists interests in ${interests.slice(0, 6).join(', ')}, but those are not evidence of a current assignment.` : ''}`;
  }

  const source = direct.find((item) => mentionSentence(person, item.content)) || direct[0]!;
  const sentence = mentionSentence(person, source.content);
  const date = source.updated_at ? new Date(source.updated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  const excerpt = String(sentence || source.content).slice(0, 260);
  return `${identity} I found ${direct.length} direct mention${direct.length === 1 ? '' : 's'} in the imported work history, but that does not by itself prove a current assignment. The most recent matching record${date ? ` from ${date}` : ''} in ${source.project || 'an imported project'} says: “${excerpt}${String(sentence || source.content).length > 260 ? '…' : ''}”`;
}
