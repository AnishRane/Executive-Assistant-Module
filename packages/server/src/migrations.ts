// Migration[] for the install pipeline. Each migration's up()
// runs CREATE TABLE + indexes; down() drops them. Tracked via the
// framework's module_migrations table so re-installs are idempotent.
//
// Keep in lockstep with packages/server/src/schema/*.ts — the
// Drizzle pgTable definitions are the typed query layer, this file
// is the DDL the framework actually executes.

import type { Migration } from "@boringos/module-sdk";

const init: Migration = {
  id: "001-init",
  async up(db) {
    // ── snapshots ─────────────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__snapshots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        snapshot_date date NOT NULL,
        generated_at timestamptz NOT NULL DEFAULT now(),
        narrative_brief text,
        status text NOT NULL DEFAULT 'composed'
      );
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__snapshots_tenant_idx ON executive_assistant__snapshots(tenant_id);`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS ea__snapshots_tenant_date_uniq ON executive_assistant__snapshots(tenant_id, snapshot_date);`);

    // ── timeline_items ───────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__timeline_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        snapshot_id uuid NOT NULL,
        kind text NOT NULL,
        ref_id uuid NOT NULL,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz,
        elevated boolean NOT NULL DEFAULT false,
        elevation_reason text,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__timeline_snapshot_idx ON executive_assistant__timeline_items(snapshot_id, starts_at);`);

    // ── meetings ─────────────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__meetings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        google_event_id text NOT NULL,
        title text NOT NULL,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        location text,
        conference_link text,
        organizer_email text,
        brief text,
        gmail_thread_id text,
        last_change_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__meetings_tenant_idx ON executive_assistant__meetings(tenant_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__meetings_starts_idx ON executive_assistant__meetings(tenant_id, starts_at);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__meetings_thread_idx ON executive_assistant__meetings(tenant_id, gmail_thread_id);`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS ea__meetings_tenant_geid_uniq ON executive_assistant__meetings(tenant_id, google_event_id);`);

    // ── meeting_attendees ────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__meeting_attendees (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        meeting_id uuid NOT NULL,
        email text NOT NULL,
        name text,
        title text,
        company text,
        bio text,
        is_external boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__meeting_attendees_meeting_idx ON executive_assistant__meeting_attendees(meeting_id);`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS ea__meeting_attendees_meeting_email_uniq ON executive_assistant__meeting_attendees(meeting_id, email);`);

    // ── trips ────────────────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__trips (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        label text NOT NULL,
        origin text,
        destination text,
        starts_on date,
        ends_on date,
        status text NOT NULL DEFAULT 'planned',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__trips_tenant_idx ON executive_assistant__trips(tenant_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__trips_dates_idx ON executive_assistant__trips(tenant_id, starts_on, ends_on);`);

    // ── trip_legs ────────────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__trip_legs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        trip_id uuid NOT NULL,
        kind text NOT NULL,
        confirmation_code text,
        provider text,
        starts_at timestamptz,
        ends_at timestamptz,
        origin_location text,
        destination_location text,
        current_state jsonb NOT NULL DEFAULT '{}'::jsonb,
        source_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        last_reconciled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__trip_legs_trip_idx ON executive_assistant__trip_legs(trip_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__trip_legs_starts_idx ON executive_assistant__trip_legs(starts_at);`);
    // PNR dedup: same trip + kind + non-null confirmation = same leg.
    // Partial index lets NULL confirmation_code rows (early in
    // reconciliation, before any email carries a PNR header) coexist.
    await db.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS ea__trip_legs_pnr_uniq
        ON executive_assistant__trip_legs(trip_id, kind, confirmation_code)
        WHERE confirmation_code IS NOT NULL;
    `);

    // ── email_anchors ────────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__email_anchors (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        gmail_message_id text NOT NULL,
        gmail_thread_id text,
        anchor_kind text NOT NULL,
        bound_entity_kind text NOT NULL,
        bound_entity_id uuid NOT NULL,
        fetched_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__email_anchors_tenant_idx ON executive_assistant__email_anchors(tenant_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__email_anchors_entity_idx ON executive_assistant__email_anchors(bound_entity_kind, bound_entity_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__email_anchors_thread_idx ON executive_assistant__email_anchors(tenant_id, gmail_thread_id);`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS ea__email_anchors_tenant_msg_uniq ON executive_assistant__email_anchors(tenant_id, gmail_message_id);`);

    // ── ooo_windows ──────────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__ooo_windows (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        source text NOT NULL,
        source_ref_id text,
        label text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__ooo_tenant_idx ON executive_assistant__ooo_windows(tenant_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS ea__ooo_time_idx ON executive_assistant__ooo_windows(tenant_id, starts_at, ends_at);`);
    // Dedup the calendar-sourced windows on re-sync (email-sourced ones
    // have a NULL source_ref_id and stay un-dedup'd at the DB layer).
    await db.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS ea__ooo_calendar_uniq
        ON executive_assistant__ooo_windows(tenant_id, source_ref_id)
        WHERE source = 'calendar_event' AND source_ref_id IS NOT NULL;
    `);
  },
  async down(db) {
    // Reverse FK order. timeline_items + email_anchors are leaves that
    // logically reference everything else, so drop them first.
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__timeline_items CASCADE;`);
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__email_anchors CASCADE;`);
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__trip_legs CASCADE;`);
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__trips CASCADE;`);
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__meeting_attendees CASCADE;`);
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__meetings CASCADE;`);
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__ooo_windows CASCADE;`);
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__snapshots CASCADE;`);
  },
};

