import mysql from "mysql2/promise";
for (const key of ['DB_USER','DB_PASSWORD','DB_NAME']) {
  if (!process.env[key]) throw new Error(`Missing local configuration: ${key}`);
}
export const pool = mysql.createPool({
  host:process.env.DB_HOST || '127.0.0.1',
  port:Number(process.env.DB_PORT || 3306),
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
  charset:'utf8mb4',waitForConnections:true,connectionLimit:10,namedPlaceholders:true
});
export async function pingDatabase(){const c=await pool.getConnection();try{await c.ping();}finally{c.release();}}
