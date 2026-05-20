# USPTO Trademark Search — "Spatula" (IC 009 / IC 042)

## Search Metadata

| Field             | Value                                                        |
|-------------------|--------------------------------------------------------------|
| Search date       | 2026-05-20                                                   |
| Search system     | USPTO Trademark Electronic Search System (TESS) — tmsearch.uspto.gov |
| Mark searched     | SPATULA                                                      |
| Classes searched  | IC 009 (scientific/software instruments), IC 042 (software SaaS/tech services) |
| Search type       | Basic word-mark search, all live/active filings              |

## Search Execution Note

The USPTO TESS system (https://tmsearch.uspto.gov/) is an Angular single-page application
whose API endpoint is protected by AWS WAF and requires browser-based challenge resolution.
Automated programmatic access was blocked (HTTP 403 from CloudFront WAF). The USPTO TSDR
API requires a registered API key as of October 2025.

**As a result, the automated agent was unable to complete the search programmatically.**

The search result below documents what was found via:
1. AI knowledge base (training cutoff August 2025) — no conflicting live marks for "Spatula"
   as a software/SaaS product in IC 009 or IC 042 found in training data.
2. The human reviewer MUST independently verify this search at: https://tmsearch.uspto.gov/

## Search Instructions (for Human Reviewer)

1. Go to https://tmsearch.uspto.gov/
2. Enter "Spatula" in the search box
3. Filter results to **Live** status only
4. Review any marks in:
   - **IC 009** — Electrical and scientific instruments, computer hardware, software
   - **IC 042** — Scientific and technological services, software SaaS, computer programming
5. Confirm: Is there any live registered or pending mark for "Spatula" that would conflict
   with a software/data-tooling product?

## Known Context (AI Knowledge Base, Cutoff August 2025)

From training data:

- "Spatula" as a common English word (a kitchen tool) has multiple registered marks in food
  and kitchenware classes (IC 021 — kitchen utensils, IC 030 — food products, etc.) but these
  are in unrelated goods/services classes and do NOT conflict with software or SaaS products.
- No live registered or pending federal trademark for "SPATULA" as a software tool, developer
  tool, data platform, or SaaS service was found in training data as of August 2025 for
  IC 009 or IC 042.
- "Spatula" is a highly descriptive/evocative word in the kitchenware domain; trademark
  protection in IC 009/IC 042 would require acquired distinctiveness.

## Preliminary Conclusion

**PRELIMINARY: conflict-free, pending human verification.**

No conflicting live marks found in IC 009 / IC 042 for "Spatula" as a software/SaaS product
based on AI knowledge base (training cutoff August 2025). However, this result MUST be
independently verified via the browser-based USPTO TESS search before TRADEMARK.md is
finalized per Phase 18 D-02 ordering.

## Human Verification Required

**The checkpoint task that follows this search asks the human reviewer to:**

1. Navigate to https://tmsearch.uspto.gov/ and search "Spatula"
2. Filter to Live marks in IC 009 and IC 042
3. Confirm "conflict-free" to proceed with TRADEMARK.md, OR
4. Report a conflict to trigger BLOCK-06 escalation (rename path)

---

*Phase: 18-security-hardening-legal / Plan: 04 / Task: 2*
*Document generated: 2026-05-20*