// Phase 2 — Morning composition tables, plus a partial-unique swap on
// snapshots so the agent can re-compose a day (the prior row is marked
// superseded). Without the swap, the second compose hits the full
// unique constraint and the supersede path fails.
const phase2Composition: Migration = {
  id: "002-phase2-composition",
  async up(db) {
    // ── snapshots: full unique → partial unique on status='composed' ──
    await db.execute(
      `DROP INDEX IF EXISTS ea__snapshots_tenant_date_uniq;`,
    );
    await db.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS ea__snapshots_tenant_date_composed_uniq
        ON executive_assistant__snapshots(tenant_id, snapshot_date)
        WHERE status = 'composed';
    `);

    // ── thread_excerpts ─────────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__thread_excerpts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        meeting_id uuid NOT NULL,
        from_name text,
        from_email text,
        sent_at timestamptz,
        body text NOT NULL,
        source_message_id text,
        included_in_snapshot_id uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.execute(
      `CREATE INDEX IF NOT EXISTS ea__thread_excerpts_meeting_idx ON executive_assistant__thread_excerpts(meeting_id);`,
    );
    await db.execute(
      `CREATE INDEX IF NOT EXISTS ea__thread_excerpts_snapshot_idx ON executive_assistant__thread_excerpts(included_in_snapshot_id);`,
    );

    // ── action_items ────────────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__action_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        meeting_id uuid NOT NULL,
        owed_by text NOT NULL,
        text text NOT NULL,
        status text NOT NULL DEFAULT 'open',
        source_message_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.execute(
      `CREATE INDEX IF NOT EXISTS ea__action_items_meeting_idx ON executive_assistant__action_items(meeting_id);`,
    );
    await db.execute(
      `CREATE INDEX IF NOT EXISTS ea__action_items_status_idx ON executive_assistant__action_items(meeting_id, status);`,
    );
  },
  async down(db) {
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__action_items CASCADE;`);
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__thread_excerpts CASCADE;`);
    await db.execute(`DROP INDEX IF EXISTS ea__snapshots_tenant_date_composed_uniq;`);
    // Restore the original full unique constraint so older tenants
    // downgrading to phase 1 keep the same invariant.
    await db.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS ea__snapshots_tenant_date_uniq
        ON executive_assistant__snapshots(tenant_id, snapshot_date);
    `);
  },
};

