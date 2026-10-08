import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, '../docs/org-memory-system.excalidraw');
type ExcalidrawElement = Record<string, unknown>;
type Point = [number, number];

interface LabelOptions {
  fontSize?: number;
  width?: number;
  height?: number;
  lineHeight?: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
}

let sequence = 0;
const elements: ExcalidrawElement[] = [];
const connectors: ExcalidrawElement[] = [];

function base(id: string, type: string, x: number, y: number, width: number, height: number, overrides: ExcalidrawElement = {}): ExcalidrawElement {
  sequence += 1;
  return {
    id, type, x, y, width, height, angle: 0,
    strokeColor: '#17211b', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100,
    groupIds: [], frameId: null, index: `a${String(sequence).padStart(3, '0')}`,
    roundness: type === 'rectangle' ? { type: 3 } : null,
    seed: 1000 + sequence, version: 1, versionNonce: 5000 + sequence,
    isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
    ...overrides,
  };
}

function rect(id: string, x: number, y: number, width: number, height: number, fill: string, stroke = '#d7d8d1', overrides: ExcalidrawElement = {}): void {
  elements.push(base(id, 'rectangle', x, y, width, height, {
    backgroundColor: fill, strokeColor: stroke, strokeWidth: 1.5, ...overrides,
  }));
}

function label(id: string, x: number, y: number, text: string, options: LabelOptions = {}): void {
  const fontSize = options.fontSize || 16;
  const lines = text.split('\n');
  const width = options.width || Math.max(60, Math.max(...lines.map((line) => line.length)) * fontSize * 0.57);
  const height = options.height || lines.length * fontSize * (options.lineHeight || 1.25);
  elements.push(base(id, 'text', x, y, width, height, {
    strokeColor: options.color || '#17211b', fontSize, fontFamily: 2,
    text, textAlign: options.align || 'left', verticalAlign: 'top', containerId: null,
    originalText: text, autoResize: true, lineHeight: options.lineHeight || 1.25,
    roundness: null,
  }));
}

function arrow(id: string, points: Point[], color = '#566158', options: { strokeWidth?: number; dashed?: boolean; noHead?: boolean } = {}): void {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const x = Math.min(...xs); const y = Math.min(...ys);
  const normalized = points.map(([px, py]) => [px - x, py - y]);
  connectors.push(base(id, 'arrow', x, y, Math.max(...xs) - x, Math.max(...ys) - y, {
    strokeColor: color, strokeWidth: options.strokeWidth || 2,
    strokeStyle: options.dashed ? 'dashed' : 'solid',
    points: normalized, lastCommittedPoint: null, startBinding: null, endBinding: null,
    startArrowhead: null, endArrowhead: options.noHead ? null : 'arrow', elbowed: false,
    roundness: { type: 2 },
  }));
}

function pill(id: string, x: number, y: number, width: number, text: string, fill: string, color: string): void {
  rect(`${id}-box`, x, y, width, 34, fill, fill, { strokeWidth: 1 });
  label(`${id}-text`, x, y + 8, text, { fontSize: 13, width, align: 'center', color, height: 17 });
}

// Header
label('title', 60, 38, 'Org Memory', { fontSize: 34, color: '#17211b' });
label('title-accent', 245, 45, 'SYSTEM ARCHITECTURE', { fontSize: 14, color: '#174f39' });
label('subtitle', 60, 88, 'A private organizational memory built from approved AI-assisted work', { fontSize: 17, color: '#6e776f' });

// Section labels
label('inputs-heading', 60, 150, '01  INPUTS', { fontSize: 14, color: '#376f65' });
label('pipeline-heading', 365, 150, '02  PRIVATE INGESTION', { fontSize: 14, color: '#8a6718' });
label('core-heading', 725, 150, '03  CORE PLATFORM', { fontSize: 14, color: '#174f39' });
label('experience-heading', 1110, 150, '04  EXPERIENCES', { fontSize: 14, color: '#a24e3a' });

