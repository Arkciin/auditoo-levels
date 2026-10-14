export interface Migration {
  readonly name: string;
  readonly sql: string;
}

/**
 * Schema migrations, applied in order. The SQL is embedded so that the bundled server needs no
 * extra files at runtime. A migration that has shipped must never change: add a new one instead.
 */
export const migrations: readonly Migration[] = [
  {
    name: "001_init",
    sql: /* sql */ `
      -- Singleton holding the global version. Every committed change bumps it by one and stamps it
      -- on the rows it wrote, so "rows with version > cursor" is exactly what a device is missing.
      CREATE TABLE server_meta (id integer PRIMARY KEY CHECK (id = 1), version bigint NOT NULL);
      INSERT INTO server_meta (id, version) VALUES (1, 0);

      -- One row per device: the last mutation processed for it, which makes pushes idempotent.
      CREATE TABLE clients (
        id uuid PRIMARY KEY,
        last_mutation_id bigint NOT NULL DEFAULT 0,
        last_seen_at timestamptz NOT NULL DEFAULT now()
      );

      -- Timestamps that travel to devices (created_at, deleted_at) are epoch-ms bigints, exactly
      -- what the shared mutators compute on devices, so server rows and optimistic rows are
      -- identical. Deletes are soft (deleted_at) so that they sync like any other change and can
      -- be undone. updated_at is server-side bookkeeping only.
      CREATE TABLE properties (
        id uuid PRIMARY KEY,
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
        created_at bigint NOT NULL,
        deleted_at bigint,
        version bigint NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX properties_version_idx ON properties (version);

      -- Positions are fractional-index keys: they must compare by code unit, hence COLLATE "C"
      -- (a locale-aware collation interleaves upper and lower case and breaks the order).
      CREATE TABLE levels (
        id uuid PRIMARY KEY,
        property_id uuid NOT NULL REFERENCES properties (id),
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
        position text COLLATE "C" NOT NULL,
        deleted_at bigint,
        version bigint NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX levels_version_idx ON levels (version);
      CREATE INDEX levels_property_position_idx ON levels (property_id, position);

      CREATE TABLE spaces (
        id uuid PRIMARY KEY,
        level_id uuid NOT NULL REFERENCES levels (id),
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
        position text COLLATE "C" NOT NULL,
        deleted_at bigint,
        version bigint NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX spaces_version_idx ON spaces (version);
      CREATE INDEX spaces_level_position_idx ON spaces (level_id, position);
    `,
  },
  {
    name: "002_server_epoch",
    sql: /* sql */ `
      -- Identity of this database, drawn when it is created. Devices record the epoch their data
      -- comes from: another epoch means the database was replaced, so their cursor and the
      -- mutations it acknowledged mean nothing here, and they start over from a full pull.
      -- Restoring a backup replaces the database too: draw a new epoch right after it with
      --   UPDATE server_meta SET epoch = gen_random_uuid();
      ALTER TABLE server_meta ADD COLUMN epoch uuid NOT NULL DEFAULT gen_random_uuid();
    `,
  },
  {
    name: "003_rejected_mutations",
    sql: /* sql */ `
      -- The mutations rejected for each device, written with the acknowledgement. A push retried
      -- after its response was lost finds them already processed: this is how the server can still
      -- tell the device, which would otherwise drop them at its next pull without a word. Reasons
      -- are codes (RejectionReason in packages/shared/src/protocol.ts), never user data.
      CREATE TABLE rejected_mutations (
        client_id uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
        mutation_id bigint NOT NULL,
        reason text NOT NULL,
        rejected_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (client_id, mutation_id)
      );
    `,
  },
];
