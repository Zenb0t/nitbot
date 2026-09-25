# Register: app (application logic)

How application code changes fail. Check the ones the diff makes relevant; skip the rest silently.

- **State and ordering:** a value read, then used after an await, callback, or lock release, when something else can change it in between. UI state updated before the request it depends on succeeds.
- **Null and empty:** a new code path that assumes a list is non-empty, a lookup succeeds, or an optional field is present, where some caller or record can violate it.
- **Error paths:** a new call that can throw or return an error, and what the caller sees: swallowed, retried forever, surfaced as a 500 with internals, or leaving partial state behind.
- **Changed defaults:** a parameter default, config fallback, or feature-flag default that silently changes behavior for callers that never pass it.
- **Boundaries:** off-by-one in ranges, slices and pagination; inclusive vs exclusive dates; empty vs missing strings.
- **Duplication of effects:** a handler that can run twice (retry, double submit, redelivered message) and creates, charges, or sends twice.
- **Resource lifetime:** listeners, timers, subscriptions, handles, or connections acquired on a path that can exit early without release.
- **Hot paths:** a query, network call, or O(n) scan newly placed inside a loop or a per-request path.
- **Consistency with siblings:** the map's house example does the same job differently (transactions, logging, error wrapping, auth checks). Name the example.
