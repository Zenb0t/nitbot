// What nitbot remembers between runs.
//   reviews/<slug>/<stamp>.json  archive (gitignored). Read by synthesis to say
//                                what was fixed since last time; never shown
//                                to the blind agents, so it cannot anchor them.
//   dismissed.json               false positives with reasons (committed).
//   conventions.md               house rules the team confirmed (committed).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nitbotDir, ensureNitbotDir, readJson } from './config.mjs';

const SEVERITIES = ['P0', 'P1', 'P2', 'nit'];
const VERDICTS = ['ship', 'ship-with-fixes', 'do-not-ship'];
const STATUSES = ['open', 'fixed', 'dismissed'];

export function validateReview(r) {
  const errors = [];
  if (!r || typeof r !== 'object') return ['review must be a JSON object'];
  if (!VERDICTS.includes(r.verdict)) errors.push(`verdict must be one of ${VERDICTS.join(', ')}`);
  if (!['dual', 'degraded', 'quick'].includes(r.method)) errors.push('method must be "dual", "quick" or "degraded"');
  if (!Array.isArray(r.gates)) errors.push('gates must be an array like ["G1:ok", "G5:skipped:<reason>"]');
  if (!Array.isArray(r.findings)) errors.push('findings must be an array');
  (r.findings ?? []).forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!f.id) errors.push(`${at}.id is required`);
    if (!SEVERITIES.includes(f.severity)) errors.push(`${at}.severity must be one of ${SEVERITIES.join(', ')}`);
    if (!f.title) errors.push(`${at}.title is required`);
    if (!f.file) errors.push(`${at}.file is required`);
    if (!f.scenario) errors.push(`${at}.scenario is required: the concrete input or state that produces the wrong result`);
    if (f.status && !STATUSES.includes(f.status)) errors.push(`${at}.status must be one of ${STATUSES.join(', ')}`);
  });
  return errors;
}

export function saveReview(root, slug, review) {
  const errors = validateReview(review);
  if (errors.length) return { ok: false, errors };
  ensureNitbotDir(root);
  const dir = path.join(nitbotDir(root), 'reviews', slug);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}.json`);
  const findings = review.findings.map((f) => ({ status: 'open', ...f, fingerprint: fingerprint(f) }));
  fs.writeFileSync(file, JSON.stringify({ ...review, slug, savedAt: new Date().toISOString(), findings }, null, 2) + '\n');
  return { ok: true, file: path.relative(root, file).split(path.sep).join('/') };
}

export function latestReview(root, slug) {
  const dir = path.join(nitbotDir(root), 'reviews', slug);
  if (!fs.existsSync(dir)) return null;
  const latest = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().pop();
  return latest ? readJson(path.join(dir, latest), null) : null;
}

export function loadDismissed(root) {
  return readJson(path.join(nitbotDir(root), 'dismissed.json'), []);
}

export function dismiss(root, { title, file, rule, reason, by }) {
  if (!title && !rule) throw new Error('dismiss needs --title or --rule');
  if (!reason) throw new Error('dismiss needs --reason: the evidence that makes this a false positive');
  ensureNitbotDir(root);
  const list = loadDismissed(root);
  const entry = { id: `D${list.length + 1}`, title: title ?? null, rule: rule ?? null, file: file ?? null, reason, by: by ?? 'unknown', date: new Date().toISOString().slice(0, 10) };
  list.push(entry);
  fs.writeFileSync(path.join(nitbotDir(root), 'dismissed.json'), JSON.stringify(list, null, 2) + '\n');
  return entry;
}

export function loadConventions(root) {
  try {
    return fs.readFileSync(path.join(nitbotDir(root), 'conventions.md'), 'utf8').trim();
  } catch {
    return '';
  }
}

function fingerprint(f) {
  return createHash('sha1').update(`${f.file}\0${f.title}`.toLowerCase()).digest('hex').slice(0, 10);
}
