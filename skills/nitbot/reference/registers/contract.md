# Register: contract (public API, exported modules, wire formats)

Code other code depends on. The map lists callers; the question is whether all of them still work.

- **Signature changes:** a renamed, reordered, removed, or newly required parameter; a narrowed accepted type; a widened return type (newly nullable, new union member, new thrown error). Check each caller in the map.
- **Behavior changes behind a stable signature:** same types, different semantics (sorting, rounding, units, timezone, default values, error vs empty result). These break callers silently and deserve P1.
- **Wire compatibility:** for protobuf, GraphQL, OpenAPI, JSON payloads, or events: removed or renamed fields, changed field numbers or types, enum values removed or reordered, required fields added to requests. Old clients and old messages in queues still exist during and after deploy.
- **Versioning:** a breaking change to a published package or API without a version bump, deprecation path, or changelog entry.
- **Exports:** something newly exported that exposes internals, or something removed from an index that consumers import.
- **Error contracts:** error types, codes, or messages that callers match on.
