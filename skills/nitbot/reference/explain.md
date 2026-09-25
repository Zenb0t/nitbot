# explain

Write a guide that makes a human reviewer faster. This is not a review: no findings, no verdict, no sub-agents. It costs one pass over the map and the diff.

## Flow

1. Setup has run `nitbot context`. Read `.nitbot/state/run.json`, `intent.md`, and `map.md`. Read `current.diff` only as far as needed to describe what each part does.
2. Write the guide in chat:

```
<Target label> · <N files, M changed lines> · risk <level>

What it claims to do
<2-3 sentences from intent.md; "no stated intent" if empty>

What it actually changes
- <area or file group>: <one line each, behavior not mechanics>

Where to look hardest
- <file:line or symbol>: <why: callers affected, security register, bug-fix history, co-change gap>
(3-5 items, ordered by risk, each backed by something in the map)

Suggested reading order
1. <file> (<why first>)
...

Not in this diff, but maybe should be
- <co-change partners from the map, with their percentages>
```

3. Offer, as the last line, to run `/nitbot review` on the same target.

Keep it under about 40 lines. Every "look hardest" item must point at something concrete in the map or the diff, not at general advice.
