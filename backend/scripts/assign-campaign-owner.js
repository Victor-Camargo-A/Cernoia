import 'dotenv/config';
import {pool} from '../src/db.js';
import {emailAddress} from '../src/services/campaign-rules.js';

// Server-only operation. This is deliberately unavailable through tenant or
// platform APIs. It never changes another administrator's password.
const email=emailAddress(process.argv[2]);
if(!email)throw Error('Uso: node scripts/assign-campaign-owner.js correo-del-dueño');
const client=await pool.connect();
try{
 await client.query('BEGIN');
 const settings=(await client.query('SELECT owner_admin_id FROM saas.campaign_settings WHERE id=TRUE FOR UPDATE')).rows[0];
 const admin=(await client.query("SELECT id FROM saas.platform_admin_users WHERE LOWER(email)=$1 AND status='active'",[email])).rows[0];
 if(!admin)throw Error('Primero crea la cuenta global del dueño con create-platform-admin.');
 if(settings.owner_admin_id&&settings.owner_admin_id!==admin.id)throw Error('Ya existe un dueño. No se reemplazará desde este comando.');
 await client.query('UPDATE saas.campaign_settings SET owner_admin_id=$1,updated_at=NOW() WHERE id=TRUE',[admin.id]);
 await client.query('COMMIT');console.log('Acceso exclusivo asignado. Los envíos conservan su configuración actual.');
}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();await pool.end();}
