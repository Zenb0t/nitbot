# dismiss / conventions

nitbot's memory is small on purpose, and every entry is something a person agreed to.

| File | Committed | Holds | Read by |
|---|---|---|---|
| `.nitbot/dismissed.json` | yes | false positives, with the evidence | Reviewer, Skeptic |
| `.nitbot/conventions.md` | yes | house rules the team confirmed | Reviewer |
| `.nitbot/reviews/<slug>/*.json` | no | past reviews | synthesis only, never the agents |

## dismiss

`/nitbot dismiss <finding id or description> <reason>`

1. Find the finding in the latest review for this target when an id is given, to get its title and file.
2. The reason must be evidence, not preference: "`validateUser` upstream rejects null (`auth.ts:40`)", "fixture key, not a real credential", "user confirmed this is intended". If the user gave no reason, ask for one line.
3. Run `node <skill-dir>/scripts/nitbot.mjs dismiss --title "<title>" --file <path> --reason "<reason>" --by "<user or 'nitbot, user confirmed'>"`. For a detector rule, pass `--rule <id>` instead of `--title`.
4. For a detector rule that is wrong for a whole file or the whole project, use `nitbot ignore file <glob>` or `nitbot ignore rule <id>` instead, and say which you did.

A dismissal that is really a house rule ("we allow console.log in scripts/") belongs in conventions too; offer to add it.

## conventions

`/nitbot conventions` prints `.nitbot/conventions.md` (or says it does not exist).

Add a convention only when the user states one or confirms one you proposed. Write each as one line: the rule, then where it applies, then why if known. Example:
`- Handlers wrap every write in withTransaction() (src/handlers/**) - partial writes caused the March incident.`

### conventions learn

Proposes conventions from what human reviewers in this repo actually flag. Needs `gh`.

1. `gh api "repos/{owner}/{repo}/pulls/comments?per_page=100&sort=created&direction=desc"` (review comments on merged and open PRs; add `--paginate` only if the user asks for more history).
2. Group the comments by recurring theme. A theme needs at least three comments from at least two PRs.
3. Propose at most eight conventions, each with its count and one example comment link. Do not write anything yet.
4. Ask which to keep. Append only the confirmed ones to `.nitbot/conventions.md`.
