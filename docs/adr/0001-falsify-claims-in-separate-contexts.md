# Falsify every claim in a separate context; split work by deterministic vs judgment

Status: accepted · Discussed in [#21](https://github.com/Zenb0t/nitbot/issues/21)

## Context

A proposed framing of AI-assisted development splits it into Understand → Model → Bound → Prove → Falsify → Assess → Stop, with "verification gathers positive evidence, review attempts to falsify it" as the core asymmetry. nitbot already has a component for each stage (see [CONTEXT.md](../../CONTEXT.md)), so the question is which principles the framing should fix in place, not what to build.

## Decision

1. **The axis that routes work is deterministic vs judgment, not positive vs negative.** Anything a tool can decide is decided by the project's tools and reported as a tool fact, without a Skeptic. Models judge only what tools cannot. A passing test is weak evidence and a failing one is decisive, so most deterministic evidence is falsifying evidence; calling it "proof" would overstate it.
2. **Falsification is recursive.** Every step that produces claims gets a step, in a separate context, that tries to refute them: the Reviewer falsifies the change, and the Skeptic falsifies the Reviewer's findings. A future step that produces claims (for example, patches from `fix`) needs its own falsifier.
3. **Risk is assessed twice.** Before review, `riskScore` in `scripts/lib/map.mjs` decides how much falsification to buy (mode and lenses). After review, surviving severities decide the ship verdict. Both are script rules, not model estimates.
4. **Stop is a human decision, informed by a rule that can be run.** The ship verdict is derived from severities, and the user decides. Nothing in the system checks Intent against what the user actually needed; that stays with the human.
5. **The loop's stage names are vocabulary, not prompt text.** Agent briefs keep concrete instructions ("the concrete input or state, at `file:line`, that produces a wrong result"), which steer weak models better than abstract directives.

## Considered and rejected

- **A probabilistic stop criterion** ("stop when residual risk < ε"). Residual risk can't be computed, so the rule can't be executed or audited.
- **Abstract directives in agent prompts** ("adversarial disjunction", "entropy thresholds"). They give a model room to perform rigor rather than do it, which goes against designing for the weakest model.

## Consequences

- Evals ablate by stage (Bound: change map; Falsify: Skeptic; evidence-after-judgment), and each component stays only if it earns its tokens ([evals/README.md](../../evals/README.md)).
- Context isolation removes session priors but not model priors: the Reviewer and the Skeptic currently share a model (`model: inherit`). Whether falsifying with a different model improves precision is an open eval question, tracked in #21.
