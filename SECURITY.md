# Security policy

`wp-ssh-mcp` handles a secret key that can control a WordPress site, so please report problems privately.

**Report a vulnerability:** use GitHub's *Security → Report a vulnerability* (private advisory) on this repository. Please do not open a public issue for security problems.

Include what you found, how to reproduce it, and the version (`npx wp-ssh-mcp --version`).

## Design rules this project follows

- Starts in **read mode**; write and risky tools are hidden until the user opts in with `WPSSH_MODE`.
- Never prints or returns the secret key.
- Refuses plain `http://` (except localhost) and never follows redirects, so the key is not forwarded elsewhere.
- No telemetry and no third-party servers: it talks only to the site URLs the user configures.

Note: the WP SSH plugin has its own security policy in [MSSOFTPC/wp-ssh](https://github.com/MSSOFTPC/wp-ssh).
