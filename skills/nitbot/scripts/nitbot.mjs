#!/usr/bin/env node
// nitbot CLI. The skill calls this; its stdout is written for the model to
// act on: short, factual, and ending in DIRECTIVES the skill must follow.
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, resolveTarget, git } from './lib/git.mjs';
import { parseDiff } from './lib/diff.mjs';
import { loadConfig, updateConfig, ensureNitbotDir, nitbotDir, readJson } from './lib/config.mjs';
import { detect, summarize, formatFindings } from './lib/detect.mjs';
import { classify, rulebooks } from './lib/registers.mjs';
import { rollLenses } from './lib/lenses.mjs';
import { buildMap, riskScore, formatMap } from './lib/map.mjs';
import { gatherEvidence, formatEvidence } from './lib/evidence.mjs';
import { discoverTools, describeTools, commitFramework } from './lib/toolchain.mjs';
import { saveReview, latestReview, loadDismissed, dismiss, loadConventions } from './lib/memory.mjs';
import { runHook } from './lib/hook.mjs';

const VERSION = '0.1.0';
const [, , command = 'help', ...rest] = process.argv;
const { args, flags } = parseArgs(rest);

const commands = { context, evidence, detect: detectCmd, map: mapCmd, lenses, save, dismiss: dismissCmd, ignore, hooks, hook, version: () => console.log(VERSION), help };

try {
  if (!commands[command]) fail(`Unknown command "${command}". Run: nitbot help`);
  await commands[command]();
} catch (err) {
  fail(err.message);
}

function root() {
  const r = repoRoot();
  if (!r) fail('NOT_A_REPO: nitbot reviews git changes; run it inside a git repository.');
  return r;
}

