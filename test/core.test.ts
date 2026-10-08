import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cosine, localEmbedding } from '../src/server/embeddings.ts';
import { directPersonWorkMentions, extractWhoName, findNamedPerson, guardedPersonAnswer } from '../src/server/answer-guardrails.ts';

test('long person-status questions resolve the person and abstain from unrelated work', () => {
  const people = [
    { name: 'Dhiram Shah', role: 'Director - Demand Growth', interests: ['Cars'] },
    { name: 'Rohan Sharma', role: 'Product Engineer', interests: [] },
  ];
  const query = 'who is dhiram is there any mention on what he is working on right now/';
  const person = findNamedPerson(query, people);
  assert.ok(person);
  assert.equal(extractWhoName(query), 'dhiram');
  assert.equal(person.name, 'Dhiram Shah');
  assert.deepEqual(directPersonWorkMentions(person, [{
    content: "Everything's built and I tested it against Qwen.",
    owner: 'Rohan',
    score: 0.95,
  }]), []);
  assert.match(guardedPersonAnswer(query, person, []), /couldn't find enough evidence in the imported Claude Code sessions/i);
});

test('a copied question is not treated as evidence of a current assignment', () => {
  const person = { name: 'Dhiram Shah', role: 'Director - Demand Growth', interests: [] };
  const sources = [
    { content: 'What is Dhiram working on?', score: 0.99 },
    { content: 'Rohan is building the connector.', score: 0.9 },
    { content: 'Dhiram is currently leading the demand growth launch.', score: 0.7 },
  ];
  const evidence = directPersonWorkMentions(person, sources);
  assert.equal(evidence.length, 1);
  assert.match(evidence[0]!.content, /Dhiram is currently leading/);
});

test('local embeddings rank related repeated language above unrelated text', () => {
  const query = localEmbedding('scraping leads enrichment');
  const related = localEmbedding('lead scraping and lead enrichment pipeline');
  const unrelated = localEmbedding('ios animation typography');
  assert.ok(cosine(query, related) > cosine(query, unrelated));
});

test('topic classification produces graph edges with organization isolation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'org-memory-test-'));
  process.env.ORG_MEMORY_DB = path.join(directory, 'test.sqlite');
  const { db, classifyConversation, getGraph, getGraphNode, getTeamContext, seedOrg } = await import(`../src/server/db.ts?test=${Date.now()}`) as typeof import('../src/server/db.ts');
  const org = db.prepare("INSERT INTO organizations(name,slug) VALUES ('Flent','flent') RETURNING id").get() as { id: number };
  const user = db.prepare("INSERT INTO users(org_id,name,email,password_hash,team,role) VALUES (?,?,?,?,?,?) RETURNING id").get(org.id, 'Dhiram', 'dhiram@example.com', 'test', 'Supply', 'member') as { id: number };
  seedOrg(org.id);
  const conversation = db.prepare("INSERT INTO conversations(org_id,owner_id,source,external_id,title,project) VALUES (?,?,?,?,?,?) RETURNING id").get(org.id, user.id, 'claude', 'one', 'Scraping leads', 'supply-pipeline') as { id: number };
  classifyConversation(org.id, conversation.id, 'Build a crawler for scraping and enriching prospective leads');
  const graph = getGraph(org.id, user.id);
  assert.ok(graph.nodes.some((node) => node.label === 'Lead scraping'));
  assert.equal(graph.nodes.some((node) => node.id.startsWith('profile:')), false);
  assert.equal(graph.nodes.some((node) => node.type === 'person' || node.type === 'team'), false);
  assert.ok(graph.nodes.some((node) => node.type === 'project'));
  assert.ok(graph.links.some((link) => link.source.startsWith('topic:') && link.target === 'project:supply-pipeline'));
  const teamContext = getTeamContext(org.id);
  assert.ok(teamContext.some((person) => person.name === 'Ayub Ansari' && person.team === 'Design'));
  const personGraph = getGraphNode(org.id, `person:${user.id}`, user.id);
  assert.ok(personGraph);
  assert.equal(personGraph.root.label, 'Dhiram');
  assert.equal(personGraph.items[0]?.title, 'Scraping leads');
  assert.ok(personGraph.nodes.some((node) => node.id === `conversation:${conversation.id}`));
  assert.ok(personGraph.links.some((link) => link.source === `person:${user.id}` && link.target === `conversation:${conversation.id}`));
  assert.deepEqual(graph.nodes.filter((node) => !getGraphNode(org.id, node.id, user.id)), []);
  assert.equal(getGraphNode(org.id, 'project:missing', user.id), null);
  db.close();
});
