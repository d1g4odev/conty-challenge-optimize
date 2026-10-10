import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { deliveriesSince } from "../src/clock.ts";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { CAMPAIGN_ID, FIXTURE_SEED, seed } from "../src/seed.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/page-1.json", import.meta.url), "utf8"),
) as unknown;

function setup() {
  const db = openDatabase(":memory:");
  seed(db, FIXTURE_SEED);
  resetQueryCount();
  return createApp(db);
}

describe("descoberta de criadores", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = setup();
  });

  it("devolve a primeira página combinada com a campanha", async () => {
    const res = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=0`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(fixture);
  });

  it("responde a página de 20 com no máximo 8 queries", async () => {
    resetQueryCount();
    const res = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=0`);
    expect(res.status).toBe(200);
    expect(getQueryCount()).toBeLessThanOrEqual(8);
  });

  it("responde 404 quando a campanha não existe", async () => {
    const res = await app.request("/campaigns/cmp_missing/creators");
    expect(res.status).toBe(404);
  });

  it("mantém o teto de queries com 600 criadores", async () => {
    const db = openDatabase(":memory:");
    seed(db, { creators: 600, seed: 7 });
    const big = createApp(db);
    resetQueryCount();
    const res = await big.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=0`);
    expect(res.status).toBe(200);
    expect(getQueryCount()).toBeLessThanOrEqual(8);
  });
});

type Page = {
  total: number;
  creators: Array<{ id: string; niche_score: number; latest_reach: number; deliveries_90d: number }>;
};

describe("casos de borda da listagem", () => {
  function edgeApp() {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_edge', 'Borda', '["beleza","moda"]');
      INSERT INTO creators VALUES
        ('crt_a', 'Empate', '["beleza"]', ''),
        ('crt_b', 'Sem conta', '["beleza"]', ''),
        ('crt_c', 'Conta sem métrica', '["beleza"]', ''),
        ('crt_d', 'Entrega no limite', '["moda"]', ''),
        ('crt_e', 'Fora do nicho', '["games"]', '');
      INSERT INTO social_accounts VALUES
        ('acc_a', 'crt_a', 'instagram'),
        ('acc_c', 'crt_c', 'instagram'),
        ('acc_e', 'crt_e', 'instagram');
      INSERT INTO metrics VALUES
        ('met_a1', 'acc_a', 10, '2026-05-30T00:00:00.000Z', ''),
        ('met_a2', 'acc_a', 99, '2026-05-30T00:00:00.000Z', ''),
        ('met_a0', 'acc_a', 500, '2026-05-01T00:00:00.000Z', ''),
        ('met_e1', 'acc_e', 777, '2026-05-30T00:00:00.000Z', '');
      INSERT INTO deliveries VALUES
        ('del_d1', 'crt_d', '2026-03-03T12:00:00.000Z'),
        ('del_d2', 'crt_d', '2026-03-03T11:59:59.999Z');
    `);
    return createApp(db);
  }

  async function page(app: ReturnType<typeof createApp>, query = ""): Promise<Page> {
    const res = await app.request(`/campaigns/cmp_edge/creators${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Page;
  }

  it("desempata a métrica mais recente pelo id decrescente", async () => {
    const result = await page(edgeApp());
    expect(result.creators.find((creator) => creator.id === "crt_a")?.latest_reach).toBe(99);
  });

  it("lista quem não tem conta ou métrica com alcance zero e deixa de fora score zero", async () => {
    const result = await page(edgeApp());
    expect(result.creators.map((creator) => creator.id)).toEqual(["crt_a", "crt_b", "crt_c", "crt_d"]);
    expect(result.creators.find((creator) => creator.id === "crt_b")?.latest_reach).toBe(0);
    expect(result.creators.find((creator) => creator.id === "crt_c")?.latest_reach).toBe(0);
  });

  it("conta a entrega exatamente no limite dos 90 dias e não a de 1 ms antes", async () => {
    const result = await page(edgeApp());
    expect(result.creators.find((creator) => creator.id === "crt_d")?.deliveries_90d).toBe(1);
  });

  it("mantém o total quando o offset passa do fim", async () => {
    const result = await page(edgeApp(), "?limit=20&offset=50");
    expect(result.creators).toEqual([]);
    expect(result.total).toBe(4);
  });
});

type Reference = { total: number; creators: Page["creators"] };

function referenceListing(db: ReturnType<typeof openDatabase>, campaignId: string): Reference {
  const campaign = db.prepare("SELECT niches_json FROM campaigns WHERE id = ?").get(campaignId) as {
    niches_json: string;
  };
  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const creators = db.prepare("SELECT id, name, niches_json FROM creators").all() as Array<{
    id: string;
    name: string;
    niches_json: string;
  }>;
  const accounts = db.prepare("SELECT id FROM social_accounts WHERE creator_id = ?");
  const latest = db.prepare(
    "SELECT views FROM metrics WHERE account_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
  );
  const deliveries = db.prepare(
    "SELECT COUNT(*) AS n FROM deliveries WHERE creator_id = ? AND delivered_at >= ?",
  );
  const since = deliveriesSince();
  const scored = creators.flatMap((creator) => {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    const nicheScore = campaignNiches.reduce(
      (sum, niche) => sum + creatorNiches.filter((own) => own === niche).length,
      0,
    );
    if (nicheScore === 0) return [];
    const reach = (accounts.all(creator.id) as Array<{ id: string }>).reduce(
      (sum, account) => sum + Number((latest.get(account.id) as { views: number } | undefined)?.views ?? 0),
      0,
    );
    const delivered = deliveries.get(creator.id, since) as { n: number };
    return [
      {
        id: creator.id,
        name: creator.name,
        niche_score: nicheScore,
        latest_reach: reach,
        deliveries_90d: Number(delivered.n),
      },
    ];
  });
  scored.sort(
    (left, right) =>
      right.niche_score - left.niche_score ||
      right.latest_reach - left.latest_reach ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  return { total: scored.length, creators: scored };
}

describe("listagem em volume maior", () => {
  function tiedDatabase(creators: number) {
    const db = openDatabase(":memory:");
    seed(db, { creators, seed: 11 });
    db.exec(`
      UPDATE metrics SET views = views % 7;
      INSERT INTO metrics (id, account_id, views, captured_at, raw_payload)
        SELECT id || '_tie', account_id, 3, captured_at, ''
        FROM metrics
        WHERE id LIKE '%_0' AND rowid % 3 = 0;
      INSERT INTO metrics (id, account_id, views, captured_at, raw_payload)
        SELECT 'met_' || id || '_older', id, 90000, '2020-01-01T00:00:00.000Z', ''
        FROM social_accounts
        WHERE rowid % 5 = 0;
    `);
    return db;
  }

  it("devolve a mesma ordem da implementação original com empates de métrica e de alcance", async () => {
    const db = tiedDatabase(900);
    const app = createApp(db);
    const expected = referenceListing(db, CAMPAIGN_ID);
    const ties = new Set(expected.creators.map((creator) => `${creator.niche_score}:${creator.latest_reach}`));
    expect(ties.size).toBeLessThan(expected.creators.length / 4);

    const collected: Page["creators"] = [];
    for (let offset = 0; offset < expected.total + 40; offset += 20) {
      const res = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=${offset}`);
      const body = (await res.json()) as Page;
      expect(body.total).toBe(expected.total);
      expect(body.creators).toEqual(expected.creators.slice(offset, offset + 20));
      collected.push(...body.creators);
    }
    expect(collected).toEqual(expected.creators);
  });

  it("mantém o total e devolve lista vazia em páginas depois do fim", async () => {
    const db = tiedDatabase(300);
    const app = createApp(db);
    const expected = referenceListing(db, CAMPAIGN_ID);
    for (const offset of [expected.total, expected.total + 1, 10_000]) {
      resetQueryCount();
      const res = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=50&offset=${offset}`);
      expect(getQueryCount()).toBeLessThanOrEqual(8);
      expect(await res.json()).toEqual({ campaign_id: CAMPAIGN_ID, total: expected.total, creators: [] });
    }
  });

  it("não aumenta a quantidade de queries com o volume do bench", async () => {
    const counts: number[] = [];
    for (const creators of [80, 2000, 5000]) {
      const db = openDatabase(":memory:");
      seed(db, { creators, seed: 7 });
      const app = createApp(db);
      resetQueryCount();
      const res = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=0`);
      expect(res.status).toBe(200);
      counts.push(getQueryCount());
    }
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBeLessThanOrEqual(8);
  });
});
