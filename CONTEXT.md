# nitbot

nitbot reviews a code change by treating it as a hypothesis and trying to falsify it: deterministic tools first, then model judgment in separate contexts, then a human decision.

## The review loop

`Understand → Model → Bound → Prove → Falsify → Assess → Stop → Learn`

| Stage | Question | Where nitbot does it |
|---|---|---|
| Understand | What outcome is intended? | **Intent**, read as claims; the Reviewer's spec check |
| Model | What did the change construct? | The **Change** itself; `explain` makes it readable |
| Bound | What does it affect, and how much review does it deserve? | **Change map**, **Registers**, **Risk score** |
| Prove | What evidence bears on it? | **Evidence** from the project's own tools |
| Falsify | What would make it wrong? | **Reviewer**, then **Skeptic** |
| Assess | Does what survives matter? | Severity, caps, **Ship verdict** |
| Stop | Is it good enough to ship? | The question to the user; a human decides |
| Learn | What should the next run know? | **Dismissals**, **Conventions** |

The stages are a vocabulary, not a prompt. Agent briefs stay concrete (see [ADR-0001](docs/adr/0001-falsify-claims-in-separate-contexts.md)).

## Language

**Change**:
The diff under review, with whole changed functions as context. It is a hypothesis that the code does what the **Intent** says, never a fact to explain.
_Avoid_: patch, solution

**Intent**:
What the change claims to do, from the PR body, commit messages, or the user's request. Every sentence is a claim to verify, never an explanation to accept.
_Avoid_: description, spec (except in "spec check")

**Change map**:
The **Change**'s blast radius: changed symbols and their callers, files that usually change together but did not, bug-fix history, house examples.
_Avoid_: context, impact analysis

**Register**:
A category of changed file (app, contract, data, deps, docs, infra, security, tests), each with a rulebook of how that kind of change fails.

**Risk score**:
A script-computed prior on how likely the **Change** is to be wrong. It picks the **Mode** and the number of **Lenses** before any model reads the change.

**Mode**:
How much falsification a review buys: quick (**Evidence** and one **Reviewer**) or full (adds the **Skeptic**, and more **Lenses** at high risk).

**Lens**:
One angle of review, rolled by a seeded script and weighted by what the **Change** touches, so reviews diverge instead of repeating a checklist.

**Evidence**:
Output of the project's own linters, type checker, tests, scanners, and CI, filtered to changed lines. It splits into **Tool facts** and **Judgment items**.
_Avoid_: proof, verification

**Tool fact**:
A deterministic result on a changed line (a lint error, a failing test, a failed CI check). It is reported as-is, with no **Skeptic** needed, because a counterexample from a tool is already decisive.

**Judgment item**:
Evidence that needs a model to decide whether it matters (a deferred detector hit, an uncovered changed line). It joins the **Candidates**.

**Finding**:
A claim that the **Change** is wrong, with a failure scenario: the concrete input or state, at `file:line`, that produces a wrong result. No scenario means no finding; it becomes a **Question**.
_Avoid_: comment, issue, suggestion

**Candidate**:
A **Finding** or **Judgment item** waiting for the **Skeptic**. It carries the claim only, never its author's reasoning or confidence.

**Question**:
Something the review could not verify, phrased so the author can answer in one line.

**Reviewer**:
The sub-agent that tries to falsify the **Change**. It is blind: it has none of the session's context, and it sees **Evidence** only after it has returned.

**Skeptic**:
The sub-agent that tries to falsify the **Reviewer**'s **Candidates**. It rules each one CONFIRMED, PLAUSIBLE, REFUTED, or UNDECIDED.

**Ship verdict**:
The review's decision: `ship`, `ship-with-fixes`, or `do-not-ship`, derived mechanically from the severities that survive the **Skeptic**.

**Degraded run**:
A review where the **Reviewer** or **Skeptic** ran in the same context as the session. It is always labelled, never silent.

**Dismissal**:
A recorded false positive, with the reason, so it is never raised again.

**Convention**:
A confirmed house rule fed to the agents.

## Relationships

- A **Change** is judged against its **Intent**, within the bounds of its **Change map**.
- The **Risk score** chooses the **Mode**; the **Mode** decides whether a **Skeptic** runs.
- **Evidence** yields **Tool facts** (reported directly) and **Judgment items** (added to the **Candidates**).
- The **Reviewer** falsifies the **Change** and produces **Findings**; the **Skeptic** falsifies the **Findings**.
- Surviving **Findings** decide the **Ship verdict**; the user decides whether to ship.
- **Dismissals** and **Conventions** feed the next run's **Reviewer**. The **Skeptic** never sees them, so it judges each **Candidate** on the code alone.

## Flagged ambiguities

- "Verdict" names two things: the **Skeptic**'s ruling on a **Candidate** (CONFIRMED, REFUTED, …) and the review's **Ship verdict**. Say "Skeptic verdict" or "Ship verdict" when both are in play.
- "Prove" in the review loop means gathering **Evidence**, not proving correctness. A passing test corroborates; a failing one refutes.
