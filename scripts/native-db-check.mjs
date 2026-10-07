import pg from '../node/node_modules/pg/lib/index.js';

const client = new pg.Client({connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000});
try {
  await client.connect();
  const result = await client.query("SELECT current_database() AS database, current_user AS username, EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS postgis");
  console.log(result.rows[0]);
  if (!result.rows[0].postgis) {
    console.error('PostGIS is not enabled in this database; db-init requires permission to enable the installed extension.');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Database connection failed (${error.code || error.name}). Check host/port, credentials and server logs.`);
  process.exitCode = 1;
} finally {
  await client.end();
}
