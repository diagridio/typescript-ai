// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Agent frameworks this repository ships a Dapr Workflow adapter for.
 *
 * The values are the human-readable framework labels published in agent
 * registry metadata; the lower-cased value is also the middle segment of the
 * canonical workflow name (`dapr.<framework>.<AgentName>.workflow`). They are
 * deliberately identical to the `SupportedFrameworks` values in the sibling
 * `diagridio/python-ai` repo so a workflow started by a TypeScript agent and
 * one started by a Python agent land under the same naming scheme.
 *
 * Adding an adapter means adding one entry here plus one `packages/<name>`
 * directory — `tests/guards/cross-framework-imports.test.ts` asserts the two
 * stay in sync.
 */
export const SupportedFrameworks = {
  MASTRA: 'Mastra',
} as const;

export type SupportedFramework =
  (typeof SupportedFrameworks)[keyof typeof SupportedFrameworks];

/** Every supported framework label, in declaration order. */
export const ALL_SUPPORTED_FRAMEWORKS: readonly SupportedFramework[] =
  Object.values(SupportedFrameworks);

/** Narrow an arbitrary string to a {@link SupportedFramework}. */
export function isSupportedFramework(
  value: string
): value is SupportedFramework {
  return (ALL_SUPPORTED_FRAMEWORKS as readonly string[]).includes(value);
}
