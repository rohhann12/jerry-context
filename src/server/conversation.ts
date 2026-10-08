export interface ChatTurn {
  query: string;
  answer: string;
}

export function contextualizeQuery(query: string, history: ChatTurn[] = []): string {
  const value = String(query || '').trim();
  if (!history.length || !isFollowUp(value)) return value;
  const previous = history.at(-1)!;
  return `${value}\n\nPrevious question: ${previous.query}\nPrevious answer: ${String(previous.answer || '').slice(0, 1800)}`;
}

export function suggestedFollowUps(answer: string, sources: { project?: string | null }[] = []): string[] {
  const labels = [...String(answer || '').matchAll(/^[•*-]\s*([^:\n]{2,60}):/gm)].map((match) => match[1]!.trim());
  const projects = [...new Set(sources.map((source) => source.project).filter((project): project is string => !!project && !/^unknown project$/i.test(project)))];
  const subjects = [...new Set([...labels, ...projects])].slice(0, 2);
  const suggestions = subjects.map((subject) => `Go deeper on ${subject}`);
  if (!suggestions.length) suggestions.push('What are the main implementation details?');
  suggestions.push('What decisions were made?');
  suggestions.push('Which sessions support this?');
  return suggestions.slice(0, 3);
}

function isFollowUp(query: string): boolean {
  return query.split(/\s+/).length < 9
    || /\b(?:it|its|he|his|she|her|they|their|that|this|those|there)\b/i.test(query)
    || /\b(?:go deeper|tell me more|expand|elaborate|what about|how does|why|which sessions?|show me)\b/i.test(query);
}
