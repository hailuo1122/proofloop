import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Evidence storage abstraction — local disk by default, S3/MinIO when
 * `S3_BUCKET` is configured. The S3 client is dependency-free: AWS SigV4
 * signing over fetch (path-style for MinIO, virtual-host for AWS).
 */

export interface EvidenceStorage {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
}

function s3Configured(): boolean {
  return Boolean(process.env.S3_BUCKET);
}

/* ------------------------------------------------------------------ */
/* Local backend                                                       */
/* ------------------------------------------------------------------ */

class LocalStorage implements EvidenceStorage {
  constructor(private root: string) {}

  private resolve(key: string): string {
    // keys are `evidence/<runId>.json` — no traversal allowed
    if (key.includes('..') || key.startsWith('/')) {
      throw new Error(`invalid storage key: ${key}`);
    }
    return join(this.root, key);
  }

  async put(key: string, body: string): Promise<void> {
    const abs = this.resolve(key);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }

  async get(key: string): Promise<string | null> {
    const abs = this.resolve(key);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, 'utf8');
  }
}

/* ------------------------------------------------------------------ */
/* S3 backend (SigV4 over fetch)                                       */
/* ------------------------------------------------------------------ */

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

async function signingKey(secret: string, dateStamp: string, region: string): Promise<Buffer> {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

interface S3Options {
  endpoint: string; // e.g. https://s3.amazonaws.com or http://localhost:9000
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

function s3Options(): S3Options {
  const endpoint = (process.env.S3_ENDPOINT ?? 'https://s3.amazonaws.com').replace(/\/$/, '');
  const bucket = process.env.S3_BUCKET!;
  const region = process.env.S3_REGION ?? 'us-east-1';
  const accessKey = process.env.S3_ACCESS_KEY_ID ?? '';
  const secretKey = process.env.S3_SECRET_ACCESS_KEY ?? '';
  if (!accessKey || !secretKey) {
    throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required when S3_BUCKET is set');
  }
  return { endpoint, bucket, region, accessKey, secretKey };
}

/** MinIO and other S3-compatible stores use path-style; AWS uses virtual-host. */
function objectUrl(opts: S3Options, key: string): string {
  const host = new URL(opts.endpoint).host;
  if (host.endsWith('amazonaws.com')) {
    return `${opts.endpoint}/${opts.bucket}/${encodeURIComponent(key)}`;
  }
  return `${opts.endpoint}/${opts.bucket}/${encodeURIComponent(key)}`;
}

async function signAndFetch(
  opts: S3Options,
  method: 'GET' | 'PUT',
  key: string,
  body?: string,
): Promise<Response> {
  const url = objectUrl(opts, key);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = body === undefined ? EMPTY_SHA256 : sha256Hex(body);

  const canonicalHeaders = `host:${new URL(url).host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    new URL(url).pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${opts.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const keySig = await signingKey(opts.secretKey, dateStamp, opts.region);
  const signature = hmac(keySig, stringToSign).toString('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(url, {
    method,
    headers: {
      host: new URL(url).host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization,
      ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
    },
    body,
  });
}

class S3Storage implements EvidenceStorage {
  private opts: S3Options;

  constructor() {
    this.opts = s3Options();
  }

  async put(key: string, body: string): Promise<void> {
    const res = await signAndFetch(this.opts, 'PUT', key, body);
    if (!res.ok) {
      throw new Error(`S3 put ${key} failed: ${res.status} ${await res.text()}`);
    }
  }

  async get(key: string): Promise<string | null> {
    const res = await signAndFetch(this.opts, 'GET', key);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`S3 get ${key} failed: ${res.status} ${await res.text()}`);
    }
    return res.text();
  }
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

let instance: EvidenceStorage | null = null;

export function getEvidenceStorage(): EvidenceStorage {
  if (instance) return instance;
  if (s3Configured()) {
    instance = new S3Storage();
  } else {
    const root = process.env.PROOFLOOP_EVIDENCE_ROOT ?? join(process.cwd(), '.data', 'evidence');
    instance = new LocalStorage(root);
  }
  return instance;
}

export function resetEvidenceStorageForTests() {
  instance = null;
}

export function evidenceConfigured(): boolean {
  return s3Configured();
}