// Input cards
rect('claude-card', 60, 190, 250, 92, '#e9f4f1', '#8ab8b0');
label('claude-kicker', 82, 207, 'CLAUDE CODE', { fontSize: 12, color: '#376f65' });
label('claude-main', 82, 231, 'Local session transcripts', { fontSize: 18 });
label('claude-meta', 82, 258, 'Approved JSONL history', { fontSize: 13, color: '#6e776f' });

rect('codex-card', 60, 310, 250, 92, '#e9f4f1', '#8ab8b0');
label('codex-kicker', 82, 327, 'CODEX', { fontSize: 12, color: '#376f65' });
label('codex-main', 82, 351, 'Local work threads', { fontSize: 18 });
label('codex-meta', 82, 378, 'Thread databases', { fontSize: 13, color: '#6e776f' });

rect('directory-card', 60, 430, 250, 92, '#f3f7f5', '#8ab8b0');
label('directory-kicker', 82, 447, 'TEAM DIRECTORY', { fontSize: 12, color: '#376f65' });
label('directory-main', 82, 471, 'People, roles and teams', { fontSize: 18 });
label('directory-meta', 82, 498, 'Identity context only', { fontSize: 13, color: '#6e776f' });

// Ingestion pipeline
rect('pipeline-shell', 365, 190, 300, 450, '#fff8e5', '#e7be66');
label('pipeline-file', 390, 210, 'connector.ts  ·  importer.ts', { fontSize: 13, color: '#8a6718' });

const steps: [id: string, x: number, y: number, number: string, main: string, meta: string][] = [
  ['read', 390, 250, '1', 'Read approved files', 'Never scans auth or settings'],
  ['normalize', 390, 335, '2', 'Normalize + redact', 'Messages, paths and secrets'],
  ['embed', 390, 420, '3', 'Chunk + embed', 'Private searchable memory units'],
  ['classify', 390, 505, '4', 'Classify + connect', 'Owner, topic and project edges'],
];
for (const [id, x, y, number, main, meta] of steps) {
  rect(`${id}-step`, x, y, 250, 64, '#fffdf8', '#dbc77e');
  pill(`${id}-number`, x + 14, y + 15, 34, number, '#174f39', '#ffffff');
  label(`${id}-main`, x + 61, y + 12, main, { fontSize: 16 });
  label(`${id}-meta`, x + 61, y + 36, meta, { fontSize: 12, color: '#6e776f' });
}
pill('connector-token', 390, 590, 250, 'Personal connector token · optional remote sync', '#f3e5ae', '#674d10');

// Core platform
rect('core-shell', 725, 190, 330, 450, '#edf5ef', '#72a388');
rect('api-card', 750, 215, 280, 92, '#174f39', '#174f39');
label('api-kicker', 772, 232, 'NODE HTTP API', { fontSize: 12, color: '#d9ed9a' });
label('api-main', 772, 255, 'Authentication + access control', { fontSize: 18, color: '#ffffff' });
label('api-meta', 772, 282, 'Session auth · JSON endpoints', { fontSize: 13, color: '#c9d5cc' });

rect('db-card', 750, 330, 280, 178, '#fffdf8', '#72a388');
label('db-kicker', 772, 348, 'SQLITE · SINGLE PRIVATE STORE', { fontSize: 12, color: '#376f65' });
label('db-main', 772, 377, 'Organizational memory', { fontSize: 20 });
label('db-schema', 772, 414, 'organizations  ·  users  ·  profiles\nconversations  ·  chunks  ·  embeddings\ntopics  ·  conversation_topic edges', { fontSize: 14, color: '#4e5951', lineHeight: 1.55 });

pill('embedding-service', 750, 535, 132, 'embeddings.ts', '#dbece2', '#174f39');
pill('graph-service', 892, 535, 138, 'db.ts · getGraph', '#dbece2', '#174f39');
pill('guard-service', 750, 582, 280, 'answer-guardrails.ts · entity lock + evidence gate', '#d9ed9a', '#174f39');

