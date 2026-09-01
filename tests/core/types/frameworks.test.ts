// Copyright (c) 2026-Present Diagrid Inc.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';

import {
  ALL_SUPPORTED_FRAMEWORKS,
  buildWorkflowName,
  isSupportedFramework,
  SupportedFrameworks,
} from '@diagrid/agent-core';

describe('SupportedFrameworks', () => {
  it('enumerates every declared framework', () => {
    expect(ALL_SUPPORTED_FRAMEWORKS).toEqual(
      Object.values(SupportedFrameworks)
    );
  });

  it('narrows a known framework label', () => {
    expect(isSupportedFramework('Mastra')).toBe(true);
    expect(isSupportedFramework('LangGraph')).toBe(false);
    expect(isSupportedFramework('')).toBe(false);
  });

  it('is case-sensitive, because the label is the registry value', () => {
    expect(isSupportedFramework('mastra')).toBe(false);
  });

  it('yields a valid workflow-name segment for every framework', () => {
    // Adding a framework whose label does not survive lower-casing into a
    // clean segment would produce workflow names the other language SDKs
    // cannot construct.
    for (const framework of ALL_SUPPORTED_FRAMEWORKS) {
      const name = buildWorkflowName(framework, 'agent');
      expect(name).toMatch(/^dapr\.[a-z0-9]+\.Agent\.workflow$/);
    }
  });
});
