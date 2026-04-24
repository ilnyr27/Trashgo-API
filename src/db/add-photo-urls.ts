import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

try {
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS photo_urls TEXT NOT NULL DEFAULT '[]'`;
  console.log('✓ Column photo_urls added');
} catch (e: any) {
  console.error('Error:', e.message);
} finally {
  await sql.end();
  process.exit(0);
}