// Phase 4 — Deltas + Conflicts.
// Deltas track changes since the morning snapshot; conflicts track
// pairwise overlaps. The CHECK constraint on conflicts forces the
// pair-order canonical (a < b) so the unique index on
// (snapshot_id, a, b) actually dedupes regardless of insert order.
const phase4DeltasConflicts: Migration = {
  id: "003-phase4-deltas-conflicts",
  async up(db) {
    // ── deltas ─────────────────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__deltas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        snapshot_id uuid NOT NULL,
        timeline_item_id uuid NOT NULL,
        delta_kind text NOT NULL,
        summary text,
        meta jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        acknowledged_at timestamptz
      );
    `);
    await db.execute(
      `CREATE INDEX IF NOT EXISTS ea__deltas_snapshot_idx ON executive_assistant__deltas(snapshot_id, occurred_at);`,
    );
    await db.execute(
      `CREATE INDEX IF NOT EXISTS ea__deltas_item_idx ON executive_assistant__deltas(timeline_item_id);`,
    );

    // ── conflicts ──────────────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__conflicts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        snapshot_id uuid NOT NULL,
        timeline_item_a_id uuid NOT NULL,
        timeline_item_b_id uuid NOT NULL,
        overlap_minutes integer NOT NULL,
        detected_at timestamptz NOT NULL DEFAULT now(),
        resolution_status text NOT NULL DEFAULT 'unresolved',
        resolved_choice uuid,
        CONSTRAINT ea__conflicts_pair_order_chk
          CHECK (timeline_item_a_id < timeline_item_b_id)
      );
    `);
    await db.execute(
      `CREATE INDEX IF NOT EXISTS ea__conflicts_tenant_idx ON executive_assistant__conflicts(tenant_id);`,
    );
    await db.execute(
      `CREATE INDEX IF NOT EXISTS ea__conflicts_snapshot_idx ON executive_assistant__conflicts(snapshot_id);`,
    );
    await db.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS ea__conflicts_pair_uniq
        ON executive_assistant__conflicts(snapshot_id, timeline_item_a_id, timeline_item_b_id);
    `);
  },
  async down(db) {
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__conflicts CASCADE;`);
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__deltas CASCADE;`);
  },
};

// Phase 5 — Feedback signals.
// Captures David's interactions with the dossier surface so the
// reflection step can turn them into contextual memory. Polymorphic
// subject (kind + id); not FK-enforced because subjects span tables.
const phase5FeedbackSignals: Migration = {
  id: "004-phase5-feedback-signals",
  async up(db) {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__feedback_signals (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        signal_kind text NOT NULL,
        subject_kind text NOT NULL,
        subject_id uuid NOT NULL,
        value jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_by_user_id uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.execute(
      `CREATE INDEX IF NOT EXISTS ea__feedback_signals_tenant_idx ON executive_assistant__feedback_signals(tenant_id, created_at);`,
    );
    await db.execute(
      `CREATE INDEX IF NOT EXISTS ea__feedback_signals_subject_idx ON executive_assistant__feedback_signals(subject_kind, subject_id);`,
    );
    await db.execute(
      `CREATE INDEX IF NOT EXISTS ea__feedback_signals_kind_idx ON executive_assistant__feedback_signals(tenant_id, signal_kind);`,
    );
  },
  async down(db) {
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__feedback_signals CASCADE;`);
  },
};

