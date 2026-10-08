import test from 'node:test';
import assert from 'node:assert/strict';
import { directPersonMentions, directPersonWorkMentions, extractWhoName, findNamedPerson, guardedPersonAnswer, isPersonWorkQuestion, summarizeRecentSelfWork } from '../src/server/answer-guardrails.ts';

const people = [
  { name: 'Dhiram Shah', role: 'Supply Lead', interests: ['operations', 'growth'] },
  { name: 'Rohan', role: 'Engineer', interests: ['software'] },
];

test('compound identity questions remain anchored to the named person', () => {
  const query = 'who is dhiram is there any mention on what he is working on right now';
  assert.equal(extractWhoName(query), 'dhiram');
  assert.equal(findNamedPerson(query, people)?.name, 'Dhiram Shah');
  assert.equal(isPersonWorkQuestion(query), true);
  assert.equal(isPersonWorkQuestion('Who is Dhiram?'), false);
});

test('work questions resolve a unique first name anywhere in the query', () => {
  assert.equal(findNamedPerson('hi what is rohan working on', people)?.name, 'Rohan');
});

test('self work summaries use meaningful Claude and Codex session metadata', () => {
  const result = summarizeRecentSelfWork('Rohan', [
    { source: 'claude', project: 'rohan', title: 'hi', updated_at: '2026-10-07T12:00:00Z' },
    { source: 'codex', project: 'rohan', title: 'build a shared memory from .codex and .claude and make a knowledge graph', updated_at: '2026-10-07T11:00:00Z' },
    { source: 'claude', project: 'STAYIN_BE', title: 'can you setup this repo and run this locally', updated_at: '2026-10-06T20:00:00Z' },
  ]);
  assert.equal(result.evidenceCount, 2);
  assert.match(result.answer, /Org Memory/);
  assert.match(result.answer, /Stayin/);
  assert.doesNotMatch(result.answer, /says: “hi”/);
});

test('person answers reject unrelated semantic matches', () => {
  const sources = [{ owner: 'Rohan', project: 'doc-automation', content: 'Rohan is building the Qwen diagram.', updated_at: '2026-10-07' }];
  assert.deepEqual(directPersonMentions(people[0], sources), []);
  const answer = guardedPersonAnswer('what is Dhiram working on right now?', people[0], sources);
  assert.match(answer, /couldn't find enough evidence in the imported Claude Code sessions/i);
  assert.doesNotMatch(answer, /Qwen/);
});

test('a name mention without a supported activity is rejected', () => {
  const sources = [{ owner: 'Rohan', project: 'supply', content: 'Dhiram discussed the vendor onboarding plan.', updated_at: '2026-09-01' }];
  assert.deepEqual(directPersonWorkMentions(people[0], sources), []);
  const answer = guardedPersonAnswer('what is Dhiram working on?', people[0], sources);
  assert.match(answer, /couldn't find enough evidence/i);
  assert.doesNotMatch(answer, /vendor onboarding/);
});

test('explicit named work evidence is shown with a freshness qualification', () => {
  const sources = [{ owner: 'Rohan', project: 'supply', content: 'Dhiram is currently leading the vendor onboarding launch.', updated_at: '2026-09-01' }];
  const answer = guardedPersonAnswer('what is Dhiram working on?', people[0], sources);
  assert.match(answer, /does not by itself prove a current assignment/i);
  assert.match(answer, /vendor onboarding/);
});
