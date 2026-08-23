import { Project, SyntaxKind, Node } from 'ts-morph';
import { TENANT_TABLES } from '../src/database/tenant-tables.js';
import fs from 'fs';
import path from 'path';

const SCOPE_RE = /organization_id|project_id/;
const OK_MARKER = 'tenant-scope-ok';
const QUERY_STARTERS = new Set(['selectFrom', 'updateTable', 'deleteFrom']);

const ALLOWLIST_PATH = path.resolve('scripts/tenant-scope-allowlist.json');

interface AllowEntry {
  file: string;
  table: string;
  snippet: string;
  reason: string;
}

interface Finding {
  file: string;
  line: number;
  table: string;
  scoped: boolean;
  marked: boolean;
  snippet: string;
}

function normalizeSnippet(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function loadAllowlist(): AllowEntry[] {
  if (!fs.existsSync(ALLOWLIST_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8')) as AllowEntry[];
  } catch {
    console.error(`Warning: failed to parse allowlist at ${ALLOWLIST_PATH}`);
    return [];
  }
}

function tableLiteral(call: Node): string | null {
  const args = call.asKind(SyntaxKind.CallExpression)?.getArguments() ?? [];
  const first = args[0];
  if (first && Node.isStringLiteral(first)) {
    // handles "logs" and "logs as l"
    return first.getLiteralValue().split(/\s+as\s+/i)[0].trim();
  }
  return null;
}

// Walk up the fluent chain from the starter call to the full statement expression.
function chainTop(starter: Node): Node {
  let top: Node = starter;
  let cur: Node | undefined = starter;
  while (cur) {
    const parent = cur.getParent();
    if (parent && (Node.isPropertyAccessExpression(parent) || Node.isCallExpression(parent))) {
      top = parent;
      cur = parent;
    } else {
      break;
    }
  }
  return top;
}

function analyze(globs: string[]): Finding[] {
  const project = new Project({ tsConfigFilePath: 'tsconfig.json', skipAddingFilesFromTsConfig: true });
  project.addSourceFilesAtPaths(globs);
  const findings: Finding[] = [];

  for (const sf of project.getSourceFiles()) {
    const fullText = sf.getFullText();
    const lines = fullText.split('\n');

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      if (!QUERY_STARTERS.has(expr.getName())) continue;
      const table = tableLiteral(call);
      if (!table || !TENANT_TABLES.has(table)) continue;

      const top = chainTop(call);
      const text = top.getText();
      const scoped = SCOPE_RE.test(text);
      const line = call.getStartLineNumber();

      const marked = text.includes(OK_MARKER) || (() => {
        const around = [lines[line - 2], lines[line - 1], lines[line]].join('\n');
        return around.includes(OK_MARKER);
      })();

      // snippet: the trimmed line that contains the .selectFrom/.updateTable/.deleteFrom method name.
      // Using the method name node's start line (not the full PropertyAccessExpression start)
      // ensures we get the specific ".selectFrom('table')" line, which is stable and unique
      // even when surrounding variable assignments change.
      const methodNameLine = expr.getNameNode().getStartLineNumber();
      const snippet = normalizeSnippet(lines[methodNameLine - 1] ?? '');

      findings.push({ file: sf.getFilePath(), line, table, scoped, marked, snippet });
    }
  }
  return findings;
}

function makeKey(entry: { file: string; table: string; snippet: string }): string {
  return `${entry.file}|${entry.table}|${normalizeSnippet(entry.snippet)}`;
}

// Normalize file path for allowlist comparison: convert to forward slashes and strip any
// leading absolute prefix so we can match against packages/backend-relative paths.
function normalizeFilePath(filePath: string): string {
  // Convert backslashes to forward slashes
  const fwd = filePath.replace(/\\/g, '/');
  // Strip everything up to and including "packages/backend/" to get a repo-relative path
  const match = fwd.match(/packages\/backend\/(.+)$/);
  if (match) return `packages/backend/${match[1]}`;
  return fwd;
}

function main() {
  const reportMode = process.argv.includes('--report');
  const updateAllowlistMode = process.argv.includes('--update-allowlist');
  const findings = analyze(['src/**/*.ts', '!src/**/*.test.ts', '!src/tests/**']);
  const unscoped = findings.filter((f) => !f.scoped && !f.marked);

  if (reportMode) {
    for (const f of findings) {
      const status = f.scoped ? 'scoped' : f.marked ? 'marked-ok' : 'UNSCOPED';
      console.log(`${status}\t${f.table}\t${f.file}:${f.line}`);
    }
    const violations = unscoped;
    console.log(`\n${findings.length} tenant-table access sites, ${violations.length} unscoped.`);
    return;
  }

  if (updateAllowlistMode) {
    const existingAllowlist = loadAllowlist();
    const existingMap = new Map<string, AllowEntry>();
    for (const entry of existingAllowlist) {
      existingMap.set(makeKey(entry), entry);
    }

    const newEntries: AllowEntry[] = unscoped.map((f) => {
      const normFile = normalizeFilePath(f.file);
      const key = `${normFile}|${f.table}|${normalizeSnippet(f.snippet)}`;
      const existing = existingMap.get(key);
      return {
        file: normFile,
        table: f.table,
        snippet: normalizeSnippet(f.snippet),
        reason: existing?.reason ?? 'REVIEW: classify',
      };
    });

    // Sort for stable diffs: by file, then table, then snippet
    newEntries.sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      if (a.table !== b.table) return a.table.localeCompare(b.table);
      return a.snippet.localeCompare(b.snippet);
    });

    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(newEntries, null, 2) + '\n', 'utf8');
    console.log(`Written ${newEntries.length} entries to ${ALLOWLIST_PATH}`);
    return;
  }

  // Default check mode: violations are unscoped sites not covered by the allowlist.
  // Matching uses a count-based multiset: each allowlist entry covers exactly one finding
  // with the same (file, table, snippet) key. Multiple findings with the same key require
  // that many allowlist entries with that key.
  const allowlist = loadAllowlist();
  // Build a count map: key -> remaining allowable occurrences
  const allowCounts = new Map<string, number>();
  // Also track a sample entry per key for stale-warning display
  const allowSamples = new Map<string, AllowEntry>();
  for (const entry of allowlist) {
    const k = makeKey(entry);
    allowCounts.set(k, (allowCounts.get(k) ?? 0) + 1);
    allowSamples.set(k, entry);
  }

  // Track which keys were actually consumed (for stale detection)
  const consumedKeys = new Set<string>();

  const violations: Finding[] = [];
  for (const f of unscoped) {
    const normFile = normalizeFilePath(f.file);
    const key = `${normFile}|${f.table}|${normalizeSnippet(f.snippet)}`;
    const remaining = allowCounts.get(key) ?? 0;
    if (remaining <= 0) {
      violations.push(f);
    } else {
      allowCounts.set(key, remaining - 1);
      consumedKeys.add(key);
    }
  }

  // Warn about stale allowlist entries (keys that were never matched at all)
  for (const [key, entry] of allowSamples) {
    if (!consumedKeys.has(key)) {
      console.warn(`Warning: stale allowlist entry (no longer found): ${entry.file} | ${entry.table} | ${entry.snippet}`);
    }
  }

  if (violations.length > 0) {
    console.error(`Found ${violations.length} unscoped tenant-table queries not in allowlist:\n`);
    for (const v of violations) console.error(`  ${v.table}  ${v.file}:${v.line}`);
    console.error(`\nAdd an organization_id/project_id filter, annotate with "// ${OK_MARKER}: <reason>",`);
    console.error(`or run "bun run check:tenant-scoping -- --update-allowlist" to baseline (review reasons first).`);
    process.exit(1);
  }
  console.log(`OK: all ${findings.length} tenant-table access sites are scoped or allowlisted.`);
}

main();
