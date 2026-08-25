// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { ExecuteContext } from 'n8n-core';
import { Workflow, isNodeClassInstance } from 'n8n-workflow';
import type {
  IExecuteData,
  IExecuteFunctions,
  INode,
  INodeExecutionData,
  INodeType,
  INodeTypes,
  IVersionedNodeType,
  IWorkflowExecuteAdditionalData,
} from 'n8n-workflow';

/**
 * Hardened against the real n8n-core/n8n-workflow API by actually running it
 * (see git history for the specific fixes): `nodeType.execute` must be
 * invoked with node-style `this`-binding via `.call()`, not passed `context`
 * as an ordinary argument; `Set`/`If`/`Merge` are `VersionedNodeType` wrappers
 * that need `.getNodeType()` to reach anything with an `execute()` at all;
 * and the `inputData` constructor argument has to be the `{ main: [...] }`
 * -shaped `ITaskDataConnections`, not a bare array —
 * `ExecuteContext.getInputData()` keys off
 * `this.inputData.hasOwnProperty('main')`, which is silently always `false`
 * for a plain array. Mirrors what n8n's own `EphemeralNodeExecutor` does
 * internally (packages/cli/src/node-execution/ephemeral-node-executor.ts).
 * That class isn't exported — packages/cli has no library surface at all —
 * so this reimplements the same narrow pattern rather than reusing it.
 *
 * TODO(n8n-integration): credentials are entirely unimplemented — the proof
 * this package is built around only uses credential-free node types. See
 * `buildMinimalAdditionalData`'s own doc comment for exactly what's missing.
 * Every `as never` below is a named, deliberate gap, not a finished
 * implementation.
 */

// Confirmed against the locally-built n8n-nodes-base (packages/nodes-base/dist):
// these are the real dist paths and the real named exports. `Set`, `If`, and
// `Merge` each export a class extending `VersionedNodeType` (a dispatcher with
// no `execute()` of its own — see `loadNodeType` below); `NoOp` exports a plain
// single-version `INodeType` class directly.
//
type NodeTypeLoader = () => new () => INodeType | IVersionedNodeType;

/**
 * `require()`, not `await import()`: n8n's own `INodeTypes.getByNameAndVersion`/
 * `getByName` (below) are SYNCHRONOUS — n8n's real `Workflow` constructor calls
 * them synchronously internally, a contract this package must match, not one
 * it chose. Centralized in one helper (rather than a `require()` call per
 * entry below) so the necessary lint exemption is scoped to exactly this one
 * function — immune to Prettier later reformatting an object literal and
 * silently moving a line-anchored `eslint-disable-next-line` comment onto the
 * wrong line, which is a real failure mode this file hit once already.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- see doc comment above; a block, not `-next-line`, since Prettier reflowing the parameter list once already moved a line-anchored disable off the real `require()` call */
function requireNodeClass(
  modulePath: string,
  exportName: string
): ReturnType<NodeTypeLoader> {
  const mod = require(modulePath) as Record<string, unknown>;
  return mod[exportName] as ReturnType<NodeTypeLoader>;
}
/* eslint-enable @typescript-eslint/no-require-imports */

// Confirmed against the locally-built n8n-nodes-base (packages/nodes-base/dist):
// these are the real dist paths and the real named exports. `Set`, `If`, and
// `Merge` each export a class extending `VersionedNodeType` (a dispatcher with
// no `execute()` of its own — see `loadNodeType` below); `NoOp` exports a plain
// single-version `INodeType` class directly.
const SUPPORTED_NODE_TYPES: Record<string, NodeTypeLoader> = {
  'n8n-nodes-base.set': () =>
    requireNodeClass('n8n-nodes-base/dist/nodes/Set/Set.node', 'Set'),
  'n8n-nodes-base.noOp': () =>
    requireNodeClass('n8n-nodes-base/dist/nodes/NoOp/NoOp.node', 'NoOp'),
  'n8n-nodes-base.if': () =>
    requireNodeClass('n8n-nodes-base/dist/nodes/If/If.node', 'If'),
  'n8n-nodes-base.merge': () =>
    requireNodeClass('n8n-nodes-base/dist/nodes/Merge/Merge.node', 'Merge'),
  // A plain (non-VersionedNodeType) INodeType, same shape as NoOp — confirmed
  // via `class Wait extends Webhook` with no explicit constructor
  // (packages/nodes-base/dist/nodes/Wait/Wait.node.js), so `new Wait()` needs
  // no baseDescription argument the way Set/If/Merge's versioned wrappers do.
  'n8n-nodes-base.wait': () =>
    requireNodeClass('n8n-nodes-base/dist/nodes/Wait/Wait.node', 'Wait'),
};

