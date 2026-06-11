# Verify Spatula Container Images (cosign)

All four Spatula container images (`api`, `worker`, `migrate`, `cli`) are:

- **Multi-arch** — `linux/amd64` and `linux/arm64`
- **Keyless cosign-signed** — GitHub Actions OIDC → Fulcio short-lived certificate → signature in Rekor transparent log. No private signing key is used or stored.
- **SBOM-attested** — A `cyclonedx-json` SBOM is generated for each image, attached to the image via `cosign attest`, and also uploaded as a GitHub release asset (`sbom-{image}.cdx.json`).

> **CI-only signing note:** The signing and attestation steps run inside the GitHub Actions release workflow. The `cosign verify` commands below verify signatures that were created in CI — they can be run from any machine with `cosign` installed, but they require the image to have been published via a real release tag.

---

## Prerequisites

Install `cosign` on your machine:

```bash
# macOS
brew install cosign

# Linux (amd64)
curl -sL https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64 \
  -o /usr/local/bin/cosign && chmod +x /usr/local/bin/cosign

# Verify installation
cosign version
```

---

## Verify Image Signature

Replace `<version>` with the release tag (e.g. `1.1.0`). Repeat for each image: `api`, `worker`, `migrate`, `cli`.

```bash
cosign verify \
  ghcr.io/accidentally-awesome-labs/spatula/api:<version> \
  --certificate-identity-regexp='https://github\.com/accidentally-awesome-labs/spatula/\.github/workflows/release\.yml@refs/tags/.*' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com'
```

Successful output lists one or more verification entries in JSON. Each entry confirms:
- The signature was made by the Spatula release workflow (identity regexp match)
- The OIDC issuer is GitHub Actions (not a private key)
- The certificate chain traces to Sigstore's Fulcio CA

**All four images — same command, different image name:**

```bash
for IMAGE in api worker migrate cli; do
  echo "=== Verifying $IMAGE ==="
  cosign verify \
    ghcr.io/accidentally-awesome-labs/spatula/${IMAGE}:<version> \
    --certificate-identity-regexp='https://github\.com/accidentally-awesome-labs/spatula/\.github/workflows/release\.yml@refs/tags/.*' \
    --certificate-oidc-issuer='https://token.actions.githubusercontent.com'
done
```

---

## Verify SBOM Attestation

Each image has a `cyclonedx-json` SBOM attested via `cosign attest`. To verify and extract the SBOM:

```bash
cosign verify-attestation \
  ghcr.io/accidentally-awesome-labs/spatula/api:<version> \
  --type cyclonedx \
  --certificate-identity-regexp='https://github\.com/accidentally-awesome-labs/spatula/\.github/workflows/release\.yml@refs/tags/.*' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com' \
  | jq '.payload | @base64d | fromjson | .predicate'
```

The SBOM is also available as a downloadable release asset on the GitHub Releases page:
`sbom-api.cdx.json`, `sbom-worker.cdx.json`, `sbom-migrate.cdx.json`, `sbom-cli.cdx.json`

---

## Verifying the arm64 Image

The same signature covers the manifest list (multi-arch manifest), so `cosign verify` works identically for both architectures. To specifically pull and run the `arm64` image:

```bash
# Pull the arm64 image explicitly
docker pull --platform linux/arm64 ghcr.io/accidentally-awesome-labs/spatula/api:<version>

# Then run the same cosign verify command — the signature covers the manifest list
cosign verify \
  ghcr.io/accidentally-awesome-labs/spatula/api:<version> \
  --certificate-identity-regexp='https://github\.com/accidentally-awesome-labs/spatula/\.github/workflows/release\.yml@refs/tags/.*' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com'
```

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `cosign verify <image> --certificate-identity-regexp=... --certificate-oidc-issuer=...` | Verify keyless signature |
| `cosign verify-attestation <image> --type cyclonedx ...` | Verify + extract SBOM attestation |
| `docker pull --platform linux/arm64 <image>` | Pull arm64 variant explicitly |

---

## Namespace Note

The examples above use `ghcr.io/accidentally-awesome-labs/spatula` as the image namespace. This matches the `github.repository` value at release time. If the repository is forked or the namespace changes, substitute the correct namespace. The `--certificate-identity-regexp` must match the actual workflow path in the signing repository.

---

## Transparency Log

All Spatula release signatures are recorded in the [Rekor](https://rekor.sigstore.dev) public transparency log. You can look up any signature by digest:

```bash
rekor-cli search --sha $(docker inspect --format='{{index .RepoDigests 0}}' \
  ghcr.io/accidentally-awesome-labs/spatula/api:<version> | cut -d@ -f2)
```

Or browse entries at [search.sigstore.dev](https://search.sigstore.dev).
