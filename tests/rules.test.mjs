import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect } from '../skills/nitbot/scripts/lib/detect.mjs';
import { fileAsAdded, parseDiff } from '../skills/nitbot/scripts/lib/diff.mjs';

const run = (path, content, opts = {}) => detect([fileAsAdded(path, content)], { config: { detector: { ignoreRules: [], ignoreFiles: [] } }, ...opts });
const rules = (findings) => findings.map((f) => f.rule);

// Built by concatenation so this file never contains a literal token.
const AWS = 'AKIA' + 'Q'.repeat(16);

test('immediate tier catches the catastrophic basics', () => {
  assert.deepEqual(rules(run('a.js', '<<<<<<< HEAD\n')), ['conflict-marker']);
  assert.deepEqual(rules(run('a.js', `const k = "${AWS}";\n`)), ['cloud-token']);
  assert.deepEqual(rules(run('k.txt', '-----BEGIN RSA ' + 'PRIVATE KEY-----\n')), ['private-key']);
  assert.deepEqual(rules(run('a.test.ts', "it.only('x', () => {});\n")), ['focused-test']);
  assert.deepEqual(rules(run('a.js', '  debugger;\n')), ['debugger']);
  assert.deepEqual(rules(run('a.py', 'breakpoint()\n')), ['debugger']);
  assert.deepEqual(rules(run('a.js', 'https.request({ rejectUnauthorized: false });\n')), ['tls-disabled']);
  assert.deepEqual(rules(run('.env', 'X=1\n')), ['secret-file']);
});

test('near misses stay quiet', () => {
  assert.deepEqual(run('a.js', 'const example = "AKIAIOSFODNN7EXAMPLE";\n'), []);
  assert.deepEqual(run('a.js', 'const debuggerEnabled = true;\n'), []);
  assert.deepEqual(run('.env.example', 'X=\n'), []);
  assert.deepEqual(run('README.md', 'Use it.only when debugging.\n'), [], 'focused-test is JS-only');
  assert.deepEqual(run('a.js', '// ======= section =======\n'), []);
});

test('deferred tier: swallowed errors, suppressions, skips, sleeps', () => {
  assert.deepEqual(rules(run('a.ts', 'try { go() } catch (e) {}\n')), ['swallowed-error']);
  assert.deepEqual(rules(run('a.py', 'try:\n    go()\nexcept Exception:\n    pass\n')), ['swallowed-error']);
  assert.deepEqual(rules(run('a.ts', '// @ts-ignore\n')), ['new-suppression']);
  assert.deepEqual(run('a.ts', '// eslint-disable-line no-console -- CLI output\n'), [], 'a suppression with a reason is fine');
  assert.deepEqual(rules(run('a.test.js', "it.skip('x', () => {});\n")), ['skipped-test']);
  assert.deepEqual(rules(run('tests/a.test.js', 'await sleep(500);\n')), ['sleep-in-test']);
  assert.deepEqual(run('src/a.js', 'await sleep(500);\n'), [], 'sleep outside tests is not flagged');
});

test('code quoted inside strings does not trip code-shape rules; secrets in strings still do', () => {
  assert.deepEqual(run('gen.test.js', `write("it.only('x', () => {});");\n`), []);
  assert.deepEqual(run('gen.ts', "const src = 'try { go() } catch (e) {}';\n"), []);
  assert.deepEqual(run('gen.ts', 'const note = "// @ts-ignore";\n'), []);
  assert.deepEqual(rules(run('a.js', `fetch(url, { headers: { key: "${AWS}" } });\n`)), ['cloud-token']);
});

test('tiers filter', () => {
  const content = '<<<<<<< HEAD\n// @ts-ignore\n';
  assert.deepEqual(rules(run('a.ts', content, { tiers: ['immediate'] })), ['conflict-marker']);
  assert.deepEqual(rules(run('a.ts', content, { tiers: ['deferred'] })), ['new-suppression']);
});

test('inline suppression and config ignores', () => {
  assert.deepEqual(run('a.js', `const k = "${AWS}"; // nitbot-ignore: cloud-token\n`), []);
  assert.deepEqual(run('a.js', `// nitbot-ignore-next-line: cloud-token\nconst k = "${AWS}";\n`), []);
  assert.deepEqual(rules(run('a.js', `const k = "${AWS}"; // nitbot-ignore: debugger\n`)), ['cloud-token'], 'suppressing another rule does not hide this one');
  const config = { detector: { ignoreRules: [], ignoreFiles: ['fixtures/**'] } };
  assert.deepEqual(detect([fileAsAdded('fixtures/keys.js', `"${AWS}"\n`)], { config }), []);
  const byRule = { detector: { ignoreRules: ['cloud-token'], ignoreFiles: [] } };
  assert.deepEqual(detect([fileAsAdded('a.js', `"${AWS}"\n`)], { config: byRule }), []);
});

test('secrets never appear in excerpts', () => {
  const [f] = run('a.js', `const k = "${AWS}";\n`);
  assert.ok(!f.excerpt.includes(AWS));
  assert.match(f.excerpt, /\[redacted\]/);
});

test('lockfile drift needs a pin change and an untouched lockfile', () => {
  const pkg = fileAsAdded('package.json', '{\n  "dependencies": {\n    "left-pad": "^1.3.0"\n  }\n}\n');
  pkg.status = 'modified';
  const exists = (p) => p === 'package-lock.json';
  assert.deepEqual(rules(detect([pkg], { exists })), ['lockfile-drift']);
  assert.deepEqual(detect([pkg, fileAsAdded('package-lock.json', '{}\n')], { exists }), []);
});

test('an added key file with a space in its name is still a secret file', () => {
  const text = 'diff --git a/prod key.pem b/prod key.pem\nnew file mode 100644\n--- /dev/null\n+++ b/prod key.pem\t\n@@ -0,0 +1 @@\n+x\n';
  assert.deepEqual(rules(detect(parseDiff(text))), ['secret-file']);
});

test('tls-disabled fires on config and code, not on prose or comments about it', () => {
  assert.deepEqual(rules(run('a.py', 'requests.get(url, verify=False)\n')), ['tls-disabled']);
  assert.deepEqual(rules(run('a.js', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';\n")), ['tls-disabled']);
  assert.deepEqual(rules(run('Dockerfile', 'ENV NODE_TLS_REJECT_UNAUTHORIZED=0\n')), ['tls-disabled']);
  assert.deepEqual(rules(run('ci.yml', 'env:\n  NODE_TLS_REJECT_UNAUTHORIZED: "0"\n')), ['tls-disabled']);

  assert.deepEqual(run('SECURITY.md', 'Set rejectUnauthorized: false only in dev.\n'), []);
  assert.deepEqual(run('CHANGELOG.txt', 'Removed verify=False from the client.\n'), []);
  assert.deepEqual(run('a.js', '// never set rejectUnauthorized: false here\n'), []);
  assert.deepEqual(run('a.py', '# verify=False breaks auditing\n'), []);
  assert.deepEqual(run('a.js', "if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') warn();\n"), [], 'a check is not a disable');
});
