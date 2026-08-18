// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The bridge between Mastra and the durable workflow.
 *
 * This is the piece that makes the adapter an adapter. The workflow owns the
 * agent loop — one model call per iteration, each tool call its own activity —
 * so Mastra must be asked for *one step at a time* and must not execute tools
 * itself. Everything else is checkpointed by Dapr and replayed on recovery.
 *
 * ## Why `clientTools` and `maxSteps: 1` — do not "simplify" this
 *
 * Tools are handed to Mastra as **client tools**: definitions with no `execute`
 * body. Mastra documents these as tools the client runs, so it returns the
 * model's tool call *unexecuted* — exactly what a durable loop needs, and a
 * first-class concept rather than a trick.
 *
 * The obvious-looking alternative is to pass the agent's own `tools` and let
 * Mastra drive. Do not: with agent-level tools Mastra executes the tool body
 * *inside* `generate()`, where it is not a checkpointed activity — and the
 * orchestrator still schedules `invokeTool` for the same call afterwards, so the
 * tool runs **twice**, once durably and once not. A crash between them loses the
 * un-checkpointed side effect while the workflow believes the step succeeded.
 *
 * Measured with a mock AI SDK v2 model, no network. Both rows are pinned by
 * `tests/mastra/bridge.test.ts` — the first by a positive control that calls
 * `agent.generate()` directly, without which the second row could not tell a
 * working mitigation from a harness that never executes tool bodies at all:
 *
 *   agent's own `tools` + `maxSteps: 1`      -> tool body executed: 1
 *   `definitionOnlyTools` as `clientTools`   -> tool body executed: 0
 *
 * So `clientTools` + `maxSteps: 1` is a pair. Raising maxSteps to "let it
 * finish" moves the loop back inside Mastra, out of the workflow's control.
 *
 * (An earlier note here claimed agent-level tools produced `toolCalls: []` and
 * that Mastra omits their schemas at `maxSteps: 1`. That was generalised from a
 * single Ollama run where the model emitted its call as text; it does not
 * reproduce against a mock model, and the schemas are sent in both cases. The
 * conclusion was right for the wrong reason.)
 */

import type {
  InvokeModelInput,
  InvokeModelOutput,
  InvokeToolInput,
  InvokeToolOutput,
  Message,
} from '@diagrid/agent-core';
import type { MastraAgentLike } from './mapper';

/** A Mastra tool as `listTools()` returns it. */
interface MastraTool {
  readonly id?: string;
  readonly description?: string;
  readonly inputSchema?: { parse?: (value: unknown) => unknown };
  readonly outputSchema?: unknown;
  readonly execute?: (input: unknown, context: unknown) => unknown;
}

/**
 * One entry of Mastra's `generate()` result `toolCalls`.
 *
 * Note the `payload` wrapper — the fields are not flat, which is easy to get
 * wrong and produces a silently empty tool name if you do.
 */
interface MastraToolCall {
  readonly payload?: {
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly args?: unknown;
  };
}

interface MastraGenerateResult {
  readonly text?: string;
  readonly toolCalls?: readonly MastraToolCall[];
  readonly usage?: {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}

/** The subset of a Mastra `Agent` the bridge calls. */
interface GeneratingAgent extends MastraAgentLike {
  generate(
    messages: string | Record<string, unknown>[],
    options: Record<string, unknown>
  ): Promise<MastraGenerateResult>;
  listTools?: () =>
    Promise<Record<string, MastraTool>> | Record<string, MastraTool>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Read the agent's tools, whichever way this object exposes them. */
export async function readTools(
  agent: MastraAgentLike
): Promise<Record<string, MastraTool>> {
  const candidate = agent as GeneratingAgent;
  const tools =
    typeof candidate.listTools === 'function'
      ? await candidate.listTools()
      : candidate.tools;
  // `isRecord` only narrows to Record<string, unknown>; the tool shape is
  // duck-typed by design, so this is the one place it gets asserted.
  return isRecord(tools) ? (tools as Record<string, MastraTool>) : {};
}

/**
 * Copy the agent's tools with their `execute` bodies removed.
 *
 * The schemas and descriptions are what the model needs; the bodies are what
 * the workflow must own. Stripping them is what guarantees Mastra cannot run a
 * tool outside of a checkpointed activity.
 */
export async function definitionOnlyTools(
  agent: MastraAgentLike
): Promise<Record<string, MastraTool>> {
  const tools = await readTools(agent);
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const { execute: _execute, ...definition } = tool;
      return [name, definition];
    })
  );
}

