# MergePay

**USDC bounties on GitHub issues, paid the moment the PR merges, on Arc.**

A sponsor escrows USDC against an issue. When a pull request that closes it is merged, a GitHub
Actions job asks GitHub for an OIDC token. The MergePay contract **verifies GitHub's RS256
signature on-chain** and pays the PR author. No bot, no backend, no private key anyone has to trust.

```
PR merged ──▶ GitHub signs JWT ──▶ Arc contract checks RSA sig + claims ──▶ USDC to author ──▶ PR comment
   t+0s            t+3s                     t+4s  (~770k gas ≈ $0.016)           t+4.5s
```

- **Live app:** https://mergepay.codeswithroh.workers.dev
- **Contract (Arc mainnet, chain 5042):** _TBD_

## Why Arc

| Arc property | What it enables here |
| --- | --- |
| **USDC is the native gas token** | Bounty, relayer fee and payout are one asset. A first-time contributor with zero balance gets paid and never touches another token. The relayer is reimbursed in the same USDC it spent on gas. |
| **Sub-second deterministic finality** | The payout comment on the PR lands seconds after the merge, with a final tx. |
| **Osaka EVM + `modexp`/`sha256` precompiles** | 2048-bit RSA verification of GitHub's JWT signature is cheap enough to do on every award. |
| **Predictable dollar fees** | An award costs about 770k gas, roughly $0.016 at the 20 gwei base fee, so sponsors can set a flat relayer fee in USDC. |

## How it works

### 1. Fund
`fund(repoId, issue, repoName, workflowRef, expiry, relayerFee)` escrows native USDC.
- Bounties are keyed by GitHub's numeric `repository_id`, which is stable across renames.
- `workflowRef` pins the exact reusable workflow (`job_workflow_ref`, by tag or commit) allowed to award the bounty.
- Anyone can top up a bounty. Once `expiry` passes unawarded, each funder can `refund` their own share.

### 2. Award on merge
The repo adds [`examples/mergepay.yml`](examples/mergepay.yml). On `pull_request_target: closed`, the
pinned [`award.yml`](.github/workflows/award.yml) runs. For each issue the PR closes, it:
- mints an OIDC token with `aud = mergepay:<contract>:<issue>:<author-id>`
- hands the token to a relayer

The contract then checks, in [`MergePay.sol`](contracts/src/MergePay.sol):
- the `RS256` signature against GitHub's JWKS key for `kid` (via the `modexp` precompile)
- `iss` is `https://token.actions.githubusercontent.com`, and `exp`/`nbf` are valid
- `event_name == pull_request_target`
- `aud` binds this contract, the issue and the recipient
- `repository_id` matches the bounty and `job_workflow_ref` matches the pinned workflow

Then it pays `amount − relayerFee` to the author (or holds it until they link) and pays `relayerFee` to the relayer.

### 3. Link a wallet (before or after)
A contributor adds [`examples/link.yml`](examples/link.yml) to a repo **they own** and runs it once.
The contract requires:
- `event_name == workflow_dispatch`
- `actor_id == repository_owner_id`, which stops someone else's repo from minting a link token naming you
- `aud` binding the wallet
- `iat` newer than the last link, so an old token can't be replayed to switch your wallet back

Any awards held for that user are delivered right away.

### 3½. Claims: one contributor per bounty
Contributors claim a funded issue by commenting **`/claim`**
([`claims.yml`](.github/workflows/claims.yml)). The claim is simply the issue's assignee, so maintainers can
also assign or unassign by hand.
- One claim at a time per person, per repo. `/unclaim` gives it back.
- A PR from anyone else that "fixes" a claimed issue gets an automatic heads-up that it won't be paid.
- A daily job releases claims with no activity (no comment, and no PR opened by or assigned to the claimant
  that references the issue) for 7 days.
- At merge, `award.yml` only requests a GitHub-signed proof for the issue's current assignee. An unclaimed
  or someone-else's issue is skipped and stays funded. The contract needs no change for any of this: it
  already pays only the GitHub user ID inside GitHub's signature, and the pinned workflow decides who that is.

### 4. Built for coding agents
Many PRs are now opened by coding agents. If the agent uses the contributor's account, nothing changes. If it opens the
PR from its **own bot account** (`user.type == "Bot"`), a bot can't link a wallet. So `award.yml` pays the
**first human assignee** instead: the person who handed the issue to the agent. Assignees are read live
from the API, so a maintainer can fix the assignment and re-run the job. If nobody is assigned, the workflow
comments on the PR instead of paying.

The payout address never comes from PR text. An agent can be prompt-injected into writing an attacker's
address into a PR body, but the recipient is always a GitHub user ID inside GitHub's signed token.

### 5. Unclaimed awards go back to funders
An award waits `CLAIM_WINDOW` (180 days) for its recipient to link a wallet. After that, anyone can call
`returnUnclaimed(id)`, and each funder `refund`s their pro-rata share of the payout. A recipient who linked in
time is never affected, even if a delivery failed.

### Relayer
[`app/src/worker.ts`](app/src/worker.ts) is a Cloudflare Worker that also serves the web UI. It splits the
JWT, simulates the call, and pays gas. It **can't forge or redirect anything**: every field that
matters is inside GitHub's signature. Anyone can run one.

## Security notes

- **JSON claim parsing** ([`JsonClaims.sol`](contracts/src/lib/JsonClaims.sol)) looks for the literal
  `"key":"`. Inside a JSON string every quote is escaped, so the pattern can't match inside a
  value, and values containing `\` are rejected. Tests cover a head-ref that tries to smuggle a second `aud`.
- **Alg confusion:** only `RS256` is accepted, and keys are RSA moduli with e = 65537.
- **GitHub's keys** are registered by the owner (`setSigningKey`) and can be checked against
  https://token.actions.githubusercontent.com/.well-known/jwks. `SyncKeys` in
  [`Deploy.s.sol`](contracts/script/Deploy.s.sol) re-syncs them. Next step: timelocked multisig ownership.
- **`pull_request_target`** is safe here because the award workflow never checks out PR code.
  User-controlled text (the PR body) only reaches the job through `env:`.
- **Trust in maintainers is inherent:** whoever can merge decides who authored the fix. The pinned
  workflow keeps *how* the recipient is picked public and fixed.

## Repo layout

```
contracts/   Foundry: MergePay.sol + Base64Url / JsonClaims / RsaSha256 libs, 26 tests
.github/     reusable award.yml and link.yml workflows
examples/    what repos and contributors copy
app/         Cloudflare Worker: relayer API + static web app (viem, no build step)
```

## Run it

```bash
# contracts
cd contracts && forge test -vv            # 26 tests, incl. forged/tampered/replayed tokens
node scripts/gen-fixtures.mjs             # regenerate signed test tokens

# local end-to-end: anvil + worker + GitHub-shaped tokens through the relayer
anvil --chain-id 5042 &
cd app && npm i && node scripts/e2e-local.mjs          # deploys, prints the next command
npx wrangler dev --var CONTRACT:0x... --var RPC_URL:http://127.0.0.1:8545
CONTRACT=0x... node scripts/e2e-local.mjs

# mainnet
cd contracts && node scripts/fetch-jwks.mjs
forge script script/Deploy.s.sol --tc Deploy --rpc-url arc --broadcast --account <keystore>
cd ../app && npx wrangler secret put RELAYER_KEY && npx wrangler deploy
```

## License

MIT
