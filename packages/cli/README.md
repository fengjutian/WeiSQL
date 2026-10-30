# @weisql/cli

Command line tools for WeiSQL AI data packages. The package is intentionally
thin: all validation logic lives in `@weisql/sdk`; this package only adds
argument parsing, formatting and exit codes.

## Validate a package

```bash
weisql validate ./examples/fixture
weisql validate ./examples/fixture --mode manifest --json
```

Stages, in order:

1. `manifest.json` exists, parses as JSON, and passes Manifest V1 L1/L2 checks.
2. Every declared resource is verified according to the selected mode:
   - `all` (default): size and SHA-256,
   - `manifest`: size only,
   - `none`: structure only.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | package is valid |
| 1 | package is invalid |
| 2 | usage error |

`--json` prints `{ ok, directory, mode, datasetId, integrity, issues }`. Each
issue carries `stage` (`manifest` or `resources`), a stable `code`, a message
and `details` (for example the offending `path`).

## Notes

- The command never opens a Runtime, so it cannot be used to test SQL or vector
  queries; it answers "is this directory a complete, self-consistent package?".
- `--mode manifest` cannot detect same-length content tampering. That is the
  documented difference between the two modes, not a bug.
