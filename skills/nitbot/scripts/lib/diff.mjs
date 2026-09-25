// Unified-diff parser. Produces one entry per file with the new-side lines of
// every hunk (context + added, in order) so rules can look at neighbours, plus
// the removed lines so reviewers can ask what a deleted line used to guarantee.

export function parseDiff(text) {
  const files = [];
  let file = null;
  let inHeader = false;
  let newLine = 0;
  let oldLine = 0;

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (line.startsWith('diff --git ')) {
      file = newFile();
      files.push(file);
      inHeader = true;
      const m = line.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
      if (m) {
        file.oldPath = unquote(m[1]);
        file.path = unquote(m[2]);
      }
      continue;
    }
    if (!file) continue;

    if (line.startsWith('@@')) {
      inHeader = false;
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
        // git names the enclosing function after the second @@ (funcname).
        file.hunks.push({ start: newLine, length: m[3] === undefined ? 1 : Number(m[3]), context: m[4].trim() });
      }
      continue;
    }

    // Before the first hunk, "--- " and "+++ " are headers; inside a hunk they
    // are content (a removed line that itself started with "--").
    if (inHeader) {
      parseHeader(file, line);
      continue;
    }

    if (line.startsWith('+')) {
      file.lines.push({ n: newLine++, text: line.slice(1), added: true });
      file.additions++;
    } else if (line.startsWith('-')) {
      file.removed.push({ n: oldLine++, text: line.slice(1) });
      file.deletions++;
    } else if (line.startsWith(' ')) {
      file.lines.push({ n: newLine++, text: line.slice(1), added: false });
      oldLine++;
    }
    // "\ No newline at end of file" falls through.
  }

  for (const f of files) {
    if (!f.path) f.path = f.oldPath;
  }
  return files;
}

// A whole file that has no diff yet (untracked): every line is an addition.
export function fileAsAdded(path, content) {
  const file = newFile();
  const lines = content.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  file.path = path;
  file.status = 'added';
  file.binary = content.includes('\u0000');
  file.lines = lines.map((text, i) => ({ n: i + 1, text, added: true }));
  file.additions = lines.length;
  file.hunks = lines.length ? [{ start: 1, length: lines.length, context: '' }] : [];
  return file;
}

function newFile() {
  return {
    path: null,
    oldPath: null,
    status: 'modified',
    binary: false,
    lines: [], // { n, text, added } on the new side
    removed: [], // { n, text } on the old side
    hunks: [], // { start, length, context } new-side ranges
    additions: 0,
    deletions: 0,
  };
}

function parseHeader(file, line) {
  if (line.startsWith('new file mode')) file.status = 'added';
  else if (line.startsWith('deleted file mode')) file.status = 'deleted';
  else if (line.startsWith('rename from ')) {
    file.status = 'renamed';
    file.oldPath = unquote(line.slice('rename from '.length));
  } else if (line.startsWith('rename to ')) file.path = unquote(line.slice('rename to '.length));
  else if (line.startsWith('Binary files ')) file.binary = true;
  else if (line.startsWith('--- ') && line !== '--- /dev/null') file.oldPath = stripPrefix(unquote(line.slice(4)), 'a/');
  else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = stripPrefix(unquote(line.slice(4)), 'b/');
}

function stripPrefix(p, prefix) {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

// git quotes paths containing unusual characters: "a/dir/na\"me".
function unquote(p) {
  if (!(p.startsWith('"') && p.endsWith('"'))) return p;
  return p.slice(1, -1).replace(/\\(["\\])/g, '$1');
}
