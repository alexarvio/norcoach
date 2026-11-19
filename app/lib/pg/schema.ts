import { sql } from "drizzle-orm";
import { boolean, doublePrecision, index, integer, jsonb, pgSequence, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// The Postgres tables behind the store (phase 1 of moving off ironline.json).
//
// One table per collection in db.ts, with the same name, and one column per
// field, named exactly as the field. That identity is what lets store.ts
// load and save every collection with one generic mapping, and what keeps a
// row identical after a round trip:
//   - every column is nullable (older rows lack newer fields);
//   - `extra` holds any field a row has that is not a column here, so nothing
//     in the data is lost if the JSON grew a field this schema doesn't know;
//     `extra.__absent` lists known fields the row did not have at all, so a
//     missing field comes back missing rather than as null.
// Numbers that are not ids are double precision: a weight, a kcal count or a
// set count typed as 2.5 must survive exactly.
//
// Top-level values that are not collections (the id counters, branding, the
// reset tokens, and collections the app no longer uses) live in `kv`.

const id = () => integer("id").primaryKey();
const fk = (name: string) => integer(name);
const num = (name: string) => doublePrecision(name);
const extra = () => jsonb("extra");
/**
 * A real instant beside a text stamp (18 Nov, step 4C): not a field of the row. Filled by the writer from the text
 * (DERIVED below, pg/stamps.ts) and never loaded back; the app keeps reading the text.
 */
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const users = pgTable("users", {
  id: id(),
  email: text("email"),
  password_hash: text("password_hash"),
  role: text("role"),
  client_id: fk("client_id"),
  must_change_password: boolean("must_change_password"),
  created_at: text("created_at"),
  extra: extra(),
});

export const clients = pgTable("clients", {
  id: id(),
  name: text("name"),
  avatar_path: text("avatar_path"),
  coach_id: fk("coach_id"),
  extra: extra(),
});

export const exercises = pgTable("exercises", {
  id: id(),
  name: text("name"),
  muscle_tags: text("muscle_tags"),
  video_url: text("video_url"),
  coach_id: fk("coach_id"),
  extra: extra(),
});

export const program_days = pgTable("program_days", {
  id: id(),
  client_id: fk("client_id"),
  week_number: num("week_number"),
  day_of_week: num("day_of_week"),
  label: text("label"),
  status: text("status"),
  is_rest: boolean("is_rest"),
  extra: extra(),
});

export const training_programs = pgTable("training_programs", {
  id: id(),
  client_id: fk("client_id"),
  name: text("name"),
  start_week: num("start_week"),
  total_weeks: num("total_weeks"),
  status: text("status"),
  deployed_at: text("deployed_at"),
  scheduled_at: text("scheduled_at"),
  extra: extra(),
});

export const client_phases = pgTable("client_phases", {
  id: id(),
  client_id: fk("client_id"),
  track: text("track"),
  name: text("name"),
  start_week: text("start_week"),
  end_week: text("end_week"),
  nutrition: jsonb("nutrition"),
  program_id: fk("program_id"),
  extra: extra(),
});

// The food diary's indexes (19 Nov, quest 8 part 1; app/lib/food/rows.ts reads a client's days, a meal's rows, a picture's
// rows by file). The unique rule on calorie_logs (client_id, date) is NOT here: a FOOD_STORE=pg boot makes it under the
// lease once its twins are moved out, and a memory boot drops it (app/lib/food/boot.ts), so a twin never blocks a save.
export const calorie_logs = pgTable(
  "calorie_logs",
  {
    id: id(),
    client_id: fk("client_id"),
    date: text("date"),
    kcal: num("kcal"),
    logged_at: text("logged_at"),
    note: text("note"),
    extra: extra(),
  },
  (t) => [index("calorie_logs_client_date_idx").on(t.client_id, t.date, t.id)]
);

export const check_in_notes = pgTable("check_in_notes", {
  id: id(),
  client_id: fk("client_id"),
  kind: text("kind"),
  period: text("period"),
  text: text("text"),
  created_at: text("created_at"),
  extra: extra(),
});

export const client_exercise_notes = pgTable("client_exercise_notes", {
  id: id(),
  client_id: fk("client_id"),
  exercise_id: fk("exercise_id"),
  text: text("text"),
  updated_at: text("updated_at"),
  extra: extra(),
});

export const client_gyms = pgTable("client_gyms", {
  id: id(),
  client_id: fk("client_id"),
  name: text("name"),
  created_at: text("created_at"),
  last_used_at: text("last_used_at"),
  archived: boolean("archived"),
  is_home: boolean("is_home"),
  extra: extra(),
});

export const coach_profiles = pgTable("coach_profiles", {
  coach_id: integer("coach_id").primaryKey(),
  display_name: text("display_name"),
  title: text("title"),
  headline: text("headline"),
  location: text("location"),
  languages: text("languages"),
  years_coaching: num("years_coaching"),
  hero_path: text("hero_path"),
  candid_path: text("candid_path"),
  avatar_path: text("avatar_path"),
  intro: text("intro"),
  bio: text("bio"),
  quote: text("quote"),
  specialties: jsonb("specialties"),
  studies: jsonb("studies"),
  experience: jsonb("experience"),
  outside: text("outside"),
  reply_note: text("reply_note"),
  published: boolean("published"),
  updated_at: text("updated_at"),
  extra: extra(),
});

export const client_program_notes = pgTable("client_program_notes", {
  id: id(),
  client_id: fk("client_id"),
  program_id: fk("program_id"),
  text: text("text"),
  updated_at: text("updated_at"),
  extra: extra(),
});

export const cardio_entries = pgTable("cardio_entries", {
  id: id(),
  program_day_id: fk("program_day_id"),
  name: text("name"),
  time: text("time"),
  pace: text("pace"),
  incline: text("incline"),
  distance: text("distance"),
  notes: text("notes"),
  order_index: num("order_index"),
  extra: extra(),
});

export const cardio_logs = pgTable("cardio_logs", {
  id: id(),
  cardio_entry_id: fk("cardio_entry_id"),
  client_id: fk("client_id"),
  done_at: text("done_at"),
  extra: extra(),
});

export const workout_assignments = pgTable("workout_assignments", {
  id: id(),
  program_day_id: fk("program_day_id"),
  exercise_id: fk("exercise_id"),
  order_index: num("order_index"),
  sets: num("sets"),
  reps: text("reps"),
  target_weight_kg: num("target_weight_kg"),
  rpe_target: num("rpe_target"),
  rest_seconds: num("rest_seconds"),
  tempo: text("tempo"),
  distance: text("distance"),
  time: text("time"),
  notes: text("notes"),
  demo_url: text("demo_url"),
  note_kind: text("note_kind"),
  note_at: text("note_at"),
  note_read: boolean("note_read"),
  target_set_at: text("target_set_at"),
  extra: extra(),
});

export const set_logs = pgTable("set_logs", {
  id: id(),
  workout_assignment_id: fk("workout_assignment_id"),
  set_number: num("set_number"),
  weight_kg: num("weight_kg"),
  reps: num("reps"),
  rpe_actual: num("rpe_actual"),
  logged_at: text("logged_at"),
  extra: extra(),
  logged_at_tz: instant("logged_at_tz"),
});

export const invoices = pgTable("invoices", {
  id: id(),
  client_id: fk("client_id"),
  description: text("description"),
  amount: num("amount"),
  status: text("status"),
  created_at: text("created_at"),
  updated_at: text("updated_at"),
  extra: extra(),
});

export const nutrition_plans = pgTable("nutrition_plans", {
  client_id: integer("client_id").primaryKey(),
  name: text("name"),
  maintenance_kcal: num("maintenance_kcal"),
  ebf: num("ebf"),
  training_day_meals: jsonb("training_day_meals"),
  rest_day_meals: jsonb("rest_day_meals"),
  vitamins: jsonb("vitamins"),
  other: jsonb("other"),
  supplements: jsonb("supplements"),
  coach_notes: text("coach_notes"),
  day_targets: jsonb("day_targets"),
  water_l: num("water_l"),
  supplement_rows: jsonb("supplement_rows"),
  extra: extra(),
});

export const measurement_fields = pgTable("measurement_fields", {
  id: id(),
  client_id: fk("client_id"),
  name: text("name"),
  unit: text("unit"),
  order_index: num("order_index"),
  visible_to_client: boolean("visible_to_client"),
  pinned: boolean("pinned"),
  extra: extra(),
});

export const measurement_values = pgTable("measurement_values", {
  id: id(),
  client_id: fk("client_id"),
  field_id: fk("field_id"),
  date: text("date"),
  value: num("value"),
  logged_at: text("logged_at"),
  extra: extra(),
});

export const skinfold_entries = pgTable("skinfold_entries", {
  id: id(),
  client_id: fk("client_id"),
  date: text("date"),
  site: text("site"),
  reading_mm: num("reading_mm"),
  extra: extra(),
});

export const metric_definitions = pgTable("metric_definitions", {
  id: id(),
  client_id: fk("client_id"),
  category: text("category"),
  name: text("name"),
  unit: text("unit"),
  frequency: text("frequency"),
  order_index: num("order_index"),
  pinned: boolean("pinned"),
  visible_to_client: boolean("visible_to_client"),
  extra: extra(),
});

export const metric_entries = pgTable("metric_entries", {
  id: id(),
  metric_definition_id: fk("metric_definition_id"),
  period: text("period"),
  value: num("value"),
  logged_at: text("logged_at"),
  extra: extra(),
  logged_at_tz: instant("logged_at_tz"),
});

export const metric_template_categories = pgTable("metric_template_categories", {
  id: id(),
  name: text("name"),
  frequency: text("frequency"),
  order_index: num("order_index"),
  coach_id: fk("coach_id"),
  extra: extra(),
});

export const metric_template_items = pgTable("metric_template_items", {
  id: id(),
  template_category_id: fk("template_category_id"),
  name: text("name"),
  unit: text("unit"),
  order_index: num("order_index"),
  extra: extra(),
});

export const photo_slots = pgTable("photo_slots", {
  id: id(),
  client_id: fk("client_id"),
  label: text("label"),
  order_index: num("order_index"),
  paused: boolean("paused"),
  extra: extra(),
});

export const photo_uploads = pgTable("photo_uploads", {
  id: id(),
  slot_id: fk("slot_id"),
  period: text("period"),
  file_path: text("file_path"),
  uploaded_at: text("uploaded_at"),
  extra: extra(),
});

export const photo_settings = pgTable("photo_settings", {
  client_id: integer("client_id").primaryKey(),
  cadence: text("cadence"),
  photo_start_date: text("photo_start_date"),
  photo_instructions: text("photo_instructions"),
  extra: extra(),
});

export const photo_period_notes = pgTable(
  "photo_period_notes",
  {
    client_id: integer("client_id").notNull(),
    period: text("period").notNull(),
    shape: text("shape"),
    strengths: text("strengths"),
    improvements: text("improvements"),
    next_steps: text("next_steps"),
    saved_at: text("saved_at"),
    extra: extra(),
  },
  (t) => [primaryKey({ columns: [t.client_id, t.period] })]
);

export const client_profiles = pgTable("client_profiles", {
  client_id: integer("client_id").primaryKey(),
  birthdate: text("birthdate"),
  gender: text("gender"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  height_cm: num("height_cm"),
  starting_weight_kg: num("starting_weight_kg"),
  coaching_start_date: text("coaching_start_date"),
  current_week: text("current_week"),
  goal_phase: text("goal_phase"),
  goal_phase_start_date: text("goal_phase_start_date"),
  goal_date: text("goal_date"),
  main_goal: text("main_goal"),
  main_goal_saved_at: text("main_goal_saved_at"),
  check_in_day: text("check_in_day"),
  steps_goal: text("steps_goal"),
  cardio_goal: text("cardio_goal"),
  training_goal: text("training_goal"),
  water_goal: text("water_goal"),
  extra: extra(),
});

export const client_goals = pgTable("client_goals", {
  id: id(),
  client_id: fk("client_id"),
  term: text("term"),
  text: text("text"),
  done: boolean("done"),
  order_index: num("order_index"),
  created_at: text("created_at"),
  tracked_by: jsonb("tracked_by"),
  meeting_id: fk("meeting_id"),
  extra: extra(),
});

export const meetings = pgTable("meetings", {
  id: id(),
  client_id: fk("client_id"),
  coach_id: fk("coach_id"),
  date: text("date"),
  time: text("time"),
  duration_minutes: num("duration_minutes"),
  topic: text("topic"),
  status: text("status"),
  link: text("link"),
  prep_notes: text("prep_notes"),
  summary: text("summary"),
  extra: extra(),
});

export const meeting_notes = pgTable("meeting_notes", {
  id: id(),
  meeting_id: fk("meeting_id"),
  text: text("text"),
  created_at: text("created_at"),
  extra: extra(),
});

export const training_columns = pgTable("training_columns", {
  id: id(),
  client_id: fk("client_id"),
  key: text("key"),
  label: text("label"),
  kind: text("kind"),
  visible: boolean("visible"),
  order_index: num("order_index"),
  extra: extra(),
});

export const assignment_custom_values = pgTable("assignment_custom_values", {
  id: id(),
  workout_assignment_id: fk("workout_assignment_id"),
  column_id: fk("column_id"),
  value: text("value"),
  extra: extra(),
});

const chatColumns = () => ({
  id: id(),
  client_id: fk("client_id"),
  sender: text("sender"),
  text: text("text"),
  media_path: text("media_path"),
  media_type: text("media_type"),
  created_at: text("created_at"),
  extra: extra(),
  created_at_tz: instant("created_at_tz"),
});
// The indexes the chat's queries will lean on (18 Nov, Step 5; app/lib/chat/statements.ts): a client's thread (and the
// export); a client's messages from a time on (dockRecent, Needs you, the Feed's Since); each client's last message in
// the thread's order (dockLast) and the coach's last by instant (coachLast), read one client at a time; a file's messages.
export const chat_messages = pgTable("chat_messages", chatColumns(), (t) => [
  index("chat_messages_client_id_idx").on(t.client_id, t.id),
  index("chat_messages_client_sent_idx").on(t.client_id, t.created_at_tz).where(sql`sender = 'client'`),
  index("chat_messages_client_text_idx").on(t.client_id, sql`(created_at COLLATE "C") DESC`, t.id.desc().nullsFirst()),
  index("chat_messages_coach_last_idx").on(t.client_id, t.created_at_tz.desc().nullsLast(), t.id).where(sql`sender = 'coach'`),
  index("chat_messages_media_path_idx").on(t.media_path).where(sql`${t.media_path} IS NOT NULL`),
]);

/**
 * The chat shadow's tables (18 Nov, Step 5; app/lib/chat/shadow.ts, CHAT_SHADOW=write on staging): chat_messages' and
 * once_keys' shape, seeded from them at boot, written by the new single-statement SQL beside the store's own saves and
 * compared with the real tables. Not collections: never loaded into memory, never written by the store's writer.
 */
export const chat_messages_shadow = pgTable("chat_messages_shadow", chatColumns(), (t) => [
  index("chat_messages_shadow_client_id_idx").on(t.client_id, t.id),
  index("chat_messages_shadow_media_path_idx").on(t.media_path),
]);

export const client_events = pgTable("client_events", {
  id: id(),
  client_id: fk("client_id"),
  kind: text("kind"),
  title: text("title"),
  start_date: text("start_date"),
  end_date: text("end_date"),
  note: text("note"),
  created_at: text("created_at"),
  extra: extra(),
});

export const event_categories = pgTable("event_categories", {
  id: id(),
  coach_id: fk("coach_id"),
  label: text("label"),
  color: text("color"),
  created_at: text("created_at"),
  extra: extra(),
});

const noteColumns = () => ({
  id: id(),
  client_id: fk("client_id"),
  message: text("message"),
  created_at: text("created_at"),
  kind: text("kind"),
  read: boolean("read"),
  action_tab: text("action_tab"),
  action_label: text("action_label"),
  action_ref: fk("action_ref"),
  dedupe_key: text("dedupe_key"),
  extra: extra(),
  created_at_tz: instant("created_at_tz"),
});
// The indexes the notifications' queries lean on (19 Nov, Step 6, quest 7; app/lib/notes/statements.ts): a client's
// newest in the list's own order (the text stamp, then id), a client's notes by their dedupe key, the unread reminders
// the minute job looks at, a coach message's note by the message's id, and the older notes with none (matched by words).
// The unique rule on (client_id, dedupe_key) is NOT here: it is made only by a NOTES_STORE=pg boot, under the lease, and
// dropped by a memory boot (app/lib/notes/boot.ts), so a twin can never block a memory-mode save.
export const coach_activity = pgTable("coach_activity", noteColumns(), (t) => [
  index("coach_activity_client_text_idx").on(t.client_id, sql`(created_at COLLATE "C") DESC`, t.id.desc().nullsFirst()),
  // Keys and words by their md5: a key carries a goal's or an event's own words, and a btree row past ~2.7 kB would
  // fail the store's save; each statement asks `md5(x) = md5($) AND x = $`.
  index("coach_activity_client_key_idx").on(t.client_id, sql`md5(dedupe_key)`, t.id).where(sql`dedupe_key IS NOT NULL`),
  index("coach_activity_unread_reminder_idx").on(t.client_id, t.id).where(sql`kind = 'reminder' AND read IS NOT TRUE`),
  index("coach_activity_message_idx").on(t.client_id, sql`(extra ->> 'message_id')`).where(sql`kind = 'coach_note'`),
  index("coach_activity_note_words_idx").on(t.client_id, sql`md5(message)`).where(sql`kind = 'coach_note'`),
]);
/**
 * The notifications' shadow (19 Nov, quest 7; app/lib/notes/shadow.ts, NOTES_SHADOW=write on staging): coach_activity's
 * shape with the unique dedupe rule the cut-over will have, written by the new statements beside the store's own saves.
 * Not a collection: never loaded into memory, never written by the store's writer.
 */
export const coach_activity_shadow = pgTable("coach_activity_shadow", noteColumns(), (t) => [
  uniqueIndex("coach_activity_shadow_dedupe_uq").on(t.client_id, sql`md5(dedupe_key)`).where(sql`dedupe_key IS NOT NULL`),
  index("coach_activity_shadow_client_idx").on(t.client_id, t.id),
]);
/** Twins on (client_id, dedupe_key) the pg boot took out before making the unique rule, kept here, never deleted (notes/boot.ts). */
export const coach_activity_twins = pgTable("coach_activity_twins", { ...noteColumns(), removed_at: timestamp("removed_at", { withTimezone: true, mode: "string" }).notNull().defaultNow() });
/**
 * The notifications' ops already written (NOTES_STORE=pg, quest 7; app/lib/notes/outbox.ts): each outbox op's own token,
 * put in by the same transaction as the op's statement, so an op run again (a crash after its commit, a connection lost
 * as it committed) is known and does nothing: no second row, no second buzz. Pruned after 30 days, after a pg boot
 * (on `at`'s index).
 */
export const coach_activity_ops = pgTable(
  "coach_activity_ops",
  {
    token: text("token").primaryKey(),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    /** What the op did when it ran ("inserted"…), so a retry in this process after a lost connection still buzzes once. */
    outcome: text("outcome"),
  },
  (t) => [index("coach_activity_ops_at_idx").on(t.at)]
);

export const report_templates = pgTable("report_templates", {
  id: id(),
  name: text("name"),
  created_at: text("created_at"),
  coach_id: fk("coach_id"),
  extra: extra(),
});

export const report_template_sections = pgTable("report_template_sections", {
  id: id(),
  template_id: fk("template_id"),
  type: text("type"),
  label: text("label"),
  metric_name: text("metric_name"),
  order_index: num("order_index"),
  extra: extra(),
});

export const client_reports = pgTable("client_reports", {
  id: id(),
  client_id: fk("client_id"),
  template_id: fk("template_id"),
  template_name: text("template_name"),
  period_start: text("period_start"),
  period_end: text("period_end"),
  status: text("status"),
  summary: text("summary"),
  ai_generated: boolean("ai_generated"),
  sections_snapshot: text("sections_snapshot"),
  generated_at: text("generated_at"),
  approved_at: text("approved_at"),
  sent_at: text("sent_at"),
  opened_at: text("opened_at"),
  extra: extra(),
});

export const client_preferences = pgTable("client_preferences", {
  client_id: integer("client_id").primaryKey(),
  coach_notes: boolean("coach_notes"),
  checkin_reminders: boolean("checkin_reminders"),
  weekly_digest: boolean("weekly_digest"),
  units: text("units"),
  extra: extra(),
});

/** Everything at the top level of the store that is not a collection. */
export const kv = pgTable("kv", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
});

// ---- Tables the app queries directly (phase 2) ----------------------------
//
// Not collections: these are never loaded into memory or written by
// store.ts. The code that uses them reads and writes Postgres itself (see
// pg/direct.ts), so they carry real types and constraints instead of the
// all-nullable mirror of the JSON rows above.

/**
 * Where to deliver a push notification: one row per device a user turned
 * notifications on for. `endpoint` is the delivery service's address for
 * that device (a web push URL, or an APNs device token for the native app).
 */
export const push_subscriptions = pgTable(
  "push_subscriptions",
  {
    id: serial("id").primaryKey(),
    user_id: integer("user_id").notNull(),
    kind: text("kind").notNull().$type<"web" | "apns" | "fcm">(),
    endpoint: text("endpoint").notNull().unique(),
    // Web push only: the device's encryption keys.
    p256dh: text("p256dh"),
    auth: text("auth"),
    user_agent: text("user_agent"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    last_sent_at: timestamp("last_sent_at", { withTimezone: true }),
  },
  (t) => [index("push_subscriptions_user_id_idx").on(t.user_id)]
);

/**
 * "Forgot password" links. Only a hash of the token is kept, so someone who
 * reads this table can't use a link that is still open. One use, one hour.
 */
export const password_resets = pgTable(
  "password_resets",
  {
    id: serial("id").primaryKey(),
    user_id: integer("user_id").notNull(),
    token_hash: text("token_hash").notNull().unique(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    used_at: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("password_resets_user_id_idx").on(t.user_id)]
);

/**
 * Every collection, with the field(s) that identify a row. store.ts walks
 * this list to load and save; a collection missing here would not be saved.
 */
export const food_entries = pgTable(
  "food_entries",
  {
    id: id(),
    client_id: fk("client_id"),
    date: text("date"),
    meal: text("meal"),
    food_id: text("food_id"),
    name: text("name"),
    grams: num("grams"),
    serving: text("serving"),
    kcal: num("kcal"),
    protein: num("protein"),
    carbs: num("carbs"),
    fat: num("fat"),
    logged_at: text("logged_at"),
    extra: extra(),
    logged_at_tz: instant("logged_at_tz"),
  },
  (t) => [
    index("food_entries_client_date_idx").on(t.client_id, t.date, t.id),
    // A meal of the client's own on every day it holds food (removeFoodMeal's reach).
    index("food_entries_client_meal_idx").on(t.client_id, t.meal, t.id),
  ]
);

export const custom_foods = pgTable("custom_foods", {
  id: id(),
  client_id: fk("client_id"),
  name: text("name"),
  kcal: num("kcal"),
  protein: num("protein"),
  carbs: num("carbs"),
  fat: num("fat"),
  serving_label: text("serving_label"),
  serving_grams: num("serving_grams"),
  created_at: text("created_at"),
  extra: extra(),
});

export const food_meals = pgTable(
  "food_meals",
  {
    id: id(),
    client_id: fk("client_id"),
    name: text("name"),
    created_at: text("created_at"),
    extra: extra(),
  },
  (t) => [index("food_meals_client_idx").on(t.client_id, t.id)]
);

export const food_days = pgTable(
  "food_days",
  {
    id: id(),
    client_id: fk("client_id"),
    date: text("date"),
    day_type: text("day_type"),
    extra: extra(),
  },
  (t) => [index("food_days_client_date_idx").on(t.client_id, t.date, t.id)]
);

export const saved_meals = pgTable(
  "saved_meals",
  {
    id: id(),
    client_id: fk("client_id"),
    name: text("name"),
    items: jsonb("items"),
    created_at: text("created_at"),
    extra: extra(),
  },
  (t) => [
    index("saved_meals_client_idx").on(t.client_id, t.id),
    // A picture's rows by file (the pictures' clean-up, the look).
    index("saved_meals_picture_idx").on(sql`(extra ->> 'picture')`).where(sql`(extra ->> 'picture') IS NOT NULL`),
  ]
);

export const off_foods = pgTable("off_foods", {
  id: id(),
  code: text("code"),
  name: text("name"),
  brand: text("brand"),
  quantity: text("quantity"),
  kcal: num("kcal"),
  protein: num("protein"),
  carbs: num("carbs"),
  fat: num("fat"),
  serving_label: text("serving_label"),
  serving_grams: num("serving_grams"),
  fetched_at: text("fetched_at"),
  extra: extra(),
});

export const saved_days = pgTable(
  "saved_days",
  {
    id: id(),
    client_id: fk("client_id"),
    name: text("name"),
    items: jsonb("items"),
    created_at: text("created_at"),
    extra: extra(),
  },
  (t) => [index("saved_days_client_idx").on(t.client_id, t.id)]
);

export const meal_photos = pgTable(
  "meal_photos",
  {
    id: id(),
    client_id: fk("client_id"),
    date: text("date"),
    meal: text("meal"),
    file_path: text("file_path"),
    uploaded_at: text("uploaded_at"),
    extra: extra(),
  },
  (t) => [index("meal_photos_client_date_idx").on(t.client_id, t.date, t.meal, t.id), index("meal_photos_path_idx").on(t.file_path)]
);

/**
 * The food diary's write tokens (19 Nov, quest 8 part 1; FOOD_STORE=pg): each write's own, in its transaction, so a write
 * whose commit was lost to a dropped connection can be read back rather than run blind. Pruned after 30 days. Not a
 * collection: never loaded into memory, never written by the store's writer.
 */
export const food_ops = pgTable(
  "food_ops",
  {
    token: text("token").primaryKey(),
    op: text("op").notNull(),
    client_id: integer("client_id"),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    after: jsonb("after"),
  },
  (t) => [index("food_ops_at_idx").on(t.at)]
);

/** Twin rows a FOOD_STORE=pg boot moved out before making a unique rule (calorie_logs on client and day), kept whole. */
export const food_twins = pgTable(
  "food_twins",
  {
    tbl: text("tbl").notNull(),
    id: integer("id").notNull(),
    row: jsonb("row").notNull(),
    removed_at: timestamp("removed_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tbl, t.id] })]
);

export const video_requests = pgTable("video_requests", {
  id: id(),
  client_id: fk("client_id"),
  assignment_id: num("assignment_id"),
  note: text("note"),
  requested_at: text("requested_at"),
  file_path: text("file_path"),
  submitted_at: text("submitted_at"),
  seen_at: text("seen_at"),
  reply_note: text("reply_note"),
  reply_file_path: text("reply_file_path"),
  replied_at: text("replied_at"),
  reply_seen_at: text("reply_seen_at"),
  extra: extra(),
});

/**
 * The phone's workouts (lib/healthSync.ts; 19 Nov, Step 6 of docs/database-plan.md): until now one list in `kv`, now a
 * table of its own, still in memory and written row by row by the store. Written only by syncWorkouts, from the
 * phone's sync. Keyed as the sync matches a workout: the client, the store ("apple", "google") and the store's own id,
 * which the sync cleans where it makes it (cleanText), so no two rows can differ only by what Postgres takes out.
 * `id` is not a key (allocId keeps it unique: the Activity row's own id); its columns in the order the sync writes them.
 *
 * Kept in `kv` as well while a rollback to the builds before it is wanted (ROLLBACK_KV_COPIES): every boot makes the
 * table that copy (pg/healthWorkouts.ts).
 */
export const health_workouts = pgTable(
  "health_workouts",
  {
    id: integer("id"),
    client_id: integer("client_id").notNull(),
    store: text("store").notNull(),
    platform_id: text("platform_id").notNull(),
    type: text("type"),
    start: text("start"),
    end: text("end"),
    seconds: num("seconds"),
    kcal: num("kcal"),
    meters: num("meters"),
    source: text("source"),
    synced_at: text("synced_at"),
    extra: extra(),
  },
  (t) => [primaryKey({ columns: [t.client_id, t.store, t.platform_id] })]
);

/**
 * Saves taken once (lib/once.ts; 18 Nov, step 4B): until now a list in `kv`, now a table of its own, still in memory
 * and written by the mirror in the same transaction as the rows of the save that took the key, so a later step that
 * writes a row straight to Postgres can write its key with it. `key` is the save's name and the device's key
 * ("chat9:abc…"), never empty (once.ts takes none under 8 characters); `at` the moment it was taken (ms), as the row
 * holds it; `created_at` the same as an instant, filled by the writer.
 *
 * Kept in `kv` as well while a rollback to the builds before step 4 must keep its retry protection
 * (ROLLBACK_KV_COPIES): the boot takes the table from that copy (pg/onceKeys.ts).
 */
const onceColumns = () => ({
  key: text("key").primaryKey(),
  at: num("at"),
  result: jsonb("result"),
  redirect: text("redirect"),
  extra: extra(),
  created_at: instant("created_at"),
});
export const once_keys = pgTable("once_keys", onceColumns());
/** once_keys' shadow (Step 5): the chat send's once key goes in it with the shadow's message, in one statement. */
export const once_keys_shadow = pgTable("once_keys_shadow", onceColumns());

export const COLLECTIONS = [
  { name: "users", table: users, key: ["id"] },
  { name: "clients", table: clients, key: ["id"] },
  { name: "exercises", table: exercises, key: ["id"] },
  { name: "program_days", table: program_days, key: ["id"] },
  { name: "training_programs", table: training_programs, key: ["id"] },
  { name: "client_phases", table: client_phases, key: ["id"] },
  { name: "calorie_logs", table: calorie_logs, key: ["id"] },
  { name: "food_entries", table: food_entries, key: ["id"] },
  { name: "custom_foods", table: custom_foods, key: ["id"] },
  { name: "food_meals", table: food_meals, key: ["id"] },
  { name: "food_days", table: food_days, key: ["id"] },
  { name: "saved_meals", table: saved_meals, key: ["id"] },
  { name: "off_foods", table: off_foods, key: ["id"] },
  { name: "saved_days", table: saved_days, key: ["id"] },
  { name: "meal_photos", table: meal_photos, key: ["id"] },
  { name: "video_requests", table: video_requests, key: ["id"] },
  { name: "check_in_notes", table: check_in_notes, key: ["id"] },
  { name: "client_exercise_notes", table: client_exercise_notes, key: ["id"] },
  { name: "client_gyms", table: client_gyms, key: ["id"] },
  { name: "coach_profiles", table: coach_profiles, key: ["coach_id"] },
  { name: "client_program_notes", table: client_program_notes, key: ["id"] },
  { name: "cardio_entries", table: cardio_entries, key: ["id"] },
  { name: "cardio_logs", table: cardio_logs, key: ["id"] },
  { name: "workout_assignments", table: workout_assignments, key: ["id"] },
  { name: "set_logs", table: set_logs, key: ["id"] },
  { name: "invoices", table: invoices, key: ["id"] },
  { name: "nutrition_plans", table: nutrition_plans, key: ["client_id"] },
  { name: "measurement_fields", table: measurement_fields, key: ["id"] },
  { name: "measurement_values", table: measurement_values, key: ["id"] },
  { name: "skinfold_entries", table: skinfold_entries, key: ["id"] },
  { name: "metric_definitions", table: metric_definitions, key: ["id"] },
  { name: "metric_entries", table: metric_entries, key: ["id"] },
  { name: "metric_template_categories", table: metric_template_categories, key: ["id"] },
  { name: "metric_template_items", table: metric_template_items, key: ["id"] },
  { name: "photo_slots", table: photo_slots, key: ["id"] },
  { name: "photo_uploads", table: photo_uploads, key: ["id"] },
  { name: "photo_settings", table: photo_settings, key: ["client_id"] },
  { name: "photo_period_notes", table: photo_period_notes, key: ["client_id", "period"] },
  { name: "client_profiles", table: client_profiles, key: ["client_id"] },
  { name: "client_goals", table: client_goals, key: ["id"] },
  { name: "meetings", table: meetings, key: ["id"] },
  { name: "meeting_notes", table: meeting_notes, key: ["id"] },
  { name: "training_columns", table: training_columns, key: ["id"] },
  { name: "assignment_custom_values", table: assignment_custom_values, key: ["id"] },
  { name: "chat_messages", table: chat_messages, key: ["id"] },
  { name: "client_events", table: client_events, key: ["id"] },
  { name: "event_categories", table: event_categories, key: ["id"] },
  { name: "coach_activity", table: coach_activity, key: ["id"] },
  { name: "report_templates", table: report_templates, key: ["id"] },
  { name: "report_template_sections", table: report_template_sections, key: ["id"] },
  { name: "client_reports", table: client_reports, key: ["id"] },
  { name: "client_preferences", table: client_preferences, key: ["client_id"] },
  // Loaded oldest first, as the list in kv kept them: once.ts keeps the newest MAX_KEPT.
  { name: "once_keys", table: once_keys, key: ["key"], order: ["at", "key"] },
  // Loaded by id (the order they were added in) only once kv holds no copy: while it does, memory takes the copy's own
  // order (pg/healthWorkouts.ts), which decides the coach's Activity where two workouts tie.
  { name: "health_workouts", table: health_workouts, key: ["client_id", "store", "platform_id"], order: ["id"] },
] as const;

/**
 * The columns that are not a field of the row (18 Nov, step 4C): a real instant beside a text stamp (`stamp`, read as
 * stampMs reads it, pg/stamps.ts) or a count of ms (`ms`). Filled by the writer on every upsert from the field named
 * in `from`, backfilled in SQL by the migration that added them, put right at boot where they differ (store.ts).
 */
export const DERIVED = [
  { table: chat_messages, name: "chat_messages", column: "created_at_tz", from: "created_at", kind: "stamp" },
  { table: set_logs, name: "set_logs", column: "logged_at_tz", from: "logged_at", kind: "stamp" },
  { table: metric_entries, name: "metric_entries", column: "logged_at_tz", from: "logged_at", kind: "stamp" },
  { table: food_entries, name: "food_entries", column: "logged_at_tz", from: "logged_at", kind: "stamp" },
  { table: coach_activity, name: "coach_activity", column: "created_at_tz", from: "created_at", kind: "stamp" },
  { table: once_keys, name: "once_keys", column: "created_at", from: "at", kind: "ms" },
] as const;

/**
 * Collections also kept whole in `kv` under their own name, for a rollback to a build that still reads them there
 * (18 Nov, step 4B; health_workouts 19 Nov, Step 6): written beside the table in the same save, and never loaded from
 * kv by loadStore: the boot makes the table the copy first (pg/onceKeys.ts, pg/healthWorkouts.ts).
 */
export const ROLLBACK_KV_COPIES = ["once_keys", "health_workouts"] as const;

/**
 * Where ids come from for the tables that will leave memory (18 Nov, step 4A; pg/ids.ts): one sequence each, int4 like
 * the id columns, raised at every boot to the highest id and `_seq`. Named as SEQUENCED_TABLES in ids.ts lists them.
 */
const idSeq = (table: string) => pgSequence(`${table}_id_seq`, { startWith: 1, increment: 1, minValue: 1, maxValue: 2147483647, cache: 1 });
export const chat_messages_id_seq = idSeq("chat_messages");
export const coach_activity_id_seq = idSeq("coach_activity");
export const food_entries_id_seq = idSeq("food_entries");
export const calorie_logs_id_seq = idSeq("calorie_logs");
export const food_days_id_seq = idSeq("food_days");
export const food_meals_id_seq = idSeq("food_meals");
export const saved_meals_id_seq = idSeq("saved_meals");
export const meal_photos_id_seq = idSeq("meal_photos");
export const metric_entries_id_seq = idSeq("metric_entries");
export const set_logs_id_seq = idSeq("set_logs");
export const workout_assignments_id_seq = idSeq("workout_assignments");
export const program_days_id_seq = idSeq("program_days");
export const health_workouts_id_seq = idSeq("health_workouts");
// Saved days had none (quest 8 part 1): theirs, for FOOD_STORE=pg (pg/ids.ts takes it then; memory mode counts from _seq).
export const saved_days_id_seq = idSeq("saved_days");

/**
 * Names that are tables, never a key in `kv` (17 Nov): a kv row named like a collection would replace that collection
 * on the next boot (kv loads after the tables). The collections are added to this by store.ts; here are the tables
 * outside COLLECTIONS, and kv itself. A collection that ever leaves COLLECTIONS (to be queried directly) keeps its name
 * on this list, so a stray copy of it is never written to kv either.
 */
// chat_messages is here too (Step 5's cut-over): with CHAT_STORE=pg it leaves the writer's collections, and a stray
// `chat_messages` in the store must never be written to kv. A no-op while it is a collection (store.ts adds those anyway).
// coach_activity, its shadow, its twins and its ops' tokens the same (quest 7, NOTES_STORE=pg; app/lib/notes/).
export const TABLE_NAMES_NOT_IN_KV = ["kv", "push_subscriptions", "password_resets", "chat_messages_shadow", "once_keys_shadow", "chat_messages", "coach_activity", "coach_activity_shadow", "coach_activity_twins", "coach_activity_ops", "food_ops", "food_twins"] as const;
