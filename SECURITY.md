# Security Policy

## Supported Versions

The following version lines receive security fixes:

| Version | Supported                                    |
| ------- | -------------------------------------------- |
| 1.x     | :white_check_mark:                           |
| 0.x     | :white_check_mark: (until 1.0 GA + 6 months) |

Security fixes for 0.x will be backported only for Critical and High severity issues.
Once 1.0 GA is released, 0.x will move to end-of-life after a 6-month transition window.

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues, pull
requests, or Discussions.** Public disclosure before a fix is available puts all users
at risk.

Instead, report vulnerabilities via **private disclosure**:

- **Email:** security@spatula.dev
- **Subject line:** `[SECURITY] <brief description>`

Include in your report:

1. A description of the vulnerability and its impact
2. Steps to reproduce (proof-of-concept if available)
3. The Spatula version(s) affected
4. Any potential mitigations you have identified
5. Whether you prefer to be credited publicly or remain anonymous in the advisory

We follow [coordinated vulnerability disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure).
We will credit reporters in the GitHub Security Advisory unless they prefer anonymity.

## GPG Key

PGP-encrypted reports are not yet accepted. Use `security@spatula.dev` for
private disclosure until this section publishes a real public key fingerprint.

## Response SLA

We aim to meet the following response targets:

| Severity            | Acknowledgement  | Triage                   | Fix Target   |
| ------------------- | ---------------- | ------------------------ | ------------ |
| Critical            | 24 hours         | 48 hours                 | 7 days       |
| High                | 48 hours         | 5 business days          | 30 days      |
| Medium              | 5 business days  | 10 business days         | 90 days      |
| Low / Informational | 10 business days | At maintainer discretion | Next release |

**Critical issues** (e.g., remote code execution, authentication bypass, data exfiltration)
receive a 24-hour acknowledgement target and an emergency patch release on a best-effort basis.

If you have not received an acknowledgement within the stated SLA, follow up at
security@spatula.dev.

## Scope

The following are **in scope** for security reports:

- `@accidentally-awesome-labs/spatula-core`, `@accidentally-awesome-labs/spatula-db`, `@accidentally-awesome-labs/spatula-queue`, `@accidentally-awesome-labs/spatula-shared`
- `apps/api` (`@accidentally-awesome-labs/spatula-api`) — the REST API server
- `apps/cli` (`@accidentally-awesome-labs/spatula`) — the CLI/TUI application
- Docker images published to `ghcr.io/accidentally-awesome-labs/spatula`

The following are **out of scope**:

- Third-party dependencies — please report upstream; we will track CVEs via Dependabot
- Social engineering attacks
- Denial of service attacks (volumetric)
- Issues requiring physical access to a user's machine
- Vulnerabilities in systems or software not listed above

## Disclosure Policy

Once a fix is available, we will:

1. Publish a GitHub Security Advisory with the CVE (if assigned)
2. Release a patched version
3. Credit the reporter (unless they prefer anonymity)
4. Add the issue to the `CHANGELOG.md` security section

We request a **90-day coordinated disclosure window** from first contact before any public
disclosure. We will work with reporters to agree on a shorter timeline for Critical issues.