// Test-only extension point (used by the retry-loop functional test — see
// examples/n8n/fixtures/flaky-node.js). When set, the module at this path is
// require()'d and its exports merged in, so a throwaway node type can be
// exercised through the real orchestrator/activity/ledger path without baking
// test-only node types into this file permanently. Never set in normal
// operation.
const testNodeTypesModule = process.env['DIAGRID_N8N_TEST_NODE_TYPES_MODULE'];
if (testNodeTypesModule) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- test-only, dynamic path from an env var, must stay synchronous (see requireNodeClass's own doc comment)
  const testTypes = require(testNodeTypesModule) as typeof SUPPORTED_NODE_TYPES;
  Object.assign(SUPPORTED_NODE_TYPES, testTypes);
}

function isVersionedNodeType(
  nodeType: INodeType | IVersionedNodeType
): nodeType is IVersionedNodeType {
  return 'getNodeType' in nodeType;
}

/**
 * Resolves a node type name (+ optional version) down to a real, executable
 * `INodeType` — following `VersionedNodeType.getNodeType(version)` when the
 * registered class is a version dispatcher rather than a node itself. This is
 * the same resolution `Workflow`'s own constructor performs via
 * `nodeTypes.getByNameAndVersion` (packages/workflow/src/workflow.ts) — it
 * needs the same treatment here since it reads `nodeType.description.properties`
 * unconditionally, which only the resolved, version-specific type actually has.
 */
function loadNodeType(type: string, version?: number): INodeType {
  const load = SUPPORTED_NODE_TYPES[type];
  if (!load) {
    throw new Error(
      `@diagrid/n8n does not yet support node type "${type}" — ` +
        'only a small set of credential-free node types are wired up so far, see execute-node.ts.'
    );
  }
  const NodeClass = load();
  const instance = new NodeClass();
  return isVersionedNodeType(instance)
    ? instance.getNodeType(version)
    : instance;
}

// Enough for `new Workflow(...)` and `ExecuteContext` to resolve a type by name
// without needing n8n's real, much larger `NodeTypes` service.
function buildMinimalNodeTypes(): INodeTypes {
  return {
    getByNameAndVersion: (type, version) => loadNodeType(type, version),
    getByName: (type) => {
      const load = SUPPORTED_NODE_TYPES[type];
      if (!load) {
        throw new Error(
          `@diagrid/n8n does not yet support node type "${type}".`
        );
      }
      return new (load())();
    },
    getKnownTypes: () => ({}),
  };
}

function buildMinimalAdditionalData(): IWorkflowExecuteAdditionalData {
  // Verified sufficient for Set/NoOp/If/Merge/Wait's actual execute() paths —
  // running inside a real, fully booted n8n process means `Container.get(...)`
  // -backed helpers (file-system, SSH tunnel, data-table, deduplication)
  // resolve against n8n's own live DI container rather than needing to be
  // stubbed here. `credentialsHelper` is the only field these node types
  // actually dereference; every other REQUIRED field on
  // `IWorkflowExecuteAdditionalData` (executeWorkflow, getRunExecutionData,
  // getRuntimeCredential, restApiUrl, instanceBaseUrl, the
  // form/webhook/mcp base URLs, ...) is still genuinely missing — a node type
  // that touches any of those (credentials, sub-workflow calls, webhooks,
  // response streaming) will throw.
  //
  // TODO(n8n-integration): credential resolution. Expand this object, not the
  // cast, as support for more node types is added.
  return {
    credentialsHelper: {
      // Not `async`: a function that always throws has return type `never`,
      // itself assignable to whatever Promise type `getDecrypted` declares —
      // no `await` needed to satisfy either the real signature or the lint
      // rule that would otherwise flag an async function with none.
      getDecrypted: () => {
        throw new Error(
          '@diagrid/n8n: credential resolution is not implemented'
        );
      },
    },
  } as unknown as IWorkflowExecuteAdditionalData;
}

/** Discriminates a normal completion from a node putting the execution to wait. */
export type ExecuteNodeResult =
  | { status: 'success'; outputItems: INodeExecutionData[][] }
  | {
      status: 'waiting';
      outputItems: INodeExecutionData[][];
      waitTill: number;
    };

