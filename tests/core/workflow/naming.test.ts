// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Workflow-name contract.
 *
 * The cases below are lifted from the docstrings of
 * `diagrid/agent/core/workflow/naming.py` in `diagridio/python-ai`. They are
 * duplicated here on purpose: the two implementations are a cross-language
 * contract, and this file is what fails if the TypeScript side drifts.
 */

import { describe, expect, it } from 'vitest';

import { buildWorkflowName, sanitizeAgentName } from '@diagrid/agent-core';

describe('sanitizeAgentName', () => {
  it.each([
    ['get_user', 'GetUser'],
    ['get-user', 'GetUser'],
    ['get user', 'GetUser'],
    ['GetUser', 'GetUser'],
    ['UPPERCASE', 'Uppercase'],
    ['SamwiseGamgee', 'SamwiseGamgee'],
    ['catering-coordinator', 'CateringCoordinator'],
    ['Samwise Gamgee', 'SamwiseGamgee'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(sanitizeAgentName(input)).toBe(expected);
  });

  it('matches the Python implementation on SCREAMING_SNAKE_CASE', () => {
    // Deliberately `Get_user`, not `GetUser`.
    //
    // python-ai's `_normalize_to_title_case` docstring claims
    // `"GET_USER" -> "GetUser"`, but its code checks `name.isupper()` first —
    // and Python treats `"GET_USER"` as upper (underscores are uncased), so it
    // returns `"GET_USER".capitalize()` == `"Get_user"`. The docstring is
    // wrong, the code is the contract, and workflow names have to agree across
    // languages, so this port matches the code.
    //
    // Worth fixing in both repos at once — changing it here alone would split
    // the workflow namespace for any agent with an all-caps name.
    expect(sanitizeAgentName('GET_USER')).toBe('Get_user');
  });

  it.each([
    ['agent<name>', 'Agentname'],
    ['a|b', 'Ab'],
    ['a/b', 'Ab'],
    ['a\\b', 'Ab'],
  ])('strips characters invalid in tool names: %j -> %j', (input, expected) => {
    expect(sanitizeAgentName(input)).toBe(expected);
  });

  it('falls back to unnamed_agent for an empty name', () => {
    expect(sanitizeAgentName('')).toBe('unnamed_agent');
  });

  it('falls back to unnamed_agent when sanitizing removes everything', () => {
    expect(sanitizeAgentName('<|/>')).toBe('unnamed_agent');
  });

  it('is idempotent', () => {
    const once = sanitizeAgentName('catering-coordinator');
    expect(sanitizeAgentName(once)).toBe(once);
  });
});

describe('buildWorkflowName', () => {
  it('builds the canonical dapr.<framework>.<Name>.workflow form', () => {
    expect(buildWorkflowName('Mastra', 'catering-coordinator')).toBe(
      'dapr.mastra.CateringCoordinator.workflow'
    );
  });

  it('lower-cases the framework segment but not the agent segment', () => {
    expect(buildWorkflowName('Mastra', 'SamwiseGamgee')).toBe(
      'dapr.mastra.SamwiseGamgee.workflow'
    );
  });

  it('produces a usable name even for an empty agent name', () => {
    expect(buildWorkflowName('Mastra', '')).toBe(
      'dapr.mastra.unnamed_agent.workflow'
    );
  });
});
