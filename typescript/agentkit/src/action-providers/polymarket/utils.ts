import crypto from "crypto";
import { EvmWalletProvider } from "../../wallet-providers";
import {
  CLOB_API_URL,
  CLOB_AUTH_DOMAIN,
  CLOB_AUTH_MESSAGE,
  CLOB_AUTH_TYPES,
  PUSD_SCALE,
} from "./constants";

/** Derived L2 API credentials returned by the CLOB auth endpoints. */
export interface ApiCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
}

/**
 * Performs a GET request against a JSON HTTP API and parses the response.
 *
 * @param url - The fully-qualified URL to fetch.
 * @returns The parsed JSON body.
 * @throws If the response status is not ok.
 */
export async function httpGetJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * Builds a query string from a record of params, skipping undefined values.
 *
 * @param params - The query parameters.
 * @returns A query string beginning with "?", or an empty string if no params.
 */
export function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.append(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

/**
 * Scales a price/size pair to 6-decimal maker/taker amounts for a CLOB order.
 *
 * For BUY: makerAmount = price * size (pUSD spent), takerAmount = size (shares).
 * For SELL: makerAmount = size (shares sold), takerAmount = price * size (pUSD received).
 *
 * @param side - The order side, "BUY" or "SELL".
 * @param price - The limit price per share (0-1).
 * @param size - The number of shares.
 * @returns The maker and taker amounts as 6-decimal integer strings.
 */
export function scaleAmounts(
  side: "BUY" | "SELL",
  price: number,
  size: number,
): { makerAmount: string; takerAmount: string } {
  const usd = Math.round(price * size * PUSD_SCALE);
  const shares = Math.round(size * PUSD_SCALE);
  if (side === "BUY") {
    return { makerAmount: usd.toString(), takerAmount: shares.toString() };
  }
  return { makerAmount: shares.toString(), takerAmount: usd.toString() };
}

/**
 * Generates a cryptographically-secure random uint256 salt for an order.
 *
 * @returns The salt as a decimal string.
 */
export function generateOrderSalt(): string {
  return BigInt(`0x${crypto.randomBytes(16).toString("hex")}`).toString();
}

/**
 * Computes the Polymarket L2 HMAC request signature.
 *
 * The API secret is url-safe-base64 decoded for use as the HMAC key, the
 * message is `timestamp + method + requestPath + body`, and the digest is
 * encoded as url-safe base64 (NOT hex).
 *
 * @param secret - The derived API secret (url-safe base64 string).
 * @param timestamp - The request timestamp (unix seconds, as string).
 * @param method - The HTTP method, e.g. "POST".
 * @param requestPath - The request path, e.g. "/order".
 * @param body - The exact JSON body string sent with the request, if any.
 * @returns The url-safe base64 HMAC signature.
 */
export function buildPolyHmacSignature(
  secret: string,
  timestamp: string,
  method: string,
  requestPath: string,
  body?: string,
): string {
  const key = Buffer.from(secret, "base64url");
  const message = `${timestamp}${method}${requestPath}${body ?? ""}`;
  const digest = crypto.createHmac("sha256", key).update(message).digest("base64");
  return digest.replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Builds the L1 (EIP-712 ClobAuth) headers used to create/derive API credentials.
 *
 * @param walletProvider - The wallet provider used to sign the ClobAuth struct.
 * @returns The POLY_* L1 headers.
 */
export async function buildL1Headers(
  walletProvider: EvmWalletProvider,
): Promise<Record<string, string>> {
  const address = walletProvider.getAddress();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = 0;

  const signature = await walletProvider.signTypedData({
    domain: CLOB_AUTH_DOMAIN,
    types: CLOB_AUTH_TYPES,
    primaryType: "ClobAuth",
    message: {
      address,
      timestamp,
      nonce,
      message: CLOB_AUTH_MESSAGE,
    },
  });

  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: nonce.toString(),
  };
}

/**
 * Builds the L2 (HMAC) headers used to authenticate CLOB order operations.
 *
 * @param walletProvider - The wallet provider (for the signer address).
 * @param creds - The derived API credentials.
 * @param method - The HTTP method.
 * @param requestPath - The request path.
 * @param body - The exact JSON body string, if any.
 * @returns The POLY_* L2 headers.
 */
export function buildL2Headers(
  walletProvider: EvmWalletProvider,
  creds: ApiCreds,
  method: string,
  requestPath: string,
  body?: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = buildPolyHmacSignature(creds.secret, timestamp, method, requestPath, body);

  return {
    POLY_ADDRESS: walletProvider.getAddress(),
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: creds.apiKey,
    POLY_PASSPHRASE: creds.passphrase,
  };
}

/**
 * Normalizes the API credential response shape from the CLOB auth endpoints.
 *
 * @param data - The raw JSON response.
 * @returns The parsed credentials, or null if the shape is unrecognized.
 */
function parseCreds(data: unknown): ApiCreds | null {
  const obj = data as Record<string, string> | null;
  if (!obj) {
    return null;
  }
  const apiKey = obj.apiKey ?? obj.api_key;
  const secret = obj.secret ?? obj.api_secret;
  const passphrase = obj.passphrase ?? obj.api_passphrase;
  if (apiKey && secret && passphrase) {
    return { apiKey, secret, passphrase };
  }
  return null;
}

/**
 * Derives (or creates) L2 API credentials using L1 EIP-712 authentication.
 *
 * Tries GET /auth/derive-api-key first (deterministic from the signing key),
 * then falls back to POST /auth/api-key to create new credentials.
 *
 * @param walletProvider - The wallet provider used for L1 signing.
 * @returns The derived API credentials.
 * @throws If neither endpoint returns valid credentials.
 */
export async function deriveApiCreds(walletProvider: EvmWalletProvider): Promise<ApiCreds> {
  // Try to derive existing credentials.
  const deriveHeaders = await buildL1Headers(walletProvider);
  const deriveResp = await fetch(`${CLOB_API_URL}/auth/derive-api-key`, {
    method: "GET",
    headers: deriveHeaders,
  });
  if (deriveResp.ok) {
    const creds = parseCreds(await deriveResp.json());
    if (creds) {
      return creds;
    }
  }

  // Fall back to creating new credentials (fresh L1 headers / timestamp).
  const createHeaders = await buildL1Headers(walletProvider);
  const createResp = await fetch(`${CLOB_API_URL}/auth/api-key`, {
    method: "POST",
    headers: createHeaders,
  });
  if (createResp.ok) {
    const creds = parseCreds(await createResp.json());
    if (creds) {
      return creds;
    }
  }

  throw new Error("Failed to derive or create Polymarket API credentials");
}