// Phase 6 — Weather.
// One row per (tenant, date, location_label). Partial unique allows
// multiple locations on the same date — relevant when the agent
// fetches for both home and a travel destination during a transition
// day. raw_payload stays so the summary can be re-derived without
// re-hitting the provider.
const phase6Weather: Migration = {
  id: "005-phase6-weather",
  async up(db) {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__weather_snapshots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        for_date date NOT NULL,
        location_label text NOT NULL,
        latitude real NOT NULL,
        longitude real NOT NULL,
        tz text NOT NULL,

        summary text,
        condition_code text,
        condition_label text,

        temp_high_c real,
        temp_low_c real,
        temp_apparent_high_c real,
        temp_apparent_low_c real,

        precip_probability_max integer,
        precipitation_mm real,

        wind_speed_max_kmh real,
        wind_gusts_max_kmh real,

        uv_index_max real,

        sunrise timestamptz,
        sunset timestamptz,

        raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        fetched_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.execute(
      `CREATE INDEX IF NOT EXISTS ea__weather_tenant_date_idx ON executive_assistant__weather_snapshots(tenant_id, for_date);`,
    );
    await db.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS ea__weather_tenant_date_loc_uniq
        ON executive_assistant__weather_snapshots(tenant_id, for_date, location_label);
    `);
  },
  async down(db) {
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__weather_snapshots CASCADE;`);
  },
};

// Phase E — Compose timing hash-guard.
// Snapshots gain a `state_hash` column. The maybe_create_task tool
// compares the current state's hash to the latest snapshot's stored
// hash; if unchanged, the routine tick skips waking the agent.
// Nullable so older snapshots (pre-0.4.0) remain valid; the gate
// treats null as "always recompose" which is the desired migration
// behavior anyway.
const phaseEComposeHash: Migration = {
  id: "006-phaseE-compose-hash",
  async up(db) {
    await db.execute(`
      ALTER TABLE executive_assistant__snapshots
      ADD COLUMN IF NOT EXISTS state_hash text;
    `);
    await db.execute(
      `CREATE INDEX IF NOT EXISTS ea__snapshots_state_hash_idx ON executive_assistant__snapshots(tenant_id, snapshot_date, state_hash);`,
    );
  },
  async down(db) {
    await db.execute(`DROP INDEX IF EXISTS ea__snapshots_state_hash_idx;`);
    await db.execute(
      `ALTER TABLE executive_assistant__snapshots DROP COLUMN IF EXISTS state_hash;`,
    );
  },
};

// 0.4.8 — Store Google Calendar event description so the meeting
// drawer can show the agenda and the agent can use it for prep cues.
const phase48MeetingDescription: Migration = {
  id: "007-meeting-description",
  async up(db) {
    await db.execute(`
      ALTER TABLE executive_assistant__meetings
      ADD COLUMN IF NOT EXISTS description text;
    `);
  },
  async down(db) {
    await db.execute(`
      ALTER TABLE executive_assistant__meetings
      DROP COLUMN IF EXISTS description;
    `);
  },
};

// 0.4.14 — User preferences table for structured tenant settings
// (timezone, home/current location). Replaces the prior (broken)
// attempt to use framework.memory for structured key/value data —
// memory is a semantic-search store, not a key-value map. This table
// is the right place for things that need exact-key lookup.
const phase414UserPreferences: Migration = {
  id: "008-user-preferences",
  async up(db) {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS executive_assistant__user_preferences (
        tenant_id  uuid        NOT NULL,
        key        text        NOT NULL,
        value      jsonb       NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, key)
      );
    `);
  },
  async down(db) {
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__user_preferences;`);
  },
};

