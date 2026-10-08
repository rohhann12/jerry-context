import test from 'node:test';
import assert from 'node:assert/strict';
import { contextualizeQuery, suggestedFollowUps } from '../src/server/conversation.ts';

test('follow-up questions carry the previous memory answer into retrieval', () => {
  const history = [{ query: 'What is Rohan working on?', answer: '• Org Memory: building private semantic search.' }];
  const expanded = contextualizeQuery('What is he building in Org Memory?', history);
  assert.match(expanded, /Previous question: What is Rohan working on/);
  assert.match(expanded, /private semantic search/);
  assert.equal(contextualizeQuery('Explain the Stayin deployment architecture', []), 'Explain the Stayin deployment architecture');
});

test('follow-up suggestions expose answer bullets and supporting sessions', () => {
  const suggestions = suggestedFollowUps('• Org Memory: building search.\n• Stayin: running locally.', [{ project: 'org-memory' }]);
  assert.deepEqual(suggestions, ['Go deeper on Org Memory', 'Go deeper on Stayin', 'What decisions were made?']);
});
