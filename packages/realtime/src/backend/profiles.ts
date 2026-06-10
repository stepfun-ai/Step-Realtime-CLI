import type { BackendCapabilities } from "./types.js";

/** Backend ids supported by the realtime SDK. */
export type BackendId = "stepfun_stateless";

/**
 * Per-backend routing + credential profile.
 *
 * This table is the single source of truth for "which endpoint / model /
 * default voice / credential a given backend uses". Both the standalone
 * web harness and step-cli consume it via {@link buildBackendOptions} so
 * the two hosts never re-derive (and diverge on) this mapping.
 */
export interface BackendProfile {
  id: BackendId;
  /** Upstream realtime WebSocket endpoint. */
  endpoint: string;
  /** Default audio model. */
  model: string;
  /** Default voice id. */
  defaultVoice: string;
  /** Credential label the host's {@link CredentialResolver} must resolve. */
  credentialLabel: string;
  capabilities: BackendCapabilities;
}

export const BACKEND_PROFILES: Record<BackendId, BackendProfile> = {
  stepfun_stateless: {
    id: "stepfun_stateless",
    endpoint: "wss://api.stepfun.com/v1/realtime/stateless",
    model: "step-overture-preview",
    defaultVoice: "jingdiannvsheng",
    credentialLabel: "stepfun",
    capabilities: {
      nativeFunctionCalling: true,
      modelMaintainsHistory: false,
      serverVad: false,
      audioOutput: true,
    },
  },
};

/** Credential resolved by the host for a given label. */
export interface ResolvedCredential {
  apiKey: string;
  /** Optional endpoint override; falls back to the profile default. */
  endpoint?: string;
}

/**
 * Host-provided credential lookup. The SDK does not know where credentials
 * live (secrets.json, step-cli config, env): the host implements this and
 * maps a label → key/endpoint.
 */
export interface CredentialResolver {
  resolve(label: string): ResolvedCredential | undefined;
}

/** Connection options shared by all stepfun backend adapters. */
export interface BackendConnectionOptions {
  apiKey: string;
  endpoint: string;
  model: string;
  voice: string;
}

export interface BuildBackendOverrides {
  model?: string;
  voice?: string;
  endpoint?: string;
}

/**
 * Compose adapter connection options from a backend profile + a host
 * credential resolver. Throws when the host cannot supply the credential the
 * backend requires (e.g. selecting stepfun_stateless without a "stepfun"
 * key) — callers should catch and degrade rather than connect with a wrong
 * key/endpoint.
 */
export function buildBackendOptions(
  backendId: BackendId,
  resolver: CredentialResolver,
  overrides?: BuildBackendOverrides,
): BackendConnectionOptions {
  const profile = BACKEND_PROFILES[backendId];
  if (!profile) {
    throw new Error(`unknown realtime backend: ${String(backendId)}`);
  }
  const cred = resolver.resolve(profile.credentialLabel);
  if (!cred?.apiKey) {
    throw new Error(
      `missing realtime credential for backend "${backendId}" ` +
        `(credential label "${profile.credentialLabel}")`,
    );
  }
  return {
    apiKey: cred.apiKey,
    endpoint: overrides?.endpoint ?? cred.endpoint ?? profile.endpoint,
    model: overrides?.model ?? profile.model,
    voice: overrides?.voice ?? profile.defaultVoice,
  };
}
