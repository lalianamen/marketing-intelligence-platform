import { googleOAuthConfigured, type ServerConfig } from "../config";
import { Ga4Connector } from "./ga4";
import { GoogleAdsConnector } from "./googleAds";
import { SearchConsoleConnector } from "./searchConsole";
import { SimulatedConnector } from "./simulated";
import { type Connector, ConnectorError } from "./types";
import type { FetchLike } from "./google";

export function connectorFor(
  providerId: string,
  mode: "live" | "simulated" | "manual",
  cfg: ServerConfig,
  fetchImpl?: FetchLike,
): Connector {
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
