import type { ProofloopConfig } from './config.js';
import { parseProofloopConfig } from './config.js';
import type { PolicySlice } from './status/policy.js';

export interface RepoRule {
  key: string;
  description: string;
  ruleType: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

const RISK_ORDER = ['critical', 'high', 'medium', 'low'] as const;
type Risk = (typeof RISK_ORDER)[number];

function asRiskList(values: unknown[]): Risk[] {
  return values.filter((x): x is Risk =>
    RISK_ORDER.includes(String(x) as Risk),
  );
}

/** Union risks; never drop levels that were already in the baseline. */
function strengthenBlockOn(base: Risk[], extra: Risk[]): Risk[] {
  const set = new Set<Risk>([...base, ...extra]);
  return RISK_ORDER.filter((r) => set.has(r));
}

const CLAIM_CATS = [
  'security',
  'data',
  'compatibility',
  'functional',
  'architecture',
  'performance',
  'ux',
] as const;

/** Merge DB/UI rules into proofloop.yml policies.
 * Rules may only *tighten* gate policy relative to the yml baseline:
 * - blockOn / requireDynamicVerificationFor: union (never remove baseline entries)
 * - allowNetwork: may only disable if baseline allowed it
 * - maxTotalDurationSeconds: may only shorten
 */
export function mergeRulesIntoConfig(
  base: ProofloopConfig,
  rules: RepoRule[] | undefined,
): ProofloopConfig {
  const enabled = (rules ?? []).filter((r) => r.enabled);
  if (!enabled.length) return base;

  let blockOn = [...base.policies.blockOn] as Risk[];
  let requireDynamic = [...base.policies.requireDynamicVerificationFor];
  let allowNetwork = base.policies.allowNetwork;
  let maxTotalDurationSeconds = base.policies.maxTotalDurationSeconds;
  const commands = { ...base.commands };

  for (const rule of enabled) {
    const cfg = rule.config ?? {};
    if (Array.isArray(cfg.blockOn)) {
      blockOn = strengthenBlockOn(blockOn, asRiskList(cfg.blockOn));
    }
    if (Array.isArray(cfg.requireDynamicVerificationFor)) {
      const extra = cfg.requireDynamicVerificationFor.filter((x) =>
        CLAIM_CATS.includes(String(x) as (typeof CLAIM_CATS)[number]),
      ) as PolicySlice['requireDynamicVerificationFor'];
      requireDynamic = [...new Set([...requireDynamic, ...extra])];
    }
    if (typeof cfg.allowNetwork === 'boolean') {
      // Cannot enable network if yml forbids it; can only further restrict.
      allowNetwork = base.policies.allowNetwork && cfg.allowNetwork && allowNetwork;
    }
    if (typeof cfg.maxTotalDurationSeconds === 'number' && cfg.maxTotalDurationSeconds > 0) {
      maxTotalDurationSeconds = Math.min(maxTotalDurationSeconds, cfg.maxTotalDurationSeconds);
    }
    for (const key of ['lint', 'typecheck', 'unit', 'integration', 'build', 'security'] as const) {
      if (typeof cfg[key] === 'string' && cfg[key]) commands[key] = String(cfg[key]);
    }
  }

  return parseProofloopConfig({
    ...base,
    commands,
    policies: {
      blockOn,
      requireDynamicVerificationFor: requireDynamic,
      allowNetwork,
      maxTotalDurationSeconds,
    },
  });
}

export function summarizeRuleImpact(base: ProofloopConfig, rules: RepoRule[]): {
  before: PolicySlice;
  after: PolicySlice;
  changes: string[];
} {
  const afterCfg = mergeRulesIntoConfig(base, rules);
  const before = base.policies;
  const after = afterCfg.policies;
  const changes: string[] = [];
  if (JSON.stringify(before.blockOn) !== JSON.stringify(after.blockOn)) {
    changes.push(`blockOn: [${before.blockOn}] → [${after.blockOn}]`);
  }
  if (
    JSON.stringify(before.requireDynamicVerificationFor) !==
    JSON.stringify(after.requireDynamicVerificationFor)
  ) {
    changes.push(
      `requireDynamicVerificationFor: [${before.requireDynamicVerificationFor}] → [${after.requireDynamicVerificationFor}]`,
    );
  }
  if (before.allowNetwork !== after.allowNetwork) {
    changes.push(`allowNetwork: ${before.allowNetwork} → ${after.allowNetwork}`);
  }
  if (before.maxTotalDurationSeconds !== after.maxTotalDurationSeconds) {
    changes.push(
      `maxTotalDurationSeconds: ${before.maxTotalDurationSeconds} → ${after.maxTotalDurationSeconds}`,
    );
  }
  if (!changes.length) changes.push('No policy delta vs proofloop.yml defaults');
  return { before, after, changes };
}
