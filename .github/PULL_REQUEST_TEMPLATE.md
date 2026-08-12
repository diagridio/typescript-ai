## What

<!-- What changes, and why. Link the issue if there is one. -->

## Test plan

<!-- How you verified it. Delete rows that don't apply. -->

- [ ] `make ci` passes locally (format, lint, typecheck, build, unit tests)
- [ ] New or changed behaviour is covered by a test
- [ ] Integration lane checked (`make test-integration`) — required when
      touching workflow registration, state, or the Dapr surface
- [ ] Ollama e2e checked — apply the `e2e-ollama` label to run it on this PR

## Adapter checklist

<!-- Only if this PR touches packages/<framework>/. Otherwise delete. -->

- [ ] The framework SDK is a **peer** dependency, not a hard one
- [ ] Dapr types imported from `@diagrid/agent-core`, not `@dapr/dapr`
- [ ] `ADAPTERS` in `tests/guards/cross-framework-imports.test.ts` is up to date
- [ ] `SupportedFrameworks` and `.github/dependabot.yml` updated for a new adapter
- [ ] Unimplemented paths throw or report an error — no plausible-looking fakes
