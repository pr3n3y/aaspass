import { createHash, createHmac } from 'node:crypto';
import { config } from '../config.js';

const enc = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

function signingKey(secret: string, date: string, region: string) {
  const kDate = createHmac('sha256', `AWS4${secret}`).update(date).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update('s3').digest();
  return createHmac('sha256', kService).update('aws4_request').digest();
}

function stamp() {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export function presignPut(key: string, endpoint = config.s3PublicEndpoint): string {
  const url = new URL(endpoint);
  const { amzDate, dateStamp } = stamp();
  const scope = `${dateStamp}/${config.s3Region}/s3/aws4_request`;
  const canonicalUri = `/${config.s3Bucket}/${key.split('/').map(enc).join('/')}`;
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.s3AccessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '300',
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${enc(name)}=${enc(query[name])}`)
    .join('&');
  const canonicalRequest = ['PUT', canonicalUri, canonicalQuery, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signature = createHmac('sha256', signingKey(config.s3SecretKey, dateStamp, config.s3Region))
    .update(stringToSign)
    .digest('hex');
  return `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function signedFetch(method: string, path: string, body?: Buffer, contentType?: string): Promise<Response> {
  const url = new URL(config.s3Endpoint);
  const { amzDate, dateStamp } = stamp();
  const scope = `${dateStamp}/${config.s3Region}/s3/aws4_request`;
  const payloadHash = createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex');
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('');
  const canonicalRequest = [method, path, '', canonicalHeaders, names.join(';'), payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signature = createHmac('sha256', signingKey(config.s3SecretKey, dateStamp, config.s3Region))
    .update(stringToSign)
    .digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.s3AccessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return fetch(`${url.origin}${path}`, {
    method,
    headers: {
      authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(contentType ? { 'content-type': contentType } : {}),
    },
    body: body ? new Uint8Array(body) : undefined,
  });
}

let bucketReady: Promise<void> | null = null;

export function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const path = `/${config.s3Bucket}`;
    const head = await signedFetch('HEAD', path);
    if (head.ok || head.status === 200) return;
    const created = await signedFetch('PUT', path);
    if (!created.ok && created.status !== 409) {
      throw new Error(`bucket ${created.status}`);
    }
  })();
  return bucketReady;
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await ensureBucket();
  const path = `/${config.s3Bucket}/${key.split('/').map(enc).join('/')}`;
  const response = await signedFetch('PUT', path, body, contentType);
  if (!response.ok) throw new Error(`upload ${response.status}`);
}

export async function getObject(key: string): Promise<{ body: Buffer; contentType: string }> {
  await ensureBucket();
  const path = `/${config.s3Bucket}/${key.split('/').map(enc).join('/')}`;
  const response = await signedFetch('GET', path);
  if (!response.ok) throw new Error(`download ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { body: bytes, contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
}
