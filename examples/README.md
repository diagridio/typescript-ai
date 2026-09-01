# Examples

Runnable code samples for the Diagrid TypeScript AI adapters. Clone the repo,
install once from the root, and run any script directly.

```bash
pnpm install
```

| Framework                   | Directory                                         | What's inside                                         |
| --------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| [Mastra](https://mastra.ai) | [`mastra/`](mastra/) — [README](mastra/README.md) | Agent inspection, simple agent, crash recovery, retry |

Adding an adapter? Add an `examples/<framework>/` directory alongside it. The
examples are pnpm workspace members and are type-checked by `pnpm typecheck`, so
they cannot drift from the adapter API without breaking the build.

## Two ways to run

Every example works on both paths, and reports which one it detected:

|                 | Local Dapr                                                          | Diagrid Catalyst                                                                                            |
| --------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Command         | `dapr run --app-id X --resources-path ./resources -- pnpm <script>` | `diagrid dev run --app-id X -- pnpm <script>`                                                               |
| Components      | the on-disk `resources/` directory                                  | provisioned in the Catalyst project                                                                         |
| Setup           | `dapr init` (needs Docker)                                          | `diagrid project create <name> --deploy-managed-kv --deploy-managed-pubsub --enable-managed-workflow --use` |
| Component names | `workflows-state` + `kvstore`, declared in `resources/`             | the same names, provisioned managed — nothing to set                                                        |

`diagrid dev run` injects `DAPR_GRPC_ENDPOINT` and `DAPR_API_TOKEN`, which
`@dapr/dapr` reads from the environment — so the adapters need no
Catalyst-specific code. And the managed components those flags provision are
named `kvstore` and `pubsub`, which are what the adapters default to, so neither
path needs configuring. The `resources/` files copy those names deliberately;
Catalyst is where they are fixed.

## Shared prerequisites

- **Node.js ≥ 22.13** — `.nvmrc` pins the version CI uses
- **A sidecar**, either kind: the
  [Dapr CLI](https://docs.dapr.io/getting-started/install-dapr-cli/) initialized
  with `dapr init`, or the
  [Diagrid CLI](https://docs.diagrid.io/catalyst/references/cli-reference/) with a
  Catalyst project
- **An LLM API key** — `OPENAI_API_KEY` by default. Set `OLLAMA_ENDPOINT`
  instead to run against a local model and skip the key entirely.

Each framework's README spells out exactly which of these its scripts need —
some need none.

## Managed quickstarts

For a complete Catalyst-managed project rather than a local script, see the
[Diagrid Catalyst quickstarts](https://docs.diagrid.io/getting-started/quickstarts/ai-agents/).