// Experiences
rect('ask-card', 1110, 190, 420, 205, '#fff4ef', '#ef8b72');
label('ask-kicker', 1135, 211, 'ASK YOUR WORK', { fontSize: 12, color: '#a24e3a' });
label('ask-main', 1135, 237, 'Grounded semantic answers', { fontSize: 21 });
label('ask-flow', 1135, 279, 'Query', { fontSize: 14, color: '#5d675f' });
pill('entity-lock', 1200, 270, 100, 'Entity lock', '#ffe1d8', '#8d3f2d');
pill('evidence-gate', 1310, 270, 126, 'Evidence gate', '#ffe1d8', '#8d3f2d');
pill('retrieve-rank', 1446, 270, 64, 'Rank', '#ffe1d8', '#8d3f2d');
label('ask-detail', 1135, 326, 'Direct mentions first · abstain when evidence is weak\nExtractive response or optional local Ollama generation', { fontSize: 14, color: '#5d675f', lineHeight: 1.45 });

rect('graph-card', 1110, 435, 420, 205, '#f1effa', '#7668a6');
label('graph-kicker', 1135, 456, 'EXPLORE THE GRAPH', { fontSize: 12, color: '#5f528e' });
label('graph-main', 1135, 482, 'Relationships you can drill into', { fontSize: 21 });
label('graph-path', 1135, 526, 'Team  →  Person  →  Work area  →  Project  →  Session', { fontSize: 15, color: '#4e4375' });
label('graph-detail', 1135, 565, '/api/graph overview + /api/graph/node focus\nSVG nodes · drag · pan · zoom · breadcrumbs · conversation viewer', { fontSize: 14, color: '#5d675f', lineHeight: 1.45 });

// Trust plane
rect('trust-plane', 60, 700, 1470, 132, '#17211b', '#17211b');
label('trust-heading', 88, 724, 'TRUST PLANE', { fontSize: 13, color: '#d9ed9a' });
label('trust-title', 88, 750, 'Privacy and correctness are system behavior—not prompt instructions.', { fontSize: 19, color: '#ffffff' });
pill('trust-local', 645, 735, 150, 'Local-first import', '#2b5d47', '#ffffff');
pill('trust-redact', 808, 735, 150, 'Secret redaction', '#2b5d47', '#ffffff');
pill('trust-owner', 971, 735, 160, 'Owner-scoped recall', '#2b5d47', '#ffffff');
pill('trust-admin', 1144, 735, 150, 'Admin-only graph', '#2b5d47', '#ffffff');
pill('trust-abstain', 1307, 735, 190, 'No evidence → no claim', '#d9ed9a', '#174f39');
label('trust-meta', 645, 788, 'Private sessions never become another teammate’s inferred work status.', { fontSize: 13, color: '#c9d5cc' });

// Connectors are placed behind the cards.
arrow('claude-ingest', [[310, 236], [342, 236], [342, 282], [390, 282]], '#376f65');
arrow('codex-ingest', [[310, 356], [342, 356], [342, 282], [390, 282]], '#376f65');
arrow('directory-core', [[310, 476], [690, 476], [690, 419], [750, 419]], '#6d9183', { dashed: true });
arrow('step-1-2', [[515, 314], [515, 335]], '#a98126');
arrow('step-2-3', [[515, 399], [515, 420]], '#a98126');
arrow('step-3-4', [[515, 484], [515, 505]], '#a98126');
arrow('ingest-core', [[640, 537], [692, 537], [692, 419], [750, 419]], '#a98126');
arrow('core-ask', [[1030, 261], [1074, 261], [1074, 292], [1110, 292]], '#174f39');
arrow('core-graph', [[1030, 552], [1074, 552], [1074, 537], [1110, 537]], '#5f528e');

const document = {
  type: 'excalidraw', version: 2, source: 'https://excalidraw.com',
  elements: [...connectors, ...elements],
  appState: { gridSize: 20, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: '#f7f5ee' },
  files: {},
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Generated ${output} with ${document.elements.length} elements`);
