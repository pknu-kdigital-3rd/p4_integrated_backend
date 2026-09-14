param(
    [string]$PublicAddress = "10.174.96.95",
    [string]$DnsName = ""
)

$ErrorActionPreference = "Stop"
$tlsDirectory = Join-Path $PSScriptRoot "..\secrets\tls"
New-Item -ItemType Directory -Force -Path $tlsDirectory | Out-Null

$caKey = Join-Path $tlsDirectory "development-ca.key"
$caCert = Join-Path $tlsDirectory "development-ca.crt"
$serverKey = Join-Path $tlsDirectory "server.key"
$serverCsr = Join-Path $tlsDirectory "server.csr"
$serverCert = Join-Path $tlsDirectory "server.crt"
$serialFile = Join-Path $tlsDirectory "development-ca.srl"
$opensslConfig = Join-Path $PSScriptRoot "openssl-development.cnf"

$san = "IP:$PublicAddress"
if ($DnsName) { $san = "$san,DNS:$DnsName" }
$env:ITS_TLS_SAN = $san

function Invoke-TlsOpenSsl {
    param([string[]]$Arguments)
    & openssl @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "OpenSSL failed with exit code $LASTEXITCODE"
    }
}

Invoke-TlsOpenSsl @("genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", $caKey)
Invoke-TlsOpenSsl @("req", "-x509", "-new", "-sha256", "-days", "825", "-key", $caKey, "-config", $opensslConfig, "-section", "req", "-subj", "/CN=ITS Development CA", "-extensions", "ca_ext", "-out", $caCert)
Invoke-TlsOpenSsl @("genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", $serverKey)
Invoke-TlsOpenSsl @("req", "-new", "-sha256", "-key", $serverKey, "-config", $opensslConfig, "-section", "req", "-out", $serverCsr)
Invoke-TlsOpenSsl @("x509", "-req", "-sha256", "-days", "397", "-in", $serverCsr, "-CA", $caCert, "-CAkey", $caKey, "-CAcreateserial", "-copy_extensions", "copy", "-out", $serverCert)

Remove-Item -LiteralPath $serverCsr -Force
if (Test-Path $serialFile) { Remove-Item -LiteralPath $serialFile -Force }

Write-Host "Created $serverCert and $serverKey"
Write-Host "Install and trust $caCert on each development browser and Android device."
Remove-Item Env:ITS_TLS_SAN -ErrorAction SilentlyContinue