/**
 * Convert the durable transcript into AI SDK `ModelMessage`s.
 *
 * The workflow's own message shape is deliberately flat and JSON-friendly so it
 * survives the state store; the model wants structured content parts. Tool
 * results are the awkward case: a `tool` role message needs the *tool name*,
 * which the flat shape does not carry, so it is recovered from the tool call in
 * the preceding assistant message.
 */
export function toModelMessages(
  messages: readonly Message[]
): Record<string, unknown>[] {
  const toolNameById = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      toolNameById.set(call.id, call.name);
    }
  }

  const converted: Record<string, unknown>[] = [];

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        // The agent's instructions already carry the system prompt; a second one
        // here would duplicate it.
        break;

      case 'user':
        converted.push({ role: 'user', content: message.content });
        break;

      case 'assistant': {
        const calls = message.toolCalls ?? [];
        if (calls.length === 0) {
          converted.push({ role: 'assistant', content: message.content });
          break;
        }
        const parts: Record<string, unknown>[] = [];
        if (message.content) {
          parts.push({ type: 'text', text: message.content });
        }
        for (const call of calls) {
          parts.push({
            type: 'tool-call',
            toolCallId: call.id,
            toolName: call.name,
            input: safeParse(call.args),
          });
        }
        converted.push({ role: 'assistant', content: parts });
        break;
      }

      case 'tool':
        converted.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: message.toolCallId ?? '',
              toolName: toolNameById.get(message.toolCallId ?? '') ?? 'unknown',
              output: { type: 'text', value: message.content },
            },
          ],
        });
        break;
    }
  }

  return converted;
}

/**
 * Parse JSON, falling back to the raw string when it is not JSON.
 *
 * `__proto__` and `constructor` keys are dropped during parsing. These strings
 * come from the model, and a model's output is untrusted input the moment a
 * retrieved document or a tool result can influence it. Tools with a Zod
 * `inputSchema` are already safe (zod 4 strips unknown keys), but a tool without
 * one receives this object directly — and a body doing `Object.assign(defaults,
 * args)` or a lodash `merge` turns an own `__proto__` into prototype pollution.
 */
function safeParse(value: string): unknown {
  try {
    return JSON.parse(value, (key: string, parsed: unknown) =>
      key === '__proto__' || key === 'constructor' ? undefined : parsed
    ) as unknown;
  } catch {
    return value;
  }
}

/**
 * Build the function the `invokeModel` activity delegates to.
 *
 * One model call, tools offered but never executed here. The activity boundary
 * is what makes the call durable: its result is checkpointed, so a crash after
 * this returns never re-issues (or re-bills) it.
 */