async function context() {
  const r = root();
  const config = loadConfig(r);
  const target = resolveTarget(r, args[0]);
  const firstRun = ensureNitbotDir(r);
  const state = path.join(nitbotDir(r), 'state');
  const directives = [];

  const { registers, skipped, perFile } = classify(target.files);
  const reviewable = perFile.filter((f) => f.status !== 'deleted');
  const changedLines = reviewable.reduce((s, f) => s + f.additions + f.deletions, 0);
  const hasHead = Boolean(git(r, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true }));
  const map = buildMap(r, target.files.filter((f) => !skipped.includes(f.path)), { registers, hasHead });
  const risk = riskScore({ registers, map, changedLines });
  const requested = flags.mode || (config.review.mode !== 'auto' ? config.review.mode : null);
  const mode = requested || risk.mode;
  const { seed, lenses: rolled } = rollLenses({ count: risk.lenses ?? 2, registers: Object.keys(registers), seed: flags.seed ? Number(flags.seed) : undefined });
  const areas = changedLines > config.review.largeDiffLines ? splitAreas(reviewable, config.review.splitLines) : null;
  // `evidence` reuses these answers instead of probing every binary again.
  const toolProbes = {};
  const tools = await discoverTools(r, { probes: toolProbes });

  fs.writeFileSync(path.join(state, 'current.diff'), target.fnDiffText ?? target.diffText);
  // The plain diff is what `evidence` checks, so both commands see one change set.
  fs.writeFileSync(path.join(state, 'target.diff'), target.diffText);
  fs.writeFileSync(path.join(state, 'intent.md'), target.intent || '(no stated intent)\n');
  fs.writeFileSync(path.join(state, 'map.md'), formatMap(map) + '\n');
  const run = {
    version: VERSION,
    createdAt: new Date().toISOString(),
    targetArg: args[0] ?? null,
    kind: target.kind,
    label: target.label,
    slug: target.slug,
    head: git(r, ['rev-parse', 'HEAD'], { allowFail: true })?.trim() ?? null,
    pr: target.pr ? { number: target.pr.number, url: target.pr.url, headRefOid: target.pr.headRefOid, checkedOut: target.pr.checkedOut } : null,
    files: reviewable,
    skipped,
    registers,
    rulebooks: rulebooks(registers),
    changedLines,
    risk,
    mode,
    lensSeed: seed,
    lenses: rolled,
    areas,
    toolProbes,
  };
  fs.writeFileSync(path.join(state, 'run.json'), JSON.stringify(run, null, 2) + '\n');

  const rel = (f) => `.nitbot/state/${f}`;
  const out = [];
  out.push(`nitbot ${VERSION} context`);
  out.push(`target:   ${target.label}`);
  out.push(`slug:     ${target.slug}`);
  out.push(`diff:     ${rel('current.diff')} (${reviewable.length} files, ${changedLines} changed lines, whole functions shown)${skipped.length ? `; ${skipped.length} generated/lock files skipped` : ''}`);
  out.push(`intent:   ${rel('intent.md')}${target.intent ? '' : ' (empty)'}`);
  out.push(`map:      ${rel('map.md')} (${map.symbols.length} changed symbols, ${map.coChange.length} co-change gaps, ${map.siblings.length} house examples)`);
  out.push(`registers: ${Object.entries(registers).map(([k, v]) => `${k}(${v.length})`).join(' ') || 'none'}`);
  out.push(`rulebooks: ${run.rulebooks.join(', ') || 'none'}`);
  out.push(`risk:     ${risk.level} (score ${risk.score}${risk.reasons.length ? `: ${risk.reasons.join('; ')}` : ''})`);
  out.push(`mode:     ${mode}${requested ? ' (requested)' : ' (from risk)'}`);
  out.push(`lenses:   ${rolled.map((l) => `${l.id} "${l.name}"`).join(', ')} [seed ${seed}]`);
  out.push(`tools:    ${describeTools(tools)}`);

  if (config.invalid.length) directives.push(`CONFIG_INVALID: ${config.invalid.join('; ')}. Its settings and ignores are NOT applied. Tell the user so they can fix the file.`);
  if (firstRun) directives.push('FIRST_RUN: created .nitbot/ (with its own .gitignore). Mention it once in the report.');
  if (!reviewable.length) directives.push('NOTHING_TO_REVIEW: the target has no reviewable changes. Tell the user and stop; do not spawn agents.');
  if (Object.keys(registers).every((k) => k === 'docs')) directives.push('DOCS_ONLY: run quick mode and review for accuracy against the code, not style.');
  if (areas) directives.push(`LARGE_DIFF: ${changedLines} lines. Spawn one Reviewer per area (same lenses), each told to review only its files: ${areas.map((a, i) => `A${i + 1}=${a.label} (${a.lines} lines)`).join('; ')}. Area file lists are in run.json.`);
  if (target.pr && !target.pr.checkedOut) directives.push(`PR_NOT_CHECKED_OUT: the working tree is not the PR head. Agents must read PR files with \`git show ${target.pr.headRefOid}:<path>\`, never from disk.`);
  if (!target.intent) directives.push('INTENT_MISSING: no PR body or commit messages. If this session wrote the change, write the user\'s original request into .nitbot/state/intent.md before spawning agents; otherwise continue and review for correctness only.');

  const previous = latestReview(r, target.slug);
  const open = previous?.findings?.filter((f) => f.status === 'open') ?? [];
  if (open.length) directives.push(`PREVIOUS_REVIEW: ${open.length} open finding(s) from ${previous.savedAt?.slice(0, 10)}. Do NOT give them to the agents. In synthesis, check each against the new diff and report fixed / still open.`);
  const dismissed = loadDismissed(r);
  if (dismissed.length) directives.push(`DISMISSED: ${dismissed.length} entries in .nitbot/dismissed.json. Pass the path to the Reviewer and Skeptic; matching findings are dropped.`);
  if (loadConventions(r)) directives.push('CONVENTIONS: pass .nitbot/conventions.md to the Reviewer.');

  out.push('');
  out.push('DIRECTIVES:');
  out.push(...(directives.length ? directives.map((d) => `- ${d}`) : ['- none']));
  console.log(out.join('\n'));
}

