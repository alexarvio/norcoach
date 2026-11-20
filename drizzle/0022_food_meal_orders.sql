-- Step 6, quest 8 part 1, the food item's question 3 (19 Nov, Alex: "if we have to do it at some point, might as well do
-- it now"; docs/database-plan.md): a client's meal-card order with FOOD_STORE=pg, written in the same transaction as the
-- food it orders (app/lib/food/rows.ts writeFood) and the truth on a pg boot (app/lib/food/orders.ts). Empty in memory
-- mode: nothing the app reads changes. Every statement can run twice.
CREATE TABLE IF NOT EXISTS "food_meal_orders" (
	"client_id" integer PRIMARY KEY NOT NULL,
	"meal_order" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
