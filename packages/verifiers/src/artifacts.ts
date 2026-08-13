import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createId, type Artifact, type ArtifactKind } from '@proofloop/core';

export function saveArtifact(input: {
  runId: string;
  kind: ArtifactKind;
  storageRoot: string;
  content: string | Buffer;
  redacted: boolean;
  filename: string;
}): Artifact {
  const buf = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content;
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const id = createId('artifact');
  const storagePath = join(input.storageRoot, input.runId, input.filename);
  mkdirSync(dirname(storagePath), { recursive: true });
  writeFileSync(storagePath, buf);
  return {
    id,
    runId: input.runId,
    kind: input.kind,
    storagePath,
    sha256,
    sizeBytes: buf.byteLength,
    redacted: input.redacted,
  };
}

export function environmentFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  const keys = ['NODE_VERSION', 'OS', 'PROCESSOR_ARCHITECTURE', 'ComSpec', 'SHELL'];
  const parts = [
    `node=${process.version}`,
    `platform=${process.platform}`,
    `arch=${process.arch}`,
    ...keys.map((k) => `${k}=${env[k] ? 'set' : 'unset'}`),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}
