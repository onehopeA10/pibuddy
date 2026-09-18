# SQLite partitions and backup

## Twelve independent databases

Durable state is partitioned by capability across **twelve independent SQLite files**. Hits for `FOREIGN KEY` / `REFERENCES` / `ATTACH DATABASE` across the repo are zero: there are no foreign keys and no cross-database transactions.

| File | Generation source | Contents |
| --- | --- | --- |
| `artifacts.db` | `PRAGMA user_version` | Artifact version chain and status |
| `changesets.db` | `PRAGMA user_version` | Workspace change review |
| `connectors.db` | `PRAGMA user_version` | External channel connectors |
| `home-assistant.db` | `PRAGMA user_version` | Home-entity registry |
| `home-automation.db` | `PRAGMA user_version` | Home-automation rules |
| `memory.db` | `PRAGMA user_version` | Memory / knowledge base / vectors |
| `remote.db` | `PRAGMA user_version` | Remote devices and audit |
| `session-index.db` | `PRAGMA user_version` | Session index |
| `tasks.db` | `PRAGMA user_version` | Scheduled tasks and runs |
| `usage.db` | one row in `usage_meta` | Usage and cost |
| `workflows.db` | `PRAGMA user_version` | Workflow definitions and runs |
| `workspaces.db` | `PRAGMA user_version` | Workspace preferences |

## Consistency: per-database snapshot, not an atomic snapshot

Backup calls the online `backup()` of `node:sqlite` one database at a time. Each database is **internally** consistent. Cross-database consistency is best-effort — tens to hundreds of milliseconds can pass between the first and the twelfth snapshot.

That is a **direct consequence of the partition, not a defect** — there is no cross-database invariant to maintain. This sentence must appear on the settings page as written.

## Backup scope

- **Included**: the twelve databases plus `workspaces.json` (the workspace registry; `workspace_id` columns only make sense with it).
- **Excluded**: `settings.json`, account credentials (`auth.json` / secret-store), logs, and artifact file bodies (ordinary files in the user workspace).

The backup manifest schema is `BACKUP_SCHEMA_VERSION = 1` (`contract/src/backup.ts`).

## Restore is two-phase

```
backup:restore
   │  only drops a validated copy into userData/pending-restore/
   ▼
next launch (first line of whenReady in main/index.ts, before any store opens)
   │  applyPendingRestoreOnStartup() actually applies it
   ▼
pending area deleted only after every rename succeeds
```

In-place replace is not possible — twelve handles are open, and a rename-over on Windows can EPERM. The pending area is deleted only after every rename succeeds, so a crash mid-apply converges on the next launch.

## Single implementations

| Capability | Only implementation |
| --- | --- |
| Backup logic (registry / manifest codec / path containment / inventory) | `app/src/main/backup/backup-manifest.ts` |
| Backup I/O (snapshot / fsync / verify / staging / apply) | `app/src/main/backup/backup-service.ts` |
| Four IPC channels (including directory and confirm dialogs) | `app/src/main/backup/backup-ipc.ts` |

> An update must not migrate or delete user sessions, settings, vault, indexes, or drafts. Database migrations must be forward-compatible and backup-able. On failure the app enters recovery mode instead of crash-looping. See [Updates and release](/en/delivery/).

Chinese companion: [SQLite 分区与备份](/data/).
