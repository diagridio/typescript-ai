// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Agent name sanitization for workflow ID construction.
 *
 * This is a direct port of `diagrid/agent/core/workflow/naming.py` in
 * `diagridio/python-ai`, which in turn mirrors the TitleCase normalization
 * used by dapr-agents. Workflow names are a cross-language contract: a
 * Catalyst project inspecting `dapr.mastra.CateringCoordinator.workflow` must
 * see the same shape whether the agent was written in TypeScript or Python,
 * so the two implementations must stay behaviourally identical. The unit
 * tests in `tests/core/workflow/naming.test.ts` carry the same cases as the
 * Python docstrings.
 */

const SEPARATORS = /[_\s-]+/;
const TITLE_CASE_START = /^[A-Z][a-z]/;
const HAS_SEPARATOR = /[_\s-]/;
/** Characters that are invalid in OpenAI tool names. */
const INVALID_CHARS = /[<|\\/>]/g;

const UNNAMED_AGENT = 'unnamed_agent';

function capitalize(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
}

/**
 * Normalize a name to TitleCase.
 *
 * Converts snake_case, kebab-case and space-separated names to TitleCase:
 *
 * ```text
 * "get_user"      -> "GetUser"
 * "get-user"      -> "GetUser"
 * "get user"      -> "GetUser"
 * "GetUser"       -> "GetUser"  (preserved)
 * "GET_USER"      -> "GetUser"
 * "UPPERCASE"     -> "Uppercase"
 * "SamwiseGamgee" -> "SamwiseGamgee"  (preserved)
 * ```
 */
function normalizeToTitleCase(name: string): string {
  if (!name) {
    return '';
  }

  // All-uppercase -> capitalize only the first letter, matching Python's
  // `str.capitalize()`.
  if (
    name === name.toUpperCase() &&
    name !== name.toLowerCase() &&
    name.length > 1
  ) {
    return capitalize(name);
  }

  // Already TitleCase (no separators, starts upper-then-lower): leave alone so
  // "SamwiseGamgee" does not collapse to "Samwisegamgee".
  if (TITLE_CASE_START.test(name) && !HAS_SEPARATOR.test(name)) {
    return name;
  }

  return name.split(SEPARATORS).filter(Boolean).map(capitalize).join('');
}

/**
 * Sanitize an agent name for use in workflow IDs.
 *
 * Converts to TitleCase and strips characters that are invalid in OpenAI tool
 * names (spaces, `<`, `|`, `\`, `/`, `>`). Matches `sanitize_openai_tool_name`
 * in dapr-agents so workflow IDs are consistent across frameworks.
 *
 * ```text
 * "catering-coordinator" -> "CateringCoordinator"
 * "Samwise Gamgee"       -> "SamwiseGamgee"
 * "agent<name>"          -> "Agentname"
 * ""                     -> "unnamed_agent"
 * ```
 */
export function sanitizeAgentName(name: string): string {
  if (!name) {
    return UNNAMED_AGENT;
  }

  const titled = normalizeToTitleCase(name);
  if (!titled) {
    return UNNAMED_AGENT;
  }

  return titled.replace(INVALID_CHARS, '') || UNNAMED_AGENT;
}

/**
 * Build the canonical Dapr workflow name for an agent.
 *
 * Returns `dapr.<framework>.<TitleCaseName>.workflow`. This is the single
 * source of truth for the workflow name used both when registering the
 * workflow and when publishing the agent's `workflowName` metadata, so the
 * two can never drift apart.
 *
 * ```text
 * buildWorkflowName('Mastra', 'catering-coordinator')
 *   -> 'dapr.mastra.CateringCoordinator.workflow'
 * ```
 */
export function buildWorkflowName(framework: string, name: string): string {
  return `dapr.${framework.toLowerCase()}.${sanitizeAgentName(name)}.workflow`;
}
