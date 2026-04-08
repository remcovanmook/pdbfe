# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report
it responsibly. **Do not open a public GitHub issue.**

Email: **security@vanmook.net**

Include:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- Suggested fix (if you have one)

You should receive an acknowledgement within 48 hours. We will work with
you to understand the issue and coordinate a fix before any public
disclosure.

## Scope

This project is a read-only mirror of PeeringDB data. The primary
attack surfaces are:

- **XSS in the frontend** — mitigated by `escapeHTML()` enforcement via
  static analysis (pre-commit + CI).
- **SQL injection in the API worker** — mitigated by parameterised queries
  throughout. No raw string interpolation into SQL.
- **OAuth token handling** — session tokens are stored in HttpOnly cookies
  with Secure and SameSite attributes.
- **API key material** — keys are hashed (SHA-256) before storage. Only
  the prefix is stored in cleartext for identification.

## Supported Versions

Only the latest deployed version is supported. There are no backported
security patches.
