# Contributing

Thanks for helping. MergePay pays for its own issues, so you can earn USDC doing this.

1. Pick a funded issue on the [Bounties tab](https://mergepay.fun/app#bounties) and comment `/claim` on it. Only the claimant's PR is paid, and a claim with no activity for 7 days is released.
2. Open a pull request with `Fixes #N` in the description.
3. [Link a wallet](https://mergepay.fun/app#wallet) once, before or after the merge.

## Before you open the PR

- Contracts: `cd contracts && forge test` must pass. Add a test for any new check in `MergePay.sol`.
- Workflows: keep PR code out of `pull_request_target` jobs, and pass any user text through `env:`, never `${{ }}` inside `run:`.
- App: `cd app && npx tsc` must pass. The frontend is plain HTML and JS with no build step, so keep it that way.
- Changing `award.yml`, `claims.yml` or `link.yml` changes what existing bounties trust. Discuss it in an issue first; releases go out under a new tag, never by moving `v1`.

## Security

If you find a way to get paid for a merge that didn't happen, please don't open a public issue. Contact [@codeswithroh](https://github.com/codeswithroh) directly.
