# Register: deps (dependency manifests)

- **New packages:** does the standard library or an existing dependency already do this? Is the package maintained, widely used, and spelled correctly (typosquats)? Does it run install scripts?
- **Version ranges:** a major version bump without the code changes its changelog requires; a range loose enough to pull a future breaking release.
- **Lockfile:** the manifest changed but the lockfile did not (the detector flags this), or the lockfile changed far more than the manifest explains.
- **Scope:** runtime dependencies that belong in dev dependencies, or the reverse.
- **License:** a new dependency whose license conflicts with how this project is distributed.

Vulnerability databases are the scanners' job (osv-scanner, npm audit, Dependabot). Do not guess CVEs from memory.
