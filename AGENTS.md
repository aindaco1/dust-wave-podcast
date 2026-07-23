# Repository guidance

- Keep the Worker stateless. Durable state belongs in a bound Cloudflare service.
- Never commit credentials, private feed tokens, subscriber email addresses, or provider payloads.
- Put schema changes in ordered D1 migrations; do not edit an applied migration.
- Keep staging and production bindings explicit in `wrangler.jsonc`.
- Reuse `shared/dust-wave-platform` before introducing a Pool/Store/Dust Wave duplicate.
- Run `npm run check` and both Wrangler dry runs before opening or updating a release PR.

