import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  integer,
  bigint,
  real,
  boolean,
  timestamp,
  jsonb,
  serial,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const wallets = pgTable("wallets", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id"),
  publicKey: varchar("public_key").notNull().unique(),
  label: varchar("label").notNull().default("default"),
  strategyProfile: varchar("strategy_profile").default("balanced"),
  balanceLamports: bigint("balance_lamports", { mode: "number" }).notNull().default(0),
  status: varchar("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastStopOutAt: timestamp("last_stop_out_at"),
});

export const insertWalletSchema = createInsertSchema(wallets).omit({
  id: true,
  createdAt: true,
});
export type InsertWallet = z.infer<typeof insertWalletSchema>;
export type Wallet = typeof wallets.$inferSelect;

export const positions = pgTable("positions", {
  id: serial("id").primaryKey(),
  walletId: integer("wallet_id").notNull(),
  tokenAddress: varchar("token_address").notNull(),
  symbol: varchar("symbol").notNull(),
  side: varchar("side").notNull().default("long"),
  sizeSol: real("size_sol").notNull(),
  entryPrice: real("entry_price").notNull(),
  currentPrice: real("current_price").notNull(),
  unrealizedPnl: real("unrealized_pnl").notNull().default(0),
  realizedPnl: real("realized_pnl").notNull().default(0),
  managementMode: varchar("management_mode").notNull().default("LOCAL_MANAGED"),
  status: varchar("status").notNull().default("open"),
  slPct: real("sl_pct"),
  tpLevels: jsonb("tp_levels").$type<number[]>(),
  trailingStopPct: real("trailing_stop_pct"),
  deadlockState: varchar("deadlock_state"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  closedAt: timestamp("closed_at"),
});

export const insertPositionSchema = createInsertSchema(positions).omit({
  id: true,
  createdAt: true,
});
export type InsertPosition = z.infer<typeof insertPositionSchema>;
export type Position = typeof positions.$inferSelect;

export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  walletId: integer("wallet_id").notNull(),
  positionId: integer("position_id"),
  tokenAddress: varchar("token_address").notNull(),
  symbol: varchar("symbol").notNull().default("UNKNOWN"),
  side: varchar("side").notNull(),
  sizeSol: real("size_sol").notNull(),
  price: real("price").notNull(),
  slippageBps: integer("slippage_bps"),
  orderId: varchar("order_id"),
  txSignature: varchar("tx_signature"),
  status: varchar("status").notNull().default("pending"),
  feesSol: real("fees_sol").notNull().default(0),
  pnlSol: real("pnl_sol"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTradeSchema = createInsertSchema(trades).omit({
  id: true,
  createdAt: true,
});
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof trades.$inferSelect;

export const entitlementPlans = pgTable("entitlement_plans", {
  code: varchar("code").primaryKey(),
  name: varchar("name").notNull(),
  description: text("description"),
  priceSol: real("price_sol").notNull(),
  durationHours: integer("duration_hours").notNull(),
  stackable: boolean("stackable").notNull().default(false),
  maxStack: integer("max_stack").notNull().default(1),
  limitsDelta: jsonb("limits_delta").$type<Record<string, number>>().notNull(),
  autoRenewAllowed: boolean("auto_renew_allowed").notNull().default(false),
});

export const insertEntitlementPlanSchema = createInsertSchema(entitlementPlans);
export type InsertEntitlementPlan = z.infer<typeof insertEntitlementPlanSchema>;
export type EntitlementPlan = typeof entitlementPlans.$inferSelect;

export const entitlements = pgTable("entitlements", {
  id: serial("id").primaryKey(),
  walletId: integer("wallet_id").notNull(),
  planCode: varchar("plan_code").notNull(),
  purchasedAt: timestamp("purchased_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  limitsDelta: jsonb("limits_delta").$type<Record<string, number>>().notNull(),
  active: boolean("active").notNull().default(true),
});

export const insertEntitlementSchema = createInsertSchema(entitlements).omit({
  id: true,
  purchasedAt: true,
});
export type InsertEntitlement = z.infer<typeof insertEntitlementSchema>;
export type Entitlement = typeof entitlements.$inferSelect;

export const riskDenials = pgTable("risk_denials", {
  id: serial("id").primaryKey(),
  walletId: integer("wallet_id").notNull(),
  tokenAddress: varchar("token_address"),
  reason: text("reason").notNull(),
  ruleCode: varchar("rule_code").notNull(),
  severity: varchar("severity").notNull().default("hard"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertRiskDenialSchema = createInsertSchema(riskDenials).omit({
  id: true,
  createdAt: true,
});
export type InsertRiskDenial = z.infer<typeof insertRiskDenialSchema>;
export type RiskDenial = typeof riskDenials.$inferSelect;

export const killSwitchState = pgTable("kill_switch_state", {
  walletId: integer("wallet_id").primaryKey(),
  mode: varchar("mode").notNull().default("TRADES_ONLY"),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertKillSwitchSchema = createInsertSchema(killSwitchState);
export type InsertKillSwitch = z.infer<typeof insertKillSwitchSchema>;
export type KillSwitch = typeof killSwitchState.$inferSelect;

export const memoryEntries = pgTable("memory_entries", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id"),
  walletId: integer("wallet_id"),
  tokenAddress: varchar("token_address"),
  tags: text("tags").array(),
  notes: text("notes").notNull(),
  outcome: varchar("outcome"),
  strategyVersion: varchar("strategy_version"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMemoryEntrySchema = createInsertSchema(memoryEntries).omit({
  id: true,
  createdAt: true,
});
export type InsertMemoryEntry = z.infer<typeof insertMemoryEntrySchema>;
export type MemoryEntry = typeof memoryEntries.$inferSelect;

export const strategyState = pgTable("strategy_state", {
  walletId: integer("wallet_id").primaryKey(),
  featureWeights: jsonb("feature_weights").$type<Record<string, number>>().notNull(),
  strategyVersion: varchar("strategy_version").notNull().default("v1.0.0"),
  mode: varchar("mode").notNull().default("HARDENED"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertStrategyStateSchema = createInsertSchema(strategyState);
export type InsertStrategyState = z.infer<typeof insertStrategyStateSchema>;
export type StrategyState = typeof strategyState.$inferSelect;
