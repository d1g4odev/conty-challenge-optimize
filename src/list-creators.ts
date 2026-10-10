import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { niches_json: string };
type CountRow = { n: number };
type PageRow = CreatorMatch & { total: number };

const MATCHED = `
  matched AS (
    SELECT creators.id, creators.name, COUNT(*) AS niche_score
    FROM creators
    JOIN json_each(creators.niches_json) AS creator_niche
    JOIN json_each(?) AS campaign_niche ON campaign_niche.value = creator_niche.value
    GROUP BY creators.id
  )`;

const PAGE_SQL = `
  WITH ${MATCHED},
  ranked_metrics AS (
    SELECT social_accounts.creator_id, metrics.views,
      ROW_NUMBER() OVER (
        PARTITION BY metrics.account_id
        ORDER BY metrics.captured_at DESC, metrics.id DESC
      ) AS position
    FROM metrics
    JOIN social_accounts ON social_accounts.id = metrics.account_id
    WHERE social_accounts.creator_id IN (SELECT id FROM matched)
  ),
  reach AS (
    SELECT creator_id, SUM(views) AS latest_reach
    FROM ranked_metrics
    WHERE position = 1
    GROUP BY creator_id
  ),
  recent AS (
    SELECT creator_id, COUNT(*) AS deliveries_90d
    FROM deliveries
    WHERE delivered_at >= ? AND creator_id IN (SELECT id FROM matched)
    GROUP BY creator_id
  )
  SELECT matched.id, matched.name, matched.niche_score,
    COALESCE(reach.latest_reach, 0) AS latest_reach,
    COALESCE(recent.deliveries_90d, 0) AS deliveries_90d,
    COUNT(*) OVER () AS total
  FROM matched
  LEFT JOIN reach ON reach.creator_id = matched.id
  LEFT JOIN recent ON recent.creator_id = matched.id
  ORDER BY matched.niche_score DESC, latest_reach DESC, matched.id COLLATE BINARY ASC
  LIMIT ? OFFSET ?`;

const TOTAL_SQL = `WITH ${MATCHED} SELECT COUNT(*) AS n FROM matched`;

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(db, "SELECT niches_json FROM campaigns WHERE id = ?", input.campaignId);
  if (!campaign) return null;

  const rows = await all<PageRow>(
    db,
    PAGE_SQL,
    campaign.niches_json,
    deliveriesSince(),
    input.limit,
    input.offset,
  );

  const total = rows[0]?.total ?? (await get<CountRow>(db, TOTAL_SQL, campaign.niches_json))?.n ?? 0;

  return {
    campaign_id: input.campaignId,
    total: Number(total),
    creators: rows.map((row) => ({
      id: row.id,
      name: row.name,
      niche_score: Number(row.niche_score),
      latest_reach: Number(row.latest_reach),
      deliveries_90d: Number(row.deliveries_90d),
    })),
  };
}
