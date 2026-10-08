import test from 'node:test';
import assert from 'node:assert/strict';
import { assessConversationPrivacy, PRIVACY_POLICY_VERSION, sanitizeConversationForSync } from '../src/shared/privacy.ts';

test('ordinary engineering sessions remain syncable', () => {
  const conversation = { title: 'Fix graph navigation', project: 'org-memory', messages: [{ role: 'user', content: 'Remove the duplicate Engineering breadcrumb and add a test.' }] };
  const result = sanitizeConversationForSync(conversation);
  assert.equal(result.redacted, false);
  assert.equal(result.conversation, conversation);
  assert.equal(result.assessment.policyVersion, PRIVACY_POLICY_VERSION);
});

test('personnel evaluations are fully redacted on the machine', () => {
  const conversation = {
    source: 'claude', externalId: 'sensitive-1', title: "Evaluate Dhiram's output", project: 'manager-notes',
    messages: [
      { role: 'user', content: "Please evaluate Dhiram's performance and recommend whether to promote him." },
      { role: 'assistant', content: 'Here is a detailed assessment with confidential examples.' },
    ],
  };
  const result = sanitizeConversationForSync(conversation);
  assert.equal(result.redacted, true);
  assert.ok(result.assessment.categories.includes('personnel_evaluation'));
  const outbound = JSON.stringify(result.conversation);
  assert.doesNotMatch(outbound, /Dhiram|manager-notes|promote|assessment/i);
  assert.match(result.conversation.messages[0].content, /REDACTED LOCALLY/);
  assert.equal(result.conversation.title, 'Private session — content redacted locally');
  assert.equal(result.conversation.project, 'Private');
});

test('credentials cause full local redaction before sync', () => {
  const secret = 'super-secret-value-123';
  const result = sanitizeConversationForSync({ title: 'Deploy', project: 'api', messages: [{ role: 'user', content: `password: ${secret}` }] });
  assert.equal(result.redacted, true);
  assert.ok(result.assessment.categories.includes('credentials'));
  assert.doesNotMatch(JSON.stringify(result.conversation), new RegExp(secret));
});

test('redacted outbound payload does not disclose the matched category', () => {
  const result = sanitizeConversationForSync({ title: 'Performance review', project: 'people', messages: [{ role: 'user', content: 'Write an employee performance review.' }] });
  assert.equal(assessConversationPrivacy(result.conversation).allowed, true);
  assert.equal('categories' in result.conversation, false);
  assert.doesNotMatch(JSON.stringify(result.conversation), /personnel_evaluation|performance review/i);
});
