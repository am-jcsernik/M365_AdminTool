/*
 * keyvault.js — v12 RBAC Phase 4: fetch per-tenant app-only certificates from
 * Azure Key Vault using the Container App's MANAGED IDENTITY.
 *
 * Deliberately dependency-free: uses Node's built-in fetch against the platform
 * managed-identity token endpoint (Container Apps / App Service expose
 * IDENTITY_ENDPOINT + IDENTITY_HEADER; VMs expose the IMDS endpoint) and the
 * Key Vault REST API. No @azure/* SDKs, so package-lock and image size are
 * unchanged.
 *
 * Note on the private key: app-only auth must sign a client assertion at
 * runtime, so the compute needs the private key in memory. Key Vault protects
 * it at rest and releases it only to the trusted managed identity; we stage it
 * to a 0600 temp file for PowerShell to load. This is the standard pattern —
 * "private key stays in KV" applies to provisioning (cert creation), not to the
 * runtime signer.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const KV_API = "7.4";
const VAULT_RESOURCE = "https://vault.azure.net";

async function safeText(r) { try { return await r.text(); } catch { return ""; } }

// Acquire an access token for a resource via the platform managed identity.
async function getManagedIdentityToken(resource = VAULT_RESOURCE) {
  const idEndpoint = process.env.IDENTITY_ENDPOINT;
  const idHeader = process.env.IDENTITY_HEADER;
  if (idEndpoint && idHeader) {
    // Container Apps / App Service MSI endpoint.
    const url = `${idEndpoint}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01`;
    const r = await fetch(url, { headers: { "X-IDENTITY-HEADER": idHeader } });
    if (!r.ok) throw new Error(`Managed identity token (identity endpoint) failed: ${r.status} ${await safeText(r)}`);
    return (await r.json()).access_token;
  }
  // Fallback: IMDS (VMs and some hosts).
  const url = `http://169.254.169.254/metadata/identity/oauth2/token?resource=${encodeURIComponent(resource)}&api-version=2018-02-01`;
  const r = await fetch(url, { headers: { Metadata: "true" } });
  if (!r.ok) throw new Error(`Managed identity token (IMDS) failed: ${r.status} ${await safeText(r)}`);
  return (await r.json()).access_token;
}

// Fetch a certificate's full material from Key Vault. A KV certificate's private
// key is retrievable as a SECRET of the same name; contentType is
// application/x-pkcs12 (base64 PFX) or application/x-pem-file.
async function getCertificateSecret(vaultName, secretName, { version = "" } = {}) {
  if (!vaultName) throw new Error("Key Vault name not configured (KEY_VAULT_NAME).");
  const token = await getManagedIdentityToken(VAULT_RESOURCE);
  const url = `https://${vaultName}.vault.azure.net/secrets/${encodeURIComponent(secretName)}` +
    `${version ? "/" + encodeURIComponent(version) : ""}?api-version=${KV_API}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Key Vault get secret '${secretName}' failed: ${r.status} ${await safeText(r)}`);
  const j = await r.json();
  return { value: j.value, contentType: j.contentType || null };
}

// Stage the cert to a 0600 temp file for PowerShell to load. Returns { path, format }.
function writeCertTemp(secret, name) {
  const dir = path.join(os.tmpdir(), "m365-admin-reports", "certs");
  fs.mkdirSync(dir, { recursive: true });
  const isPem = (secret.contentType || "").toLowerCase().includes("pem");
  const file = path.join(dir, `${name}.${isPem ? "pem" : "pfx"}`);
  const buf = isPem ? Buffer.from(secret.value, "utf8") : Buffer.from(secret.value, "base64");
  fs.writeFileSync(file, buf, { mode: 0o600 });
  return { path: file, format: isPem ? "pem" : "pfx" };
}

module.exports = { getManagedIdentityToken, getCertificateSecret, writeCertTemp, VAULT_RESOURCE };
