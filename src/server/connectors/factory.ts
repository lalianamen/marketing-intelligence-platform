import { googleOAuthConfigured, type ServerConfig } from "../config";
import { Ga4Connector } from "./ga4";
import { GoogleAdsConnector } from "./googleAds";
import { SearchConsoleConnector } from "./searchConsole";
import { ClarityConnector } from "./clarity";
import { StripeConnector } from "./stripe";
import { BingWebmasterConnector } from "./bing";
import { MetaAdsConnector } from "./meta";
import { SimulatedConnector } from "./simulated";
import { type Connector, ConnectorError } from "./types";
import type { FetchLike } from "./google";

export function connectorFor(
  providerId: string,
  mode: "live" | "simulated" | "manual",
  cfg: ServerConfig,
  fetchImpl?: FetchLike,
): Connector {
  if (providerId === "stripe") {
    if (mode !== "live") throw new ConnectorError("not_configured", "no sample data for Stripe");
    return new StripeConnector({ fetch: fetchImpl });
  }
  if (providerId === "meta_ads") {
    if (mode !== "live") throw new ConnectorError("not_configured", "no sample data for Meta Ads");
    if (!cfg.meta.appId || !cfg.meta.appSecret) throw new ConnectorError("not_configured", "Facebook sign-in is not configured by the administrator");
    return new MetaAdsConnector({ appId: cfg.meta.appId, appSecret: cfg.meta.appSecret, apiVersion: cfg.meta.apiVersion, fetch: fetchImpl });
  }
  if (providerId === "bing_webmaster") {
    if (mode !== "live") throw new ConnectorError("not_configured", "no sample data for Bing Webmaster Tools");
    return new BingWebmasterConnector({
      fetch: fetchImpl,
      oauth: cfg.bing.clientId && cfg.bing.clientSecret ? { clientId: cfg.bing.clientId, clientSecret: cfg.bing.clientSecret } : undefined,
    });
  }
  if (providerId === "microsoft_clarity") {
    if (mode !== "live") throw new ConnectorError("not_configured", "no sample data for Clarity");
    return new ClarityConnector({ fetch: fetchImpl });
  }
  if (providerId !== "ga4" && providerId !== "google_ads" && providerId !== "google_search_console") {
    throw new ConnectorError("not_configured", `no API connector for provider ${providerId}`);
  }
  if (mode === "simulated") {
    if (providerId === "google_search_console") throw new ConnectorError("not_configured", "no sample data for Search Console");
    return new SimulatedConnector(providerId);
  }
  if (mode !== "live") throw new ConnectorError("not_configured", `unsupported mode ${mode}`);
  if (!googleOAuthConfigured(cfg)) {
    throw new ConnectorError("not_configured", "Google OAuth is not configured by the administrator");
  }
  const base = { clientId: cfg.google.clientId!, clientSecret: cfg.google.clientSecret!, fetch: fetchImpl };
  if (providerId === "ga4") return new Ga4Connector(base);
  if (providerId === "google_search_console") return new SearchConsoleConnector(base);
  return new GoogleAdsConnector({
    ...base,
    apiVersion: cfg.google.adsApiVersion,
    developerToken: cfg.google.adsDeveloperToken,
    loginCustomerId: cfg.google.adsLoginCustomerId,
  });
}
