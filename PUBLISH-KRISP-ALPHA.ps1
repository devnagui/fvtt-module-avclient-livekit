<#
  Publica o build alfa "Krisp" no fork devnagui/fvtt-module-avclient-livekit.

  Pre-requisitos (uma vez):
    1. Instalar o GitHub CLI:   winget install --id GitHub.cli
    2. Autenticar:             gh auth login   (escolha GitHub.com > HTTPS > browser)

  Depois, rode este script a partir da pasta do repo:
    ./PUBLISH-KRISP-ALPHA.ps1

  O que ele faz:
    - Cria o fork devnagui/fvtt-module-avclient-livekit (se ainda nao existir)
    - Faz push da branch feature/krisp-noise-filter e da tag v0.6.8-krisp.alpha.1
    - (Re)builda e gera o zip
    - Cria o GitHub Release (prerelease) com o zip e o module.json anexados
    - Imprime o Manifest URL para instalar no Foundry
#>

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$Owner   = "devnagui"
$Repo    = "fvtt-module-avclient-livekit"
$Branch  = "feature/krisp-noise-filter"
$Tag     = "v0.6.8-krisp.alpha.1"
$Zip     = "fvtt-module-avclient-livekit.zip"
$PnpmCmd = { param($rest) corepack pnpm@11.7.0 @rest }

# 0. Sanity: gh disponivel?
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Error "GitHub CLI (gh) nao encontrado. Rode: winget install --id GitHub.cli ; depois gh auth login"
}

# 1. Garante o fork (nao falha se ja existir)
Write-Host "==> Garantindo o fork $Owner/$Repo ..." -ForegroundColor Cyan
try {
  gh repo view "$Owner/$Repo" *> $null
  Write-Host "    Fork ja existe." -ForegroundColor DarkGray
} catch {
  # Cria como fork do upstream (mantem historico) na conta autenticada
  gh repo fork "bekriebel/$Repo" --clone=false --fork-name $Repo
}

# 2. Aponta o remote 'fork' e faz push da branch + tag
Write-Host "==> Push da branch e tag ..." -ForegroundColor Cyan
if (-not (git remote | Select-String -SimpleMatch "fork")) {
  git remote add fork "https://github.com/$Owner/$Repo.git"
}
git push -u fork $Branch
git push fork $Tag

# 3. (Re)build + zip para garantir artefato atualizado
Write-Host "==> Build + empacotando o zip ..." -ForegroundColor Cyan
& $PnpmCmd @("install","--fetch-retries=1")
& $PnpmCmd @("run","build")
if (Test-Path $Zip) { Remove-Item $Zip }
Compress-Archive -Path .\dist\* -DestinationPath $Zip -Force

# 4. Cria o Release (prerelease) com os assets
Write-Host "==> Criando o GitHub Release $Tag ..." -ForegroundColor Cyan
gh release create $Tag `
  ".\$Zip" `
  ".\dist\module.json" `
  --repo "$Owner/$Repo" `
  --title "$Tag - Enhanced Noise Cancellation (Krisp) [alpha]" `
  --notes "Alpha build com cancelamento de ruido aprimorado (Krisp) ligado por padrao, botao de toggle na barra de camera, checkbox nas config, i18n (en/es/pl) e correcao dos controles em janela popout." `
  --prerelease

# 5. Mostra o link de instalacao
$manifest = "https://github.com/$Owner/$Repo/releases/download/$Tag/module.json"
Write-Host ""
Write-Host "PRONTO! Instale no Foundry via Manifest URL:" -ForegroundColor Green
Write-Host "  $manifest" -ForegroundColor Yellow
