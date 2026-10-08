import type { Graph, GraphNode, GraphNodeDetail, TeamProfile } from '../server/db.ts';

interface Me { id: number; name: string; team: string; role: string }
interface ChatHistoryRow { id: number; query: string; answer: string; mode: string; created_at: string; thread_id: string }
interface SourceLink { id: number; title?: string; project?: string; source?: string }
interface ThreadMessage {
  role: 'user' | 'assistant';
  text: string;
  mode?: string;
  query?: string;
  loading?: boolean;
  sources?: SourceLink[];
  followUps?: string[];
}
type GraphRoot = GraphNodeDetail['root'];
type PlacedNode = GraphNode & { x: number; y: number };

// Elements are looked up by ids that index.html is guaranteed to contain.
const $ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T => root.querySelector<T>(selector)!;
const $$ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(selector)];
let me: Me;
let graphOverview: Graph;
let graphTrail: GraphRoot[] = [];
let teamContext: TeamProfile[] = [];
let chatHistory: ChatHistoryRow[] = [];
let activeThreadId: string = crypto.randomUUID();
let activeMessages: ThreadMessage[] = [];

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', ...options.headers }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong');
  return data as T;
}

function toast(message: string): void {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3200);
}

function formData(form: HTMLFormElement) { return Object.fromEntries(new FormData(form)); }
function esc(value: string | number = ''): string { const div = document.createElement('div'); div.textContent = String(value); return div.innerHTML; }

