import type { Level, MutatorTx, Property, Space } from "@repo/shared";
import type { Queryable } from "../db/sql";
import { SELECT_LEVELS, SELECT_PROPERTIES, SELECT_SPACES } from "./queries";

/**
 * Runs the shared mutators against the database, inside the caller's transaction. Every row a
 * mutation writes is stamped with `version`, the server version that mutation produces.
 */
export class ServerTx implements MutatorTx {
  private wrote = false;

  constructor(
    private readonly sql: Queryable,
    private readonly version: number,
  ) {}

  /** Whether the mutation wrote anything (some are no-ops, e.g. deleting a deleted space). */
  get changed(): boolean {
    return this.wrote;
  }

  async getProperty(id: string): Promise<Property | undefined> {
    const [property] = await this.sql.query<Property>(`${SELECT_PROPERTIES} WHERE id = $1`, [id]);
    return property;
  }

  async getLevel(id: string): Promise<Level | undefined> {
    const [level] = await this.sql.query<Level>(`${SELECT_LEVELS} WHERE id = $1`, [id]);
    return level;
  }

  async getSpace(id: string): Promise<Space | undefined> {
    const [space] = await this.sql.query<Space>(`${SELECT_SPACES} WHERE id = $1`, [id]);
    return space;
  }

  async getSpaces(ids: readonly string[]): Promise<Space[]> {
    if (ids.length === 0) return [];
    return this.sql.query<Space>(`${SELECT_SPACES} WHERE id = ANY($1::uuid[])`, [ids]);
  }

  // A put replaces the whole entity, exactly like the device-side snapshot transaction does.

  async putProperty({ id, name, createdAt, deletedAt }: Property): Promise<void> {
    await this.write(
      `INSERT INTO properties (id, name, created_at, deleted_at, version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name,
         created_at = excluded.created_at,
         deleted_at = excluded.deleted_at,
         version = excluded.version,
         updated_at = now()`,
      [id, name, createdAt, deletedAt, this.version],
    );
  }

  async putLevel({ id, propertyId, name, position, deletedAt }: Level): Promise<void> {
    await this.write(
      `INSERT INTO levels (id, property_id, name, position, deleted_at, version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         property_id = excluded.property_id,
         name = excluded.name,
         position = excluded.position,
         deleted_at = excluded.deleted_at,
         version = excluded.version,
         updated_at = now()`,
      [id, propertyId, name, position, deletedAt, this.version],
    );
  }

  async putSpace({ id, levelId, name, position, deletedAt }: Space): Promise<void> {
    await this.write(
      `INSERT INTO spaces (id, level_id, name, position, deleted_at, version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         level_id = excluded.level_id,
         name = excluded.name,
         position = excluded.position,
         deleted_at = excluded.deleted_at,
         version = excluded.version,
         updated_at = now()`,
      [id, levelId, name, position, deletedAt, this.version],
    );
  }

  private async write(statement: string, params: readonly unknown[]): Promise<void> {
    await this.sql.query(statement, params);
    this.wrote = true;
  }
}
