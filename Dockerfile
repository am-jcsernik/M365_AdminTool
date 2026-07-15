# ═══════════════════════════════════════════════════════════════════════
#  M365 Admin Reports — Docker Image
#  
#  Base: Ubuntu 22.04 + Node.js 20 + PowerShell 7 + Microsoft Graph SDK
#  Size: ~1.2GB (Graph modules are large)
#  
#  Build:  docker build -t m365-admin-reports .
#  Run:    docker run -p 3365:3365 m365-admin-reports
# ═══════════════════════════════════════════════════════════════════════

FROM ubuntu:22.04

LABEL maintainer="M365 Admin Toolkit"
LABEL description="M365 Admin Read-Only Reports with web UI"

# Avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive
ENV DOCKER_MODE=1

# ── System packages ──────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    apt-transport-https \
    software-properties-common \
    gnupg \
    lsb-release \
    wget \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 LTS ──────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── PowerShell 7 ────────────────────────────────────────────────────
RUN wget -q "https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb" \
    && dpkg -i packages-microsoft-prod.deb \
    && rm packages-microsoft-prod.deb \
    && apt-get update \
    && apt-get install -y powershell \
    && rm -rf /var/lib/apt/lists/*

# ── Install Microsoft Graph PowerShell modules ──────────────────────
# Only the sub-modules we actually use (not the full 40+ module meta-package)
RUN pwsh -NoProfile -NonInteractive -Command ' \
    $ProgressPreference = "SilentlyContinue"; \
    Set-PSRepository -Name PSGallery -InstallationPolicy Trusted; \
    @( \
        "Microsoft.Graph.Authentication", \
        "Microsoft.Graph.Users", \
        "Microsoft.Graph.Groups", \
        "Microsoft.Graph.Identity.DirectoryManagement", \
        "Microsoft.Graph.Identity.SignIns", \
        "Microsoft.Graph.Reports", \
        "Microsoft.Graph.DeviceManagement", \
        "Microsoft.Graph.Sites", \
        "Microsoft.Graph.Files" \
    ) | ForEach-Object { \
        Write-Host "Installing $_..."; \
        Install-Module -Name $_ -Scope AllUsers -Force -AllowClobber \
    }; \
    Write-Host "Graph modules installed." \
'

# ── Install Exchange Online Management module ────────────────────────
RUN pwsh -NoProfile -NonInteractive -Command ' \
    $ProgressPreference = "SilentlyContinue"; \
    Write-Host "Installing ExchangeOnlineManagement..."; \
    Install-Module -Name ExchangeOnlineManagement -Scope AllUsers -Force -AllowClobber; \
    Write-Host "Exchange module installed." \
'

# ── Verify installations ────────────────────────────────────────────
RUN pwsh -NoProfile -NonInteractive -Command ' \
    Write-Host "=== Verification ==="; \
    Write-Host "PowerShell: $($PSVersionTable.PSVersion)"; \
    Write-Host "Graph.Auth:  $((Get-Module -ListAvailable Microsoft.Graph.Authentication | Select -First 1).Version)"; \
    Write-Host "Graph.Users: $((Get-Module -ListAvailable Microsoft.Graph.Users | Select -First 1).Version)"; \
    Write-Host "Exchange:    $((Get-Module -ListAvailable ExchangeOnlineManagement | Select -First 1).Version)"; \
    Write-Host "Node.js:     $(node --version)"; \
' && node --version

# ── Application setup ────────────────────────────────────────────────
WORKDIR /app

# Copy manifest + lockfile first for reproducible, cache-friendly installs.
COPY package.json package-lock.json ./
# npm ci installs exactly what the lockfile pins (reproducible builds).
# --omit=dev drops devDependencies; @babel/standalone is a runtime dep
# (the server transforms the frontend at request time), so it is retained.
RUN npm ci --omit=dev

# Copy application code. server.js require()s every module below, so all of
# them must be present in the image (the pre-v11 Dockerfile copied only
# server.js + public/, which no longer boots after the module split).
COPY server.js reports.js packs.js snapshots.js audit.js ./
# v12 RBAC modules — server.js require()s these, so they MUST be in the image.
COPY auth.js rbac.js tenants.js keyvault.js ./
# v12 Phase 4b — the per-tenant session pool; server.js require()s it. Omitting
# it crash-loops the image on boot (MODULE_NOT_FOUND). See ADR-0007's Dockerfile
# COPY note: this explicit list must track every module server.js requires.
COPY sessions.js ./
COPY scripts/ ./scripts/
COPY public/ ./public/
COPY config.json.example ./
# The tenant list (config.json) is intentionally NOT baked into the image.
# Supply it at runtime via the mounted DATA volume or an env-driven config;
# see deploy/README.md.

# ── Persistent data volume ───────────────────────────────────────────
# DATA_DIR holds all durable state (snapshots, audit log, console logs, CSV
# exports). In Azure Container Apps this path is backed by an Azure Files
# mount so state survives restarts and scale-to-zero. Created and owned by
# the non-root runtime user below.
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data /tmp/m365-admin-reports

# ── Runtime config ───────────────────────────────────────────────────
ENV PORT=3365
ENV NODE_ENV=production
# DOCKER_MODE (set at the top of this file) binds 0.0.0.0 and switches Graph
# connect to device-code auth — required inside a container.
EXPOSE 3365

# Health check for Azure Container Apps
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3365/api/health || exit 1

# Run as non-root for security. Own /app, the data volume, and the temp dir.
RUN groupadd -r m365app && useradd -r -g m365app -d /app m365app \
    && chown -R m365app:m365app /app /app/data /tmp/m365-admin-reports
USER m365app

CMD ["node", "server.js"]
