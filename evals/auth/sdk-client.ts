/**
 * sdk-client.ts — the MCP SDK v2 client (2.1.0) against a tier's `/mcp`, as a
 * connector would run it (SMD-2285 criterion 3).
 *
 * The SDK does everything a real client does: its first connect meets the 401,
 * reads the protected-resource metadata the challenge names, discovers the
 * authorization server from the issuer, and then either presents its metadata
 * document URL as `client_id` (when the server advertises CIMD and the
 * provider has one) or registers through DCR. It sends PKCE and `resource`.
 * The verifier's Browser stands in for the user at the sign-in and consent
 * pages, and the SDK redeems the code, checking `iss` (RFC 9207). A second
 * connect with the stored token then calls the stand-in's `whoami` tool, which
 * travels the exchange to the REST core.
 */
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/client";
import type { Browser } from "./flows.ts";
import { NATIVE_REDIRECT } from "./policy.ts";

type Provider = OAuthClientProvider & { authUrl?: URL };

function memoryProvider(metadataUrl?: string): Provider {
  let info: unknown;
  let tokens: unknown;
  let verifier = "";
  let discovery: unknown;
  const p = {
    authUrl: undefined as URL | undefined,
    clientMetadataUrl: metadataUrl,
    get redirectUrl() {
      return NATIVE_REDIRECT;
    },
    get clientMetadata() {
      return { client_name: "Open Brain POC client (DCR)", redirect_uris: [NATIVE_REDIRECT], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" };
    },
    clientInformation: () => info,
    saveClientInformation: (i: unknown) => {
      info = i;
    },
    tokens: () => tokens,
    saveTokens: (t: unknown) => {
      tokens = t;
    },
    redirectToAuthorization: (url: URL) => {
      p.authUrl = url;
    },
    saveCodeVerifier: (v: string) => {
      verifier = v;
    },
    codeVerifier: () => verifier,
    saveDiscoveryState: (s: unknown) => {
      discovery = s;
    },
    discoveryState: () => discovery,
  };
  return p as unknown as Provider;
}

export type SdkRun = {
  /** The authorization URL the SDK built: its client_id, resource, PKCE and scope are read from it. */
  authUrl: URL;
  /** Every request the SDK made, as `METHOD url`: a DCR registration is a POST to the registration endpoint. */
  requests: string[];
  accessToken: string;
  /** What `whoami` returned: the REST core's view after the exchange. */
  tool: { isError?: boolean; text: string };
};

export async function sdkFlow(serverUrl: string, browser: Browser, metadataUrl?: string): Promise<SdkRun> {
  const provider = memoryProvider(metadataUrl);
  const requests: string[] = [];
  const recording = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${input instanceof Request ? input.url : String(input)}`);
    return fetch(input, init);
  }) as typeof fetch;
  const first = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider, fetch: recording });
  try {
    await new Client({ name: "ob1-auth-poc", version: "0.0.0" }).connect(first);
    throw new Error("the SDK connected without authorization");
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
  }
  if (!provider.authUrl) throw new Error("the SDK never asked to redirect to the authorization server");
  const authUrl = provider.authUrl;
  await first.finishAuth(await browser.authorize(authUrl, NATIVE_REDIRECT));

  const client = new Client({ name: "ob1-auth-poc", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider, fetch: recording }));
  const result = (await client.callTool({ name: "whoami", arguments: {} })) as { isError?: boolean; content?: { type: string; text?: string }[] };
  await client.close();
  const tokens = (await provider.tokens()) as { access_token?: string } | undefined;
  return {
    authUrl,
    requests,
    accessToken: tokens?.access_token ?? "",
    tool: { isError: result.isError, text: result.content?.find((c) => c.type === "text")?.text ?? "" },
  };
}
