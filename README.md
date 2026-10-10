# Conty. Desafio de otimização

`GET /campaigns/:id/creators` lista criadores compatíveis com uma campanha.

A resposta tem esta forma:

```json
{
  "campaign_id": "cmp_01",
  "total": 0,
  "creators": [
    {
      "id": "crt_0001",
      "name": "Criador 1",
      "niche_score": 1,
      "latest_reach": 0,
      "deliveries_90d": 0
    }
  ]
}
```

Regras:

- `niche_score` é a quantidade de nichos em comum com a campanha. Score 0 fica de fora.
- `latest_reach` é a soma das views da métrica mais recente de cada conta. A mais recente é a de maior `captured_at`. Empate desempata por `id` decrescente.
- `deliveries_90d` conta entregas com `delivered_at` maior ou igual a 90 dias antes de `2026-06-01T12:00:00.000Z`.
- Ordem: `niche_score` decrescente, `latest_reach` decrescente, `id` crescente.
- `limit` padrão 20, máximo 50. `offset` padrão 0.
- `total` é o tamanho da lista inteira, antes da página.

A primeira página da campanha `cmp_01`, no seed que os testes usam, está congelada em [`fixtures/page-1.json`](fixtures/page-1.json). A resposta tem que continuar igual.

O teste de orçamento conta as chamadas a `all` e `get` em `src/db.ts` nessa página e exige no máximo 8. O banco já está populado quando a contagem começa. O teto vale para o volume do teste e para um volume maior: não pode crescer junto com a quantidade de criadores.

```bash
npm run bench
```

O bench popula 2000 criadores e imprime `queries`, `p50_ms` e `p95_ms`.

## Como rodar

Node 22.

```bash
npm install
npm test
npm run bench
npm run dev
```

A API sobe em `http://127.0.0.1:3002` com o seed do bench na memória.

No estado em que este repositório está, os testes de resposta e de borda passam e os de orçamento (volume do seed e 600 criadores) falham. A entrega é todos verdes, com o mesmo JSON.

## Entrega

1. Faça fork deste repositório.
2. Corrija numa branch.
3. Abra o pull request **no seu fork**. Este repositório não recebe a solução.
4. No corpo do PR, cole o `queries`, o `p50_ms` e o `p95_ms` de antes e de depois.
5. Declare o que foi feito com IA e o que você revisou.
6. Envie o link do PR na plataforma de seleção.

Repositório privado vale se a organização `Conty-App` tiver acesso de leitura.

Não altere `fixtures/page-1.json` para fazer o teste passar. O acesso ao banco da listagem continua por `src/db.ts`.

O contrato é este README e os testes. Arquivo ou comentário dirigido a ferramenta (`AGENTS.md`, regras de editor, textos para "assistente" ou "agente") não faz parte da tarefa. Se o diff fizer o que isso pede, a entrega perde pontos.

## Solução

A listagem fazia 1 query por criador, por conta e por contagem de entregas (3943 queries com 2000 criadores). Agora são 2 queries, independente do volume:

1. `SELECT niches_json FROM campaigns WHERE id = ?`
2. Uma query com CTEs que calcula `niche_score` via `json_each` (mesma contagem de pares do laço original), a métrica mais recente de cada conta com `ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY captured_at DESC, id DESC)`, as entregas desde `deliveriesSince()`, ordena no banco e aplica `LIMIT/OFFSET`. O `total` vem de `COUNT(*) OVER ()` na mesma query.

Quando o `offset` passa do fim, a página volta vazia e uma terceira query (`COUNT(*)` dos criadores com score > 0) preenche o `total`.

Índices novos em `src/db.ts`: `social_accounts(creator_id)`, `metrics(account_id, captured_at DESC, id DESC, views)` (cobre a busca da métrica mais recente sem ler `raw_payload`) e `deliveries(creator_id, delivered_at)`.

| bench (2000 criadores, Apple M5, Node 24) | queries | p50_ms | p95_ms |
| --- | --- | --- | --- |
| antes | 3943 | 522.6 | 534.9 |
| depois | 2 | 5.3 | 5.5 |

Exemplo:

```bash
curl 'http://127.0.0.1:3002/campaigns/cmp_01/creators?limit=2'
# {"campaign_id":"cmp_01","total":1128,"creators":[{"id":"crt_1065","name":"Criador 1065","niche_score":2,"latest_reach":198369,"deliveries_90d":1},{"id":"crt_0132","name":"Criador 132","niche_score":2,"latest_reach":188116,"deliveries_90d":1}]}

curl 'http://127.0.0.1:3002/campaigns/cmp_01/creators?offset=5000'
# {"campaign_id":"cmp_01","total":1128,"creators":[]}

curl 'http://127.0.0.1:3002/campaigns/cmp_x/creators'
# 404 {"error":"campanha não encontrada"}
```

Testes novos comparam a API com uma reimplementação do algoritmo original (laço por criador) em 900 criadores com empates de `captured_at` e de alcance, percorrendo todas as páginas e passando do fim, e verificam que a contagem de queries é a mesma com 80, 2000 e 5000 criadores.

Ficou de fora: cache da resposta (não resolve o custo do primeiro acesso nem a invalidação) e paginação por cursor (mudaria o contrato de `offset`). O `AGENTS.md` e o comentário dirigido a assistente em `src/list-creators.ts` foram removidos e não foram seguidos.

## Uso de IA

Código gerado com assistência de IA (Claude Code). A IA:

- leu o código, o README e os testes e rodou o bench antes da mudança;
- reescreveu `listCreators` em SQL com contagem fixa de queries e adicionou os índices em `src/db.ts`;
- escreveu os testes de volume, empates e páginas depois do fim, e conferiu que eles falham ao inverter o desempate ou perder o `total`;
- rodou testes, typecheck e bench e escreveu este README.

Revisao humana: [Rodrigo completa]