function authTab(name: string): void {
  $$('.auth-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.authTab === name));
  $$('.auth-form').forEach((form) => form.classList.toggle('hidden', form.id !== `${name}-form`));
}

$$('[data-auth-tab]').forEach((button) => button.onclick = () => authTab(button.dataset.authTab!));
for (const [id, endpoint] of [['login-form', '/api/auth/login'], ['create-form', '/api/auth/register'], ['join-form', '/api/auth/join']]) {
  $<HTMLFormElement>(`#${id}`).onsubmit = async (event) => {
    event.preventDefault();
    try { await request(endpoint, { method: 'POST', body: JSON.stringify(formData(event.currentTarget as HTMLFormElement)) }); await boot(); }
    catch (error) { toast((error as Error).message); }
  };
}

async function boot() {
  try {
    me = await request<Me>('/api/me');
    $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
    $('#profile-name').textContent = me.name; $('#profile-meta').textContent = `${me.team} · ${me.role}`; $('#avatar').textContent = me.name[0].toUpperCase();
    $$('[data-admin]').forEach((el) => el.classList.toggle('hidden', me.role !== 'admin'));
    showView('overview');
    await loadChatHistory();
  } catch { $('#app').classList.add('hidden'); $('#auth').classList.remove('hidden'); }
}

async function openConversation(id: number | string): Promise<void> {
  try {
    const item = await request<{ source: string; project: string; title: string; owner: string; chunks: { role: string; content: string }[] }>(`/api/conversations/${id}`);
    $('#conversation-content').innerHTML = `<div class="eyebrow">${esc(item.source)} · ${esc(item.project)}</div><h2>${esc(item.title)}</h2><p>Owned by ${esc(item.owner)}</p>${item.chunks.map((chunk) => `<div class="message ${chunk.role}"><small>${esc(chunk.role)}</small><p>${esc(chunk.content)}</p></div>`).join('')}`;
    $<HTMLDialogElement>('#conversation-dialog').showModal();
  } catch (error) { toast((error as Error).message); }
}

const titles: Record<string, [breadcrumb: string, title: string]> = {
  overview: ['WORKSPACE / OVERVIEW', 'Shared memory'],
  'team-context': ['WORKSPACE / PEOPLE', 'Team context'],
  graph: ['WORKSPACE / ADMIN', 'Knowledge graph'],
};

function showView(view: string): void {
  $$('.view').forEach((panel) => {
    const selected = panel.id === `${view}-view`;
    panel.classList.toggle('hidden', !selected);
    // Explicit display prevents a stale cached utility rule or browser extension
    // from leaving the selected panel hidden.
    if (selected) panel.style.setProperty('display', 'block', 'important');
    else panel.style.removeProperty('display');
  });
}

$$('aside nav [data-view]').forEach((button) => button.onclick = async () => {
  const view = button.dataset.view!;
  $$('aside nav [data-view]').forEach((x) => x.classList.toggle('active', x === button));
  showView(view);
  $('#breadcrumb').textContent = titles[view]![0]; $('#page-title').textContent = titles[view]![1];
  if (view === 'overview') await loadChatHistory();
  if (view === 'team-context') await loadTeamContext();
  if (view === 'graph') await loadGraph();
});

function answerModeLabel(mode?: string): string {
  return mode === 'local-llm' ? 'Local LLM · private' : mode === 'session-summary' ? 'Recent Claude/Codex sessions · private' : mode === 'verified-person' ? 'Verified person · direct evidence' : mode === 'guardrail' ? 'Protected · no inference' : mode === 'team-directory' ? 'Team directory' : 'Evidence summary · private';
}

async function loadChatHistory() {
  const list = $('#chat-history-list');
  if (!list) return;
  try { chatHistory = await request<ChatHistoryRow[]>('/api/chat-history'); }
  catch (error) { list.innerHTML = `<div class="empty-state">${esc((error as Error).message)}</div>`; return; }
  const threads: (ChatHistoryRow & { key: string })[] = [];
  const seen = new Set<string>();
  chatHistory.forEach((chat) => {
    const key = chat.thread_id || `legacy_${chat.id}`;
    if (!seen.has(key)) { seen.add(key); threads.push({ ...chat, key }); }
  });
  list.innerHTML = threads.length ? threads.map((chat, index) => `
    <button class="chat-history-item" type="button" data-chat-index="${index}">
      <span><strong>${esc(chat.query)}</strong><small>${esc(chat.thread_id ? 'Memory conversation' : answerModeLabel(chat.mode))}</small></span>
      <time>${esc(new Date(`${chat.created_at}Z`).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</time>
    </button>`).join('') : '<div class="empty-state">Your recent questions will appear here.</div>';
  $$('[data-chat-index]', list).forEach((item) => {
    item.onclick = async () => {
      const chat = threads[Number(item.dataset.chatIndex)]!;
      activeThreadId = chat.thread_id || crypto.randomUUID();
      const turns = chat.thread_id ? await request<ChatHistoryRow[]>(`/api/chat-history?thread=${encodeURIComponent(chat.thread_id)}`) : [chat];
      activeMessages = turns.flatMap((turn): ThreadMessage[] => [
        { role: 'user', text: turn.query },
        { role: 'assistant', text: turn.answer, mode: turn.mode },
      ]);
      renderMemoryThread();
      $<HTMLInputElement>('#dashboard-search-input').value = '';
      $<HTMLInputElement>('#dashboard-search-input').placeholder = 'Ask a follow-up…';
      $('.dashboard-search').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
}

function startNewChat(): void {
  activeThreadId = crypto.randomUUID();
  activeMessages = [];
  $<HTMLInputElement>('#dashboard-search-input').value = '';
  $<HTMLInputElement>('#dashboard-search-input').placeholder = 'What am I working on?';
  $('#memory-thread').classList.add('hidden');
  $('#memory-thread-messages').innerHTML = '';
  syncComposerPosition();
  $('#dashboard-search-input').focus();
}

$('#new-chat').onclick = startNewChat;

function renderMemoryThread(): void {
  const thread = $('#memory-thread');
  thread.classList.toggle('hidden', activeMessages.length === 0);
  syncComposerPosition();
  $('#memory-thread-messages').innerHTML = activeMessages.map((message, index) => {
    if (message.role === 'user') return `<article class="memory-message user"><div class="memory-message-role">You</div><p>${esc(message.text)}</p></article>`;
    const sources = message.sources?.length ? `<div class="memory-sources"><span>Supporting sessions</span>${message.sources.map((source) => `<button type="button" data-source-id="${source.id}">${esc(source.title || source.project || 'Imported session')}<small>${esc(source.project || source.source || '')}</small></button>`).join('')}</div>` : '';
    const suggestions = index === activeMessages.length - 1 && message.followUps?.length ? `<div class="memory-followups">${message.followUps.map((question) => `<button type="button" data-follow-up="${esc(question)}">${esc(question)} <span>→</span></button>`).join('')}</div>` : '';
    const reaction = message.query && /\bdhiram\b/i.test(message.query) ? '<img class="dhiram-reaction" src="/assets/dhiram-batman.gif" alt="Batman reaction">' : '';
    return `<article class="memory-message assistant${message.loading ? ' is-loading' : ''}"><div class="memory-message-heading"><div class="memory-message-role">Org Memory</div><small>${esc(message.loading ? 'Retrieving evidence…' : answerModeLabel(message.mode))}</small></div><p>${esc(message.text)}</p>${reaction}${sources}${suggestions}</article>`;
  }).join('');
  $$('[data-source-id]', thread).forEach((button) => button.onclick = () => openConversation(button.dataset.sourceId!));
  $$('[data-follow-up]', thread).forEach((button) => button.onclick = () => askMemory(button.dataset.followUp!));
  thread.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function syncComposerPosition(): void {
  const container = $('.dashboard-search');
  const form = $('#dashboard-search-form');
  const thread = $('#memory-thread');
  const hasConversation = activeMessages.length > 0;
  container.classList.toggle('has-conversation', hasConversation);
  if (hasConversation) container.append(form);
  else container.insertBefore(form, thread);
}

async function loadTeamContext(): Promise<void> {
  const groups = $('#team-context-groups');
  if (!teamContext.length) {
    groups.innerHTML = '<div class="empty-state">Loading team context…</div>';
    try { teamContext = await request<TeamProfile[]>('/api/team-context'); }
    catch (error) { groups.innerHTML = `<div class="empty-state">${esc((error as Error).message)}</div>`; toast((error as Error).message); return; }
  }
  renderTeamContext($<HTMLInputElement>('#team-context-search').value);
}

function renderTeamContext(query = ''): void {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = teamContext.filter((person) => {
    const text = `${person.name} ${person.role} ${person.team} ${person.interests.join(' ')}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const byTeam = new Map<string, TeamProfile[]>();
  matches.forEach((person) => byTeam.set(person.team, [...(byTeam.get(person.team) || []), person]));
  $('#team-context-summary').textContent = terms.length
    ? `${matches.length} matching ${matches.length === 1 ? 'person' : 'people'}`
    : `${matches.length} people across ${byTeam.size} functions`;
  const container = $('#team-context-groups');
  container.innerHTML = matches.length ? [...byTeam.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([team, people]) => `
    <details class="team-context-group"${terms.length ? ' open' : ''}>
      <summary class="team-context-group-title"><div><h4>${esc(team)}</h4><small>View people</small></div><span>${people.length}</span></summary>
      <div class="team-context-people">${people.map((person) => `
        <article class="team-context-person">
          <div class="team-context-avatar" aria-hidden="true">${esc(person.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join(''))}</div>
          <div class="team-context-person-copy"><h5>${esc(person.name)}</h5><p>${esc(person.role)}</p>${person.interests.length ? `<div class="team-context-interests">${person.interests.slice(0, 4).map((interest) => `<span>${esc(interest)}</span>`).join('')}</div>` : ''}</div>
          <button class="team-context-chat" type="button" data-chat-person="${esc(person.name)}">Chat about this person <span>→</span></button>
        </article>`).join('')}</div>
    </details>`).join('') : '<div class="empty-state">No team context matches that search.</div>';
  $$('[data-chat-person]', container).forEach((button) => {
    button.onclick = async () => {
      const name = button.dataset.chatPerson!;
      const overviewButton = $('aside nav [data-view="overview"]');
      overviewButton.click();
      const question = `Who is ${name}, and what are they working on?`;
      startNewChat();
      await askMemory(question);
      $('.dashboard-search').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
}

$<HTMLInputElement>('#team-context-search').oninput = (event) => renderTeamContext((event.currentTarget as HTMLInputElement).value);

$<HTMLFormElement>('#dashboard-search-form').onsubmit = async (event) => {
  event.preventDefault(); const query = $<HTMLInputElement>('#dashboard-search-input').value.trim(); if (!query) return;
  await askMemory(query);
};

async function askMemory(query: string): Promise<void> {
  const form = $('#dashboard-search-form');
  const submit = $<HTMLButtonElement>('button', form);
  activeMessages.push({ role: 'user', text: query });
  const pending: ThreadMessage = { role: 'assistant', text: 'Searching the underlying Claude and Codex conversations…', loading: true, query };
  activeMessages.push(pending);
  $<HTMLInputElement>('#dashboard-search-input').value = '';
  $<HTMLInputElement>('#dashboard-search-input').placeholder = 'Ask a follow-up…';
  submit.disabled = true;
  renderMemoryThread();
  try {
    const clientHistory = activeMessages.slice(0, -2).reduce<{ query: string; answer: string }[]>((turns, message, index, all) => {
      const next = all[index + 1];
      if (message.role === 'user' && next?.role === 'assistant') turns.push({ query: message.text, answer: next.text });
      return turns;
    }, []).slice(-4);
    // Keep the query in the URL as a compatibility fallback while an older
    // server process is being restarted; the updated server reads the POST body.
    const response = await request<{ answer?: string; mode?: string; sources?: SourceLink[]; followUps?: string[]; threadId: string }>(`/api/answer?q=${encodeURIComponent(query)}`, { method: 'POST', body: JSON.stringify({ query, threadId: activeThreadId, history: clientHistory }) });
    Object.assign(pending, { text: response.answer || 'No answer was generated.', mode: response.mode, sources: response.sources || [], followUps: response.followUps || [], loading: false });
    activeThreadId = response.threadId;
    renderMemoryThread();
    await loadChatHistory();
  } catch (error) {
    Object.assign(pending, { text: (error as Error).message, mode: 'error', loading: false });
    renderMemoryThread();
    toast((error as Error).message);
  } finally {
    submit.disabled = false;
    $('#dashboard-search-input').focus();
  }
}

$('#import-button').onclick = () => $<HTMLDialogElement>('#import-dialog').showModal();
$('#run-import').onclick = async (event) => {
  event.preventDefault(); const button = event.currentTarget as HTMLButtonElement; button.disabled = true; button.textContent = 'Importing and indexing…';
  try {
    const source = new FormData($<HTMLFormElement>('#import-dialog form')).get('source');
    const result = await request<Record<string, { conversations: number }>>('/api/import', { method: 'POST', body: JSON.stringify({ source }) });
    const count = Object.values(result).reduce((sum, part) => sum + part.conversations, 0);
    $<HTMLDialogElement>('#import-dialog').close(); toast(`Imported ${count} work sessions`);
  } catch (error) { toast((error as Error).message); }
  finally { button.disabled = false; button.textContent = 'Import on this machine'; }
};

$('#connector-token').onclick = async () => {
  try {
    const result = await request<{ token: string }>('/api/connector-token', { method: 'POST', body: JSON.stringify({ label: navigator.platform || 'My computer' }) });
    $('#connector-command').textContent = `curl -fsSL ${location.origin}/install.sh | sh -s -- --server ${location.origin} --token ${result.token}`;
    toast('Connector key generated — it is shown only once');
  } catch (error) { toast((error as Error).message); }
};

async function loadGraph(): Promise<void> {
  try {
    $('#graph-inspector').innerHTML = '<small>LOADING</small><h3>Building graph…</h3><p>Connecting teams, people, work areas, and projects.</p>';
    graphOverview = await request<Graph>('/api/graph');
    graphTrail = [];
    renderGraph(graphOverview);
    renderGraphWelcome();
    renderGraphNavigation();
  } catch (error) {
    $('#graph-inspector').innerHTML = `<small>GRAPH ERROR</small><h3>Could not load</h3><p>${esc((error as Error).message)}</p>`;
    toast((error as Error).message);
  }
}

function renderGraphWelcome(): void {
  $('#graph-inspector').innerHTML = '<small>SELECT A NODE</small><h3>Explore relationships</h3><p>Click a work area or project to open the imported knowledge inside it.</p><div class="graph-hint">Drag nodes to rearrange · drag the canvas to pan · scroll to zoom.</div>';
}

async function drillIntoNode(node: GraphNode): Promise<void> {
  if (node.type === 'conversation') return openConversation(node.conversationId || node.id.split(':')[1]!);
  if (node.root || graphTrail.at(-1)?.id === node.id) return;
  const inspector = $('#graph-inspector');
  inspector.innerHTML = `<small>OPENING ${esc(node.type)}</small><h3>${esc(node.label)}</h3><p>Finding the work and relationships inside this node…</p>`;
  try {
    const detail = await request<GraphNodeDetail>(`/api/graph/node?id=${encodeURIComponent(node.id)}`);
    if (graphTrail.at(-1)?.id !== detail.root.id) graphTrail.push(detail.root);
    renderGraph(detail, true);
    renderGraphDetail(detail);
    renderGraphNavigation();
  } catch (error) {
    inspector.innerHTML = `<small>GRAPH ERROR</small><h3>Could not open node</h3><p>${esc((error as Error).message)}</p><button class="graph-back" type="button">Back to graph</button>`;
    $('.graph-back').onclick = () => void renderCurrentGraph();
  }
}

function showParentGraph(): void {
  if (graphTrail.length) graphTrail.pop();
  renderCurrentGraph();
}

async function renderCurrentGraph(): Promise<void> {
  const current = graphTrail.at(-1);
  if (!current) {
    renderGraph(graphOverview);
    renderGraphWelcome();
    renderGraphNavigation();
    return;
  }
  const inspector = $('#graph-inspector');
  inspector.innerHTML = `<small>OPENING ${esc(current.type)}</small><h3>${esc(current.label)}</h3><p>Restoring this graph…</p>`;
  try {
    const detail = await request<GraphNodeDetail>(`/api/graph/node?id=${encodeURIComponent(current.id)}`);
    graphTrail[graphTrail.length - 1] = detail.root;
    renderGraph(detail, true);
    renderGraphDetail(detail);
    renderGraphNavigation();
  } catch (error) {
    inspector.innerHTML = `<small>GRAPH ERROR</small><h3>Could not restore node</h3><p>${esc((error as Error).message)}</p>`;
    toast((error as Error).message);
  }
}

function renderGraphNavigation(): void {
  graphTrail = graphTrail.filter((root, index) => index === 0 || root.id !== graphTrail[index - 1]!.id);
  const back = $<HTMLButtonElement>('#graph-back-top');
  back.disabled = graphTrail.length === 0;
  const entries = [{ label: 'Work graph', index: -1 }, ...graphTrail.map((root, index) => ({ label: root.label, index }))];
  $('#graph-breadcrumbs').innerHTML = entries.map((entry, position) => {
    const current = position === entries.length - 1;
    return `<li>${current
      ? `<span aria-current="page">${esc(entry.label)}</span>`
      : `<button class="graph-crumb" type="button" data-graph-index="${entry.index}">${esc(entry.label)}</button>`}</li>`;
  }).join('');
  $$('.graph-crumb', $('#graph-breadcrumbs')).forEach((crumb) => {
    crumb.onclick = () => {
      const index = Number(crumb.dataset.graphIndex);
      graphTrail = index < 0 ? [] : graphTrail.slice(0, index + 1);
      renderCurrentGraph();
    };
  });
}

$('#graph-back-top').onclick = showParentGraph;

function renderGraphDetail(detail: GraphNodeDetail): void {
  const root = detail.root;
  const itemLabel = detail.items.length === 1 ? 'work session' : 'work sessions';
  $('#graph-inspector').innerHTML = `
    <small>${esc(root.type)} / CONTENTS</small>
    <h3>${esc(root.label)}</h3>
    <p>${esc(root.description)}</p>
    <div class="graph-hint">Drag any node to rearrange this graph.</div>
    <div class="graph-content-heading"><strong>${detail.items.length} ${itemLabel}</strong><small>${detail.truncated ? 'Latest 24' : 'All'}</small></div>
    <div class="graph-content-list">${detail.items.length ? detail.items.map((item) => `
      <button class="graph-content-item" type="button" data-conversation-id="${item.id}">
        <strong>${esc(item.title)}</strong>
        <span>${esc(item.owner)} · ${esc(item.project)}</span>
        ${item.topics.length ? `<em>${item.topics.slice(0, 3).map(esc).join(' · ')}</em>` : ''}
      </button>`).join('') : '<div class="graph-empty">No imported work is inside this node yet.</div>'}</div>`;
  $$('[data-conversation-id]', $('#graph-inspector')).forEach((item) => item.onclick = () => openConversation(item.dataset.conversationId!));
}

function renderGraph(data: Graph, focused = false): void {
  const svg = $<SVGSVGElement>('#graph'); svg.innerHTML = ''; svg.setAttribute('viewBox', '0 0 1100 620');
  const width = 1100, height = 620, cx = 465, cy = 310;
  const root = focused ? (data.nodes.find((node) => node.root) || data.nodes[0]) : null;
  // Positions are assigned below, so every visible node becomes a PlacedNode.
  const visibleNodes = (root ? data.nodes.filter((node) => node !== root) : data.nodes) as PlacedNode[];
  const groups: Record<string, PlacedNode[]> = { team: [], person: [], topic: [], project: [], conversation: [] };
  visibleNodes.forEach((node) => (groups[node.type] ||= []).push(node));
  if (focused) {
    const conversations = groups['conversation']!;
    conversations.forEach((node, index) => { const angle = (index / Math.max(conversations.length, 1)) * Math.PI * 2 - Math.PI / 2; const ring = conversations.length > 14 ? (index % 2 ? 190 : 125) : 155; node.x = cx + Math.cos(angle) * ring; node.y = cy + Math.sin(angle) * ring; });
    const context = visibleNodes.filter((node) => node.type !== 'conversation');
    context.forEach((node, index) => { const angle = (index / Math.max(context.length, 1)) * Math.PI * 2 - Math.PI / 2 + .18; const ring = index % 2 ? 300 : 260; node.x = cx + Math.cos(angle) * ring; node.y = cy + Math.sin(angle) * ring; });
  } else {
    const rings: Record<string, number> = { team: 70, person: 150, topic: 245, project: 330 };
    const offsets: Record<string, number> = { team: 0, person: .3, topic: .7, project: 1.1, conversation: 0 };
    for (const [type, nodes] of Object.entries(groups)) nodes.forEach((node, index) => { const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2 - Math.PI / 2 + (offsets[type] || 0); node.x = cx + Math.cos(angle) * (rings[type] || 300); node.y = cy + Math.sin(angle) * (rings[type] || 300); });
  }
  const byId: Record<string, PlacedNode> = Object.fromEntries(visibleNodes.map((node) => [node.id, node]));
  const ns = 'http://www.w3.org/2000/svg';
  for (const link of data.links) { const a = byId[link.source], b = byId[link.target]; if (!a || !b) continue; const line = document.createElementNS(ns, 'line'); line.setAttribute('x1', String(a.x)); line.setAttribute('y1', String(a.y)); line.setAttribute('x2', String(b.x)); line.setAttribute('y2', String(b.y)); line.setAttribute('stroke-width', String(Math.min(6, 1 + Number(link.weight || 1)))); line.setAttribute('class', 'graph-link'); line.dataset.source = link.source; line.dataset.target = link.target; svg.append(line); }
  const colors: Record<string, string> = { team: '#174f39', person: '#ef8b72', topic: '#e7be66', project: '#8ab8b0', conversation: '#7668a6' };
  for (const node of visibleNodes) {
    const group = document.createElementNS(ns, 'g');
    group.setAttribute('class', `graph-node-group${node.root ? ' is-root' : ''}`);
    group.setAttribute('tabindex', '0'); group.setAttribute('role', 'button'); group.setAttribute('aria-label', `Open ${node.type} ${node.label}`);
    const circle = document.createElementNS(ns, 'circle'); circle.setAttribute('cx', String(node.x)); circle.setAttribute('cy', String(node.y)); circle.setAttribute('r', String(node.root ? 27 : node.type === 'team' ? 18 : 11 + Math.min(8, Number(node.count || 0)))); circle.setAttribute('fill', String(colors[node.type])); circle.setAttribute('class', 'graph-node');
    const label = document.createElementNS(ns, 'text'); label.setAttribute('x', String(node.x + 14)); label.setAttribute('y', String(node.y + 4)); label.setAttribute('class', 'graph-label'); label.textContent = node.label.length > 24 ? `${node.label.slice(0, 22)}…` : node.label;
    if (node.root) { label.setAttribute('x', String(node.x)); label.setAttribute('y', String(node.y + 44)); label.setAttribute('text-anchor', 'middle'); }
    group.append(circle, label); group.onclick = () => { if (group.dataset.dragged !== 'true') drillIntoNode(node); }; group.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); drillIntoNode(node); } }; svg.append(group);
  }
  enableGraphDragging(svg, { nodes: visibleNodes });
}

function graphPoint(svg: SVGSVGElement, event: MouseEvent): DOMPoint {
  const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM()!.inverse());
}

function enableGraphDragging(svg: SVGSVGElement, data: { nodes: PlacedNode[] }): void {
  let pan: { x: number; y: number; box: { x: number; y: number; width: number; height: number } } | null = null;
  const setViewBox = (box: { x: number; y: number; width: number; height: number }) => svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
  svg.onpointerdown = (event) => {
    if ((event.target as Element).closest?.('.graph-node-group')) return;
    const box = svg.viewBox.baseVal;
    pan = { x: event.clientX, y: event.clientY, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
    svg.setPointerCapture(event.pointerId); svg.classList.add('is-panning');
  };
  svg.onpointermove = (event) => {
    if (!pan) return;
    const rect = svg.getBoundingClientRect();
    setViewBox({ ...pan.box, x: pan.box.x - (event.clientX - pan.x) * pan.box.width / rect.width, y: pan.box.y - (event.clientY - pan.y) * pan.box.height / rect.height });
  };
  svg.onpointerup = svg.onpointercancel = () => { pan = null; svg.classList.remove('is-panning'); };
  svg.onwheel = (event) => {
    event.preventDefault();
    const box = svg.viewBox.baseVal; const at = graphPoint(svg, event); const scale = event.deltaY > 0 ? 1.12 : .89;
    const width = Math.min(2200, Math.max(440, box.width * scale)); const height = width * 620 / 1100; const ratio = width / box.width;
    setViewBox({ x: at.x - (at.x - box.x) * ratio, y: at.y - (at.y - box.y) * ratio, width, height });
  };

  $$<SVGGElement>('.graph-node-group', svg).forEach((group, index) => {
    const graphNode = data.nodes[index]!; let drag: { start: DOMPoint; x: number; y: number; moved: boolean } | null = null;
    group.onpointerdown = (event) => {
      event.stopPropagation(); const start = graphPoint(svg, event);
      drag = { start, x: graphNode.x, y: graphNode.y, moved: false };
      group.dataset.dragged = 'false'; group.setPointerCapture(event.pointerId); group.classList.add('is-dragging');
    };
    group.onpointermove = (event) => {
      if (!drag) return;
      const point = graphPoint(svg, event); const dx = point.x - drag.start.x; const dy = point.y - drag.start.y;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      graphNode.x = drag.x + dx; graphNode.y = drag.y + dy;
      const circle = group.querySelector('circle')!; const label = group.querySelector('text')!;
      circle.setAttribute('cx', String(graphNode.x)); circle.setAttribute('cy', String(graphNode.y));
      label.setAttribute('x', String(graphNode.root ? graphNode.x : graphNode.x + 14)); label.setAttribute('y', String(graphNode.y + (graphNode.root ? 44 : 4)));
      $$<SVGLineElement>('.graph-link', svg).forEach((line) => {
        if (line.dataset.source === graphNode.id) { line.setAttribute('x1', String(graphNode.x)); line.setAttribute('y1', String(graphNode.y)); }
        if (line.dataset.target === graphNode.id) { line.setAttribute('x2', String(graphNode.x)); line.setAttribute('y2', String(graphNode.y)); }
      });
    };
    group.onpointerup = group.onpointercancel = () => {
      if (!drag) return; group.dataset.dragged = String(drag.moved); drag = null; group.classList.remove('is-dragging');
      setTimeout(() => { group.dataset.dragged = 'false'; }, 0);
    };
  });
}

boot();
