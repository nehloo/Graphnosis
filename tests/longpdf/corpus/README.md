# Long-PDF benchmark corpus

We do not redistribute the source documents. Fetch each one locally; the harness
expects them at the paths below.

| Path | Source | License |
|---|---|---|
| `filing.pdf` | NVIDIA Form 10-K, fiscal year 2024 (filed 2024-02-21). Download from SEC EDGAR. | Public — SEC filing |
| `manual.pdf` | PostgreSQL 16 documentation, whole-docs A4 PDF (`postgresql-16-A4.pdf`). | PostgreSQL License (MIT-equivalent) |
| `paper.pdf`  | "2 OLMo 2 Furious" (Team OLMo et al., 2025), `arXiv:2501.00656`. ~36 pages main + appendices. | CC-BY 4.0 (verified) |

## Fetch commands

```bash
# filing.pdf — NVDA FY2024 10-K. Find the 2024-02-21 filing on EDGAR:
#   https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=10-K
# then download the full submission as PDF (or print-to-PDF the .htm).

# manual.pdf — Postgres 16 docs, whole-docs A4 PDF.
curl -L -o tests/longpdf/corpus/manual.pdf https://www.postgresql.org/files/documentation/pdf/16/postgresql-16-A4.pdf

# paper.pdf — OLMo 2 (CC-BY 4.0).
curl -L -o tests/longpdf/corpus/paper.pdf https://arxiv.org/pdf/2501.00656
```

## Pinning

Once you've downloaded each file, write its SHA-256 to `corpus/CHECKSUMS.txt`
(one `sha256  filename` per line). The harness verifies these on every run so
benchmark numbers are tied to specific document bytes.

```
shasum -a 256 corpus/filing.pdf corpus/manual.md corpus/paper.pdf > corpus/CHECKSUMS.txt
```

## Swap policy

If you swap any document, also bump the version field in `tests/longpdf/README.md`
and start a new dated `results/` folder. Don't compare numbers across corpus
versions.
