# Register: docs

Review documentation for truth, not prose style.

- **Accuracy:** commands, flags, config keys, function names, and defaults mentioned in the docs exist and behave as described in the code at this revision. Check the ones this diff touches.
- **Drift:** code in this diff changed a behavior that existing docs still describe the old way. The map's co-change section often points at the doc.
- **Examples:** code samples that would not run: wrong imports, removed APIs, missing setup.
- **Safety:** docs that tell readers to disable a security control, commit a secret, or run an unpinned installer without saying why.
