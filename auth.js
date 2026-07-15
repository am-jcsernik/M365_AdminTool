/*
 * auth.js — v12 RBAC Phase 1: acting-identity resolution (AuthN plumbing).
 *
 * Resolves WHO is calling (the signed-in operator) from Azure Container Apps
 * Easy Auth and attaches it as req.user. This is deliberately AUTHENTICATION
 * ONLY — no authorization is enforced here. Access/tenant/report guards land in
 * Phase 3 (see docs/PLAN-v12-rbac.md); Phase 1 just makes the acting identity
 * available to the audit log and to those later guards.
 *
 * Two identities stay distinct throughout v12:
 *   - acting user  (this file) — who is using the tool  → req.user
 *   - connection   (server.js) — what the tool reports as → connectionInfo
 *
 * Easy Auth (when enabled on the Container App) validates the sign-in at the
 * edge and injects, on every forwarded request:
 *   X-MS-CLIENT-PRINCIPAL       base64(JSON) with a `claims` array
 *   X-MS-CLIENT-PRINCIPAL-NAME  the user principal name (convenience)
 *   X-MS-CLIENT-PRINCIPAL-ID    the object id  (convenience)
 *   X-MS-CLIENT-PRINCIPAL-IDP   the identity provider
 * These headers are trustworthy ONLY behind Easy Auth, which strips any
 * client-supplied copies. We therefore never read them on the local bind.
 */

const DOCKER_MODE = !!process.env.DOCKER_MODE;

// Bootstrap group ids (Phase 0 provisions these). The RBAC store (Phase 2)
// becomes the source of truth; env is the interim wiring so Phase 1 can already
// compute group membership for the audit trail.
const ADMIN_GROUP_ID  = process.env.ADMIN_GROUP_ID  || null;
const ACCESS_GROUP_ID = process.env.ACCESS_GROUP_ID || null;

// Claim type aliases seen across Easy Auth / Entra token shapes.
const UPN_CLAIMS = [
  "preferred_username", "upn", "email",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
];
const OID_CLAIMS = [
  "http://schemas.microsoft.com/identity/claims/objectidentifier", "oid",
];

// Decode the Easy Auth principal into { upn, oid, groups, groupsOverage, idp }.
function decodePrincipal(req) {
  let claims = [];
  const b64 = req.headers["x-ms-client-principal"];
  if (b64) {
    try {
      const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      if (Array.isArray(json.claims)) claims = json.claims;
    } catch { /* malformed blob — fall back to the convenience headers below */ }
  }
  const claim = (types) => {
    const c = claims.find(x => types.includes(x.typ));
    return c ? c.val : null;
  };
  const upn = req.headers["x-ms-client-principal-name"] || claim(UPN_CLAIMS);
  const oid = req.headers["x-ms-client-principal-id"]   || claim(OID_CLAIMS);
  const groups = claims.filter(x => x.typ === "groups").map(x => x.val);
  // Group overage: when a user is in too many groups, Entra omits the group
  // claims and emits a marker instead. Flag it so Phase 3 can fall back to a
  // Graph /me/memberOf lookup rather than silently seeing zero groups.
  const groupsOverage = claims.some(
    x => x.typ === "_claim_names" || (x.typ === "hasgroups" && String(x.val) === "true")
  );
  return { upn, oid, groups, groupsOverage, idp: req.headers["x-ms-client-principal-idp"] || null };
}

// Express middleware: attach req.user. Log-only in Phase 1 (no 401/403 yet).
function userMiddleware(req, res, next) {
  const hasEasyAuth = !!(req.headers["x-ms-client-principal"] || req.headers["x-ms-client-principal-name"]);
  let user;
  if (hasEasyAuth) {
    user = decodePrincipal(req);
    user.source = "easy-auth";
  } else if (!DOCKER_MODE) {
    // Local dev: nothing gates localhost, so synthesize a full local admin.
    // We must NOT trust Easy Auth headers here (spoofable on the local bind),
    // hence this branch only runs when no such header is present.
    user = { upn: "local-dev@localhost", oid: null, groups: [], groupsOverage: false, idp: "local", source: "local-dev" };
  } else {
    // In-container with no Easy Auth header: the request did not pass the gate.
    // Phase 1 does not enforce, so mark it anonymous; Phase 3 will 401 here.
    user = { upn: null, oid: null, groups: [], groupsOverage: false, idp: null, source: "anonymous" };
  }
  user.isAdmin = !!(ADMIN_GROUP_ID && user.groups.includes(ADMIN_GROUP_ID));
  req.user = user;
  next();
}

module.exports = { userMiddleware, decodePrincipal, ADMIN_GROUP_ID, ACCESS_GROUP_ID };
