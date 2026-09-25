# Register: tests

Judge whether the tests would catch the bug they exist for. Whether tests pass is the evidence script's job.

- **Can it fail?** For each new or changed test, name the smallest bug in the code under test that the test would still pass with. Assertions on mocks only, snapshot-only tests, and tests that assert what the implementation does rather than what it should do are the usual culprits.
- **Coverage of the change:** the evidence report lists changed lines no test executes. For logic changes, say which scenario is missing, concretely.
- **Weakened tests:** assertions removed or loosened, expected values updated to match new output without a reason in the intent, tests skipped or deleted alongside the code they covered.
- **Flakiness:** fixed sleeps, real time or timezone, network, shared global state, order dependence, randomness without a seed.
- **Fixtures:** real credentials or personal data in fixtures; fixtures so large nobody will read them.
