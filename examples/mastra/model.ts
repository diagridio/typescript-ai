// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Model selection shared by every example.
 *
 * Mastra accepts a model in several shapes; the two used here are the ones
 * worth knowing:
 *
 * - A **model-router magic string** (`'openai/gpt-4o-mini'`) — the form
 *   Mastra's docs lead with. No provider package needed, so these examples
 *   have no `@ai-sdk/*` dependency at all.
 * - An **OpenAI-compatible config** (`{ id, url }`) — how you point an agent at
 *   Ollama or any other OpenAI-shaped endpoint.
 *
 * Setting `OLLAMA_ENDPOINT` switches every example to a local model, which is
 * what the Ollama e2e lane does. Otherwise it uses OpenAI and needs
 * `OPENAI_API_KEY`.
 */

/** A Mastra model config: magic string, or an OpenAI-compatible endpoint. */
export type ExampleModel = string | { id: `${string}/${string}`; url: string };

const DEFAULT_OPENAI_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_OLLAMA_MODEL = 'qwen3:0.6b';

/** Resolve the model from the environment. */
export function resolveExampleModel(): ExampleModel {
  const ollamaEndpoint = process.env['OLLAMA_ENDPOINT'];
  if (ollamaEndpoint) {
    const model = process.env['OLLAMA_MODEL'] ?? DEFAULT_OLLAMA_MODEL;
    return { id: `ollama/${model}`, url: ollamaEndpoint };
  }
  return process.env['DIAGRID_EXAMPLE_MODEL'] ?? DEFAULT_OPENAI_MODEL;
}

/** One-line description of the resolved model, for the scripts' output. */
export function describeExampleModel(model: ExampleModel): string {
  return typeof model === 'string' ? model : `${model.id} @ ${model.url}`;
}
