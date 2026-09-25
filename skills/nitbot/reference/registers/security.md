# Register: security (overlay on auth, sessions, crypto, input handling, payments, admin)

This overlays another register. Trace data, not keywords.

- **Authorization, not just authentication:** every new read or write path checks that this user may act on this object (ownership, tenant, role), not only that someone is logged in. Compare with the house example's check.
- **Input to sinks:** follow each externally controlled value (request, headers, files, webhooks, third-party responses, queue messages) to where it is used: SQL, shell, file paths, templates and HTML, redirects, deserialization, regexes, URLs fetched server-side.
- **Secrets and tokens:** generation from a secure random source, constant-time comparison, expiry, rotation, scope; never logged or returned in errors.
- **Crypto:** no home-made crypto, no ECB, no static IVs or nonces, no MD5/SHA-1 for passwords; passwords use a slow KDF.
- **Sessions and cookies:** fixation, missing `HttpOnly`/`Secure`/`SameSite`, logout that does not invalidate server-side state.
- **Webhooks and callbacks:** signature verified before parsing, replay protection, idempotency.
- **Failure modes:** errors that reveal whether a user exists, stack traces to clients, a fail-open default when a policy check errors.
- **Removed checks:** read the removed lines. A deleted guard is the most common security regression in a diff.