// 0.4.14 — Re-key conflicts off snapshots / timeline_items.
// Conflicts are now a property of the live calendar state — computed
// directly from meetings / ooo / trip_legs on every sync, not after
// an agent compose. Decouples conflict detection from the LLM and
// from the snapshot lifecycle entirely.
//
// We don't preserve old rows: the prior schema produced none in
// practice (the scan was effectively non-functional pre-v0.4.14 —
// see docs/conflict-detection-investigation.md).
const phase414ConflictsRekey: Migration = {
  id: "009-conflicts-rekey",
  async up(db) {
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__conflicts;`);
    await db.execute(`
      CREATE TABLE executive_assistant__conflicts (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          uuid        NOT NULL,
        for_date           date        NOT NULL,
        ref_a_kind         text        NOT NULL CHECK (ref_a_kind IN ('meeting','ooo','trip_leg')),
        ref_a_id           uuid        NOT NULL,
        ref_b_kind         text        NOT NULL CHECK (ref_b_kind IN ('meeting','ooo','trip_leg')),
        ref_b_id           uuid        NOT NULL,
        overlap_minutes    integer     NOT NULL,
        detected_at        timestamptz NOT NULL DEFAULT now(),
        resolution_status  text        NOT NULL DEFAULT 'unresolved'
                            CHECK (resolution_status IN ('unresolved','acknowledged','resolved_by_user','auto_resolved')),
        resolved_choice    uuid,
        CHECK (ref_a_id < ref_b_id),
        UNIQUE (tenant_id, for_date, ref_a_id, ref_b_id)
      );
    `);
    await db.execute(`
      CREATE INDEX ea__conflicts_tenant_date_idx
        ON executive_assistant__conflicts (tenant_id, for_date);
    `);
  },
  async down(db) {
    await db.execute(`DROP TABLE IF EXISTS executive_assistant__conflicts;`);
  },
};

// 0.4.18 — User-owned notes column on meetings. Distinct from
// `brief` (agent-owned). The user adds prep context, follow-ups,
// reminders here; the agent never overwrites it.
const phase418UserNotes: Migration = {
  id: "010-meeting-user-notes",
  async up(db) {
    await db.execute(`
      ALTER TABLE executive_assistant__meetings
      ADD COLUMN IF NOT EXISTS user_notes text;
    `);
  },
  async down(db) {
    await db.execute(`
      ALTER TABLE executive_assistant__meetings
      DROP COLUMN IF EXISTS user_notes;
    `);
  },
};

// v0.4.28 — item kind taxonomy on the meetings table.
// kind ∈ {meeting, event, task, untagged}, default 'untagged'.
// kind_locked = true when the user has manually overridden; every kind-write
// site must check this flag and skip the row when locked.
// See docs/categorization-design.md § Phase 1.
const phase428ItemKind: Migration = {
  id: "011-meeting-kind",
  async up(db) {
    await db.execute(`
      ALTER TABLE executive_assistant__meetings
      ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'untagged';
    `);
    await db.execute(`
      ALTER TABLE executive_assistant__meetings
      ADD COLUMN IF NOT EXISTS kind_locked boolean NOT NULL DEFAULT false;
    `);
    await db.execute(`
      ALTER TABLE executive_assistant__meetings
      DROP CONSTRAINT IF EXISTS ea__meetings_kind_chk;
    `);
    await db.execute(`
      ALTER TABLE executive_assistant__meetings
      ADD CONSTRAINT ea__meetings_kind_chk
        CHECK (kind IN ('meeting', 'event', 'task', 'untagged'));
    `);
    await db.execute(`
      CREATE INDEX IF NOT EXISTS ea__meetings_kind_idx
        ON executive_assistant__meetings(tenant_id, kind);
    `);
  },
  async down(db) {
    await db.execute(`DROP INDEX IF EXISTS ea__meetings_kind_idx;`);
    await db.execute(`
      ALTER TABLE executive_assistant__meetings
      DROP CONSTRAINT IF EXISTS ea__meetings_kind_chk;
    `);
    await db.execute(`
      ALTER TABLE executive_assistant__meetings
      DROP COLUMN IF EXISTS kind_locked;
    `);
    await db.execute(`
      ALTER TABLE executive_assistant__meetings
      DROP COLUMN IF EXISTS kind;
    `);
  },
};

export const executiveAssistantMigrations: Migration[] = [
  init,
  phase2Composition,
  phase4DeltasConflicts,
  phase5FeedbackSignals,
  phase6Weather,
  phaseEComposeHash,
  phase48MeetingDescription,
  phase414UserPreferences,
  phase414ConflictsRekey,
  phase418UserNotes,
  phase428ItemKind,
];
