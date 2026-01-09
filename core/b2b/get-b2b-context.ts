// core/lib/b2b/get-b2b-context.ts
import { cookies } from "next/headers";

import { client } from "~/client";
import { graphql } from "~/client/graphql";
import { getSessionCustomerAccessToken } from "~/auth";

export type B2BContext =
  | { state: "guest" }
  | {
      state: "logged-in";
      customerAccessToken: string;
      customerEntityId: number;
      email?: string;

      // Step 2 additions:
      bcCurrentCustomerJwt?: string;
      b2bStorefrontAuthToken?: string;
    };

const GET_CURRENT_CUSTOMER = graphql(`
  query GetCurrentCustomer {
    customer {
      entityId
      email
    }
  }
`);

/**
 * Calls the BigCommerce Current Customer API to obtain a JWT for the active storefront session.
 * B2B docs: /customer/current.jwt?$app_client_id=... :contentReference[oaicite:4]{index=4}
 */
async function getCurrentCustomerJwtFromStorefront(): Promise<string | null> {
  const origin = process.env.BC_STOREFRONT_ORIGIN;
  const appClientId =
    process.env.B2B_APP_CLIENT_ID ?? "dl7c39mdpul6hyc489yk0vzxl6jesyx"; // documented B2B app client id :contentReference[oaicite:5]{index=5}

  if (!origin) {
    throw new Error("Missing env var BC_STOREFRONT_ORIGIN");
  }

  // Forward cookies from the incoming request to the BigCommerce storefront domain.
  // This is required because current.jwt is based on the shopper's session. :contentReference[oaicite:6]{index=6}
  const cookieHeader = cookies()
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const url = `${origin.replace(/\/$/, "")}/customer/current.jwt?$app_client_id=${encodeURIComponent(
    appClientId,
  )}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    cache: "no-store",
  });

  // When browsing as a guest, Current Customer API returns 404. :contentReference[oaicite:7]{index=7}
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Current Customer JWT request failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as { jwtString?: string };
  return json.jwtString ?? null;
}

/**
 * Exchanges the BigCommerce Current Customer JWT for a B2B storefront authToken via
 * the `authorization` mutation. :contentReference[oaicite:8]{index=8}
 */
async function getB2BStorefrontAuthToken(bcTokenJwt: string): Promise<string | null> {
  const channelIdRaw = process.env.BC_CHANNEL_ID;
  const channelId = channelIdRaw ? Number(channelIdRaw) : 1;

  // B2B GraphQL Storefront API base URL :contentReference[oaicite:9]{index=9}
  const res = await fetch("https://api-b2b.bigcommerce.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: `
        mutation B2BAuthorization($bcToken: String!, $channelId: Int!) {
          authorization(authData: { bcToken: $bcToken, channelId: $channelId }) {
            result { token }
          }
        }
      `,
      variables: { bcToken: bcTokenJwt, channelId },
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`B2B authorization mutation failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as any;
  const token = json?.data?.authorization?.result?.token;
  return typeof token === "string" && token.length ? token : null;
}

export async function getB2BContext(): Promise<B2BContext> {
  // Step 1: Determine guest vs logged-in using Catalyst session CAT
  const customerAccessToken = await getSessionCustomerAccessToken();

  if (!customerAccessToken) {
    return { state: "guest" };
  }

  try {
    const res = await client.fetch({
      document: GET_CURRENT_CUSTOMER,
      customerAccessToken,
    });

    const customer = res.data?.customer;
    if (!customer?.entityId) return { state: "guest" };

    // Step 2: Try to obtain B2B storefront authToken (best-effort).
    // If this fails, we still return logged-in so PDP doesn't break.
    let bcCurrentCustomerJwt: string | undefined;
    let b2bStorefrontAuthToken: string | undefined;

    try {
      const jwt = await getCurrentCustomerJwtFromStorefront();
      if (jwt) {
        bcCurrentCustomerJwt = jwt;
        const token = await getB2BStorefrontAuthToken(jwt);
        if (token) b2bStorefrontAuthToken = token;
      }
    } catch {
      // swallow errors; we’ll use Step 1 behavior if B2B token can't be retrieved yet
    }

    return {
      state: "logged-in",
      customerAccessToken,
      customerEntityId: customer.entityId,
      email: customer.email ?? undefined,
      bcCurrentCustomerJwt,
      b2bStorefrontAuthToken,
    };
  } catch {
    return { state: "guest" };
  }
}
