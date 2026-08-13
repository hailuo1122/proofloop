import { describe, expect, it } from 'vitest';
import { parseProofloopConfig } from './config.js';
import { mergeRulesIntoConfig, summarizeRuleImpact } from './rules-merge.js';

describe('mergeRulesIntoConfig', () => {
  it('applies enabled blockOn / requireDynamic from repo rules', () => {
    const base = parseProofloopConfig({});
    const merged = mergeRulesIntoConfig(base, [
      {
        key: 'strict',
        description: 'block medium+',
        ruleType: 'security',
        enabled: true,
        config: {
          blockOn: ['critical', 'high', 'medium'],
          requireDynamicVerificationFor: ['security', 'functional'],
        },
      },
    ]);
    expect(merged.policies.blockOn).toEqual(['critical', 'high', 'medium']);
    expect(merged.policies.requireDynamicVerificationFor).toContain('functional');
  });

  it('never weakens baseline blockOn or requireDynamic', () => {
    const base = parseProofloopConfig({
      policies: {
        blockOn: ['critical', 'high'],
        requireDynamicVerificationFor: ['security', 'compatibility'],
        allowNetwork: false,
        maxTotalDurationSeconds: 600,
      },
    });
    const merged = mergeRulesIntoConfig(base, [
      {
        key: 'weaken',
        description: 'attempt to drop high and enable network',
        ruleType: 'security',
        enabled: true,
        config: {
          blockOn: ['critical'],
          requireDynamicVerificationFor: ['ux'],
          allowNetwork: true,
          maxTotalDurationSeconds: 900,
        },
      },
    ]);
    expect(merged.policies.blockOn).toEqual(['critical', 'high']);
    expect(merged.policies.requireDynamicVerificationFor).toEqual(
      expect.arrayContaining(['security', 'compatibility', 'ux']),
    );
    expect(merged.policies.allowNetwork).toBe(false);
    expect(merged.policies.maxTotalDurationSeconds).toBe(600);
  });

  it('ignores disabled rules', () => {
    const base = parseProofloopConfig({});
    const merged = mergeRulesIntoConfig(base, [
      {
        key: 'x',
        description: 'x',
        ruleType: 'security',
        enabled: false,
        config: { blockOn: ['low'] },
      },
    ]);
    expect(merged.policies.blockOn).toEqual(base.policies.blockOn);
  });

  it('summarizes impact for UI preview', () => {
    const base = parseProofloopConfig({
      policies: {
        blockOn: ['critical', 'high'],
        requireDynamicVerificationFor: ['security'],
        allowNetwork: true,
        maxTotalDurationSeconds: 600,
      },
    });
    const { changes } = summarizeRuleImpact(base, [
      {
        key: 'net',
        description: 'restrict net',
        ruleType: 'command_policy',
        enabled: true,
        config: { allowNetwork: false, blockOn: ['critical', 'high', 'medium'] },
      },
    ]);
    expect(changes.some((c) => c.includes('allowNetwork'))).toBe(true);
    expect(changes.some((c) => c.includes('blockOn'))).toBe(true);
  });
});
