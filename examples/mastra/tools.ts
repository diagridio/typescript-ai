// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Demo tools shared by the example scripts.
 *
 * Extracted so each script can keep its interesting part — the agent config and
 * the runner usage — front and centre instead of repeating 60 lines of tool
 * boilerplate four times.
 *
 * Every tool is deterministic and offline: an example should never depend on a
 * third-party API being up, and the durability story is about the *workflow*
 * surviving failure, not about what the tools do.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const searchWeb = createTool({
  id: 'searchWeb',
  description: 'Search the web for information on a topic.',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
  }),
  outputSchema: z.object({ results: z.string() }),
  execute: ({ query }) =>
    Promise.resolve({
      results: `Found 10 relevant documents about ${query}.`,
    }),
});

export const calculate = createTool({
  id: 'calculate',
  description: 'Perform an arithmetic calculation.',
  // Structured input rather than an expression string: it needs no expression
  // parser (python-ai's equivalent reaches for `eval`), and it shows off what a
  // Zod input schema actually buys you — the model has to produce a valid
  // operator, and the adapter validates that before the tool ever runs.
  inputSchema: z.object({
    a: z.number(),
    b: z.number(),
    op: z.enum(['add', 'subtract', 'multiply', 'divide']),
  }),
  outputSchema: z.object({ result: z.number() }),
  execute: ({ a, b, op }) => {
    switch (op) {
      case 'add':
        return Promise.resolve({ result: a + b });
      case 'subtract':
        return Promise.resolve({ result: a - b });
      case 'multiply':
        return Promise.resolve({ result: a * b });
      case 'divide':
        if (b === 0) {
          // A tool error is information for the model, not a workflow failure —
          // the adapter reports it back so the model can correct the call.
          throw new Error('Cannot divide by zero');
        }
        return Promise.resolve({ result: a / b });
    }
  },
});

export const getWeather = createTool({
  id: 'getWeather',
  description: 'Get the current weather for a city.',
  inputSchema: z.object({
    city: z.string().describe('The city name'),
  }),
  outputSchema: z.object({
    city: z.string(),
    summary: z.string(),
    temperatureC: z.number(),
  }),
  execute: ({ city }) =>
    Promise.resolve({ city, summary: 'Sunny', temperatureC: 22 }),
});

/** All demo tools, keyed the way Mastra's `tools` option expects. */
export const demoTools = { searchWeb, calculate, getWeather };
