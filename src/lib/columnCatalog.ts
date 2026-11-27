// Column catalogs per connector (one table per connector; base columns always
// on, optional fields chosen by the user). GA4 keeps its own module and limits;
// other providers use the generic helpers below.

import {
  GA4_GROUPS,
  GA4_MAX_DIMENSIONS,
  GA4_MAX_METRICS,
  type Ga4Group,
  ga4Fields,
  ga4SelectionProblem,
  sanitizeGa4Selection,
} from "./ga4Catalog";
import { GSC_GROUPS } from "./gscCatalog";
import { CLARITY_GROUPS, CLARITY_MAX_BREAKDOWNS } from "./clarityCatalog";
import { STRIPE_GROUPS } from "./stripeCatalog";
import { BING_GROUPS, BING_MAX_BREAKDOWNS } from "./bingCatalog";
import { META_GROUPS, META_MAX_BREAKDOWNS } from "./metaCatalog";
import { APP_DB_GROUPS } from "./appDbCatalog";

export interface ColumnCatalog {
  provider: string;
  /** Key in company_connections.settings that stores the chosen field names. */
  settingsKey: string;
  groups: Ga4Group[];
  maxDimensions: number | null;
  maxMetrics: number | null;
  /** Limit on chosen breakdowns (base columns not counted), when the source has one. */
  maxBreakdowns?: number;
  /** The numbers are whatever the source returns (columns read from the stored rows). */
  metricsFromData?: boolean;
  sanitize(items: unknown): string[];
  fields(selection: unknown): { dimensions: string[]; metrics: string[] };
  problem(selection: unknown): string | null;
}

function generic(
  provider: string,
  settingsKey: string,
  groups: Ga4Group[],
  opts: { maxBreakdowns?: number; metricsFromData?: boolean; sourceName?: string } = {},
): ColumnCatalog {
  const core = groups.find((g) => g.core)!;
  const optional = groups
    .filter((g) => !g.core)
    .flatMap((g) => [
      ...g.dimensions.map((f) => ({ name: f.name, group: g.id, kind: "dimension" as const })),
      ...g.metrics.map((f) => ({ name: f.name, group: g.id, kind: "metric" as const })),
    ]);
  const sanitize = (items: unknown) => {
    const list = Array.isArray(items) ? items.map(String) : [];
    return optional.filter((f) => list.includes(f.name) || list.includes(f.group)).map((f) => f.name);
  };
  return {
    provider,
    settingsKey,
    groups,
    maxDimensions: null,
    maxMetrics: null,
    sanitize,
    fields(selection) {
      const chosen = sanitize(selection);
      const dimensions = core.dimensions.map((d) => d.name);
      const metrics = core.metrics.map((m) => m.name);
      for (const f of optional) if (chosen.includes(f.name)) (f.kind === "dimension" ? dimensions : metrics).push(f.name);
      return { dimensions, metrics };
    },
    maxBreakdowns: opts.maxBreakdowns,
    metricsFromData: opts.metricsFromData,
    problem(selection) {
      if (opts.maxBreakdowns === undefined) return null;
      const n = optional.filter((f) => f.kind === "dimension" && sanitize(selection).includes(f.name)).length;
      return n > opts.maxBreakdowns
        ? `${opts.sourceName ?? provider} allows at most ${opts.maxBreakdowns} breakdowns in one table; this choice needs ${n}. Switch another breakdown off first.`
        : null;
    },
  };
}

const CATALOGS: Record<string, ColumnCatalog> = {
  ga4: {
    provider: "ga4",
    settingsKey: "ga4_reports",
    groups: GA4_GROUPS,
    maxDimensions: GA4_MAX_DIMENSIONS,
    maxMetrics: GA4_MAX_METRICS,
    sanitize: sanitizeGa4Selection,
    fields: ga4Fields,
    problem: ga4SelectionProblem,
  },
  google_search_console: generic("google_search_console", "columns", GSC_GROUPS),
  stripe: generic("stripe", "columns", STRIPE_GROUPS),
  app_database: generic("app_database", "columns", APP_DB_GROUPS),
  meta_ads: generic("meta_ads", "columns", META_GROUPS, { maxBreakdowns: META_MAX_BREAKDOWNS, sourceName: "Meta" }),
  bing_webmaster: generic("bing_webmaster", "columns", BING_GROUPS, { maxBreakdowns: BING_MAX_BREAKDOWNS, sourceName: "Bing" }),
  microsoft_clarity: generic("microsoft_clarity", "columns", CLARITY_GROUPS, { maxBreakdowns: CLARITY_MAX_BREAKDOWNS, metricsFromData: true, sourceName: "Clarity" }),
};

/** The column catalog of a provider, or null when its table has fixed columns. */
export function columnCatalog(provider: string): ColumnCatalog | null {
  return CATALOGS[provider] ?? null;
}

/** Is `item` a field name or group id of the catalog (core excluded)? */
export function isCatalogItem(cat: ColumnCatalog, item: string): boolean {
  return cat.groups.some((g) => !g.core && (g.id === item || [...g.dimensions, ...g.metrics].some((f) => f.name === item)));
}
