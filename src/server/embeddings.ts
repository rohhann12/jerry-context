import crypto from 'node:crypto';

const DIMENSIONS = 192;

export function normalize(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return magnitude ? values.map((value) => value / magnitude) : values;
}

export function localEmbedding(text: string): number[] {
  const vector: number[] = Array(DIMENSIONS).fill(0);
  const words = String(text).toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || [];
  for (const word of words) {
    const digest = crypto.createHash('sha256').update(word).digest();
    for (let i = 0; i < 4; i += 1) {
      const index = digest.readUInt16BE(i * 2) % DIMENSIONS;
      vector[index] += (digest[i + 8] & 1) === 0 ? 1 : -1;
    }
  }
  return normalize(vector);
}

export async function embed(text: string): Promise<number[]> {
  const baseUrl = process.env.OLLAMA_URL;
  if (!baseUrl) return localEmbedding(text);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.OLLAMA_MODEL || 'nomic-embed-text', input: text }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const body = await response.json() as { embeddings?: number[][]; embedding?: number[] };
    const vector = body.embeddings?.[0] || body.embedding;
    if (!vector) throw new Error('Ollama returned no embedding');
    return normalize(vector);
  } catch {
    return localEmbedding(text);
  }
}

export function cosine(a: number[] | undefined, b: number[] | undefined): number {
  if (!a?.length || a.length !== b?.length) return 0;
  return a.reduce((sum, value, index) => sum + value * b![index]!, 0);
}

