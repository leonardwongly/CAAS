# Production access approval record

> Status: **template; production remains PROHIBITED.** This record defines
> what production access means and records the decision that would permit it.
> The decision is not made: every decision field below is blank, and the gate
> logic in Section 4 keeps production **PROHIBITED** until the record is
> signed by the user and retained with evidence. This file grants nothing.

## 1. What production access would mean

If approved, production access would permit **public or broad organizational
use** of CAAS-derived data — a fundamentally different scope from the private,
single-user POC ([design §0.1](../../docs/superpowers/specs/2026-08-11-flight-route-explorer-design.md#01-delivery-profile-and-authority)).
Concretely, approval covers these decisions (design §30 items 1, 7, 8):

1. **Data access**: who may access CAAS-derived data, through which
   endpoints, and with which authentication/authorization model.
2. **Privacy**: classification, residency, and privacy controls for the data,
   plus any external map/tile provider privacy decision.
3. **Retention**: data/log/evidence retention schedules, access-review
   cadence, audit export and legal-hold decisions.
4. **Broader accessibility**: supported browsers/assistive technology,
   accessibility matrix, product UAT, and support obligations for the
   production audience.

## 2. Decision fields (all blank — REQUIRES USER AUTHORIZATION)

| Decision | Field | Decision |
|---|---|---|
| 1 | Redistribution/privacy authority cited (written authority; not HTTP 200 or key possession) | **REQUIRES USER AUTHORIZATION** — `________` |
| 2 | Permitted production audience and access model | **REQUIRES USER AUTHORIZATION** — `________` |
| 3 | Data classification and residency decision | **REQUIRES USER AUTHORIZATION** — `________` |
| 4 | Retention schedule; access-review cadence; audit export / legal-hold decision | **REQUIRES USER AUTHORIZATION** — `________` |
| 5 | External map/tile provider privacy approval (or continued dependency-free SVG only) | POC level: OSM raster tiles authorized by the owner 2026-08-15 (design §0.5, `AC-POC-MAP-01`); **production level remains REQUIRES USER AUTHORIZATION** — `________` |
| 6 | Supported browser / assistive-technology matrix and UAT criteria | **REQUIRES USER AUTHORIZATION** — `________` |
| 7 | Acceptable-use boundary (no operational decision-making; safety copy preserved) | **REQUIRES USER AUTHORIZATION** — `________` |
| 8 | Release authority, sign-off chain, and emergency rollback authority | **REQUIRES USER AUTHORIZATION** — `________` |
| 9 | Effective date and expiry/revocation condition | **REQUIRES USER AUTHORIZATION** — `________` |
| 10 | Retention of this decision (commit + hashes) | **REQUIRES USER AUTHORIZATION** — `________` |

## 3. Gate logic — production stays PROHIBITED until all hold

```text
POC gates passed (local, Azure)      --> does not open production
Written redistribution/privacy authority (field 1) --> NO --> PROHIBITED
Network-enforced egress designed and validated (#32) --> NO --> PROHIBITED
Named owners, SLOs, IR, DR evidence (#33) --> NO --> PROHIBITED
Data/privacy/retention/accessibility decisions (fields 2-6) --> NO --> PROHIBITED
User signs this record (fields 7-10) with retained evidence --> NO --> PROHIBITED
Every production-prerequisites register row closed (#31) --> NO --> PROHIBITED
----------------------------------------------------------------- APPROVED (recorded, time-bounded)
```

Until approval, the [production-prerequisites register](production-prerequisites-register.md)
governs and the service must be described as a non-operational POC
([design §28.5](../../docs/superpowers/specs/2026-08-11-flight-route-explorer-design.md#30-public-production-gate),
README "Known limitations and evidence boundary"). Approval never retroactively
authorizes prior exposure, and it does not change the data-use gate for
external demos ([data-use authorization gate](../data-use/data-use-authorization-gate.md)).

## 4. Required attachments at approval

- The [Data Use Record](../data-use/data-use-record.md) completed and current.
- The closed [production-prerequisites register](production-prerequisites-register.md).
- The [egress design](egress-design.md) validation evidence.
- The [production operations](production-operations.md) ownership/SLO/IR/DR
  evidence.
- This record, signed, at a recorded commit with SHA-256 hashes of every
  attachment.

## 5. Revocation

The user may revoke production access at any time by recording the revocation
at a new commit. Revocation re-applies Section 3 gate logic: production
traffic must stop, and the decommission steps of design §31 apply.

Resolved per GitHub issue #34.
