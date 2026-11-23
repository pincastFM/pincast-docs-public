---
name: pincast
description: Call the Pincast Placecard API at api.pincast.fm/v1 from a server, to register card sets and cards, record that a person collected a card, read what a person holds, link a person who signed in through id.pincast.fm, and move a guest's cards to them. Use when code calls api.pincast.fm, sends an X-Pincast-Key header, or adds card collecting to an app built on Pincast.
---

# Pincast Placecard API

Placecard is Pincast's card registry. An app registers its card sets and cards, records each card a person collects, and reads back what a person holds. Docs: https://docs.pincast.fm. Every docs page also comes as Markdown: add `.md` to its address.

## Rules that never bend

1. Call `https://api.pincast.fm/v1` from the server only. Send the app key in the `X-Pincast-Key` header.
2. Read the key from the environment (`PINCAST_KEY`). It reads `pck_`, the app id, `_`, then a secret. Never put it in browser code, an app bundle, a query string, a log or the repository.
3. Every key is live, and every write is real. There's no test mode, no test key, no API SDK and no webhooks. Pincast issues keys by hand, at support@pincast.fm. The card table is a public npm package, `@pincast/placecard-kit`, and it draws what your server fetched: https://docs.pincast.fm/guides/card-table.
4. The API has seven calls today: six take the app key, and one, the list of apps, is public. Check the reference before calling any other path: https://docs.pincast.fm/api-reference/introduction.
5. No call deletes anything. Retire a card by sending it with `"status": "retired"`; the people who hold it keep it.

## The seven calls

| Call | What it does |
| :- | :- |
| `PUT /sets/{set}` | Register a set and its cards, or update them. A card left out of the call is kept. |
| `GET /sets/{set}` | Read a set back, with its counts and whether it lists in Placecard. |
| `POST /sets/{set}/collects` | Record that a person collected a card. |
| `GET /sets/{set}/collects?actor=<id>` | One person's cards in the set. Repeat `actor` for up to three ids of the same person. |
| `POST /sets/{set}/claims` | Move a guest's cards to the person who just signed in. |
| `POST /people` | Link a person who signed in, by their id.pincast.fm ID token. |
| `GET /apps` | The apps listed on Pincast. Public: no key, and a key sent is ignored. |

A set id is up to 64 characters, each a lowercase letter, a digit, `_` or `-`, starting with a letter or digit. A card needs `key`, `type` and `title`; its `parent` (a tree card's species card) must be in the same call or already registered.

## A first collect

Register a set with one card:

```bash
curl -X PUT https://api.pincast.fm/v1/sets/central-park-trees \
  -H "X-Pincast-Key: $PINCAST_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"name":"Central Park Trees","cards":[{"key":"species:ginkgo","type":"species","title":"Ginkgo"}]}'
```

Record a guest's collect of it:

```bash
curl -X POST https://api.pincast.fm/v1/sets/central-park-trees/collects \
  -H "X-Pincast-Key: $PINCAST_KEY" \
  -H "Content-Type: application/json" \
  -d '{"card":"species:ginkgo","actor":{"id":"guest-7f3c9a2e5b41","source":"anonymous"},"at":"2026-11-14T15:04:05Z"}'
```

## People

- A guest: `actor.id` is the app's guest token for this device, and `actor.source` is `anonymous`. A guest token is never a person's id.
- When a person signs in through id.pincast.fm, send their ID token to `POST /people` as `{"token": "..."}`. Use the `person` it answers as `actor.id`, with `actor.source` set to `logto`, and as a claim's `to`.
- A claim's `from` is the guest token the app read on this device, never a value taken from the request. Claims work per set: send one for each set the guest collected in.

## Errors

Checks run in this order, and the first to fail answers: the key (401, 403, or 400 when `X-Pincast-Key` and `X-Placecard-Key` differ), the key's limit (429), the set id (400), the `Idempotency-Key` (400), the body (400), and for a signed-in person's collect or a claim, their sign-in link (403).

Every error has one body. Branch on `data.code`, never on `message`. `data.field` names the field at fault, and `data.fix` says what to send instead. Every code: https://docs.pincast.fm/api-reference/errors.

- Don't resend a 4xx unchanged: fix what `data.field` names first.
- 403 `person_not_signed_in`: send `POST /people` with the person's ID token, then send the call again.
- 409 `actor_signed_in`: a guest collect used the id of a person who signed in to the app. Never send a person's id as a guest token.

## Retries and limits

- Every call is safe to send again. On the three writes, send an `Idempotency-Key`: a UUID made once per request and sent unchanged with each retry. The replayed answer comes with `Idempotent-Replayed: true`, and the same key with a different request answers 422 `idempotency_key_reused`.
- Send `at` with every collect. Without it, each resend is a new time and counts as another collect.
- Each key takes 600 calls a minute, counted over the last 60 seconds. On 429 `rate_limited` or 503 `signin_check_unavailable`, wait the seconds in `Retry-After`, then send the same call once. A 500 is safe to send again later.
