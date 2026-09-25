# Register: infra (CI, containers, deploy, config)

Mistakes here fail in environments nobody runs locally.

- **Secrets:** credentials in workflow files, Dockerfiles, compose files, or build args; secrets printed to logs; secrets exposed to workflows triggered from forks (`pull_request_target` with a checkout of the PR head).
- **CI permissions:** `permissions:` broader than needed; third-party actions pinned to a tag or branch instead of a commit SHA.
- **Reproducibility:** unpinned base images (`:latest`), unpinned tool versions, `curl | sh` installers.
- **Container safety:** running as root without need, secrets or `.git` copied into images, missing `.dockerignore` for large or sensitive paths.
- **Config drift:** a new required env var with no default and no entry in every environment's config; a default that differs between environments.
- **Health and rollback:** changed ports, health checks, or readiness probes that no longer match the app; a deploy step with no way back.
- **Blast radius:** a change applied to every environment at once where the rest of the config stages rollouts.
