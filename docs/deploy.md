# Deploying

The app is a static single-page site. There is no server: it builds to `dist/`
and any static host will serve it. `HashRouter` keeps routes after the `#`, so
no URL-rewrite rules are needed anywhere.

## GitHub Pages (what is set up)

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) builds and
publishes on every push to `main`. It runs the same gates as local — typecheck,
lint, service checks — and publishes only if they pass.

The repo is `Harisiva15/360-PeopleHub` and the site is
**https://harisiva15.github.io/360-PeopleHub/**. Every push to `main`
redeploys it.

Nothing has to be enabled by hand: `configure-pages` is set to `enablement:
true`, so the first successful run turns Pages on with the workflow's own
token.

A **project site is served from `/<repo>/`**, not the domain root, which is why
the workflow sets `BASE_PATH`. Building without it produces a site whose asset
URLs are wrong for that host.

## Anywhere else

```bash
npm run build          # BASE_PATH=/ by default — correct for a domain root
```

Then serve `dist/`. For a subdirectory, set `BASE_PATH` to match:

```bash
BASE_PATH=/hr/ npm run build
```

To check a subdirectory build before shipping it, `BASE_PATH` must be set for
`vite preview` too, not only for the build — otherwise preview serves from the
root and its SPA fallback returns `index.html` for every asset request, so
everything looks like a 200 whether or not it works.

## What this deployment is not

It has **no authentication**. The role switcher is client-side state, so anyone
with the URL can become an admin and read every salary, PAN and bank account in
the sample data. That data is fabricated, which is what makes a public demo
fine — but the same build must not be pointed at real records.

Making it real means implementing [`docs/api-contract.md`](api-contract.md)
behind a session, and calling `setServices()` in
[`src/services/index.ts`](../src/services/index.ts). No screen changes.
