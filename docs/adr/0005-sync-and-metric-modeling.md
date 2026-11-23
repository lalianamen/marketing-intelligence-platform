# ADR-0005: Sync and metric modeling

Status: accepted · 2026-11-23

## Decision
- Layers: RAW (source-faithful, per sync run) → NORMALIZED (grain date × origin × source × account × campaign) → MART (date × origin × source × currency).
- Incremental sync by cursor plus a provider **lookback** re-fetch (GA4 3 d, Google Ads 14 d), MERGE by grain, so late data
  corrects history without double counting. History is never truncated to a rolling window.
- Recent dates are marked `preliminary`. Completeness is validated, and gaps are reported, never filled.
- NULL means not available. Ratios use paired sums. Money ratios need a single currency (no FX in Phase 1).
- Conversions keep their type (`ad_platform_conversion`, `ga4_key_event`, `csv_conversion`) and are never summed across
  sources. There is no cross-channel deduplication without identity/attribution evidence.
- Revenue is split into attributed (platform-reported) and billed (CSV `revenue_type=billed`). CAC/ROI are not computed.
- Simulated rows are flagged in every layer and excluded from blended totals when real data exists.

## Consequences
The dashboard is honest but shows more "Not available" for sparse sources. Adding FX or attribution later is additive.
