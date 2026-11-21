import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull().default(''),
  photoUrl: text('photo_url').notNull().default(''),
  role: text('role').notNull().default('member'), // 'owner' | 'admin' | 'member'
  emailVerified: boolean('email_verified').notNull().default(false),
  authProvider: text('auth_provider').notNull().default('google.com'),
  accountStatus: text('account_status').notNull().default('active'), // 'active' | 'suspended'
  loginCount: integer('login_count').notNull().default(1),
  lastLoginAt: timestamp('last_login_at').defaultNow().notNull(),
  lastActiveAt: timestamp('last_active_at').defaultNow().notNull(),
  lastTokenIssuedAt: timestamp('last_token_issued_at'),
  sessionRevokedAfter: timestamp('session_revoked_after'),
  lastSeenDevice: text('last_seen_device').notNull().default(''),
  lastSeenIp: text('last_seen_ip').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const userActivityLogs = pgTable('user_activity_logs', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  actorEmail: text('actor_email').notNull(),
  actorName: text('actor_name').notNull().default(''),
  actorRole: text('actor_role').notNull().default('member'),
  category: text('category').notNull(), // 'auth' | 'governance' | 'ai_desk' | 'media_lab' | 'mockup' | 'spatial' | 'share'
  action: text('action').notNull(),
  summary: text('summary').notNull(),
  resourceType: text('resource_type').notNull().default(''),
  resourceId: text('resource_id').notNull().default(''),
  authStatus: text('auth_status').notNull().default('verified'), // 'verified' | 'unverified' | 'suspended'
  clientContext: text('client_context').notNull().default(''),
  metadataJson: text('metadata_json').notNull().default('{}'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const chatMessages = pgTable('chat_messages', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  threadId: text('thread_id').notNull(),
  role: text('role').notNull(), // 'user' | 'model'
  modelId: text('model_id').notNull().default('gemini-4-hydrogen'),
  persona: text('persona').notNull().default('Managing Editor'),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const transcriptions = pgTable('transcriptions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  title: text('title').notNull(),
  transcriptText: text('transcript_text').notNull(),
  durationSeconds: integer('duration_seconds').notNull().default(0),
  mimeType: text('mime_type').notNull().default('audio/webm'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const mediaItems = pgTable('media_items', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  kind: text('kind').notNull(), // 'image' | 'video' | 'music'
  modelId: text('model_id').notNull(),
  prompt: text('prompt').notNull(),
  aspectRatio: text('aspect_ratio').notNull().default('16:9'),
  lyrics: text('lyrics').notNull().default(''),
  previewNote: text('preview_note').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const mapPins = pgTable('map_pins', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  placeId: text('place_id').notNull().default(''),
  name: text('name').notNull(),
  address: text('address').notNull().default(''),
  category: text('category').notNull().default('client_site'), // 'client_site' | 'story_beat' | 'field_stop'
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  notes: text('notes').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const gameScores = pgTable('game_scores', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  score: integer('score').notNull(),
  capsulesCollected: integer('capsules_collected').notNull().default(0),
  distanceMeters: integer('distance_meters').notNull().default(0),
  bestCombo: integer('best_combo').notNull().default(1),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const savedMockups = pgTable('saved_mockups', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  versionNumber: integer('version_number').notNull().default(1),
  label: text('label').notNull(),
  changeNote: text('change_note').notNull().default(''),
  brandName: text('brand_name').notNull().default(''),
  headlinePreview: text('headline_preview').notNull().default(''),
  primaryColor: text('primary_color').notNull().default('#1E3A5F'),
  accentColor: text('accent_color').notNull().default('#22D3EE'),
  canvasMode: text('canvas_mode').notNull().default('light'),
  assetCount: integer('asset_count').notNull().default(0),
  contentHash: text('content_hash').notNull().default(''),
  sourceUrl: text('source_url').notNull().default(''),
  projectJson: text('project_json').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  activityLogs: many(userActivityLogs),
  chatMessages: many(chatMessages),
  transcriptions: many(transcriptions),
  mediaItems: many(mediaItems),
  mapPins: many(mapPins),
  gameScores: many(gameScores),
  savedMockups: many(savedMockups),
}));

export const userActivityLogsRelations = relations(userActivityLogs, ({ one }) => ({
  user: one(users, { fields: [userActivityLogs.userId], references: [users.id] }),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  user: one(users, { fields: [chatMessages.userId], references: [users.id] }),
}));

export const transcriptionsRelations = relations(transcriptions, ({ one }) => ({
  user: one(users, { fields: [transcriptions.userId], references: [users.id] }),
}));

export const mediaItemsRelations = relations(mediaItems, ({ one }) => ({
  user: one(users, { fields: [mediaItems.userId], references: [users.id] }),
}));

export const mapPinsRelations = relations(mapPins, ({ one }) => ({
  user: one(users, { fields: [mapPins.userId], references: [users.id] }),
}));

export const gameScoresRelations = relations(gameScores, ({ one }) => ({
  user: one(users, { fields: [gameScores.userId], references: [users.id] }),
}));

export const savedMockupsRelations = relations(savedMockups, ({ one }) => ({
  user: one(users, { fields: [savedMockups.userId], references: [users.id] }),
}));
