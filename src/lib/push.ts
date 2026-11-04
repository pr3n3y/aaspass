import { createSign, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type PushMessage = {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
};

export interface PushProvider {
  send(message: PushMessage): Promise<void>;
}

export class ConsolePushProvider implements PushProvider {
  async send(message: PushMessage): Promise<void> {
    console.info(`[push:console] ${message.title}`);
  }
}

type ServiceAccount = {
  client_email: string;
  private_key: string;
  project_id: string;
};

let cachedToken: { value: string; expiresAt: number } | null = null;

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

async function googleAccessToken(credentialsPath: string): Promise<{ token: string; projectId: string }> {
  const account = JSON.parse(readFileSync(credentialsPath, 'utf8')) as ServiceAccount;
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return { token: cachedToken.value, projectId: account.project_id };
  }
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(account.private_key).toString('base64url')}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) {
    throw new Error(`FCM auth failed with status ${response.status}`);
  }
  const json = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: now + json.expires_in };
  return { token: json.access_token, projectId: account.project_id };
}

/** Firebase Cloud Messaging HTTP v1. Used when PUSH_PROVIDER=fcm and a service account file is set. */
export class FcmPushProvider implements PushProvider {
  constructor(private readonly credentialsPath: string) {}

  async send(message: PushMessage): Promise<void> {
    const { token, projectId } = await googleAccessToken(this.credentialsPath);
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token: message.token,
          notification: { title: message.title, body: message.body },
          data: message.data ?? {},
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`FCM send failed with status ${response.status}`);
    }
  }
}

export function createPushProvider(kind: string, credentialsPath: string): PushProvider {
  if (kind === 'fcm' && credentialsPath) return new FcmPushProvider(credentialsPath);
  return new ConsolePushProvider();
}

export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}
