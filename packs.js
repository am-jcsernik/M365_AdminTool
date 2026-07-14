/*
 * packs.js — audit pack definitions (v11.3.0)
 *
 * A pack is a curated bundle of parameter-free reports run sequentially
 * in one click, optionally auto-snapshotting each result (evidence
 * collection for periodic reviews). Packs are server-owned like the
 * report catalog; the client sends only a packId.
 *
 * Rules for pack membership:
 *   - report must exist in the catalog (lint-enforced)
 *   - report must not require parameters (lint-enforced)
 *   - reports with ex:true are skipped at runtime when Exchange is not
 *     connected (recorded as "skipped", not an error)
 */

const PACKS = [
  {
    id: "security-audit",
    name: "Security Audit Pack",
    desc: "Periodic security review evidence: privileged access, external identities, stale/disabled accounts, CA posture, sign-in failures, risk, and mail exfiltration paths.",
    reports: ["admin-roles", "guest-users", "stale-users", "disabled-users", "ca-policies", "failed-signins", "risky-users", "all-forwarding-rules", "mail-forwarding", "shared-mailboxes"],
  },
  {
    id: "license-review",
    name: "License & Cost Review",
    desc: "License purchase vs. assignment, plan detail, and users consuming (or missing) licenses.",
    reports: ["license-summary", "service-plans", "unlicensed-users", "disabled-users"],
  },
  {
    id: "tenant-hygiene",
    name: "Tenant Hygiene Pack",
    desc: "Housekeeping: empty groups, stale and disabled accounts, unlicensed users, registered devices, and verified domains.",
    reports: ["empty-groups", "stale-users", "disabled-users", "unlicensed-users", "devices", "domains"],
  },
];

function findPack(id) { return PACKS.find(p => p.id === id) || null; }

module.exports = { PACKS, findPack };
