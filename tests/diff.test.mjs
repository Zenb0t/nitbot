import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, fileAsAdded } from '../skills/nitbot/scripts/lib/diff.mjs';

const SAMPLE = `diff --git a/src/app.js b/src/app.js
index 1111111..2222222 100644
--- a/src/app.js
+++ b/src/app.js
@@ -10,4 +10,5 @@ function handler(req) {
   const a = 1;
-  const b = 2;
+  const b = 3;
+  const c = 4;
--- not a header, a removed line starting with dashes
   return a;
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
diff --git a/gone.js b/gone.js
deleted file mode 100644
--- a/gone.js
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/img.png b/img.png
new file mode 100644
Binary files /dev/null and b/img.png differ
`;

test('parses line numbers, hunk context and statuses', () => {
  const [app, renamed, gone, img] = parseDiff(SAMPLE);

  assert.equal(app.path, 'src/app.js');
  assert.deepEqual(app.lines.filter((l) => l.added).map((l) => [l.n, l.text]), [[11, '  const b = 3;'], [12, '  const c = 4;']]);
  assert.equal(app.additions, 2);
  assert.equal(app.deletions, 2, 'a removed line that starts with "--" is content, not a header');
  assert.equal(app.hunks[0].context, 'function handler(req) {');

  assert.equal(renamed.status, 'renamed');
  assert.equal(renamed.oldPath, 'old.txt');
  assert.equal(renamed.path, 'new.txt');

  assert.equal(gone.status, 'deleted');
  assert.equal(gone.path, 'gone.js');

  assert.equal(img.status, 'added');
  assert.equal(img.binary, true);
});

test('fileAsAdded treats every line as new', () => {
  const f = fileAsAdded('a.py', 'x = 1\ny = 2\n');
  assert.equal(f.additions, 2);
  assert.deepEqual(f.lines.map((l) => l.n), [1, 2]);
  assert.equal(f.hunks[0].length, 2);
});

test('a path with a space loses the TAB git appends to its ---/+++ headers', () => {
  const text = 'diff --git a/prod key.pem b/prod key.pem\nnew file mode 100644\n--- /dev/null\n+++ b/prod key.pem\t\n@@ -0,0 +1 @@\n+x\n' +
    'diff --git a/my file.js b/my file.js\n--- a/my file.js\t\n+++ b/my file.js\t\n@@ -1 +1 @@\n-1\n+2\n';
  const [pem, js] = parseDiff(text);
  assert.equal(pem.path, 'prod key.pem');
  assert.equal(js.path, 'my file.js');
  assert.equal(js.oldPath, 'my file.js');
});
