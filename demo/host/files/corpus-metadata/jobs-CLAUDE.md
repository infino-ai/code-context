# Job postings corpus

284,622 job postings from three applicant-tracking systems — Ashby, Greenhouse
and Lever — as daily snapshots collected 8–11 September 2026 (the
`edwarddgao/open-apply-jobs` dataset, 10 Parquet shards, one per board per
day): 878,682 rows in all. A posting open on several of those days appears
once per day, with the same `id`, so a count that means postings must count
DISTINCT `id` (greenhouse 484,878 rows / 169,509 postings; ashby 255,830 /
67,118; lever 137,974 / 47,995). Here the rows are laid out as NDJSON: one row
per line as a JSON object, 250 lines per file, 6.4 GB in all:

    ashby/2026-09-08-0000.ndjson … ashby/2026-09-11-NNNN.ndjson
    greenhouse/2026-09-09-0000.ndjson … greenhouse/2026-09-11-NNNN.ndjson
    lever/2026-09-09-0000.ndjson … lever/2026-09-11-NNNN.ndjson

The directory name is the job board the posting came from; the date in the file
name is the day it was collected, not the day it was posted.

Every line carries the same fields:

- `id` — `<board>:<employer slug>:<posting id>`, unique
- `source_slug` — the employer's slug at the job board
- `title` — the posting's title
- `apply_url` — the application link
- `description_html` — the whole posting as raw HTML (mean ~7,000 characters)
- `employment_type` — as the board reports it and null on 56% of rows; the
  rest is not normalised (`FullTime` 238,571, `Full-time` 29,297, `Full-Time`
  18,346, `Full Time` 16,943, `Contract`, `PartTime`, `Part Time`, `Intern`, …)
- `department`
- `locations` — a list of strings, as written by the employer
- `remote` — true on 200,366 rows, else false or null
- `posted_at`, `updated_at` — ISO-8601 strings, or null
- `salary_min`, `salary_max` — numbers, or null when the posting lists none
- `salary_currency`, `salary_period`

The same rows, with the same field names, are loaded in the hosted Infino table
`chunks_jobs`: full-text indexed on `title` and `description_html`, with a
vector index (`emb`) built from `title`.
