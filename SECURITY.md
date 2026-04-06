# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.x     | :white_check_mark: |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, email **security@spatula.dev** with:

1. A description of the vulnerability
2. Steps to reproduce
3. Affected versions
4. Any potential mitigations you've identified

### What to Expect

- **Acknowledgement:** Within 48 hours
- **Status update:** Within 7 days
- **Resolution target:** Within 30 days for critical issues

We follow [coordinated vulnerability disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure). We will credit reporters in the advisory unless they prefer to remain anonymous.

## Scope

The following are in scope:

- `@spatula/core`, `@spatula/db`, `@spatula/queue`, `@spatula/shared`
- `@spatula/api`, `@spatula/cli`
- Docker images published to `ghcr.io`

The following are out of scope:

- Third-party dependencies (report upstream)
- Social engineering attacks
- Denial of service attacks
