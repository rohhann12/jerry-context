export interface ChatMessage {
  role: string;
  content: string;
  timestamp?: string | null;
}

/** A conversation as read from a local Claude/Codex history, before storage. */
export interface ConversationInput {
  source?: string;
  externalId?: string;
  title?: string;
  project?: string;
  sourcePath?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  messages: ChatMessage[];
}

export type SyncSource = 'claude' | 'codex';