async function evidence() {
  const r = root();
  const config = loadConfig(r);
  const state = path.join(nitbotDir(r), 'state');
  const run = readJson(path.join(state, 'run.json'), null);
  const diffFile = path.join(state, 'target.diff');
  if (!run || !fs.existsSync(diffFile)) fail('NO_RUN: run `nitbot context` first.');
  // Never resolve the target again: a commit, a stage, or nitbot's own files
  // appearing since `context` would make the evidence describe another change.
  const target = { label: run.label, files: parseDiff(fs.readFileSync(diffFile, 'utf8')), pr: run.pr };
  const ev = await gatherEvidence(r, target, {
    config,
    runTests: flags['no-tests'] ? false : config.evidence.runTests,
    toolTimeout: config.evidence.toolTimeoutSec * 1000,
    testTimeout: config.evidence.testTimeoutSec * 1000,
    probes: run.toolProbes,
  });
  const head = git(r, ['rev-parse', 'HEAD'], { allowFail: true })?.trim() ?? null;
  if (head !== run.head) ev.warning = 'HEAD moved since `nitbot context`: tools and tests ran on the current tree, which may not match the reviewed diff.';
  const text = formatEvidence(ev);
  fs.writeFileSync(path.join(state, 'evidence.json'), JSON.stringify(ev, null, 2) + '\n');
  fs.writeFileSync(path.join(state, 'evidence.txt'), text + '\n');
  if (flags.print) console.log(text);
  // Deliberately contentless: the parent must not see evidence before the
  // Reviewer has returned. It reads evidence.txt at synthesis time.
  else console.log(`evidence written: .nitbot/state/evidence.txt (${text.split('\n').length} lines). Read it only after the Reviewer returns.`);
}

async function detectCmd() {
  const r = root();
  const config = flags['no-config'] ? { detector: { ignoreRules: [], ignoreFiles: [] } } : loadConfig(r);
  const target = resolveTarget(r, args[0]);
  const tiers = flags.tier && flags.tier !== 'all' ? [flags.tier] : ['immediate', 'deferred'];
  const findings = detect(target.files, { config, tiers, exists: (p) => fs.existsSync(path.join(r, p)) });
  if (flags.json) console.log(JSON.stringify({ target: target.label, summary: summarize(findings), findings }, null, 2));
  else console.log(findings.length ? `${target.label}\n${formatFindings(findings)}` : `${target.label}: clean`);
  process.exitCode = findings.length ? 2 : 0;
}

async function mapCmd() {
  const r = root();
  const target = resolveTarget(r, args[0]);
  const { registers } = classify(target.files);
  console.log(formatMap(buildMap(r, target.files, { registers })) || 'nothing to map');
}

async function lenses() {
  const registers = flags.registers ? String(flags.registers).split(',') : [];
  const exclude = flags.exclude ? String(flags.exclude).split(',') : [];
  console.log(JSON.stringify(rollLenses({ count: Number(flags.count ?? 2), registers, exclude, seed: flags.seed ? Number(flags.seed) : undefined }), null, 2));
}

async function save() {
  const r = root();
  if (!args[0]) fail('usage: nitbot save <review.json>');
  const run = readJson(path.join(nitbotDir(r), 'state', 'run.json'), null);
  if (!run) fail('NO_RUN: run `nitbot context` first.');
  let review;
  try {
    review = JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf8'));
  } catch (err) {
    fail(`INVALID_JSON: ${err.message}. Fix the file and run save again.`);
  }
  const res = saveReview(r, run.slug, { target: run.label, head: run.head, lensSeed: run.lensSeed, ...review });
  if (!res.ok) fail(`REVIEW_REJECTED, fix these and run save again:\n${res.errors.map((e) => `- ${e}`).join('\n')}`);
  console.log(`saved ${res.file}`);
}

async function dismissCmd() {
  const r = root();
  const entry = dismiss(r, { title: flags.title, file: flags.file, rule: flags.rule, reason: flags.reason, by: flags.by });
  console.log(`dismissed ${entry.id}: ${entry.title ?? entry.rule}${entry.file ? ` in ${entry.file}` : ''} (${entry.reason}). Committed file: .nitbot/dismissed.json`);
}

async function ignore() {
  const r = root();
  const [kind, value] = args;
  const key = { rule: 'ignoreRules', file: 'ignoreFiles' }[kind];
  if (!key || !value) fail('usage: nitbot ignore <rule|file> <id|glob> [--local]');
  const file = updateConfig(r, (c) => {
    c.detector ??= {};
    c.detector[key] = [...new Set([...(c.detector[key] ?? []), value])];
  }, { local: Boolean(flags.local) });
  console.log(`added ${value} to detector.${key} in ${path.relative(r, file)}`);
}

