import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

try {
  await sql`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL REFERENCES users(id),
      address text NOT NULL,
      district varchar(100) NOT NULL DEFAULT '',
      days text NOT NULL DEFAULT '[]',
      time varchar(8) NOT NULL DEFAULT '18:00',
      price integer NOT NULL,
      description text NOT NULL DEFAULT '',
      active boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `;
  console.log('✓ Table subscriptions created');

  await sql`
    CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id)
  `;
  console.log('✓ Index idx_subscriptions_customer created');
} catch (e: any) {
  console.error('Error:', e.message);
} finally {
  await sql.end();
  process.exit(0);
}
