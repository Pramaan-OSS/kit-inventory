ALTER TABLE app_users ADD CONSTRAINT inventory_roles CHECK(role IN ('owner','staff','member'));
CREATE TABLE inventory_lists (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('category','purchase','sales')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80), phase text NOT NULL CHECK(phase IN ('category','open','done')),
 UNIQUE(kind,name), UNIQUE(id,kind), UNIQUE(id,phase), CHECK((kind='category')=(phase='category'))
);
INSERT INTO inventory_lists VALUES
 ('10000000-0000-4000-8000-000000000001','category','General','category'),
 ('10000000-0000-4000-8000-000000000002','purchase','Ordered','open'),
 ('10000000-0000-4000-8000-000000000003','purchase','Received','done'),
 ('10000000-0000-4000-8000-000000000004','sales','Ready to pick','open'),
 ('10000000-0000-4000-8000-000000000005','sales','Fulfilled','done');
CREATE TABLE inventory_locations(id uuid PRIMARY KEY, name text NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 120));
INSERT INTO inventory_locations VALUES ('20000000-0000-4000-8000-000000000001','Shop');
CREATE TABLE inventory_parties(id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('supplier','customer')),name text NOT NULL,email text NOT NULL,UNIQUE(id,kind));
CREATE TABLE inventory_items (
 id uuid PRIMARY KEY,name text NOT NULL,sku text NOT NULL UNIQUE,unit text NOT NULL,
 reorder_level integer NOT NULL CHECK(reorder_level BETWEEN 0 AND 1000000),
 cost integer NOT NULL CHECK(cost BETWEEN 0 AND 100000000),sale_price integer NOT NULL CHECK(sale_price BETWEEN 0 AND 100000000),
 category_id uuid NOT NULL, category_kind text NOT NULL DEFAULT 'category' CHECK(category_kind='category'),
 FOREIGN KEY(category_id,category_kind) REFERENCES inventory_lists(id,kind)
);
CREATE TABLE inventory_orders (
 id uuid PRIMARY KEY, reference text NOT NULL UNIQUE,kind text NOT NULL CHECK(kind IN ('purchase','sales')),
 party_id uuid NOT NULL,party_kind text NOT NULL,location_id uuid NOT NULL REFERENCES inventory_locations(id),
 status_id uuid NOT NULL,completed_at timestamptz,created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(party_id,party_kind) REFERENCES inventory_parties(id,kind),
 FOREIGN KEY(status_id,kind) REFERENCES inventory_lists(id,kind),
 CHECK((kind='purchase' AND party_kind='supplier') OR (kind='sales' AND party_kind='customer'))
);
CREATE TABLE inventory_lines (
 id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES inventory_orders(id),item_id uuid NOT NULL REFERENCES inventory_items(id),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 1000000),unit_price integer NOT NULL CHECK(unit_price BETWEEN 0 AND 100000000),UNIQUE(order_id,item_id)
);
CREATE TABLE inventory_moves (
 id uuid PRIMARY KEY,item_id uuid NOT NULL REFERENCES inventory_items(id),location_id uuid NOT NULL REFERENCES inventory_locations(id),
 quantity integer NOT NULL CHECK(quantity<>0 AND quantity BETWEEN -1000000 AND 1000000),reason text NOT NULL,
 order_id uuid REFERENCES inventory_orders(id),created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(order_id,item_id)
);
CREATE INDEX inventory_moves_balance ON inventory_moves(item_id,location_id);
CREATE TABLE inventory_invites (
 id uuid PRIMARY KEY,token_hash text NOT NULL UNIQUE,email text NOT NULL,role text NOT NULL CHECK(role='staff'),
 invited_by uuid NOT NULL REFERENCES app_users(id),expires_at timestamptz NOT NULL,used_at timestamptz,emailed boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX inventory_invites_active ON inventory_invites(email) WHERE used_at IS NULL;
CREATE TABLE inventory_mail (
 id uuid PRIMARY KEY, dedupe text NOT NULL UNIQUE,recipient text NOT NULL,subject text NOT NULL,body text NOT NULL
);
