# Embeddable Bounty Badge

MergePay provides an embeddable SVG badge that repository maintainers can add directly to their READMEs to showcase open USDC bounties.

## Endpoint

`GET /badge/<owner>/<repo>.svg` or `GET /badge/<owner>/<repo>`

### Behavior & Design
- **Visual Style:** Retro monochrome flat-square style matching MergePay's theme.
- **Content Type:** `image/svg+xml; charset=utf-8` (self-contained, no external font dependencies, compatible with GitHub markdown rendering).
- **Caching:** `public, max-age=60, s-maxage=60` (~60s cache header) to avoid hammering the RPC while remaining fresh.
- **State Handling:**
  - Displays formatted amount and count if bounties exist: `MergePay | 1.25 USDC open · 2 bounties`.
  - Gracefully displays `MergePay | no open bounties` if no active bounties are found.

## Example Markdown for README

```markdown
[![MergePay Bounties](https://mergepay.codeswithroh.workers.dev/badge/codeswithroh/mergepay.svg)](https://mergepay.codeswithroh.workers.dev/app#bounties)
```