export function createModelInvoker(agent: MastraAgentLike) {
  const generating = agent as GeneratingAgent;

  if (typeof generating.generate !== 'function') {
    throw new TypeError(
      'The agent passed to DaprWorkflowAgentRunner has no generate() method — ' +
        'expected a Mastra Agent from @mastra/core/agent.'
    );
  }

  // Read once, not per iteration. `listTools()` may be backed by something
  // remote (an MCP client), and an agent's tool definitions do not change
  // between iterations of a turn — re-reading them was a round trip per model
  // call for an identical answer.
  let clientToolsPromise: Promise<Record<string, MastraTool>> | undefined;

  return async (input: InvokeModelInput): Promise<InvokeModelOutput> => {
    clientToolsPromise ??= definitionOnlyTools(agent);
    const clientTools = await clientToolsPromise;

    // The whole transcript goes in as messages, in one place.
    //
    // An earlier version split it into `prompt` (the last message) plus
    // `context` (the rest). That is wrong from iteration 2 onwards: the
    // orchestrator guarantees the transcript ends with a `tool` message
    // whenever there were tool calls, so the tool result became *both* the
    // prompt and a context entry. Mastra coerces the prompt to a user message,
    // so the model saw its own tool output a second time as if the user had
    // typed it — which invites it to call the same tool again.
    //
    // The workflow, not Mastra, holds the conversation, so the full transcript
    // is passed on every iteration.
    const result = await generating.generate(toModelMessages(input.messages), {
      // One step: the loop lives in the workflow.
      maxSteps: 1,
      ...(Object.keys(clientTools).length > 0 ? { clientTools } : {}),
    });

    const toolCalls = (result.toolCalls ?? []).flatMap((call) => {
      const payload = call.payload;
      if (!payload?.toolCallId || !payload.toolName) {
        return [];
      }
      return [
        {
          id: payload.toolCallId,
          name: payload.toolName,
          // Stringified so the value that crosses the workflow boundary — and
          // gets checkpointed — is byte-stable across replays.
          args: JSON.stringify(payload.args ?? {}),
        },
      ];
    });

    const usage = {
      ...(result.usage?.promptTokens !== undefined ||
      result.usage?.inputTokens !== undefined
        ? {
            promptTokens:
              result.usage.promptTokens ?? result.usage.inputTokens ?? 0,
          }
        : {}),
      ...(result.usage?.completionTokens !== undefined ||
      result.usage?.outputTokens !== undefined
        ? {
            completionTokens:
              result.usage.completionTokens ?? result.usage.outputTokens ?? 0,
          }
        : {}),
    };

    return {
      message: {
        role: 'assistant',
        content: result.text ?? '',
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      requiresToolCalls: toolCalls.length > 0,
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    };
  };
}

/**
 * Build one invoker per tool, for the `invokeTool` activity.
 *
 * Arguments arrive as a JSON string produced by the model, i.e. from outside the
 * process, so they are validated against the tool's own schema before the body
 * runs. A tool that throws is reported as a tool error rather than an activity
 * failure — the model gets a chance to correct a bad call, which is not the same
 * thing as the infrastructure failing.
 */
export async function createToolInvokers(
  agent: MastraAgentLike
): Promise<Map<string, (input: InvokeToolInput) => Promise<InvokeToolOutput>>> {
  const tools = await readTools(agent);
  const invokers = new Map<
    string,
    (input: InvokeToolInput) => Promise<InvokeToolOutput>
  >();

  for (const [name, tool] of Object.entries(tools)) {
    if (typeof tool.execute !== 'function') {
      // Nothing to run. Left unregistered so the activity reports an honest
      // "Unknown tool" rather than silently succeeding.
      continue;
    }

    // Keyed by the `tools` record key, NOT `tool.id`.
    //
    // Mastra's `listClientTools` iterates `Object.entries(clientTools)` and
    // registers each under its key, so that is the name the model asks for. When
    // the two differ — `createTool({ id: 'lookup_order_status' })` placed at
    // `{ lookupOrder }` — keying by id makes every call miss, and
    // `invokeToolActivity` returns "Unknown tool" as a *successful* activity
    // output. That gets checkpointed permanently and fed back to the model as a
    // real tool result, burning iterations until the cap.
    //
    // Invisible in every fixture here because they all use the shorthand where
    // key and id coincide.
    if (typeof tool.inputSchema?.parse !== 'function') {
      // Tell the operator at startup, not at the first call.
      //
      // `createTool` treats `inputSchema` as optional, and a tool without one
      // receives the model's arguments with only `safeParse`'s `__proto__` /
      // `constructor` stripping between it and untrusted text — a retrieved
      // document or an earlier tool result can steer what lands here. That may
      // be a deliberate choice, so this warns rather than refusing.
      //
      // `process.emitWarning` rather than `console.warn`: it carries a stable
      // type an operator can filter or turn into an error
      // (`--throw-deprecation`-style handling via `process.on('warning')`), and
      // a library has no business writing to stdout.
      process.emitWarning(
        `Mastra tool "${name}" has no inputSchema, so its arguments reach the ` +
          'tool body unvalidated. Add a Zod inputSchema to createTool() if the ' +
          'model can be influenced by untrusted content.',
        { type: 'DiagridUnvalidatedToolArgs', code: 'DIAGRID_TOOL_NO_SCHEMA' }
      );
    }

    invokers.set(name, async (input) => {
      // Validate first, outside the retry-able region. Bad arguments are the
      // *model's* mistake, and re-running the same call cannot fix them — so
      // this returns a tool error, which goes back to the model as a result it
      // can correct from. Only failures from the tool body are retried.
      let args: unknown;
      try {
        const raw: unknown = safeParse(input.args);
        args =
          typeof tool.inputSchema?.parse === 'function'
            ? tool.inputSchema.parse(raw)
            : raw;
      } catch (error) {
        return {
          toolCallId: input.toolCallId,
          result: '',
          error: `invalid arguments: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      try {
        const output: unknown = await tool.execute!(args, {
          // Minimal execution context. Mastra tools that need `mastra`,
          // `requestContext` or a workspace are not supported yet.
          // TODO(mastra-adapter): thread the runner's RequestContext through the
          // workflow input so tools that depend on it work under replay.
          toolCallId: input.toolCallId,
        });

        return {
          toolCallId: input.toolCallId,
          result: JSON.stringify(output ?? null),
        };
      } catch (error) {
        // Deliberately rethrown rather than reported as a tool result.
        //
        // A throw from the tool body surfaces as an *activity failure*, which is
        // what lets the orchestrator retry it (see `ACTIVITY_MAX_ATTEMPTS` in
        // ./workflow.ts) without involving the model at all. Returning it as a
        // result instead would send every transient fault — a rate limit, a
        // dropped connection — on a full round trip through the LLM.
        //
        // Argument-validation failures took the other path, above.
        throw error instanceof Error ? error : new Error(String(error));
      }
    });
  }

  return invokers;
}
