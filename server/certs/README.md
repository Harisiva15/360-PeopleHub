# Database CA certificate

`supabase-prod-ca-2021.crt` is Supabase's public root, **Supabase Root 2021 CA**.
`PGSSLROOTCERT` points at it so the API verifies the database's certificate
instead of merely encrypting to it.

## Why it is committed

It is a public root certificate, not a credential — it authenticates the
database *to us* and grants nothing. Downloading it at deploy time would add a
network dependency to every boot and a step that can be skipped; committing it
means `PGSSLROOTCERT` is a path that already exists wherever the code does.

Obtained from Supabase's published download, not from the chain the server
itself presents. Taking a root from the server you are about to verify is
circular and proves nothing.

## What it verifies

The shared pooler presents:

    *.pooler.supabase.com
      -> Supabase Intermediate 2021 CA
        -> Supabase Root 2021 CA        <- this file

The leaf carries `DNS:*.pooler.supabase.com` and `DNS:*.pooler.supabase.co`, so
the hostname check passes for the pooler host as well as the chain.

## Expiry

Valid until **26 April 2031**. `npm run check:tls` reports the date; when
Supabase rotates, replace this file from their download page.

## If your platform has no writable path

Write the certificate to a file at boot from a platform secret and point
`PGSSLROOTCERT` at wherever you put it. The code reads a path and nothing else,
so any method that produces a readable file works.
