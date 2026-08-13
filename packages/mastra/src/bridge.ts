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
 * Mastra drive. That does not work here, and the reason is worth recording
 * because the failure is silent and looks like a broken model:
 *
 *   Agent-level `tools` (with `execute`) + `maxSteps: 1`
 *     -> `toolCalls: []`, `toolResults: []`, the tool body never runs, and the
 *        model emits its tool call as raw *text* with its chat template leaking
 *        (`...{"name":"getWeather",...}</tool_c`). Nothing throws.
 *
 *   `clientTools` (definitions only) + `maxSteps: 1`
 *     -> a structured call: `{ payload: { toolCallId, toolName, args } }`,
 *        unexecuted, `text: ''`.
 *
 * The model is not at fault, which was checked rather than assumed. Ollama
 * reports `qwen2.5:7b` as `completion tools`, and a **raw** OpenAI-compatible
 * request carrying a `tools` array returns `finish_reason: tool_calls` with a
 * proper structured `tool_calls` entry. So the capability is there; in the first
 * case the schemas never reached the model.
 *
 * Working hypothesis for why: with `maxSteps: 1` Mastra has no second step in
 * which to use tool results, so it omits agent-level tool schemas — whereas
 * `clientTools` tells it the caller will execute them, so it sends them anyway.
 * Unverified against Mastra's source, but it fits both observations.
 *
 * Practical consequence: `clientTools` + `maxSteps: 1` is a pair. Dropping
 * either — passing agent tools, or raising maxSteps to "let it finish" — either
 * silently stops tool calling or moves execution back inside Mastra, where it is
 * not checkpointed and a crash loses it. If you change this, re-run the
 * comparison above against a tool-capable model first.
 */

import type {
  InvokeModelInput,
  InvokeModelOutput,
  InvokeToolInput,
  InvokeToolOutput,
  Message,
} from './models';
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
    prompt: string,
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

/** Parse JSON, falling back to the raw string when it is not JSON. */
function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
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

  return async (input: InvokeModelInput): Promise<InvokeModelOutput> => {
    const clientTools = await definitionOnlyTools(agent);

    // The final user turn is the prompt; everything before it is context. The
    // whole transcript is replayed every iteration because the workflow, not
    // Mastra, is holding the conversation.
    const history = [...input.messages];
    const lastUser = history.at(-1);
    const prompt =
      lastUser?.role === 'user' ? lastUser.content : (lastUser?.content ?? '');
    const context = toModelMessages(
      lastUser?.role === 'user' ? history.slice(0, -1) : history
    );

    const result = await generating.generate(prompt, {
      // One step: the loop lives in the workflow.
      maxSteps: 1,
      ...(context.length > 0 ? { context } : {}),
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

    invokers.set(tool.id ?? name, async (input) => {
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
        // what lets the orchestrator retry it (see `TOOL_MAX_ATTEMPTS` in
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
