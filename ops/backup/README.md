# Backup setup: gecko-notes → Synology NAS

This sets up the `backup` service from `docker-compose.yml`: a small sidecar
that takes a whole-database snapshot and pushes it, together with the entire
`data/media/` tree, to a Synology NAS over SFTP on a schedule. See
`docs/backup-strategy.md` for the design rationale — this file is just the
step-by-step setup.

Nothing restic-specific needs to run on the NAS. It only needs its stock
SSH/SFTP service turned on; all the backup logic runs in the `backup`
container on the same host as the app.

This iteration wires up exactly one destination (the NAS), reached over a
direct router port-forward since gecko-notes runs on a separate remote host.
That means SSH is genuinely exposed to the internet, so the steps below lean
on key-only auth, a non-default port, a locked-down account, and DSM's
brute-force protection rather than skipping them.

## 1. On the Synology (DSM 7), as an admin

- **Control Panel → Terminal & SNMP** → enable **SSH service**.
- **Control Panel → File Services → FTP tab** → enable **SFTP Service**.
- **Control Panel → Shared Folder** → create a dedicated shared folder, e.g.
  `gecko-notes-backup`. Don't reuse an existing folder that holds anything else.
- **Control Panel → User & Group** → create a dedicated, non-admin local user,
  e.g. `gecko-backup`. Under its **Advanced** tab, enable **User Home
  service** — without it, `~/.ssh/authorized_keys` has nowhere to live.
- **Shared Folder permissions** → grant `gecko-backup` **Read/Write** on
  `gecko-notes-backup` only, and **No access** on every other shared folder.

## 2. Generate the backup keypair

On any trusted machine (not the NAS itself):

```sh
ssh-keygen -t ed25519 -N "" -f id_backup
```

Move both files into `ops/backup/secrets/` in this repo (`id_backup` and
`id_backup.pub`). That directory is gitignored — the private key must never
be committed.

## 3. Install the public key on the NAS

1. Log in once as `gecko-backup` via SSH using its password, just to make DSM
   create the home directory.
2. Via File Station (or an admin SSH session), create
   `homes/gecko-backup/.ssh/authorized_keys` containing the contents of
   `id_backup.pub`.
3. Permissions matter here and DSM is stricter than you'd expect:
   - the home directory itself: `755` (not `700` — DSM's sshd silently
     rejects key auth if the home directory is group/world-inaccessible)
   - `.ssh`: `700`
   - `authorized_keys`: `600`

## 4. Harden sshd and enable brute-force protection

- Confirm `PubkeyAuthentication yes` is set in `/etc/ssh/sshd_config` (check
  via an admin SSH session). Restart the SSH service from the DSM GUI
  (toggle it off/on in Terminal & SNMP) rather than a raw service-reload
  command — the GUI restart survives DSM updates more reliably.
- **Control Panel → Security** → enable **Auto Block** (naming/location
  varies a bit by DSM version) so repeated failed logins get the source IP
  banned automatically.

## 5. Router: port-forward

Forward an external, **non-default** port (e.g. `22022`, not `22`) to the
NAS's internal SSH port on its LAN IP. If the machine running gecko-notes has
a stable/static public IP, restrict the forward — or add a matching DSM
firewall rule — to allow only that one source IP. This single step removes
most of the risk of exposing SSH directly, so it's worth doing if at all
possible.

## 6. Pre-seed the host key

Run from the gecko-notes host (or anywhere that can already reach the NAS's
forwarded port):

```sh
ssh-keyscan -p <port> <ddns-or-public-ip> > ops/backup/secrets/known_hosts
ssh-keygen -lf ops/backup/secrets/known_hosts
```

`ssh-keyscan` itself doesn't verify anything — it just fetches whatever key
is offered. Compare the fingerprint it prints against the one DSM displays
under **Control Panel → Terminal & SNMP**. That comparison is what actually
establishes trust; skipping it defeats the point of `StrictHostKeyChecking`.

## 7. Fill in `.env`

In `.env` (not `.env.example` — that file stays a template), set:

```
RESTIC_PASSWORD=<generate with: openssl rand -base64 32>
BACKUP_SFTP_HOST=<ddns hostname or public IP>
BACKUP_SFTP_PORT=<the forwarded port>
BACKUP_SFTP_USER=gecko-backup
BACKUP_SFTP_REMOTE_PATH=/gecko-notes
```

Before trusting `BACKUP_SFTP_REMOTE_PATH`, test manually:

```sh
sftp -P <port> gecko-backup@<host>
```

then `pwd` / `ls` once connected. Synology's SFTP quirk: what that user sees
as `/` is actually their home/shared-folder, not the NAS's real filesystem
root — so the path restic should use is whatever you see from inside that
session, not something like `/volume1/gecko-notes-backup`.

Keep `RESTIC_PASSWORD` somewhere durable outside this repo too (a password
manager, etc.) — losing it makes every existing backup unrecoverable, since
restic encrypts client-side.

## 8. One-time init and first run

```sh
docker compose build backup
docker compose run --rm backup restic init
docker compose run --rm backup /usr/local/bin/backup.sh   # optional: don't wait for the first cron tick
docker compose up -d backup
```

## 9. Verify

```sh
docker compose run --rm backup restic snapshots
docker logs backup   # shows cron's output on later scheduled runs
```

## Later: adding a second destination

`docs/backup-strategy.md` also describes fanning the same backup out to an
off-site S3-compatible bucket for real geographic redundancy. That's
deliberately deferred — this iteration only wires up the NAS. Adding it
later just means a second `restic backup ... -r <bucket-repo>` (and its own
`restic forget`) in `backup.sh`, with its own credentials — no changes to
the NAS-side setup above.