export async function executeNodeStandalone(
  node: INode,
  inputItems: INodeExecutionData[][]
): Promise<ExecuteNodeResult> {
  const nodeTypes = buildMinimalNodeTypes();
  const workflow = new Workflow({
    id: 'diagrid-n8n-standalone',
    name: 'diagrid-n8n-standalone',
    nodes: [node],
    connections: {},
    active: false,
    nodeTypes,
  });

  const additionalData = buildMinimalAdditionalData();
  const nodeType = loadNodeType(node.type, node.typeVersion);

  // Named (not inline) so it can be read back after execute() returns —
  // `putExecutionToWait(waitTill)` (base-execute-context.ts) is a plain
  // `this.runExecutionData.waitTill = waitTill` mutation, not a distinct return
  // value or a thrown signal. That's the *only* way to detect a node asked to
  // wait: the real `execute()` return value looks identical to a normal
  // completion either way (see Wait.node.ts's own `putToWait`: it calls
  // `putExecutionToWait` and then still `return [context.getInputData()]`
  // normally).
  const runExecutionData: {
    resultData: { runData: Record<string, never> };
    executionData: unknown;
    waitTill?: Date;
  } = {
    resultData: { runData: {} },
    executionData: {
      nodeExecutionStack: [],
      waitingExecution: {},
      waitingExecutionSource: {},
    },
  };

  // `inputData` (8th arg) must be keyed by connection type ("main") —
  // `ExecuteContext.getInputData()` checks `this.inputData.hasOwnProperty('main')`
  // (execute-context.ts), which is always false for a bare array. Confirmed
  // against the real ExecuteContext constructor
  // (packages/core/src/execution-engine/workflow-execute.ts's own call site):
  // (workflow, node, additionalData, mode, runExecutionData, runIndex,
  // connectionInputData, inputData, executeData, closeFunctions, abortSignal,
  // subNodeExecutionResults).
  const executeData: IExecuteData = {
    node,
    data: { main: inputItems },
    source: null,
  };
  const context = new ExecuteContext(
    workflow,
    node,
    additionalData,
    'manual',
    runExecutionData as never,
    0,
    inputItems[0] ?? [],
    { main: inputItems },
    executeData,
    [],
    undefined,
    undefined
  );

  if (!nodeType.execute) {
    throw new Error(`Node type "${node.type}" has no execute() method.`);
  }

  // Any expression more complex than the "simple" tmpl fast path (a bare
  // `{{ $json.foo }}` property access) — e.g. Merge's own `inputs` description,
  // an inline `(params) => {...}` IIFE used to compute its dynamic input count —
  // runs through the sandboxed isolated-vm bridge, which throws "No bridge
  // acquired for this context. Call acquire() first." unless something calls
  // `workflow.expression.acquireIsolate()` first. Real n8n does this once,
  // globally, at the top of the real (un-patched) processRunExecutionData
  // (workflow-execute.ts) for the whole execution's lifetime; since this
  // package builds a throwaway single-node Workflow (and therefore a fresh
  // Expression/isolate-pool caller key) per activity call rather than once per
  // execution, `withIsolate` (acquire + run + release) is the correct
  // per-call-scoped equivalent — using bare `acquireIsolate()` without ever
  // releasing would leak one pool slot per node execution.
  return await workflow.expression.withIsolate(
    async (): Promise<ExecuteNodeResult> => {
      // Mirrors WorkflowExecute.executeNode's own dispatch (workflow-execute.ts):
      // "new-style" Node-class nodes take the context as an ordinary argument;
      // everything else (all node types wired up so far) expects `this` to
      // be the context and reads it via `this.getInputData()` etc. Getting this
      // wrong silently breaks every `this.*` call inside execute() rather than
      // throwing, since `this` would be undefined/wrong instead of `context`.
      // `context as unknown as IExecuteFunctions`: a real n8n internal type
      // looseness, not a shape this package invents — `ExecuteContext`'s own
      // `getWorkflow()` return type has `name: string | undefined` (a real
      // `Workflow` can be constructed without one), while `IExecuteFunctions`
      // (what `execute()`'s own signature expects) declares it required. The
      // `Workflow` this package constructs (execute-node.ts, above) always has
      // a real name, so this is safe at runtime; TypeScript just can't see that
      // n8n's own two internal types disagree on strictness here.
      const output = isNodeClassInstance(nodeType)
        ? await nodeType.execute!(context as unknown as IExecuteFunctions)
        : await nodeType.execute!.call(context as unknown as IExecuteFunctions);

      // `execute()`'s real return type (`NodeOutput`) also allows `null` (no
      // output) and `EngineRequest` (a request for the engine to run a sub-node,
      // e.g. an AI tool call) — neither is meaningful for this package's node
      // types, so treat either as an unsupported shape rather than silently
      // mis-typing it as item data.
      if (output === null) {
        throw new Error(
          `Node "${node.name}" (${node.type}) returned no output from execute().`
        );
      }
      if (!Array.isArray(output)) {
        throw new Error(
          `Node "${node.name}" (${node.type}) returned an EngineRequest from execute() (e.g. a sub-node/tool ` +
            'call) — not supported by this package.'
        );
      }

      if (runExecutionData.waitTill) {
        return {
          status: 'waiting',
          outputItems: output,
          waitTill: runExecutionData.waitTill.getTime(),
        };
      }
      return { status: 'success', outputItems: output };
    }
  );
}
