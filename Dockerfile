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

# Copy package files first (better Docker layer caching)
COPY package.json ./
RUN npm install --production

# Copy application code
COPY server.js ./
COPY public/ ./public/

# Create temp and export directories
RUN mkdir -p /tmp/m365-admin-reports /app/M365Reports

# ── Runtime config ───────────────────────────────────────────────────
ENV PORT=3365
ENV NODE_ENV=production
EXPOSE 3365

# Health check for Azure Container Apps
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3365/api/health || exit 1

# Run as non-root for security
RUN groupadd -r m365app && useradd -r -g m365app -d /app m365app \
    && chown -R m365app:m365app /app /tmp/m365-admin-reports
USER m365app

CMD ["node", "server.js"]
