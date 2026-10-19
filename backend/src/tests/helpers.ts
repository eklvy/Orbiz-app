import request from 'supertest';
import { parseEnv, type Env } from '../config/env.js';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import type { GoogleOAuthClient, GoogleProfile } from '../modules/auth/google.js';
import type { ChatProvider } from '../modules/bitebot/bitebot.provider.js';

export const FRONTEND = 'http://localhost:5173';

/** The validated test environment with optional overrides. */
export function testConfig(overrides: Record<string, string> = {}): Env {
  return parseEnv({ ...process.env, ...overrides });
}

/**
 * Stand-in for Google, used ONLY by automated tests. It never verifies real
 * tokens; it returns whatever profile the test registered for a code. Results
 * from it are not evidence that real Google sign-in works.
 */
export class FakeGoogle implements GoogleOAuthClient {
  lastAuthParams: { state: string; nonce: string; codeChallenge: string } | null = null;
  private profiles = new Map<string, Omit<GoogleProfile, 'nonce'> & { nonce?: string | null }>();
  failNextExchange = false;

  async createPkcePair() {
    return { codeVerifier: 'verifier-' + Math.random(), codeChallenge: 'challenge' };
  }

  buildAuthUrl(params: { state: string; nonce: string; codeChallenge: string }) {
    this.lastAuthParams = params;
    const query = new URLSearchParams({ ...params });
    return `https://accounts.google.test/o/oauth2/auth?${query}`;
  }

  /** Registers the profile Google would return for an authorization code. */
  willReturn(code: string, profile: Partial<GoogleProfile> & { subject: string; email: string }) {
    this.profiles.set(code, {
      emailVerified: true,
      name: 'Test Person',
      picture: null,
      ...profile,
    });
  }

  async exchangeCode({ code }: { code: string; codeVerifier: string }): Promise<GoogleProfile> {
    if (this.failNextExchange) {
      this.failNextExchange = false;
      throw new Error('invalid_grant');
    }
    const profile = this.profiles.get(code);
    if (!profile) throw new Error('unknown code');
    return {
      ...profile,
      // By default echo the nonce from the sign-in request, as Google does.
      nonce: profile.nonce === undefined ? (this.lastAuthParams?.nonce ?? null) : profile.nonce,
    };
  }
}

export function buildTestApp(
  options: { config?: Env; google?: GoogleOAuthClient | null; chatProvider?: ChatProvider | null } = {},
) {
  return createApp({
    db: prisma,
    config: options.config ?? testConfig(),
    google: options.google === undefined ? null : options.google,
    chatProvider: options.chatProvider,
  });
}

type Agent = ReturnType<typeof request.agent>;

/** Runs the whole Google flow through the app and returns the signed-in agent. */
export async function signInWithFakeGoogle(
  agent: Agent,
  google: FakeGoogle,
  profile: Partial<GoogleProfile> & { subject: string; email: string },
  returnTo = '/',
) {
  const code = `code-${profile.subject}-${Math.random()}`;
  google.willReturn(code, profile);
  await agent.get(`/api/v1/auth/google?returnTo=${encodeURIComponent(returnTo)}`).expect(303);
  const state = google.lastAuthParams!.state;
  return agent.get(`/api/v1/auth/google/callback?state=${state}&code=${code}`);
}

/** Signs in through the developer login (test environment only). */
export async function devLogin(agent: Agent, email: string, displayName?: string) {
  return agent
    .post('/api/v1/auth/dev-login')
    .set('X-Requested-With', 'CampusCart')
    .send({ email, displayName })
    .expect(200);
}