async function hooks() {
  const r = root();
  const [action = 'status', value] = args;
  const set = (key, v) => updateConfig(r, (c) => {
    c.hook ??= {};
    c.hook[key] = v;
  });
  if (action === 'on') set('enabled', true);
  else if (action === 'off') set('enabled', false);
  else if (action === 'stop-pass') set('stopPass', value === 'on');
  else if (action === 'commit-gate') set('commitGate', value === 'auto' ? 'auto' : value === 'on');
  else if (action !== 'status') fail('usage: nitbot hooks [status|on|off|stop-pass on|off|commit-gate on|off|auto]');
  const c = loadConfig(r);
  const framework = commitFramework(r);
  const gate = c.hook.commitGate === 'auto' ? (framework ? `auto: deferring to ${framework}` : 'auto: active') : c.hook.commitGate ? 'on' : 'off';
  console.log([
    `hooks:        ${c.hook.enabled ? 'enabled' : 'disabled'}${process.env.NITBOT_HOOK_DISABLED === '1' ? ' (NITBOT_HOOK_DISABLED=1 overrides)' : ''}`,
    `edit check:   ${c.hook.editCheck ? 'on' : 'off'} (immediate tier after each edit)`,
    `commit gate:  ${gate}`,
    `stop pass:    ${c.hook.stopPass ? 'on' : 'off'} (deferred tier once per session)`,
    `ignored rules: ${c.detector.ignoreRules.join(', ') || 'none'}`,
    `ignored files: ${c.detector.ignoreFiles.join(', ') || 'none'}`,
    ...c.invalid.map((e) => `INVALID (not applied): ${e}`),
  ].join('\n'));
}

async function hook() {
  const input = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
  let payload = {};
  try {
    payload = JSON.parse(input || '{}');
  } catch {
    return;
  }
  const result = runHook(args[0], payload);
  if (result) console.log(JSON.stringify(result));
}

function help() {
  console.log(`nitbot ${VERSION}
  context [target] [--mode quick|full] [--seed N]   resolve target, write diff/map/intent, print directives
  evidence [--no-tests] [--print]                   run project tools on the current run (writes .nitbot/state/evidence.*)
  detect [target] [--tier immediate|deferred|all] [--json] [--no-config]
  map [target]                                      print the change map
  lenses [--count N] [--registers a,b] [--seed N]   roll review lenses
  save <review.json>                                validate and archive a review
  dismiss --title T --reason R [--file F] [--rule id] [--by who]
  ignore <rule|file> <id|glob> [--local]
  hooks [status|on|off|stop-pass on|off|commit-gate on|off|auto]
  hook <post-edit|pre-bash|stop>                    (called by Claude Code hooks; reads JSON on stdin)
targets: nothing (auto) | staged | <PR number or URL> | <branch> | <commit> | a..b | <path>`);
}

// Packs files into review areas of ~splitLines, keeping each directory
// together when it fits so a reviewer sees related files side by side.
function splitAreas(files, splitLines) {
  const dirs = new Map();
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
    const g = dirs.get(dir) ?? { label: dir, files: [], lines: 0 };
    g.files.push(f.path);
    g.lines += f.additions + f.deletions;
    dirs.set(dir, g);
  }
  // A directory bigger than one area is split file by file.
  const units = [...dirs.values()].flatMap((g) =>
    g.lines <= splitLines ? [g] : files.filter((f) => g.files.includes(f.path)).map((f) => ({ label: f.path, files: [f.path], lines: f.additions + f.deletions })),
  );
  const areas = [];
  for (const u of units.sort((a, b) => b.lines - a.lines)) {
    const fit = areas.find((a) => a.lines + u.lines <= splitLines);
    if (fit) {
      fit.label += ` + ${u.label}`;
      fit.files.push(...u.files);
      fit.lines += u.lines;
    } else areas.push({ label: u.label, files: [...u.files], lines: u.lines });
  }
  return areas;
}

function parseArgs(list) {
  const BOOLEAN = new Set(['json', 'print', 'local', 'no-tests', 'no-config']);
  const out = { args: [], flags: {} };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) {
      out.args.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (v !== undefined) out.flags[k] = v;
    else if (!BOOLEAN.has(k) && list[i + 1] && !list[i + 1].startsWith('--')) out.flags[k] = list[++i];
    else out.flags[k] = true;
  }
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
