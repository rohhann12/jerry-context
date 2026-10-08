import type { ConversationInput } from './types.ts';

export const PRIVACY_POLICY_VERSION = '2026-10-strict-1';

interface PrivacyRule {
  category: string;
  label: string;
  patterns: RegExp[];
}

export interface PrivacyAssessment {
  decision: 'quarantine' | 'allow';
  allowed: boolean;
  categories: string[];
  labels: string[];
  policyVersion: string;
}

export type RedactedConversation<T> = T & { privacyRedacted?: true; privacyPolicyVersion?: string };

export interface SanitizedConversation<T> {
  conversation: RedactedConversation<T>;
  assessment: PrivacyAssessment;
  redacted: boolean;
}

const rules: PrivacyRule[] = [
  {
    category: 'personnel_evaluation',
    label: 'Personnel evaluation or performance management',
    patterns: [
      /\bperformance\s+(?:review|evaluation|assessment|rating|calibration)\b/i,
      /\b(?:candidate|employee|teammate|direct report|manager)\s+(?:evaluation|assessment|rating|ranking|feedback)\b/i,
      /\b(?:interview|hiring)\s+(?:feedback|evaluation|assessment|recommendation|scorecard)\b/i,
      /\b(?:evaluate|assess|rate|rank|score|review)\b.{0,80}\b(?:employee|candidate|person|teammate|direct report|individual|performance|contribution)\b/is,
      /\b(?:evaluate|assess|rate|rank|review|feedback on)\b.{0,60}\b[a-z][a-z'-]{1,30}'s\s+(?:output|work|performance|contribution|quality)\b/is,
      /\b(?:performance improvement plan|pip|promotion calibration|succession planning)\b/i,
    ],
  },
  {
    category: 'employment_action',
    label: 'Promotion, termination, disciplinary, or investigation data',
    patterns: [
      /\b(?:promote|promotion|demote|demotion|terminate|termination|firing|fire|layoff|redundancy)\b.{0,100}\b(?:employee|person|teammate|report|candidate|manager|engineer|designer|analyst)\b/is,
      /\b(?:disciplinary action|workplace investigation|misconduct allegation|harassment complaint|employee grievance)\b/i,
    ],
  },
  {
    category: 'compensation',
    label: 'Compensation or benefits data',
    patterns: [
      /\b(?:salary|compensation|pay raise|bonus|equity grant|stock grant|ctc|cost to company)\b.{0,100}\b(?:employee|candidate|offer|person|teammate|manager|annual|monthly|inr|usd|₹|\$)\b/is,
      /\b(?:employee|candidate|person|teammate)\b.{0,100}\b(?:salary|compensation|bonus|equity|ctc|pay raise)\b/is,
    ],
  },
  {
    category: 'health_or_leave',
    label: 'Health, disability, or protected leave data',
    patterns: [
      /\b(?:medical diagnosis|mental health condition|disability accommodation|medical leave|maternity leave|paternity leave|sick leave record)\b/i,
    ],
  },
  {
    category: 'identity_or_financial',
    label: 'Government identity or financial data',
    patterns: [
      /\b(?:aadhaar|aadhar|passport|pan card|social security|ssn|bank account|routing number|credit card)\b.{0,80}\b(?:number|copy|document|details|statement|scan|photo)\b/is,
      /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/,
    ],
  },
  {
    category: 'credentials',
    label: 'Credentials or private keys',
    patterns: [
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /\b(?:password|secret|api[_ -]?key|access[_ -]?token)\s*(?:is|=|:)\s*["']?[A-Za-z0-9_./+~=-]{8,}/i,
      /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
    ],
  },
  {
    category: 'legal_confidential',
    label: 'Legally privileged or confidential investigation data',
    patterns: [
      /\b(?:attorney-client privileged|legal privilege|litigation strategy|confidential legal advice|internal investigation findings)\b/i,
    ],
  },
];

function corpusOf({ title, project, messages }: Partial<ConversationInput>): string {
  return [title, project, ...(messages || []).map((message) => message?.content)].filter(Boolean).join('\n');
}

export function assessConversationPrivacy(conversation: Partial<ConversationInput>): PrivacyAssessment {
  const corpus = corpusOf(conversation);
  const matches = rules.filter((rule) => rule.patterns.some((pattern) => pattern.test(corpus)));
  return {
    decision: matches.length ? 'quarantine' : 'allow' as const,
    allowed: matches.length === 0,
    categories: matches.map((match) => match.category),
    labels: matches.map((match) => match.label),
    policyVersion: PRIVACY_POLICY_VERSION,
  };
}

export function privacyCategoryLabels(categories: string[] = []): string[] {
  return categories.map((category) => rules.find((rule) => rule.category === category)?.label || category);
}

export function sanitizeConversationForSync<T extends Partial<ConversationInput>>(conversation: T): SanitizedConversation<T> {
  const assessment = assessConversationPrivacy(conversation);
  if (assessment.allowed) return { conversation, assessment, redacted: false };
  return {
    assessment,
    redacted: true,
    conversation: {
      ...conversation,
      title: 'Private session — content redacted locally',
      project: 'Private',
      messages: [{
        role: 'user',
        content: '[REDACTED LOCALLY — this session matched the privacy policy and its contents were not synced.]',
        timestamp: conversation.startedAt || conversation.updatedAt || null,
      }],
      privacyRedacted: true as const,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION,
    },
  };
}
